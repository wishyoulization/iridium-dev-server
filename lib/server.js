// The dev server: the Iridium editor at /<name>, notebook storage at /read,
// /save and /list, a searchable, paginated notebook list at /api/notebooks
// (DELETE /api/notebooks/<name> moves one to the Trash), live collaboration at /__live__/<name> (WebSocket), an MCP
// server at /mcp, and compiled modules plus static assets for embedding.
import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import Koa from 'koa';
import Router from '@koa/router';
import { bodyParser } from '@koa/bodyparser';
import cors from '@koa/cors';
import serve from 'koa-static';
import { WebSocketServer } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { listNotebooks, notebookName, notebookPath, readNotebook, readNotebookMeta, writeNotebook } from './notebooks.js';
import { compileModule } from './define-module.js';
import { Relay } from './live.js';
import { createMcpServer } from './mcp.js';
import { viewerPage } from './viewer.js';

const require = createRequire(import.meta.url);
const IRIDIUM_PATH = '/__iridium__';
// A notebook's file attachments live in a folder named after it, next to its
// notebook file (<notebooks>/<name>/), and are served at /__files__/<name>/.
const FILES_PATH = '/__files__';
const iridiumPackage = require('@a10k/iridium/package.json');
const iridiumDist = join(dirname(require.resolve('@a10k/iridium/package.json')), 'dist');

const ownPackage = require('../package.json');
// The CDN copy matches the installed version of the npm package.
const IRIDIUM_CDN = `https://cdn.jsdelivr.net/npm/@a10k/iridium@${iridiumPackage.version}/dist`;

// The names of a notebook's file attachments (files in <notebooks>/<name>/).
const attachmentNames = (config, name) => {
  const dir = join(config.notebooks, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).filter((file) => statSync(join(dir, file)).isFile());
};

export const compileNotebook = (config, name) => {
  const path = notebookPath(config.notebooks, name);
  if (!path) throw new Error(`No notebook named ${name}`);
  // Attachments ship next to the module, in <compiled>/<name>/.
  const files = attachmentNames(config, name);
  const source = join(config.notebooks, name);
  const target = join(config.compiled, name);
  if (files.length && source !== target) {
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
  }
  const module = compileModule(readNotebook(path), { name: path, files: { folder: name, names: files } });
  writeFileSync(join(config.compiled, `${name}.js`), module);
};

export const compileAll = (config) => {
  for (const name of listNotebooks(config.notebooks)) {
    try {
      console.log('Compiling', name);
      compileNotebook(config, name);
    } catch (error) {
      console.error('Error compiling', name, error);
    }
  }
};

// Opens a URL in the user's default browser, or in `browser` (an application
// name such as "Google Chrome", or IRIDIUM_BROWSER). IRIDIUM_OPEN_BROWSER=0
// disables this, e.g. when the assistant shows notebooks in its own browser.
export const openBrowser = (url, browser = process.env.IRIDIUM_BROWSER) => {
  if (process.env.IRIDIUM_OPEN_BROWSER === '0') return;
  const [command, ...args] =
    process.platform === 'darwin' ? ['open', ...(browser ? ['-a', browser] : []), url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', ...(browser ? [browser] : []), url]
    : browser ? [browser, url] : ['xdg-open', url];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
};

export const serverUrl = (config) =>
  `http://${['0.0.0.0', '::'].includes(config.host) ? 'localhost' : config.host}:${config.port}`;

// Starts the server. `log` defaults to console.log (stdio MCP mode passes
// console.error, since stdout carries the protocol).
export const startServer = (config, { log = console.log } = {}) => {
  const app = new Koa();
  const router = new Router();
  const live = new Relay();
  // Writes a notebook's file: from a tab's Save, or a new empty notebook.
  // Cells keep their original type (e.g. Markdown) while their code is unchanged.
  const saveNotebook = (name, cells, meta = {}) => {
    const path = notebookPath(config.notebooks, name);
    const before = new Map((path ? readNotebook(path) : []).map((cell) => [cell.id, cell]));
    const kept = cells.map((cell) => {
      const previous = before.get(cell.id);
      return previous?.mode && previous.sourceCode === cell.sourceCode ? { ...cell, mode: previous.mode } : cell;
    });
    writeNotebook(join(config.notebooks, `${name}.html`), kept, { title: name, ...readNotebookMeta(path), ...meta });
    try {
      compileNotebook(config, name);
    } catch (error) {
      console.error(`Error compiling ${name}:`, error.message);
    }
  };
  const urlFor = (name) => `${serverUrl(config)}/${name}`;
  const mcpOptions = {
    live,
    urlFor,
    createNotebook: (name, title) => saveNotebook(name, [], { title }),
    fileFor: (name) => { const path = notebookPath(config.notebooks, name); return path && resolve(path); },
    openBrowser,
    listNotebooks: () => listNotebooks(config.notebooks),
    version: ownPackage.version,
  };

  // Requests that read or change notebooks must come from this machine and,
  // from a browser, from this server's own pages: guards against other sites
  // (CSRF) and DNS rebinding.
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', config.host]);
  const trusted = (headers) => {
    const host = String(headers.host ?? '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(host)) return false;
    const origin = headers.origin;
    return !origin || new URL(origin).host === headers.host;
  };

  // /read, /save and /list read and write files, so only accept them from
  // this server's own pages: a JSON body, and no cross-site Origin.
  const sameOrigin = async (ctx, next) => {
    if (!trusted(ctx.headers)) ctx.throw(403, 'Cross-origin request');
    if (!ctx.is('application/json')) ctx.throw(415, 'Expected JSON');
    await next();
  };

  router.post('/list', sameOrigin, (ctx) => {
    ctx.body = listNotebooks(config.notebooks);
  });

  // GET /api/notebooks?q=&page=1&per_page=25&sort=name|modified: notebooks
  // whose name or title contains q (any case), one page at a time, as JSON:
  // { q, sort, page, per_page, pages, total, items: [{ name, title, url, modified, cells, size }] }.
  // The `index` notebook (the home page) isn't listed.
  // Reading a title and cell count parses the file: keep them until it changes.
  const summaries = new Map(); // path → { mtimeMs, title, cells }
  const describeNotebook = (name) => {
    const path = notebookPath(config.notebooks, name);
    const { mtimeMs, mtime, size } = statSync(path);
    let cached = summaries.get(path);
    if (cached?.mtimeMs !== mtimeMs) {
      cached = { mtimeMs, title: readNotebookMeta(path).title || name, cells: readNotebook(path).length };
      summaries.set(path, cached);
    }
    return { name, title: cached.title, url: `/${name}`, modified: mtime.toISOString(), cells: cached.cells, size };
  };
  // Moves files to the Trash: the system's (macOS `trash`, restorable with Put
  // Back), or else a .trash folder inside the notebooks folder.
  const moveToTrash = async (paths) => {
    if (process.platform === 'darwin' && existsSync('/usr/bin/trash')) {
      await new Promise((done, fail) => execFile('/usr/bin/trash', paths, (error) => (error ? fail(error) : done())));
      return 'the Trash';
    }
    const bin = join(config.notebooks, '.trash', new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(bin, { recursive: true });
    for (const path of paths) renameSync(path, join(bin, path.split(/[\\/]/).pop()));
    return bin;
  };

  // DELETE /api/notebooks/<name>: moves the notebook file and its attachments
  // folder to the Trash, and removes its compiled module (rebuilt on save).
  router.delete('/api/notebooks/:name', async (ctx) => {
    if (!trusted(ctx.headers)) ctx.throw(403, 'Cross-origin request');
    const name = notebookName(ctx.params.name);
    const path = notebookPath(config.notebooks, name);
    if (!path) ctx.throw(404, `No notebook named ${name}`);
    const attachments = join(config.notebooks, name);
    const paths = [path, ...(existsSync(attachments) && statSync(attachments).isDirectory() ? [attachments] : [])];
    const where = await moveToTrash(paths.map((p) => resolve(p)));
    for (const compiled of [join(config.compiled, `${name}.js`), join(config.compiled, name)]) rmSync(compiled, { recursive: true, force: true });
    summaries.delete(path);
    ctx.body = { deleted: name, moved: paths.map((p) => resolve(p)), to: where };
  });

  router.get('/api/notebooks', (ctx) => {
    if (!trusted(ctx.headers)) ctx.throw(403, 'Cross-origin request');
    const q = String(ctx.query.q ?? '').trim().toLowerCase();
    const sort = ctx.query.sort === 'modified' ? 'modified' : 'name';
    const perPage = Math.min(200, Math.max(1, parseInt(ctx.query.per_page, 10) || 25));
    const all = listNotebooks(config.notebooks)
      .filter((name) => name !== 'index')
      .map(describeNotebook)
      .filter((item) => !q || item.name.toLowerCase().includes(q) || item.title.toLowerCase().includes(q))
      .sort(sort === 'modified'
        ? (a, b) => b.modified.localeCompare(a.modified)
        : (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    const pages = Math.max(1, Math.ceil(all.length / perPage));
    const page = Math.min(pages, Math.max(1, parseInt(ctx.query.page, 10) || 1));
    ctx.body = { q, sort, page, per_page: perPage, pages, total: all.length, items: all.slice((page - 1) * perPage, page * perPage) };
  });

  router.post('/read', sameOrigin, (ctx) => {
    const path = notebookPath(config.notebooks, notebookName(ctx.request.body?.path));
    ctx.body = path ? readNotebook(path).map(({ id, pin, sourceCode }) => ({ id, pin, sourceCode })) : []; // [] for a new notebook
  });

  router.post('/save', sameOrigin, (ctx) => {
    const name = notebookName(ctx.request.body?.path);
    const cells = ctx.request.body?.content;
    if (!Array.isArray(cells)) ctx.throw(400, 'Expected content: an array of cells');
    saveNotebook(name, cells);
    ctx.body = {};
  });

  // MCP over Streamable HTTP (stateless: one server per request).
  router.all('/mcp', async (ctx) => {
    if (!trusted(ctx.headers)) ctx.throw(403, 'Cross-origin request');
    const server = createMcpServer(mcpOptions);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    ctx.respond = false;
    ctx.res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(ctx.req, ctx.res, ctx.request.body);
  });

  // Serve the editor page for any URL that isn't a file, API route or asset.
  app.use(async (ctx, next) => {
    // A notebook's own .html file opens in the editor rather than as a page.
    const asNotebook = ctx.path.match(/^\/([^/]+)\.html$/);
    if (asNotebook && notebookPath(config.notebooks, asNotebook[1])?.endsWith('.html')) {
      ctx.redirect(`/${notebookName(asNotebook[1])}`);
      return;
    }
    if (ctx.path !== '/') await next();
    // Missing attachments and editor files are real 404s, not editor pages.
    const reserved =
      ctx.path === '/mcp' || ctx.path.startsWith(`${FILES_PATH}/`) || ctx.path.startsWith(`${IRIDIUM_PATH}/`);
    if (ctx.method === 'GET' && !reserved && (ctx.path === '/' || ctx.status === 404)) {
      ctx.status = 200;
      ctx.type = 'html';
      const name = notebookName(ctx.path);
      ctx.body = viewerPage({
        name,
        iridiumBase: config.localEditor ? IRIDIUM_PATH : IRIDIUM_CDN,
        filesBase: `${FILES_PATH}/${name}/`,
        head: config.head,
      });
    }
  });

  app.use(bodyParser({ enableTypes: ['json'], jsonLimit: '10mb' }));
  app.use(router.routes()).use(router.allowedMethods());

  // Compiled modules and assets may be imported from other origins (embeds).
  app.use(cors({ allowMethods: 'GET,HEAD' }));

  if (config.localEditor) {
    const editor = serve(iridiumDist, { maxage: 0 });
    app.use(async (ctx, next) => {
      if (!ctx.path.startsWith(`${IRIDIUM_PATH}/`)) return next();
      ctx.path = ctx.path.slice(IRIDIUM_PATH.length);
      await editor(ctx, next);
    });
  }

  // File attachments: /__files__/<name>/<file> from <notebooks>/<name>/<file>.
  const files = serve(config.notebooks, { maxage: 0 });
  app.use(async (ctx, next) => {
    const match = ctx.path.match(/^\/__files__\/([^/]+)\/(.+)$/);
    if (!match) return next();
    if (match[1] !== notebookName(match[1]) || match[2].includes('..')) ctx.throw(404);
    ctx.path = `/${match[1]}/${match[2]}`;
    await files(ctx, next);
  });

  app.use(serve(config.compiled, { maxage: 0 }));
  if (config.static && existsSync(config.static)) app.use(serve(config.static, { maxage: 0 }));

  const server = app.listen(config.port, config.host, () => {
    log(`\nIridium ${iridiumPackage.version} dev server`);
    log(serverUrl(config));
    log(`MCP: ${serverUrl(config)}/mcp`);
  });

  // Live collaboration: each editor tab connects to /__live__/<name>.
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const match = request.url?.match(/^\/__live__\/([^/?#]+)/);
    if (!match || !trusted(request.headers)) return socket.destroy();
    const name = notebookName(decodeURIComponent(match[1]));
    sockets.handleUpgrade(request, socket, head, (ws) => live.connect(name, ws));
  });

  return { server, live, mcpOptions };
};
