// The editor page: Iridium, wired to this server's /read and /save.
const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

export const viewerPage = ({ name, iridiumBase, filesBase, head }) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
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
      // FileAttachment("x") is in the notebook's files folder. No <base>, so
      // other relative URLs (fetch, img, head links) resolve against the
      // server root, next to the notebooks.
      Iridium.files_base = ${json(filesBase)};
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

      // Screenshots of cells, for assistants: Chrome's own tab capture
      // (getDisplayMedia on this tab), cropped to each cell. Chrome only starts
      // a capture from a click, so the first request shows a bar asking the
      // user to allow it; the capture then stays on until they stop sharing.
      let captureTrack = null;
      let asking = null;
      const askToCapture = () => asking ??= new Promise((resolve, reject) => {
        const bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:1000;display:flex;gap:8px;align-items:center;padding:8px 10px 8px 14px;border-radius:12px;background:#fff;box-shadow:0 0 0 .5px rgba(0,0,0,.12),0 6px 24px rgba(0,0,0,.18);font:13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#1d1d1f';
        bar.innerHTML = '<span>Claude wants to see cells of this notebook.</span>'
          + '<button data-allow style="font:inherit;padding:4px 12px;border:0;border-radius:8px;background:#0071e3;color:#fff;cursor:pointer">Allow tab capture</button>'
          + '<button data-deny style="font:inherit;padding:4px 10px;border:0;border-radius:8px;background:rgba(0,0,0,.06);cursor:pointer">Not now</button>';
        document.body.append(bar);
        const finish = (fn, value) => (bar.remove(), asking = null, fn(value));
        bar.querySelector('[data-allow]').onclick = async () => {
          try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
              video: { displaySurface: 'browser' }, audio: false,
              preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude',
            });
            const [track] = stream.getVideoTracks();
            track.addEventListener('ended', () => { if (captureTrack === track) captureTrack = null; });
            finish(resolve, track);
          } catch (error) {
            finish(reject, new Error('Tab capture was not allowed (' + error.message + ').'));
          }
        };
        bar.querySelector('[data-deny]').onclick = () => finish(reject, new Error('The user declined tab capture.'));
      });
      const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))));
      // Captures element el, scrolling it through the window in slices when it
      // is taller than the window; scale = output pixels per CSS pixel.
      const captureElement = async (track, el, scale) => {
        const box = el.getBoundingClientRect();
        const top = box.top + scrollY, width = box.width, height = Math.min(box.height, 6000);
        const start = [scrollX, scrollY];
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const context = canvas.getContext('2d');
        try {
          for (let y = 0; y < height;) {
            scrollTo(start[0], top + y);
            await settle();
            const frame = await new ImageCapture(track).grabFrame();
            const ratio = frame.width / innerWidth; // frame pixels per CSS pixel
            const offset = top + y - scrollY; // where this slice starts in the window
            const left = el.getBoundingClientRect().left;
            const slice = Math.min(height - y, innerHeight - offset);
            if (slice <= 0) break;
            context.drawImage(frame, left * ratio, offset * ratio, width * ratio, slice * ratio, 0, y * scale, width * scale, slice * scale);
            frame.close();
            y += slice;
          }
        } finally {
          scrollTo(...start);
        }
        return { width: Math.round(width), height: Math.round(height), png: canvas.toDataURL('image/png').split(',')[1] };
      };

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
          // PNGs of cells' outputs (or whole cells with includeCode), as shown here.
          screenshot: async ({ ids, includeCode = false, scale = 1 }) => {
            if (!navigator.mediaDevices?.getDisplayMedia || typeof ImageCapture === 'undefined') throw new Error('This browser has no tab capture; use Chrome.');
            if (!captureTrack || captureTrack.readyState !== 'live') captureTrack = await askToCapture();
            const order = controller.cells().map((cell) => cell.id);
            const elements = [...document.querySelectorAll('.IridiumNotebook > .IridiumCell')];
            const shots = [];
            for (const id of ids) {
              const cell = elements[order.indexOf(id)];
              if (!cell) { shots.push({ id, error: 'No cell with id ' + id }); continue; }
              const error = cell.querySelector('.CellError');
              const target = includeCode ? cell : error && error.style.display !== 'none' ? error : cell.querySelector('.CellResults');
              if (!target.getBoundingClientRect().height) { shots.push({ id, error: 'The cell has no visible output.' }); continue; }
              shots.push({ id, ...(await captureElement(captureTrack, target, scale)) });
            }
            return { shots };
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
