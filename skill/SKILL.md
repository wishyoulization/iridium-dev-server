---
name: iridium-notebooks
description: Build, edit and explore live Iridium notebooks (reactive Observable notebooks) together with the user, through the iridium MCP server. Use whenever the user asks for an Iridium notebook, an Observable notebook, an interactive notebook, or a chart, dashboard, prototype or data exploration they want to watch being built and edit themselves.
---

# Iridium notebooks

Iridium notebooks run in the user's browser and update live: every cell you add or edit through the `iridium` MCP tools appears in the user's tab as you make it, and every edit the user makes there is visible to you. Cells are reactive: when a cell changes, every cell that uses its value re-runs.

If the `iridium` tools (`create_notebook`, `add_cell`, …) aren't available, tell the user the iridium MCP server isn't connected (`claude mcp list`) instead of writing notebook files by hand.

## Workflow

1. **Start**: `create_notebook` with a short kebab-case `name`, a `title`, and the first cells (a `md` heading and intro, then the data). It opens the notebook in the user's browser. For an existing notebook use `list_notebooks` and `open_notebook`.
   - In an app with a built-in browser (e.g. the Claude desktop app), pass `open: false` and open the returned `url` in that browser so the notebook sits next to the chat.
2. **Build incrementally**: `add_cell` / `add_cells`, a few cells at a time, small and focused: load data, shape it, chart it, add controls. Each call returns the cells' live output once they have run.
3. **Check every result**: read `status`, `value`, `text` and `error`, and `other_failing_cells`. Fix errors before moving on; never leave the notebook broken. Use `evaluate` to inspect values (`data.length`, `Object.keys(data[0])`, `data.slice(0, 3)`) without adding cells.
4. **Edit, don't append duplicates**: change a cell with `edit_cell` (by its `id`); remove one with `delete_cell`. A name may be defined by only one cell.
5. **Finish**: unpin cells whose code the reader needn't see (`edit_cell` with `pinned: false`, e.g. prose and finished charts), and tell the user what the notebook does and how to use it.

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

**Plain JavaScript cells** also work (as in Observable Notebooks 2.0): several statements, top-level `const`/`let`/`function` shared with other cells, `import {x} from "npm:package"`, and `display(value)` to show output.

```js
import {csvParse} from "npm:d3-dsv";
const rows = csvParse(await (await fetch(url)).text());
display(Inputs.table(rows));
```

**Built-ins**: `d3`, `Plot`, `Inputs` (range, select, radio, checkbox, text, table, search, button, toggle, date, color, file), `htl`, `_` (lodash), `md`, `html`, `svg`, `tex`, `dot`, `mermaid`, `DuckDBClient` (SQL: `db = DuckDBClient.of({sales: data})`, then `db.sql\`SELECT …\``), `FileAttachment`, `width`, `now`, `invalidation`, `Generators`, `Promises`, `DOM`, `require` (AMD libraries), sample datasets (`penguins`, `cars`, `aapl`, …). Other libraries: `import("npm:package")` / `import {x} from "npm:package"` in plain JavaScript cells, or `require("package@version")`.

## Good notebooks

- Lead with a `md` title and a sentence on what the notebook shows; explain each section briefly.
- Prefer Plot for charts and Inputs for controls; label axes and units; use `width` for chart widths.
- Load data once in its own cell; derive views in separate cells so they react to controls.
- Keep cells short and named descriptively.
- Files the notebook reads with `FileAttachment("name")` live in a folder named after the notebook next to its `.html` file in the notebooks folder.
