// The dev server: the Iridium editor at /<name>, notebook storage at /read,
// /save and /list, live collaboration at /__live__/<name> (WebSocket), an MCP
// server at /mcp, and compiled modules plus static assets for embedding.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import Koa from 'koa';
import Router from '@koa/router';
import { bodyParser } from '@koa/bodyparser';
import cors from '@koa/cors';
import serve from 'koa-static';
import { WebSocketServer } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { listNotebooks, notebookName, notebookPath, readNotebook } from './notebooks.js';
import { compileModule } from './define-module.js';
import { LiveNotebooks } from './live.js';
import { createMcpServer } from './mcp.js';
import { viewerPage } from './viewer.js';

const require = createRequire(import.meta.url);
const IRIDIUM_PATH = '/__iridium__';
// A notebook's file attachments live in a folder named after it, next to its
// notebook file (<notebooks>/<name>/), and are served at /__files__/<name>/.
const FILES_PATH = '/__files__';
const iridiumPackage = require('@wishyoulization/iridium/package.json');
const iridiumDist = join(dirname(require.resolve('@wishyoulization/iridium/package.json')), 'dist');

// The CDN copy matches the installed version: the commit in our package.json.
const ownPackage = require('../package.json');
const iridiumCommit = ownPackage.dependencies['@wishyoulization/iridium'].split('#')[1];
const IRIDIUM_CDN = `https://cdn.jsdelivr.net/gh/wishyoulization/iridium@${iridiumCommit}/dist`;

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

// Opens a URL in the user's default browser (IRIDIUM_OPEN_BROWSER=0 disables
// this, e.g. when the assistant shows notebooks in its own browser).
export const openBrowser = (url) => {
  if (process.env.IRIDIUM_OPEN_BROWSER === '0') return;
  const [command, ...args] =
    process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
    : ['xdg-open', url];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
};

export const serverUrl = (config) =>
  `http://${['0.0.0.0', '::'].includes(config.host) ? 'localhost' : config.host}:${config.port}`;

// Starts the server. `log` defaults to console.log (stdio MCP mode passes
// console.error, since stdout carries the protocol).
export const startServer = (config, { log = console.log } = {}) => {
  const app = new Koa();
  const router = new Router();
  const live = new LiveNotebooks(config, { compile: (name) => compileNotebook(config, name) });
  const urlFor = (name) => `${serverUrl(config)}/${name}`;
  const mcpOptions = {
    live,
    urlFor,
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

  router.post('/read', sameOrigin, (ctx) => {
    ctx.body = live.cells(notebookName(ctx.request.body?.path)); // [] for a new notebook
  });

  router.post('/save', sameOrigin, (ctx) => {
    const name = notebookName(ctx.request.body?.path);
    const cells = ctx.request.body?.content;
    if (!Array.isArray(cells)) ctx.throw(400, 'Expected content: an array of cells');
    // Saved, compiled and sent to the notebook's other tabs.
    live.apply(name, { type: 'replace', cells });
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
    log(`\nIridium ${iridiumPackage.version} (${iridiumCommit}) dev server`);
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
