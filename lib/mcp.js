// MCP server: lets an assistant build and edit Iridium notebooks live, in the
// same tab the user is watching, and read each cell's live output.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notebookName } from './notebooks.js';

export const INSTRUCTIONS = `Iridium notebooks are reactive Observable notebooks that run in the user's browser. Use these tools whenever the user asks for an Iridium notebook, an Observable notebook, or an interactive notebook, chart, or data exploration they want to see live.

Workflow: create_notebook (or open_notebook for an existing one) opens the notebook in the user's browser; then add_cell/add_cells, edit_cell, delete_cell and move_cell change it live while the user watches. Every edit returns the cells' live output once they have run (value, rendered text, or error), plus any other cells that are now failing, so check results and fix errors before moving on. Use read_notebook to see the current cells (the user may have edited them too: re-read before editing cells you didn't just write) and evaluate to inspect values without adding cells.

Cells are Observable JavaScript: \`name = expression\`, \`name = { ...; return value; }\` blocks, \`viewof x = Inputs.range([0, 10])\`, \`mutable x = 0\`, generators (yield), \`import {chart} from "@d3/bar-chart"\` from observablehq.com, \`md\\\`...\\\`\` and \`html\\\`...\\\`\` for text and markup. Cells react to each other by name in any order; each named cell is defined once. Plain JavaScript cells also work (several statements, \`const\` declarations shared with other cells, \`import {x} from "npm:pkg"\`, \`display(value)\`). Built-ins include d3, Plot, Inputs, htl, _ (lodash), md, html, svg, tex, dot, mermaid, DuckDBClient, FileAttachment, width, now, invalidation, Generators, require. Prefer Plot for charts and Inputs for controls, and use \`width\` for responsive sizes.`;

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

const NO_TAB = 'No browser tab is showing this notebook, so its cells have not run here. Call open_notebook to open it and see live outputs.';

export const createMcpServer = ({ live, urlFor, openBrowser, listNotebooks, version = '1.0.0' }) => {
  const server = new McpServer({ name: 'iridium', version }, { instructions: INSTRUCTIONS });

  const wait = z.number().int().min(0).max(60000).optional()
    .describe('How long to wait for the cells to finish running, in ms (default 8000).');
  const notebookArg = z.string().describe('Notebook name (letters, digits and "-"), e.g. "sales-dashboard".');

  const requireNotebook = (raw) => {
    const name = notebookName(raw);
    if (!live.exists(name)) throw new Error(`No notebook named "${name}". Use list_notebooks or create_notebook.`);
    return name;
  };

  // Opens the notebook in the browser unless a tab already shows it, and waits
  // briefly for that tab to connect.
  const ensureTab = async (name, open) => {
    if (live.clients(name) || !open) return live.clients(name) > 0;
    openBrowser(urlFor(name));
    for (let i = 0; i < 60 && !live.clients(name); i++) await new Promise((r) => setTimeout(r, 250));
    return live.clients(name) > 0;
  };

  // The live state of `ids` after an edit, and any other failing cells.
  const outcome = async (name, ids, waitMs, extra = {}) => {
    const result = { notebook: name, url: urlFor(name), ...extra };
    // Wait for the edited cells only; then a snapshot of the rest.
    const edited = ids?.length ? await live.describe(name, ids, waitMs ?? 8000) : null;
    const cells = await live.describe(name, undefined, edited ? 0 : (waitMs ?? 8000));
    if (!cells) return { ...result, note: NO_TAB };
    result.cells = ids ? (edited ?? []).filter((cell) => ids.includes(cell.id)) : cells;
    const failing = cells.filter((cell) => !ids?.includes(cell.id) && ['error', 'rejected'].includes(cell.status));
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

  // Where a new cell goes: after/before a cell id, at an index, or at the end.
  const insertIndex = (name, { after, before, index }) => {
    const cells = live.cells(name);
    const position = (id) => {
      const i = cells.findIndex((cell) => cell.id === id);
      if (i < 0) throw new Error(`No cell with id ${id}`);
      return i;
    };
    if (after !== undefined) return position(after) + 1;
    if (before !== undefined) return position(before);
    return index ?? cells.length;
  };
  const placement = {
    after: z.number().int().optional().describe('Insert after the cell with this id.'),
    before: z.number().int().optional().describe('Insert before the cell with this id.'),
    index: z.number().int().min(0).optional().describe('Insert at this position (0 = top). Default: the end.'),
  };
  const cellSpec = z.object({
    source: z.string().describe('The cell code.'),
    pinned: z.boolean().optional().describe('Show the code editor (default true). Unpin prose and finished outputs.'),
  });

  tool('list_notebooks', 'List the Iridium notebooks, with their URLs and how many browser tabs show each.', {}, async () =>
    listNotebooks().map((name) => ({ name, title: live.get(name).meta.title, url: urlFor(name), open_tabs: live.clients(name) })),
  );

  tool(
    'create_notebook',
    'Create a new notebook, optionally with initial cells, and open it in the user\'s browser so they can watch it being built. Returns the cells\' ids and live outputs.',
    {
      name: notebookArg,
      title: z.string().optional().describe('Display title (default: the name).'),
      cells: z.array(cellSpec).optional().describe('Initial cells, top to bottom.'),
      open: z.boolean().optional().describe('Open it in the browser (default true).'),
      wait_ms: wait,
    },
    async ({ name: raw, title, cells = [], open = true, wait_ms }) => {
      const name = notebookName(raw);
      if (live.exists(name)) throw new Error(`A notebook named "${name}" already exists. Use open_notebook, or choose another name.`);
      live.create(name, title);
      const ids = cells.map(({ source, pinned = true }) => {
        const id = live.nextId(name);
        live.apply(name, { type: 'insert', cell: { id, sourceCode: source, pin: pinned } });
        return id;
      });
      await ensureTab(name, open);
      return outcome(name, ids.length ? ids : undefined, wait_ms, { created: true, ids });
    },
  );

  tool(
    'open_notebook',
    'Open an existing notebook in the user\'s browser (unless a tab already shows it) and return its cells with live outputs.',
    { name: notebookArg, open: z.boolean().optional().describe('Open a browser tab if none shows it (default true).'), wait_ms: wait },
    async ({ name: raw, open = true, wait_ms }) => {
      const name = requireNotebook(raw);
      await ensureTab(name, open);
      return outcome(name, undefined, wait_ms);
    },
  );

  tool(
    'read_notebook',
    'Read a notebook\'s cells (id, source, pinned) with each cell\'s live status and output (value, rendered text, error, exports). Re-read before editing: the user may have changed cells.',
    { notebook: notebookArg, wait_ms: wait },
    async ({ notebook, wait_ms }) => {
      const name = requireNotebook(notebook);
      const cells = await live.describe(name, undefined, wait_ms ?? 3000);
      if (!cells) return { notebook: name, url: urlFor(name), note: NO_TAB, cells: live.cells(name).map(({ id, pin, sourceCode }) => ({ id, pinned: pin, source: sourceCode })) };
      return { notebook: name, url: urlFor(name), cells };
    },
  );

  tool(
    'add_cell',
    'Add a cell (at the end, or after/before a cell, or at an index). Returns its id and live output once it has run.',
    { notebook: notebookArg, source: z.string().describe('The cell code.'), pinned: z.boolean().optional().describe('Show the code editor (default true).'), ...placement, wait_ms: wait },
    async ({ notebook, source, pinned = true, wait_ms, ...where }) => {
      const name = requireNotebook(notebook);
      const id = live.nextId(name);
      live.apply(name, { type: 'insert', cell: { id, sourceCode: source, pin: pinned }, index: insertIndex(name, where) });
      return outcome(name, [id], wait_ms, { id });
    },
  );

  tool(
    'add_cells',
    'Add several cells in order (at the end, or after/before a cell, or at an index). Returns their ids and live outputs.',
    { notebook: notebookArg, cells: z.array(cellSpec).min(1), ...placement, wait_ms: wait },
    async ({ notebook, cells, wait_ms, ...where }) => {
      const name = requireNotebook(notebook);
      let index = insertIndex(name, where);
      const ids = cells.map(({ source, pinned = true }) => {
        const id = live.nextId(name);
        live.apply(name, { type: 'insert', cell: { id, sourceCode: source, pin: pinned }, index: index++ });
        return id;
      });
      return outcome(name, ids, wait_ms, { ids });
    },
  );

  tool(
    'edit_cell',
    'Replace a cell\'s code and/or pin it. Cells that depend on it re-run. Returns its live output and any cells now failing.',
    { notebook: notebookArg, id: z.number().int(), source: z.string().optional(), pinned: z.boolean().optional(), wait_ms: wait },
    async ({ notebook, id, source, pinned, wait_ms }) => {
      const name = requireNotebook(notebook);
      live.apply(name, { type: 'update', id, sourceCode: source, pin: pinned });
      return outcome(name, [id], wait_ms);
    },
  );

  tool('delete_cell', 'Delete a cell. Returns any cells now failing (e.g. ones that used its value).', { notebook: notebookArg, id: z.number().int(), wait_ms: wait }, async ({ notebook, id, wait_ms }) => {
    const name = requireNotebook(notebook);
    live.apply(name, { type: 'remove', id });
    return outcome(name, [], wait_ms, { deleted: id });
  });

  tool(
    'move_cell',
    'Move a cell (after/before another cell, or to an index). Order only affects layout: cells react by name.',
    { notebook: notebookArg, id: z.number().int(), ...placement },
    async ({ notebook, id, ...where }) => {
      const name = requireNotebook(notebook);
      const cells = live.cells(name);
      let index = insertIndex(name, where);
      if (cells.findIndex((cell) => cell.id === id) < index) index--; // removed before reinserting
      live.apply(name, { type: 'move', id, index });
      return { notebook: name, order: live.cells(name).map((cell) => cell.id) };
    },
  );

  tool('run_cell', 'Run a cell again without changing it (e.g. to refetch data or replay an animation).', { notebook: notebookArg, id: z.number().int(), wait_ms: wait }, async ({ notebook, id, wait_ms }) => {
    const name = requireNotebook(notebook);
    live.apply(name, { type: 'run', id });
    return outcome(name, [id], wait_ms);
  });

  tool(
    'evaluate',
    'Evaluate an expression (or cell code) against the notebook\'s live values without adding a cell, e.g. "data.length" or "Object.keys(data[0])". Needs an open tab.',
    { notebook: notebookArg, expression: z.string(), timeout_ms: z.number().int().min(100).max(60000).optional() },
    async ({ notebook, expression, timeout_ms = 10000 }) => {
      const name = requireNotebook(notebook);
      const result = await live.request(name, 'evaluate', { source: expression, timeout: timeout_ms }, timeout_ms + 5000);
      return result ?? { note: NO_TAB };
    },
  );

  return server;
};
