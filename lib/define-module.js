// Compiles a notebook into an ES module with the classic Observable contract:
//
//   import define from "./notebook.js";
//   new Runtime(new Library()).module(define, Inspector.into(element));
//
// Cells are compiled by Notebook Kit (through Iridium's compileCell, the same
// compiler the editor uses); this file only turns each compiled cell into
// runtime variables, with the names classic modules use ("viewof x",
// "mutable x"), so embeds that observe or redefine cells by name keep working.
// Needs @observablehq/runtime 5.9+ (for `@variable`, used by notebook imports).
import { compileCell } from '@a10k/iridium/src/compile.js';

// Kit names special variables viewof$x / mutable$x; classic modules use spaces.
const classicName = (name) =>
  name.replace(/^viewof\$/, 'viewof ').replace(/^mutable\$/, 'mutable ');

const str = JSON.stringify;

// Gists are served as text/plain, which browsers won't import() directly.
const GIST_IMPORT = /\bimport\(("https:\/\/gist\.githubusercontent\.com\/[^"]*")\)/g;

const HELPERS = `const importGist = (url) =>
  fetch(url)
    .then((response) => response.text())
    .then((js) => import(URL.createObjectURL(new Blob([js], { type: "text/javascript" }))));

// display(value) and view(input) for plain JavaScript cells: the n-th display
// call of a run goes to the cell's n-th observer.
const cellDisplay = (observer) => {
  const observers = [];
  let index = 0;
  const display = (value) => {
    (observers[index++] ??= observer() ?? {}).fulfilled?.(value);
    return value;
  };
  return {
    start: () => void (index = 0),
    display,
    view: (Generators) => (input) => Generators.input(display(input)),
  };
};`;

const defineCell = (record, index) => {
  if (record.error) {
    return `  main.variable(observer()).define([], () => { throw new SyntaxError(${str(record.error)}); });`;
  }

  const inputs = record.inputs ?? [];
  let body = `(${record.body.replace(GIST_IMPORT, 'importGist($1)')})`;
  let runtimeInputs = inputs.map(classicName);
  const lines = [];

  // Plain JavaScript cells may call display()/view(): give them the shim. In
  // Observable JavaScript those are ordinary names (e.g. an imported view).
  const usesDisplay = record.mode === 'js' && (inputs.includes('display') || inputs.includes('view'));
  if (usesDisplay) {
    const shim = `display${index}`;
    lines.push(`  const ${shim} = cellDisplay(observer);`);
    runtimeInputs = inputs.filter((i) => i !== 'display' && i !== 'view').map(classicName);
    if (inputs.includes('view')) runtimeInputs.push('Generators');
    const params = runtimeInputs.map((_, i) => `$${i}`);
    const generators = `$${runtimeInputs.indexOf('Generators')}`;
    let next = 0;
    const args = inputs.map((input) =>
      input === 'display' ? `${shim}.display` : input === 'view' ? `${shim}.view(${generators})` : `$${next++}`,
    );
    body = `function (${params}) {\n    ${shim}.start();\n    return ${body}.call(this, ${args});\n  }`;
  }

  const define = (observed, name, ins, fn) =>
    `  main.${observed ? `variable(${observed}).define(` : 'define('}${name ? `${str(name)}, ` : ''}${str(ins)}, ${fn});`;

  if (record.automutable) {
    const name = record.output.replace(/^initial /, '');
    lines.push(
      define(null, `initial ${name}`, runtimeInputs, body),
      define(`observer(${str(`mutable ${name}`)})`, `mutable ${name}`, ['Mutable', `initial ${name}`], '(M, _) => new M(_)'),
      define(`observer(${str(name)})`, name, [`mutable ${name}`], '(_) => _.generator'),
    );
  } else if (record.autoview) {
    const view = classicName(record.output);
    const name = view.replace(/^viewof /, '');
    lines.push(
      define(`observer(${str(view)})`, view, runtimeInputs, body),
      define(`observer(${str(name)})`, name, ['Generators', view], '(G, _) => G.input(_)'),
    );
  } else if (record.output) {
    lines.push(define(`observer(${str(record.output)})`, record.output, runtimeInputs, body));
  } else if (record.outputs?.length) {
    // Several outputs (a plain JavaScript cell's declarations, or a notebook
    // import): one variable returns them all, one variable per name picks one.
    const cell = `cell ${index}`;
    const isImport = inputs.includes('@variable');
    lines.push(define(isImport ? null : 'true', cell, runtimeInputs, body));
    for (const output of record.outputs) {
      lines.push(
        isImport
          ? define(null, output, [cell], `(_) => _[${str(output)}]`)
          : define(`observer(${str(output)})`, output, [cell], `(_) => _[${str(output)}]`),
      );
    }
  } else {
    lines.push(define(record.autodisplay ? 'observer()' : 'true', null, runtimeInputs, body));
  }
  return lines.join('\n');
};

// File attachments ship in a folder next to the module; FileAttachment(name)
// resolves to them, as in modules published by Observable.
const fileAttachments = ({ folder, names = [] } = {}) =>
  names.length
    ? `  const fileAttachments = new Map(${str(names)}.map((name) => [name, { url: new URL(\`./${folder}/\${encodeURIComponent(name)}\`, import.meta.url), mimeType: null }]));
  main.builtin("FileAttachment", runtime.fileAttachments((name) => fileAttachments.get(name)));\n`
    : '';

export const compileModule = (cells, { name, files } = {}) => {
  const definitions = cells
    .filter((cell) => !cell.mode || ['ojs', 'js', 'md', 'html', 'tex', 'dot'].includes(cell.mode))
    .map((cell, index) => defineCell(compileCell(String(cell.sourceCode ?? '')), index + 1));
  return `// Compiled by iridium-dev-server${name ? ` from ${name}` : ''}. Do not edit.
${HELPERS}

export default function define(runtime, observer) {
  const main = runtime.module();
${fileAttachments(files)}${definitions.join('\n')}
  return main;
}
`;
};
