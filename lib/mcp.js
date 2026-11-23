// MCP server: lets an assistant work on Iridium notebooks in the user's open
// browser tab. The dev server is only a relay (see live.js): every tool is a
// command the tab carries out on its own notebook, as if the user had, and
// reads come from the tab. The file changes only when the tab saves.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notebookName, readNotebook } from './notebooks.js';

export const INSTRUCTIONS = `Iridium notebooks are reactive Observable notebooks that run in the user's browser. Use these tools whenever the user asks for an Iridium notebook, an Observable notebook, or an interactive notebook, chart, or data exploration they want to see live.

The tools work on the notebook open in the user's browser tab, as if the user were doing it: create_notebook or open_notebook opens a tab; then add_cell/add_cells, edit_cell, run_cell, delete_cell and move_cell change it in that tab, read_notebook reads its cells and outputs, evaluate inspects values without adding cells, screenshot_cells shows you cells' rendered output as images (check charts and layout with it rather than driving a browser), and save_notebook saves it as the tab's Save (Cmd+S) does. Every edit returns the cells' live output once they have run (value, rendered text, or error), plus any other cells that are now failing, so check results and fix errors before moving on. The user may edit in the tab too: re-read before editing cells you didn't just write (brief: true lists cells compactly, ids reads only some).

Edits are unsaved until saved, like the user's own edits (unsaved_changes in results). Save only when the user asks you to. Address cells by id or by the name they define (cell: "data"). For small changes to a long cell, edit_cell with replace: [{old, new}] patches its code instead of resending it. To open a notebook in a particular browser, pass browser (e.g. "Google Chrome") to create_notebook or open_notebook.

Cells are Observable JavaScript: \`name = expression\`, \`name = { ...; return value; }\` blocks, \`viewof x = Inputs.range([0, 10])\`, \`mutable x = 0\`, generators (yield), \`import {chart} from "@d3/bar-chart"\` from observablehq.com, \`md\\\`...\\\`\` and \`html\\\`...\\\`\` for text and markup. Cells react to each other by name in any order; each named cell is defined once. Plain JavaScript cells also work (several statements, \`const\` declarations shared with other cells, \`import {x} from "npm:pkg"\`, \`display(value)\`), and may use TypeScript syntax (types are stripped, not checked). Built-ins include d3, Plot, Inputs, htl, _ (lodash), md, html, svg, tex, dot, mermaid, DuckDBClient, FileAttachment, width, now, invalidation, Generators, require. Prefer Plot for charts and Inputs for controls, and use \`width\` for responsive sizes.`;

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// The name a cell defines (`name = …`, `viewof name = …`, `mutable name = …`),
// after any leading comments; undefined for anonymous cells.
const definedName = (source) =>
  String(source ?? '')
    .replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '')
    .match(/^(?:(?:viewof|mutable)\s+)?([A-Za-z_$][\w$]*)\s*=(?![=>])/)?.[1];

const firstLine = (source) => {
  const line = String(source ?? '').replace(/^(\s|\/\/[^\n]*\n)*/, '').split('\n')[0];
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

export const createMcpServer = ({ live, urlFor, fileFor = () => undefined, createNotebook, openBrowser, listNotebooks, version = '1.0.0' }) => {
  const server = new McpServer({ name: 'iridium', version }, { instructions: INSTRUCTIONS });

  const wait = z.number().int().min(0).max(60000).optional()
    .describe('How long to wait for the cells to finish running, in ms (default 8000).');
  const notebookArg = z.string().describe('Notebook name (letters, digits and "-"), e.g. "sales-dashboard".');
  const browserArg = z.string().optional()
    .describe('Open it in this browser application (e.g. "Google Chrome", "Safari") instead of the default one.');

  const requireNotebook = (raw) => {
    const name = notebookName(raw);
    if (!fileFor(name) && !live.clients(name)) throw new Error(`No notebook named "${name}". Use list_notebooks or create_notebook.`);
    return name;
  };

  // A cell by id, or by the name it defines (cell: "data" or "viewof x").
  const cellArgs = {
    id: z.number().int().optional().describe('The cell\'s id.'),
    cell: z.string().optional().describe('Or the name the cell defines, e.g. "data" or "viewof region".'),
  };
  const tabCells = async (name) => (await live.request(name, 'cells')).cells;
  const resolveCell = async (name, { id, cell }) => {
    const cells = await tabCells(name);
    let found;
    if (id !== undefined) found = cells.find((c) => c.id === id);
    else if (cell) {
      const wanted = cell.replace(/^(viewof|mutable)\s+/, '');
      found = cells.find((c) => definedName(c.sourceCode) === wanted);
    } else throw new Error('Give the cell\'s id or the name it defines (cell).');
    if (!found) throw new Error(`No cell ${id ?? `defining "${cell}"`} in ${name}. Use read_notebook with brief: true to list the cells.`);
    return found;
  };

  // Opens the notebook in the browser unless a tab already shows it, and waits
  // briefly for that tab to connect.
  const ensureTab = async (name, open, browser) => {
    if (live.clients(name) || !open) return live.clients(name) > 0;
    openBrowser(urlFor(name), browser);
    for (let i = 0; i < 60 && !live.clients(name); i++) await new Promise((r) => setTimeout(r, 250));
    return live.clients(name) > 0;
  };

  // The tab's state of `ids` after an edit, and any other failing cells.
  const outcome = async (name, ids, waitMs, extra = {}) => {
    const result = { notebook: name, url: urlFor(name), ...extra };
    const edited = ids?.length ? await live.describe(name, ids, waitMs ?? 8000) : null;
    const all = await live.describe(name, undefined, edited ? 0 : (waitMs ?? 8000));
    result.unsaved_changes = all.unsaved;
    // The caller just wrote the edited cells' code: don't send it back. An
    // empty ids list (delete_cell) reports no cells, only other failing ones.
    result.cells = edited ? edited.cells.map(({ source, ...cell }) => cell) : ids ? [] : all.cells;
    const failing = all.cells.filter((cell) => !ids?.includes(cell.id) && ['error', 'rejected'].includes(cell.status));
    if (failing.length) result.other_failing_cells = failing.map(({ id, source, status, error }) => ({ id, status, error, source: source.slice(0, 120) }));
    return result;
  };

  const tool = (name, description, inputSchema, handler) =>
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        return text(await handler(args));
      } catch (error) {
        return failure(error.message);
      }
    });

  const placement = {
    after: z.number().int().optional().describe('Insert after the cell with this id.'),
    before: z.number().int().optional().describe('Insert before the cell with this id.'),
    index: z.number().int().min(0).optional().describe('Insert at this position (0 = top). Default: the end.'),
  };
  const cellSpec = z.object({
    source: z.string().describe('The cell code.'),
    pinned: z.boolean().optional().describe('Show the code editor (default true). Unpin prose and finished outputs.'),
  });

  tool('list_notebooks', 'List the Iridium notebooks, with their URLs, files and how many browser tabs show each.', {}, async () =>
    listNotebooks().map((name) => ({ name, url: urlFor(name), file: fileFor(name), open_tabs: live.clients(name) })),
  );

  tool(
    'create_notebook',
    'Create a new, empty notebook file, open it in the user\'s browser, and add initial cells there (unsaved until saved). Returns the cells\' ids and live outputs.',
    {
      name: notebookArg,
      title: z.string().optional().describe('Display title (default: the name).'),
      cells: z.array(cellSpec).optional().describe('Initial cells, top to bottom.'),
      browser: browserArg,
      wait_ms: wait,
    },
    async ({ name: raw, title, cells = [], browser, wait_ms }) => {
      const name = notebookName(raw);
      if (fileFor(name)) throw new Error(`A notebook named "${name}" already exists. Use open_notebook, or choose another name.`);
      createNotebook(name, title);
      if (!(await ensureTab(name, true, browser))) {
        return { notebook: name, url: urlFor(name), file: fileFor(name), created: true, note: 'Created, but no tab connected: open the url, then add the cells.' };
      }
      if (!cells.length) return outcome(name, undefined, wait_ms, { created: true, file: fileFor(name) });
      const { ids } = await live.request(name, 'insert', { cells });
      return outcome(name, ids, wait_ms, { created: true, file: fileFor(name), ids });
    },
  );

  tool(
    'open_notebook',
    'Open a notebook in the user\'s browser (unless a tab already shows it) and return its cells with live outputs.',
    { name: notebookArg, browser: browserArg, wait_ms: wait },
    async ({ name: raw, browser, wait_ms }) => {
      const name = requireNotebook(raw);
      if (!(await ensureTab(name, true, browser))) throw new Error(`Opened ${urlFor(name)}, but no tab connected yet. Try again in a moment.`);
      return outcome(name, undefined, wait_ms, { file: fileFor(name) });
    },
  );

  tool(
    'read_notebook',
    'Read the open notebook\'s cells (id, source, pinned) with each cell\'s live status and output (value, rendered text, error, exports). brief: true lists every cell in one line (id, name, status, first line of code); ids reads only those cells. Without an open tab, returns the saved file\'s code.',
    {
      notebook: notebookArg,
      ids: z.array(z.number().int()).optional().describe('Only these cells.'),
      brief: z.boolean().optional().describe('One short line per cell instead of full code and output.'),
      wait_ms: wait,
    },
    async ({ notebook, ids, brief = false, wait_ms }) => {
      const name = requireNotebook(notebook);
      const base = { notebook: name, url: urlFor(name), file: fileFor(name) };
      if (!live.clients(name)) {
        const saved = (fileFor(name) ? readNotebook(fileFor(name)) : []).filter((cell) => !ids || ids.includes(cell.id));
        return { ...base, note: 'No tab shows this notebook: this is the saved file, without outputs. Call open_notebook to work on it.', cells: saved.map(({ id, pin, sourceCode }) => (brief ? { id, name: definedName(sourceCode), pinned: !!pin, code: firstLine(sourceCode) } : { id, pinned: !!pin, source: sourceCode })) };
      }
      const { cells, unsaved } = await live.describe(name, ids, wait_ms ?? 3000);
      if (!brief) return { ...base, unsaved_changes: unsaved, cells };
      return {
        ...base,
        unsaved_changes: unsaved,
        cells: cells.map(({ id, pinned, status, source, error }) => {
          const line = { id, name: definedName(source), pinned, status, code: firstLine(source) };
          if (error) line.error = String(error).slice(0, 200);
          return Object.fromEntries(Object.entries(line).filter(([, value]) => value !== undefined));
        }),
      };
    },
  );

  tool(
    'add_cell',
    'Add a cell to the open notebook (at the end, or after/before a cell, or at an index); it runs. Returns its id and live output.',
    { notebook: notebookArg, source: z.string().describe('The cell code.'), pinned: z.boolean().optional().describe('Show the code editor (default true).'), ...placement, wait_ms: wait },
    async ({ notebook, source, pinned = true, wait_ms, ...where }) => {
      const name = requireNotebook(notebook);
      const { ids } = await live.request(name, 'insert', { cells: [{ source, pinned }], ...where });
      return outcome(name, ids, wait_ms, { id: ids[0] });
    },
  );

  tool(
    'add_cells',
    'Add several cells in order to the open notebook (at the end, or after/before a cell, or at an index). Returns their ids and live outputs.',
    { notebook: notebookArg, cells: z.array(cellSpec).min(1), ...placement, wait_ms: wait },
    async ({ notebook, cells, wait_ms, ...where }) => {
      const name = requireNotebook(notebook);
      const { ids } = await live.request(name, 'insert', { cells, ...where });
      return outcome(name, ids, wait_ms, { ids });
    },
  );

  tool(
    'edit_cell',
    'Change a cell in the open notebook (by id, or by the name it defines) and run it: replace its code (source), patch it (replace: [{old, new}], each old text found exactly once, applied in order; cheaper than resending a long cell), and/or pin it. Returns its live output and any cells now failing.',
    {
      notebook: notebookArg,
      ...cellArgs,
      source: z.string().optional().describe('The cell\'s new code.'),
      replace: z.array(z.object({ old: z.string().min(1), new: z.string() })).optional()
        .describe('Patches to the current code: each `old` text must appear exactly once.'),
      pinned: z.boolean().optional(),
      wait_ms: wait,
    },
    async ({ notebook, source, replace, pinned, wait_ms, ...which }) => {
      const name = requireNotebook(notebook);
      if (source !== undefined && replace) throw new Error('Give either source or replace, not both.');
      const cell = await resolveCell(name, which);
      if (replace) {
        source = cell.sourceCode;
        for (const { old, new: text } of replace) {
          const count = source.split(old).length - 1;
          if (count !== 1) throw new Error(`replace: ${count ? `${count} matches` : 'no match'} in cell ${cell.id} for ${JSON.stringify(old.slice(0, 80))}; nothing changed. Include more surrounding text, or read the cell (read_notebook with ids).`);
          source = source.replace(old, () => text);
        }
      }
      await live.request(name, 'update', { id: cell.id, sourceCode: source, pin: pinned });
      return outcome(name, [cell.id], wait_ms, { id: cell.id });
    },
  );

  tool('delete_cell', 'Delete a cell from the open notebook (by id, or by the name it defines). Returns any cells now failing (e.g. ones that used its value).', { notebook: notebookArg, ...cellArgs, wait_ms: wait }, async ({ notebook, wait_ms, ...which }) => {
    const name = requireNotebook(notebook);
    const { id } = await resolveCell(name, which);
    await live.request(name, 'remove', { id });
    return outcome(name, [], wait_ms, { deleted: id });
  });

  tool(
    'move_cell',
    'Move a cell in the open notebook (after/before another cell, or to an index). Order only affects layout: cells react by name.',
    { notebook: notebookArg, ...cellArgs, ...placement },
    async ({ notebook, id: rawId, cell, ...where }) => {
      const name = requireNotebook(notebook);
      const { id } = await resolveCell(name, { id: rawId, cell });
      return { notebook: name, ...(await live.request(name, 'move', { id, ...where })) };
    },
  );

  tool('run_cell', 'Run a cell in the open notebook again without changing it (e.g. to refetch data or replay an animation).', { notebook: notebookArg, ...cellArgs, wait_ms: wait }, async ({ notebook, wait_ms, ...which }) => {
    const name = requireNotebook(notebook);
    const { id } = await resolveCell(name, which);
    await live.request(name, 'run', { id });
    return outcome(name, [id], wait_ms, { id });
  });

  // Images, not text: registered without the text wrapper.
  server.registerTool(
    'screenshot_cells',
    {
      description: 'Screenshot cells of the open notebook as PNG images, exactly as the user\'s tab shows them (charts, layout, styling, input values, unsaved edits). The tab uses Chrome\'s tab capture: the first time, it asks the user to allow it (they click Allow, then share the tab), so the first call can wait for them. Up to 6 cells per call.',
      inputSchema: {
        notebook: notebookArg,
        ids: z.array(z.number().int()).optional().describe('Cells by id.'),
        cells: z.array(z.string()).optional().describe('Or by the names they define, e.g. ["calendar", "chart"].'),
        include_code: z.boolean().optional().describe('Include the code editor of pinned cells (default: the output only).'),
        scale: z.number().min(0.5).max(3).optional().describe('Image pixels per CSS pixel (default 1; 2 for retina detail).'),
      },
    },
    async ({ notebook, ids = [], cells: names = [], include_code = false, scale = 1 }) => {
      try {
        const name = requireNotebook(notebook);
        const wanted = [...ids];
        for (const cell of names) wanted.push((await resolveCell(name, { cell })).id);
        if (!wanted.length) throw new Error('Give ids or cells to screenshot.');
        if (wanted.length > 6) throw new Error('Up to 6 cells per call.');
        await live.describe(name, wanted, 8000); // let them finish running
        // Allow two minutes: the first capture waits for the user to allow it.
        const { shots } = await live.request(name, 'screenshot', { ids: wanted, includeCode: include_code, scale }, 120000);
        const summary = shots.map(({ id, width: w, height: h, error }) => (error ? { id, error } : { id, width: w, height: h }));
        return {
          content: [
            { type: 'text', text: JSON.stringify({ notebook: name, shots: summary }, null, 2) },
            ...shots.filter((shot) => shot.png).map((shot) => ({ type: 'image', data: shot.png, mimeType: 'image/png' })),
          ],
        };
      } catch (error) {
        return failure(error.message);
      }
    },
  );

  tool(
    'save_notebook',
    'Save the open notebook to its file, exactly as the tab\'s Save (Cmd+S) does. Only when the user asks to save.',
    { notebook: notebookArg },
    async ({ notebook }) => {
      const name = requireNotebook(notebook);
      const { unsaved } = await live.request(name, 'save');
      return { notebook: name, file: fileFor(name), saved: true, unsaved_changes: unsaved };
    },
  );

  tool(
    'evaluate',
    'Evaluate an expression (or cell code) against the open notebook\'s live values without adding a cell, e.g. "data.length" or "Object.keys(data[0])".',
    { notebook: notebookArg, expression: z.string(), timeout_ms: z.number().int().min(100).max(60000).optional() },
    async ({ notebook, expression, timeout_ms = 10000 }) => {
      const name = requireNotebook(notebook);
      return live.request(name, 'evaluate', { source: expression, timeout: timeout_ms }, timeout_ms + 5000);
    },
  );

  return server;
};
