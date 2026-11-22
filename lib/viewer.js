// The editor page: Iridium, wired to this server's /read and /save.
const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

export const viewerPage = ({ name, iridiumBase, filesBase, head }) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- FileAttachment("x") resolves against the base URL: the notebook's files folder. -->
    <base href="${filesBase}" />
    <!-- The tab's connection to the server: macOS-style green dot when connected, grey otherwise. -->
    <link rel="icon" id="iridium-status" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6.5' fill='%23c8c8c8' stroke='%23a6a6a6'/%3E%3C/svg%3E" />
    <title>${name.replace(/[<&]/g, '')} · Iridium</title>
    <script type="module" src="${iridiumBase}/iridium.js"></script>
    ${head}
  </head>
  <body data-hint-view-only="IridiumViewOnly">
    <style>
      html { font-family: Verdana, Geneva, Tahoma, sans-serif; } /* as Iridium's own page */
    </style>
    <div id="iridium-root-wrapper">
      <div id="iridium-root"></div>
    </div>
    <!-- type="module": runs after iridium.js (also a module), in document order. -->
    <script type="module">
      const name = ${json(name)};
      const post = async (url, body) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(\`\${url}: \${response.status} \${await response.text()}\`);
        return response.json();
      };

      // This page edits one notebook, named by the URL.
      Iridium.get_recent = () => name;
      Iridium.set_recent = () => {};
      Iridium.list = () => post('/list', {});
      Iridium.load = () => post('/read', { path: name });

      // Assistants work on this tab through the server, a relay: it sends
      // commands (add, edit, run or delete cells, save, read outputs,
      // evaluate) and this tab carries them out on its own notebook, as if
      // the user had. Nothing else is synced, and the file is only written by
      // this tab's Save.
      let lastSave = null;
      Iridium.save = (_, cells) => (lastSave = post('/save', { path: name, content: cells }));

      Iridium.ready = (main, controller) => {
        window.IridiumMain = main;
        window.IridiumController = controller;
        // Favicon dot: green (as macOS's traffic light) while connected, so
        // assistants can work on this tab; grey while offline.
        const dot = (fill, stroke) =>
          'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="' + fill + '" stroke="' + stroke + '"/></svg>');
        const icon = document.getElementById('iridium-status');
        const setStatus = (connected) => (icon.href = connected ? dot('#28c840', '#1aab29') : dot('#c8c8c8', '#a6a6a6'));
        let socket;
        const send = (message) => socket?.readyState === 1 && socket.send(JSON.stringify(message));
        const unsaved = () => !!document.querySelector('.IridiumNotebookUnsaved');
        // Where a new or moved cell goes: after/before a cell, at an index, or the end.
        const position = ({ after, before, index }, cells = controller.cells()) => {
          const at = (id) => {
            const i = cells.findIndex((cell) => cell.id === id);
            if (i < 0) throw new Error(\`No cell with id \${id}\`);
            return i;
          };
          if (after !== undefined) return at(after) + 1;
          if (before !== undefined) return at(before);
          return index ?? cells.length;
        };
        const methods = {
          cells: () => ({ cells: controller.cells(), unsaved: unsaved() }),
          describe: ({ ids }) => ({ cells: controller.describe(ids), unsaved: unsaved() }),
          insert: ({ cells, ...where }) => {
            let index = position(where);
            return { ids: cells.map(({ source, pinned = true }) => controller.insert({ sourceCode: source, pin: pinned }, index++)) };
          },
          update: ({ id, sourceCode, pin }) => (controller.update(id, { sourceCode, pin }), {}),
          run: ({ id }) => (controller.run(id), {}),
          remove: ({ id }) => (controller.remove(id), {}),
          move: ({ id, ...where }) => {
            const rest = controller.cells().filter((cell) => cell.id !== id);
            controller.move(id, position(where, rest));
            return { order: controller.cells().map((cell) => cell.id) };
          },
          // Saves exactly as Cmd+S in this tab does.
          save: async () => {
            lastSave = null;
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, ctrlKey: true, bubbles: true }));
            if (!lastSave) throw new Error('The tab did not save.');
            await lastSave;
            await new Promise((resolve) => setTimeout(resolve, 50)); // let the saved state render
            return { saved: true, unsaved: unsaved() };
          },
          evaluate: ({ source, timeout }) => controller.evaluate(source, { timeout }),
        };
        const active = () => document.visibilityState === 'visible' && send({ type: 'active' });
        addEventListener('focus', active);
        document.addEventListener('visibilitychange', active);
        const connect = () => {
          socket = new WebSocket(\`\${location.protocol === 'https:' ? 'wss' : 'ws'}://\${location.host}/__live__/\${encodeURIComponent(name)}\`);
          socket.onopen = () => {
            setStatus(true);
            active();
          };
          socket.onclose = () => {
            setStatus(false);
            setTimeout(connect, 1000);
          };
          socket.onmessage = async ({ data }) => {
            const message = JSON.parse(data);
            if (message.type !== 'request') return;
            try {
              const result = await methods[message.method](message.params ?? {});
              send({ type: 'response', id: message.id, result });
            } catch (error) {
              send({ type: 'response', id: message.id, error: String(error?.message ?? error) });
            }
          };
        };
        connect();
      };

      Iridium.render(
        Iridium.html\`<\${Iridium.IridiumApp} Ir=\${Iridium} />\`,
        document.getElementById('iridium-root'),
      );
    </script>
  </body>
</html>`;
