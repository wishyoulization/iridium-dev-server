// Live notebooks: the server's copy of each notebook's cells, shared with the
// editor tabs showing it (over WebSocket) and with tools such as the MCP
// server. Every change is saved to the notebook file and sent to every tab;
// edits made in a tab come back the same way. Cells run in the tabs, so live
// outputs are requested from a connected tab.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { notebookPath, readNotebook, readNotebookMeta, writeNotebook } from './notebooks.js';

// How long to wait for one tab before also asking the next.
const HEDGE_MS = 1500;

const plain = ({ id, pin, sourceCode, mode }) => ({
  id,
  pin: !!pin,
  sourceCode: sourceCode ?? '',
  ...(mode ? { mode } : {}),
});

export class LiveNotebooks {
  constructor(config, { compile } = {}) {
    this.config = config;
    this.compile = compile; // (name) => void: rebuild the compiled module
    this.notebooks = new Map(); // name → { cells, meta, clients: Set, timer }
    this.requests = new Map(); // request id → { resolve, reject, timer }
    this.nextRequest = 1;
  }

  // --- State --------------------------------------------------------------------

  get(name) {
    let notebook = this.notebooks.get(name);
    if (!notebook) {
      const path = notebookPath(this.config.notebooks, name);
      notebook = {
        cells: path ? readNotebook(path).map(plain) : [],
        meta: { title: name, ...readNotebookMeta(path) },
        clients: new Set(),
        timer: null,
        seq: 0, // numbers the changes sent to tabs; tabs report the last applied
      };
      this.notebooks.set(name, notebook);
    }
    return notebook;
  }

  exists(name) {
    return this.notebooks.has(name) || !!notebookPath(this.config.notebooks, name);
  }

  cells(name) {
    return this.get(name).cells.map(plain);
  }

  // Creates an empty notebook file (if there isn't one) and returns its state.
  create(name, title) {
    const notebook = this.get(name);
    if (title) notebook.meta.title = title;
    if (!existsSync(join(this.config.notebooks, `${name}.html`))) this.persist(name);
    return notebook;
  }

  persist(name) {
    const notebook = this.get(name);
    writeNotebook(join(this.config.notebooks, `${name}.html`), notebook.cells, notebook.meta);
    // Rebuilding the module is slower; batch rapid edits.
    clearTimeout(notebook.timer);
    notebook.timer = setTimeout(() => {
      try {
        this.compile?.(name);
      } catch (error) {
        console.error(`Error compiling ${name}:`, error.message);
      }
    }, 500);
  }

  nextId(name) {
    return Math.max(0, ...this.get(name).cells.map((cell) => cell.id)) + 1;
  }

  // Applies an edit, saves the notebook and tells every tab except `origin`.
  //   { type: 'insert', cell: { id, sourceCode, pin }, index }
  //   { type: 'update', id, sourceCode?, pin? }
  //   { type: 'remove', id } · { type: 'move', id, index } · { type: 'run', id }
  //   { type: 'replace', cells }
  apply(name, op, origin = null) {
    const notebook = this.get(name);
    const cells = notebook.cells;
    const find = (id) => {
      const index = cells.findIndex((cell) => cell.id === id);
      if (index < 0) throw new Error(`Notebook ${name} has no cell with id ${id}`);
      return index;
    };
    switch (op.type) {
      case 'insert': {
        const index = Math.max(0, Math.min(op.index ?? cells.length, cells.length));
        cells.splice(index, 0, plain(op.cell));
        op = { ...op, index };
        break;
      }
      case 'update': {
        const cell = cells[find(op.id)];
        if (op.sourceCode !== undefined) {
          cell.sourceCode = op.sourceCode;
          delete cell.mode; // edited: its type is detected again on save
        }
        if (op.pin !== undefined) cell.pin = !!op.pin;
        break;
      }
      case 'remove':
        cells.splice(find(op.id), 1);
        break;
      case 'move': {
        const [cell] = cells.splice(find(op.id), 1);
        cells.splice(Math.max(0, Math.min(op.index, cells.length)), 0, cell);
        break;
      }
      case 'run':
        find(op.id);
        break;
      case 'replace': {
        // Keep the original mode of cells whose source didn't change.
        const previous = new Map(cells.map((cell) => [cell.id, cell]));
        notebook.cells = op.cells.map((cell) => {
          const before = previous.get(cell.id);
          return plain(before?.sourceCode === cell.sourceCode ? { ...cell, mode: before.mode } : cell);
        });
        op = { type: 'replace', cells: notebook.cells.map(plain) };
        break;
      }
      default:
        throw new Error(`Unknown change: ${op.type}`);
    }
    if (op.type !== 'run') this.persist(name);
    const seq = ++notebook.seq;
    this.broadcast(name, { type: 'op', op, seq }, origin);
    // The tab that made the edit already has it: just confirm its number.
    if (origin) this.send(origin, { type: 'ack', seq });
    return seq;
  }

  // The number of the latest change, to wait for tabs to catch up to it.
  seq(name) {
    return this.get(name).seq;
  }

  // --- Tabs ---------------------------------------------------------------------

  connect(name, socket) {
    const notebook = this.get(name);
    notebook.clients.add(socket);
    socket.lastHeard = Date.now();
    // A (re)connecting tab may have missed changes: send the current cells.
    this.send(socket, { type: 'op', op: { type: 'replace', cells: this.cells(name) }, seq: notebook.seq });
    socket.on('message', (data) => {
      // A tab whose page is busy (a long computation) or suspended sends
      // nothing, so the last message is a good guide to which tab will answer.
      socket.lastHeard = Date.now();
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type === 'cells' && Array.isArray(message.cells)) {
        // Edited in the tab.
        this.apply(name, { type: 'replace', cells: message.cells }, socket);
      } else if (message.type === 'response' && this.requests.has(message.id)) {
        const request = this.requests.get(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result, socket);
      }
    });
    socket.on('close', () => notebook.clients.delete(socket));
  }

  clients(name) {
    return this.notebooks.get(name)?.clients.size ?? 0;
  }

  send(socket, message) {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }

  broadcast(name, message, except = null) {
    for (const socket of this.get(name).clients) if (socket !== except) this.send(socket, message);
  }

  // Asks a connected tab to run `method` (describe, evaluate) and resolves with
  // its result; null if no tab is showing the notebook. Any tab showing the
  // notebook will do, but one may be busy (a cell running a long computation)
  // or suspended, so a busy tab mustn't hold up the answer:
  // - describe is cheap and has no effects, so it goes to every tab in turn
  //   (see ask) and the first answer wins;
  // - evaluate runs the assistant's code, which may itself be slow, so it runs
  //   in one tab only: the first to answer a describe.
  async request(name, method, params = {}, timeout = 30000) {
    const sockets = [...this.get(name).clients].sort((a, b) => b.lastHeard - a.lastHeard);
    if (!sockets.length) return null;
    if (method === 'describe') return (await this.ask(sockets, method, params, timeout)).result;
    const { socket } = sockets.length > 1 ? await this.ask(sockets, 'describe', { ids: [] }, timeout) : { socket: sockets[0] };
    return (await this.ask([socket], method, params, timeout)).result;
  }

  // Sends a request to the first of `sockets` (the tab heard from most
  // recently), then to each next one HEDGE_MS later until one answers.
  // Resolves with { result, socket } from the first answer; later answers to
  // the same request are ignored.
  ask(sockets, method, params, timeout) {
    const id = this.nextRequest++;
    const message = { type: 'request', id, method, params };
    return new Promise((resolve, reject) => {
      const hedges = [];
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        hedges.forEach(clearTimeout);
        this.requests.delete(id);
        fn(value);
      };
      const timer = setTimeout(() => {
        const tabs = sockets.length === 1 ? 'The tab showing this notebook did not' : `None of the ${sockets.length} tabs showing this notebook`;
        settle(reject)(new Error(`${tabs} answer ${method} within ${timeout / 1000}s (a cell may be running a long computation)`));
      }, timeout);
      this.requests.set(id, {
        resolve: (result, socket) => settle(resolve)({ result, socket }),
        reject: settle(reject),
      });
      this.send(sockets[0], message);
      sockets.slice(1).forEach((socket, i) => hedges.push(setTimeout(() => this.send(socket, message), (i + 1) * HEDGE_MS)));
    });
  }

  // Live state of cells (all, or `ids`) once the tab has applied every change
  // so far, waiting up to `wait` ms for them to finish running. null if no tab
  // is showing the notebook.
  async describe(name, ids, wait = 8000) {
    const seq = this.seq(name);
    const end = Date.now() + wait;
    for (;;) {
      const result = await this.request(name, 'describe', { ids });
      if (!result) return null;
      const { applied = 0, cells } = result;
      // A cell the tab hasn't received yet counts as pending.
      const arrived = applied >= seq && (!ids || ids.every((id) => cells.some((cell) => cell.id === id)));
      const settled = arrived && cells.every((cell) => cell.status !== 'pending');
      if (settled || Date.now() >= end) return cells;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}
