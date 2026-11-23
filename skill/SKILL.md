---
name: iridium-notebooks
description: Build, edit and explore live Iridium notebooks (reactive Observable notebooks) together with the user, through the iridium MCP server. Use whenever the user asks for an Iridium notebook, an Observable notebook, an interactive notebook, or a chart, dashboard, prototype or data exploration they want to watch being built and edit themselves.
---

# Iridium notebooks

Iridium notebooks run in the user's browser and update live: every cell you add or edit through the `iridium` MCP tools appears in the user's tab as you make it, and every edit the user makes there is visible to you. Cells are reactive: when a cell changes, every cell that uses its value re-runs.

If the `iridium` tools (`create_notebook`, `add_cell`, …) aren't available, tell the user the iridium MCP server isn't connected (`claude mcp list`) instead of writing notebook files by hand.

## Workflow

1. **Start**: `create_notebook` with a short kebab-case `name`, a `title`, and the first cells (a `md` heading and intro, then the data). It opens the notebook in the user's default browser. For an existing notebook use `list_notebooks` and `open_notebook`.
   - If the user names a browser ("on my Chrome"), pass `browser` (e.g. `"Google Chrome"`, `"Safari"`, `"Firefox"`): no browser extension or shell command needed.
   - In an app with a built-in browser (e.g. the Claude desktop app), unless the user asked for another browser, pass `open: false` and open the returned `url` in that browser so the notebook sits next to the chat.
2. **Build incrementally**: `add_cell` / `add_cells`, a few cells at a time, small and focused: load data, shape it, chart it, add controls. Each call returns the cells' live output once they have run.
3. **Check every result**: read `status`, `value`, `text` and `error`, and `other_failing_cells`. Fix errors before moving on; never leave the notebook broken.
   - To check how a chart, layout or styling *looks*, call `screenshot_cells` (by `cells` names or `ids`). It returns PNGs of the cells exactly as the user's tab shows them. Use it instead of driving a browser or taking screen screenshots. The first call in a tab asks the user to allow tab capture (a bar in the tab, then Chrome's share dialog), so say so when you make it. Use `evaluate` to inspect values (`data.length`, `Object.keys(data[0])`, `data.slice(0, 3)`) without adding cells.
4. **Edit, don't append duplicates**: change a cell with `edit_cell`; remove one with `delete_cell`. Address cells by `id` or by the name they define (`cell: "data"`). A name may be defined by only one cell.
   - For a small change to a long cell, patch it: `edit_cell` with `replace: [{old, new}]` (each `old` must appear exactly once). Don't resend the whole cell to add a line.
5. **Finish**: unpin cells whose code the reader needn't see (`edit_cell` with `pinned: false`, e.g. prose and finished charts), and tell the user what the notebook does and how to use it.

## Saving

You work on the notebook in the user's open tab, exactly as they would. Your edits are unsaved until saved, like theirs: results report `unsaved_changes`, and the tab shows it.
- Call `save_notebook` (the tab's own Save) only when the user asks you to save.
- When you finish with unsaved changes, say so briefly.
- Every tool except `list_notebooks` and `create_notebook` needs the notebook open in a tab. If one isn't, call `open_notebook`.

## Working efficiently

- `read_notebook` with `brief: true` lists every cell in one line (id, name, status, first line of code). Use it to find cells; read full code only for the cells you'll change (`ids: [...]`).
- Edit results don't echo your code back. They return status, value and errors only.
- Notebooks that hold records the user adds to over time (a log, a tracker) work best with data in small data-only cells (e.g. one per week or month) and all calculations and views in separate cells. Then each update is one `replace` patch to one small cell.

## Collaborating

- The user may be editing at the same time. Call `read_notebook` before editing cells you didn't just write, and don't overwrite or delete their cells without asking.
- Say briefly what you are changing ("adding a chart of sales by month") so the user can follow along in the tab.
- Outputs exist only in the browser. If a tool says no tab is showing the notebook, call `open_notebook`.

## Writing cells

Cells are **Observable JavaScript** (classic Observable notebooks):

```js
md`# Sales explorer
Data from *Q3*, updated daily.`                 // Markdown (also html`…`, svg`…`, tex`…`)

data = FileAttachment("sales.csv").csv({typed: true})   // a named cell; promises resolve automatically
total = d3.sum(data, d => d.amount)

viewof region = Inputs.select(["All", ...new Set(data.map(d => d.region))], {label: "Region"})
filtered = region === "All" ? data : data.filter(d => d.region === region)

Plot.plot({                                      // a chart; `width` keeps it responsive
  width,
  marks: [Plot.barY(filtered, {x: "month", y: "amount", fill: "region"}), Plot.ruleY([0])]
})

summary = {                                       // a block: statements, then return
  const byRegion = d3.rollup(filtered, v => d3.sum(v, d => d.amount), d => d.region);
  return Array.from(byRegion, ([region, amount]) => ({region, amount}));
}

clock = { while (true) { yield new Date().toLocaleTimeString(); await Promises.delay(1000); } }  // generators update live
mutable count = 0                                 // set elsewhere with `mutable count++`
import {Legend} from "@d3/color-legend"           // reuse cells from notebooks on observablehq.com
```

Rules: one cell per name; cells can reference each other in any order; a cell is an expression, `name = expression`, or a `{ … return … }` block. Use `viewof name = Inputs.*(…)` for controls (the cell's value is the input's value). `this` is the cell's previous value.

**Plain JavaScript cells** also work (as in Observable Notebooks 2.0): several statements, top-level `const`/`let`/`function` shared with other cells, `import {x} from "npm:package"`, and `display(value)` to show output. These cells may also use TypeScript syntax (`const n: number = 1`, `interface P { x: number }`); types are stripped, not checked.

```js
import {csvParse} from "npm:d3-dsv";
const rows = csvParse(await (await fetch(url)).text());
display(Inputs.table(rows));
```

**Pick one mode per notebook and never mix them.** A notebook is either all Observable JavaScript (`name = expr`, `viewof`, `mutable`, `md\`…\``) or all plain JavaScript (`const`, `display()`, `npm:` imports). Before adding cells to an existing notebook, read it and match the mode its cells already use. Mixing modes breaks when the notebook is copied to observablehq.com: a cell created in the other mode fails (e.g. `SyntaxError: Assignment to external variable 'x'` when a `name = …` cell lands in plain-JavaScript mode), and on Observable each such cell's mode then has to be fixed by hand.

**Built-ins**: `d3`, `Plot`, `Inputs` (range, select, radio, checkbox, text, table, search, button, toggle, date, color, file), `htl`, `_` (lodash), `md`, `html`, `svg`, `tex`, `dot`, `mermaid`, `DuckDBClient` (SQL: `db = DuckDBClient.of({sales: data})`, then `db.sql\`SELECT …\``), `FileAttachment`, `width`, `now`, `invalidation`, `Generators`, `Promises`, `DOM`, `require` (AMD libraries), sample datasets (`penguins`, `cars`, `aapl`, …). Other libraries: `import("npm:package")` / `import {x} from "npm:package"` in plain JavaScript cells, or `require("package@version")`.

## Good notebooks

- Lead with a `md` title and a sentence on what the notebook shows; explain each section briefly.
- Prefer Plot for charts and Inputs for controls; label axes and units; use `width` for chart widths.
- Load data once in its own cell; derive views in separate cells so they react to controls.
- Keep cells short and named descriptively.
- Files the notebook reads with `FileAttachment("name")` live in a folder named after the notebook next to its `.html` file in the notebooks folder.
