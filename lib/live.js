// Relay between assistants (the MCP server) and the editor tabs showing a
// notebook. The server keeps no notebook state: each open tab is the live
// notebook, and tools act on it by sending the tab commands over WebSocket
// (add, edit, run or delete cells, save, describe outputs, evaluate). The tab
// does the work exactly as if the user had, and its file is read and written
// only by the tab's own load and Save.

export class Relay {
  constructor() {
    this.tabs = new Map(); // name → Set of sockets
    this.requests = new Map(); // request id → { resolve, reject, socket }
    this.nextRequest = 1;
  }

  connect(name, socket) {
    if (!this.tabs.has(name)) this.tabs.set(name, new Set());
    const tabs = this.tabs.get(name);
    tabs.add(socket);
    socket.lastActive = Date.now();
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type === 'active') {
        // The user is looking at this tab: send it the next commands.
        socket.lastActive = Date.now();
      } else if (message.type === 'response' && this.requests.has(message.id)) {
        const request = this.requests.get(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      }
    });
    socket.on('close', () => {
      tabs.delete(socket);
      if (!tabs.size) this.tabs.delete(name);
      for (const request of this.requests.values()) {
        if (request.socket === socket) request.reject(new Error('The tab closed before answering.'));
      }
    });
  }

  clients(name) {
    return this.tabs.get(name)?.size ?? 0;
  }

  // The tab to act on: the one the user was in most recently.
  tab(name) {
    const tabs = [...(this.tabs.get(name) ?? [])];
    return tabs.sort((a, b) => b.lastActive - a.lastActive)[0] ?? null;
  }

  // Sends `method` to the notebook's tab and resolves with its answer.
  request(name, method, params = {}, timeout = 30000) {
    const socket = this.tab(name);
    if (!socket) {
      return Promise.reject(new Error(`No browser tab is showing the notebook "${name}". Call open_notebook to open one.`));
    }
    const id = this.nextRequest++;
    return new Promise((resolve, reject) => {
      const done = (fn) => (value) => {
        clearTimeout(timer);
        this.requests.delete(id);
        fn(value);
      };
      const timer = setTimeout(
        () => done(reject)(new Error(`The tab did not answer ${method} within ${timeout / 1000}s (a cell may be running a long computation).`)),
        timeout,
      );
      this.requests.set(id, { resolve: done(resolve), reject: done(reject), socket });
      socket.send(JSON.stringify({ type: 'request', id, method, params }));
    });
  }

  // The tab's cells (all, or `ids`) once they have finished running, waiting
  // up to `wait` ms, and whether the tab has unsaved changes.
  async describe(name, ids, wait = 8000) {
    const end = Date.now() + wait;
    for (;;) {
      const result = await this.request(name, 'describe', { ids });
      if (result.cells.every((cell) => cell.status !== 'pending') || Date.now() >= end) return result;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}
