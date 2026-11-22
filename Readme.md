# Iridium Dev Server

Local dev server for working with Observable notebooks: edit them in [Iridium](https://github.com/wishyoulization/iridium), save them as files, and compile them to ES modules you can embed in any app.

Cells are compiled by Observable's own engine, [Notebook Kit](https://observablehq.com/notebook-kit/kit): classic Observable JavaScript (`viewof`, `mutable`, `import {x} from "@user/notebook"`, `require(…)`) and plain JavaScript cells (several statements, `const` declarations, `npm:` imports, `display(…)`), as in Observable Notebooks 2.0.

Requires Node.js 22 or later.

## Install

```bash
npm i @wishyoulization/iridium-dev-server
```

## Run the development server

```bash
npx @wishyoulization/iridium-dev-server
```

Open http://localhost:8080/ to edit the `index` notebook, or http://localhost:8080/my-notebook for any other. Running a cell (Shift+Enter) or saving (the save button or ⌘S) writes the notebook file and its compiled module.

## Notebook list API

`GET /api/notebooks?q=&page=1&per_page=25&sort=name|modified` returns the notebooks whose name or title contains `q` (any case), one page at a time:

```json
{ "q": "zdog", "sort": "name", "page": 1, "per_page": 25, "pages": 1, "total": 2,
  "items": [{ "name": "cubrt-with-zdog", "title": "Cubrt with Zdog", "url": "/cubrt-with-zdog", "modified": "2026-11-21T…Z", "cells": 12, "size": 5480 }] }
```

`DELETE /api/notebooks/<name>` moves a notebook and its attachments folder to the Trash (macOS's, restorable with Put Back; elsewhere a `.trash` folder in the notebooks folder) and removes its compiled module.

`per_page` is at most 200, out-of-range pages are clamped, and the `index` notebook (the home page at `/`) isn't listed. A home page notebook can render it with a search input and pager: fetch the JSON in a cell and draw the cards with `htl.html`.

## Live collaboration and AI assistants (MCP)

Every tab showing a notebook connects to the server (a green dot in its favicon, like the macOS traffic light; grey when offline), so an AI assistant can work on the notebook in that tab while you watch.

The server includes an [MCP](https://modelcontextprotocol.io) server, so assistants such as Claude can build and edit notebooks with you: they add and edit cells in the tab you're watching, and read each cell's live output (value, rendered text, errors) to check their work. Tools: `create_notebook`, `open_notebook`, `list_notebooks`, `read_notebook`, `add_cell`, `add_cells`, `edit_cell`, `delete_cell`, `move_cell`, `run_cell`, `evaluate`, `screenshot_cells`, `save_notebook`.

`screenshot_cells` returns PNGs of cells as your tab shows them. The tab captures itself with Chrome's tab capture (`getDisplayMedia` on the current tab), scrolling each cell into view and cropping to it. The first time, the tab asks you to allow it: click **Allow tab capture**, then share the tab. Capture stays on until you stop sharing in Chrome's bar.

Set it up once for Claude Code, then ask any new chat for "an Iridium notebook that…":

```bash
claude mcp add --scope user iridium -- npx @wishyoulization/iridium-dev-server mcp
mkdir -p ~/.claude/skills && cp -r node_modules/@wishyoulization/iridium-dev-server/skill ~/.claude/skills/iridium-notebooks
```

- `iridium-dev-server mcp` speaks MCP over stdio. It serves the current folder's notebooks if it has an `.iridiumrc`, otherwise `~/Documents/Iridium` (or `IRIDIUM_HOME`), created on first use with port 8090. If a dev server is already running there, it connects to it, so every chat reaches the same open tabs; otherwise it starts one.
- A running dev server also serves MCP over HTTP at `/mcp` (e.g. `claude mcp add --transport http iridium http://localhost:8080/mcp`).
- New notebooks open in your default browser, or in another one: assistants can pass `browser` (e.g. `"Google Chrome"`), and `IRIDIUM_BROWSER` sets it for every notebook. Set `IRIDIUM_OPEN_BROWSER=0` to disable opening (e.g. when the assistant shows them in its own browser).
- The assistant works on the notebook in your open tab, as you would: the server only relays its commands (add, edit, run or delete cells, read outputs, save) to the tab, and keeps no notebook state. Its edits are unsaved until you save, or ask it to save, which does what the tab's Save does. Assistants can address cells by the name they define, patch long cells with `edit_cell` `replace: [{old, new}]`, and list cells compactly with `read_notebook` `brief: true`.
- `skill/SKILL.md` teaches the assistant the workflow and how to write good cells; the MCP server also sends short instructions of its own.
- Cells run in your browser, so live outputs need a tab showing the notebook.

## Static build

`-build` (or `--build`) compiles every notebook to an ES module without starting the server:

```bash
npx @wishyoulization/iridium-dev-server -build
```

## Notebook files

Notebooks are saved in Notebook Kit's HTML format (`<name>.html`), the open format Observable Desktop edits:

```html
<!doctype html>
<notebook theme="air">
  <title>my-notebook</title>
  <script id="1" type="application/vnd.observable.javascript" pinned="">
    a = 21
  </script>
  <script id="2" type="module">
    const doubled = a * 2;
    display(doubled);
  </script>
</notebook>
```

- Classic Observable JavaScript cells are stored as `application/vnd.observable.javascript`, plain JavaScript cells as `module`. Pinned cells (editor visible) have `pinned`.
- Markdown, HTML, TeX and Graphviz cells from Observable Desktop open as the equivalent `md`/`html`/`tex`/`dot` template and are saved back in their own mode. Other modes (SQL, Python, …) can't run in Iridium but are kept unchanged.
- **Legacy `.ojs` notebooks** are still read. The first save writes `<name>.html` next to it; from then on the `.html` file is used. The `.ojs` file is left untouched, so delete it once you're happy with the conversion.

## Embedding compiled notebooks

Each notebook compiles to `<name>.js` exporting the classic `define(runtime, observer)`, with the usual variable names (`viewof x`, `mutable x`), so existing embeds keep working:

```js
import { Runtime } from "https://cdn.jsdelivr.net/npm/@observablehq/runtime@6/+esm";
import { Library, FileAttachments } from "https://cdn.jsdelivr.net/npm/@observablehq/stdlib@5/+esm";
import { Inspector } from "https://cdn.jsdelivr.net/npm/@observablehq/inspector@5/+esm";
import define from "./my-notebook.js";

const runtime = new Runtime(new Library());
runtime.fileAttachments = FileAttachments; // runtime 6 no longer includes it; imported notebooks may need it
runtime.module(define, Inspector.into(document.body));
```

- Works with `@observablehq/runtime` 5.9+ (runtime 5 includes the standard library and `fileAttachments`, so `new Runtime()` is enough) and 6 as above.
- Every named cell is passed to `observer(name)`, so you can pick cells to render by name.
- Plain JavaScript cells: each `display(…)` call in a run goes to its own observer; top-level declarations are named variables.
- Built-ins specific to Notebook Kit (such as the sample datasets like `penguins`) aren't in `@observablehq/stdlib`; provide them yourself if an embedded notebook uses them.

## Configuration

Save an `.iridiumrc` file (JSON) in the project root, or an `"iridiumrc"` field in `package.json`:

```json
{
  "notebooks": "./src",
  "compiled": "./dist",
  "static": "./public",
  "port": 8080,
  "host": "localhost",
  "local_editor": true,
  "head": "<style>body{font-family:'Trebuchet MS';}</style>"
}
```

| Option | Default | |
| --- | --- | --- |
| `notebooks` | `.` | Folder for notebook files (`.html`, legacy `.ojs`). |
| `compiled` | `.` | Folder for compiled modules (`.js`), served for embedding. |
| `static` | — | Extra folder of static assets to serve. |
| `port` | `8080` | |
| `host` | `localhost` | The server writes files, so it only listens locally. Use `0.0.0.0` to expose it on your network. |
| `local_editor` | `true` | Serve Iridium from the installed package (works offline). `false` loads it from jsDelivr at the same version. |
| `head` | `""` | Extra markup for the page `<head>` (fonts, scripts, styles). |

## Security

`/read`, `/save`, `/list`, `/api/notebooks`, `/mcp` and the live WebSocket (`/__live__/<name>`) only accept requests addressed to this machine (`localhost`) and, from a browser, from the server's own pages, so other websites can't read or change notebooks (CSRF, DNS rebinding). Notebook names are reduced to letters, digits and `-`, so files are only ever read or written inside the `notebooks` and `compiled` folders. Compiled modules and static files allow cross-origin `GET` for embedding.

## Scripts

Add to your project's `package.json` for convenience:

```json
"scripts": {
  "start": "iridium-dev-server",
  "build": "iridium-dev-server -build"
}
```
