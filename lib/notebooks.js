// Notebook files: Observable Notebook Kit's HTML format (`<name>.html`, the
// format Observable Desktop edits), with legacy `<name>.ojs` files read for
// compatibility and converted to .html on their next save.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { tokTypes as tt } from 'acorn';
import { CellParser } from '@observablehq/parser';
import { deserialize, serialize, toNotebook, transpile } from '@observablehq/notebook-kit';

const { window } = new JSDOM('');

// Notebook names come from URLs and request bodies: keep only the first path
// segment and letters/digits, so a name can never reach outside the folder.
export const notebookName = (raw) =>
  String(raw ?? '')
    .replace(/^\/+/, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-zA-Z0-9]/g, '-') || 'index';

export const listNotebooks = (dir) => [
  ...new Set(
    readdirSync(dir)
      .filter((file) => /\.(html|ojs)$/.test(file) && isNotebookFile(join(dir, file)))
      .map((file) => file.replace(/\.(html|ojs)$/, '')),
  ),
];

// An .html file in the notebooks folder is a notebook only if it has <notebook>.
const isNotebookFile = (path) =>
  path.endsWith('.ojs') || /<notebook[\s>]/.test(readFileSync(path, 'utf8'));

export const notebookPath = (dir, name) => {
  const html = join(dir, `${name}.html`);
  if (existsSync(html) && isNotebookFile(html)) return html;
  const ojs = join(dir, `${name}.ojs`);
  return existsSync(ojs) ? ojs : null;
};

// --- Cell types -------------------------------------------------------------

// Same rule as Iridium (src/compile.js): Observable JavaScript first, plain
// JavaScript if it is not valid Observable JavaScript, then TypeScript;
// npm:/jsr: imports are plain JavaScript. Cells that compile as none of these
// are kept as Observable JS.
const PACKAGE_IMPORT = /\bfrom\s*(["'])(npm|jsr):/;
export const cellMode = (source) => {
  const compiles = (mode) => {
    try {
      transpile({ id: 1, value: source, mode });
      return true;
    } catch {
      return false;
    }
  };
  if (PACKAGE_IMPORT.test(source) && compiles('js')) return 'js';
  if (compiles('ojs')) return 'ojs';
  if (compiles('js')) return 'js';
  if (compiles('ts')) return 'ts';
  return 'ojs';
};

// Template cells from Observable Desktop (Markdown, HTML, TeX, Graphviz) run
// in Iridium as the equivalent tagged template, and are saved back in their
// original mode while they keep that shape.
const TEMPLATE_TAGS = { md: 'md', html: 'html', tex: 'tex', dot: 'dot' };
const toTemplate = (tag, value) => `${tag}\`${value.replace(/`/g, '\\`')}\``;
const fromTemplate = (tag, source) => {
  const match = source.match(new RegExp(`^${tag}\`([\\s\\S]*)\`$`));
  return match && !/(^|[^\\])`/.test(match[1]) ? match[1].replace(/\\`/g, '`') : null;
};

// --- Reading ------------------------------------------------------------------

// Iridium's cell shape: { id, pin, sourceCode }, plus `mode` for cells that
// came from another Kit mode, so they can be saved back unchanged.
export const readNotebook = (path) =>
  path.endsWith('.ojs') ? readOjs(readFileSync(path, 'utf8')) : readHtml(readFileSync(path, 'utf8'));

export const readNotebookMeta = (path) => {
  if (!path?.endsWith('.html')) return {};
  const { title, theme, readOnly } = deserialize(readFileSync(path, 'utf8'), {
    parser: new window.DOMParser(),
  });
  return { title, theme, readOnly };
};

const readHtml = (html) =>
  deserialize(html, { parser: new window.DOMParser() }).cells.map(({ id, value, mode, pinned }) => {
    if (mode === 'ojs' || mode === 'js' || mode === 'ts') return { id, pin: pinned, sourceCode: value };
    const tag = TEMPLATE_TAGS[mode];
    // Other modes (SQL, Python, …) can't run in Iridium; keep them
    // as they are so saving doesn't lose them.
    return { id, pin: pinned, mode, sourceCode: tag ? toTemplate(tag, value) : value };
  });

// Legacy .ojs: Observable JavaScript cells separated by `;`, pinned cells
// marked with a leading /*PIN*/ comment. @observablehq/parser 6 dropped
// parseModule, so split the file with a CellParser that reads cells until EOF.
class ModuleParser extends CellParser {
  parseTopLevel(node) {
    node.cells = [];
    while (this.type !== tt.eof) node.cells.push(this.parseCell(this.startNode()));
    this.next();
    return this.finishNode(node, 'Program');
  }
}

const readOjs = (source) => {
  const ends = ModuleParser.parse(source).cells.map((cell) => cell.end);
  return ends.map((end, i) => {
    const text = source.slice(i ? ends[i - 1] : 0, end).replace(/^\n+/, '');
    return {
      id: i + 1,
      pin: text.startsWith('/*PIN*/'),
      sourceCode: text.replace(/^\/\*PIN\*\/\n*/, '').replace(/;$/, ''),
    };
  });
};

// --- Writing ------------------------------------------------------------------

const toKitCell = ({ id, pin, sourceCode, mode }, index) => {
  const value = String(sourceCode ?? '');
  const cell = { id: Number(id) > 0 ? Number(id) : index + 1, pinned: !!pin };
  const tag = TEMPLATE_TAGS[mode];
  if (tag) {
    const inner = fromTemplate(tag, value);
    if (inner != null) return { ...cell, mode, value: inner };
  } else if (mode && mode !== 'ojs' && mode !== 'js' && mode !== 'ts') {
    return { ...cell, mode, value }; // unsupported mode: saved back unchanged
  }
  return { ...cell, mode: cellMode(value), value };
};

export const writeNotebook = (path, cells, meta = {}) => {
  const notebook = toNotebook({ ...meta, cells: cells.map(toKitCell) });
  writeFileSync(path, serialize(notebook, { document: window.document }));
};
