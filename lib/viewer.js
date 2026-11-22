// The editor page: Iridium, wired to this server's /read and /save.
const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

export const viewerPage = ({ name, iridiumBase, filesBase, head }) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- FileAttachment("x") resolves against the base URL: the notebook's files folder. -->
    <base href="${filesBase}" />
    <link rel="icon" href="data:," />
    <title>${name.replace(/[<&]/g, '')} · Iridium</title>
    <script type="module" src="${iridiumBase}/iridium.js"></script>
    ${head}
  </head>
  <body data-hint-view-only="IridiumViewOnly">
    <style>
      html { font-family: Verdana, Geneva, Tahoma, sans-serif; } /* as Iridium's own page */
      #iridium-live { position: fixed; top: 8px; right: 12px; font: 11px/1 system-ui, sans-serif; color: #888; z-index: 10; }
      #iridium-live::before { content: '●'; margin-right: 4px; color: #bbb; }
      #iridium-live[data-state='live']::before { color: #2ca02c; }
      #iridium-live[data-state='live']::after { content: 'live'; }
      #iridium-live[data-state='offline']::after { content: 'offline'; }
    </style>
    <div id="iridium-live" data-state="connecting" title="Edits from other tabs and assistants appear here live"></div>
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
      Iridium.save = (_, cells) => post('/save', { path: name, content: cells });

      // Live collaboration: the server sends edits made elsewhere (another
      // tab, or an assistant using the MCP server) and asks this tab for live
      // cell outputs; edits made here go back to the server.
      Iridium.ready = (main, controller) => {
        window.IridiumMain = main;
        window.IridiumController = controller;
        const status = document.getElementById('iridium-live');
        let socket;
        const send = (message) => socket?.readyState === 1 && socket.send(JSON.stringify(message));
        controller.subscribe((cells) => send({ type: 'cells', cells }));
        const apply = (op) => {
          if (op.type === 'insert') controller.insert(op.cell, op.index);
          else if (op.type === 'update') controller.update(op.id, op);
          else if (op.type === 'remove') controller.remove(op.id);
          else if (op.type === 'move') controller.move(op.id, op.index);
          else if (op.type === 'run') controller.run(op.id);
          else if (op.type === 'replace') controller.replace(op.cells);
        };
        let applied = 0; // the last change from the server applied here
        const methods = {
          describe: ({ ids }) => ({ applied, cells: controller.describe(ids) }),
          evaluate: ({ source, timeout }) => controller.evaluate(source, { timeout }),
        };
        const connect = () => {
          socket = new WebSocket(\`\${location.protocol === 'https:' ? 'wss' : 'ws'}://\${location.host}/__live__/\${encodeURIComponent(name)}\`);
          socket.onopen = () => status.dataset.state = 'live';
          socket.onclose = () => {
            status.dataset.state = 'offline';
            setTimeout(connect, 1000);
          };
          socket.onmessage = async ({ data }) => {
            const message = JSON.parse(data);
            if (message.type === 'op') {
              try {
                apply(message.op);
              } catch (error) {
                console.warn('Live edit failed', error);
              }
              if (message.seq) applied = Math.max(applied, message.seq);
            } else if (message.type === 'ack') {
              applied = Math.max(applied, message.seq);
            } else if (message.type === 'request') {
              try {
                const result = await methods[message.method](message.params ?? {});
                send({ type: 'response', id: message.id, result });
              } catch (error) {
                send({ type: 'response', id: message.id, error: String(error?.message ?? error) });
              }
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
