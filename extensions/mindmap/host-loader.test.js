// Loads every Mind Map provider the way the host's sandbox does, in Node
// (copied from extensions/stocks/host-loader.test.js and adapted).
//
// Older Kage hosts discover relative imports breadth-first from the entry
// files with a regex, then rewrite them in two passes. A shared module that
// imports a non-leaf points at a blob URL that was revoked or never
// rewritten, so it fails to load (ARCHITECTURE §1). Current hosts resolve
// imports properly, but users on older hosts still run this extension, so
// the layering here is the strict one:
//   entries   (search, tools, formatter, settings, explorer) may import anything;
//   composers (mind.js, view.js, explorer-canvas.js,
//              explorer-panel.js)                            import only leaves;
//   leaves    (defaults.js, lib/*.js)                        import nothing.
// The explorer's window (contributes.views, Kage docs/design/EXTENSION_VIEWS.md
// §8.5) loads its module and that module's imports with the same loader.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const imports = (source) => [...source.matchAll(/\bimport\s+(?:[^'"]+?\s+from\s+)?['"](\.{1,2}\/[^'"]+?)['"]/g)].map((match) => match[1]);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
// `export * from '…'` / `export { a } from '…'` (stocks' looser pattern also
// matches a lexicon array that contains the word 'from').
const REEXPORT_RE = /^\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]/m;
const c = manifest.contributes;
const windows = {
  floating: { search: c.searchProvider, tools: c.toolProvider, formatter: c.messageFormatters },
  chat: { search: c.searchProvider, tools: c.toolProvider, formatter: c.messageFormatters },
  settings: { settings: c.settingsProvider },
  // A view window loads only its view module (and what that imports).
  explorer: { view: c.views.find((v) => v.id === 'explorer').module },
};
const CLASS_NAMES = {
  search: 'MindMapSearchProvider',
  tools: 'MindMapToolProvider',
  formatter: 'MindMapFormatter',
  settings: 'MindMapSettingsProvider',
  view: 'MindMapExplorer',
};
const COMPOSERS = new Set(['./mind.js', './view.js', './explorer-canvas.js', './explorer-panel.js']);
const LIB = readdirSync(new URL('./lib/', import.meta.url)).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => `./lib/${f}`);
const RUNTIME = ['./search.js', './tools.js', './formatter.js', './settings.js', './explorer.js', './mind.js', './view.js',
  './explorer-canvas.js', './explorer-panel.js', './defaults.js', ...LIB];

function discover(entries, readSource) {
  // Same BFS order as sources.js / fetchSharedSourcesViaInvoke in the host.
  const shared = new Map();
  const queue = Object.values(entries).flatMap(imports);
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    if (shared.has(path)) continue;
    const source = readSource(path);
    shared.set(path, source);
    queue.push(...imports(source));
  }
  return shared;
}

function checkDepth(shared) {
  for (const [path, source] of shared) {
    if (REEXPORT_RE.test(source)) throw new Error(`${path}: re-export unsupported by host`);
    for (const dependency of imports(source)) {
      if (imports(shared.get(dependency)).length) throw new Error(`${path} imports non-leaf ${dependency}`);
    }
  }
}

// Faithful two-pass rewrite from runtime.js. Temporary module URLs let
// Node import the result; deleting pass-1 files models revoked blob URLs.
async function loadLikeHost(entries, shared) {
  const dir = mkdtempSync(join(tmpdir(), 'mindmap-host-load-'));
  const urls = new Map();
  let counter = 0;
  const create = (source) => {
    const path = join(dir, `${++counter}.mjs`);
    writeFileSync(path, source);
    return pathToFileURL(path).href;
  };
  const rewrite = (source) => source.replace(
    /(\bimport\s+(?:[^'"]+?\s+from\s+)?)(['"])(\.{1,2}\/[^'"]+?)\2/g,
    (whole, leading, quote, specifier) => urls.has(specifier) ? `${leading}${quote}${urls.get(specifier)}${quote}` : whole,
  );
  try {
    for (const [path, source] of shared) urls.set(path, create(source));
    for (const [path, source] of shared) {
      if (!/import\s.*['"]\.{1,2}\//.test(source)) continue;
      const rewritten = rewrite(source);
      if (rewritten === source) continue;
      rmSync(fileURLToPath(urls.get(path)));
      urls.set(path, create(rewritten));
    }
    const names = {};
    for (const [kind, source] of Object.entries(entries)) {
      const module = await import(/* @vite-ignore */ create(rewrite(source)));
      names[kind] = module.default?.name;
    }
    return names;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Comment text with no string or template contents (good enough for this
// codebase: it has no regex literal containing a comment opener).
function comments(source) {
  const out = [];
  for (const m of source.matchAll(/\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/[^\n]*/g)) out.push(m[0]);
  return out;
}

describe('host module depth and loading', () => {
  it.each(Object.entries(windows))('loads every %s provider through the host rewrite', async (name, paths) => {
    const entries = Object.fromEntries(Object.entries(paths).map(([kind, path]) => [kind, read(path)]));
    const shared = discover(entries, read);
    checkDepth(shared);
    const names = await loadLikeHost(entries, shared);
    expect(Object.keys(names)).toEqual(Object.keys(paths));
    for (const [kind, className] of Object.entries(names)) expect(className).toBe(CLASS_NAMES[kind]);
  });

  it('settings loads mind.js directly (the settings window loads only its provider)', () => {
    const shared = discover({ settings: read(c.settingsProvider) }, read);
    expect(shared.has('./mind.js')).toBe(true);
  });

  it('keeps the entry → composer → leaf layering', () => {
    const entries = Object.fromEntries([...Object.entries(windows.floating), ...Object.entries(windows.explorer)].map(([k, p]) => [k, read(p)]));
    const shared = discover(entries, read);
    expect(shared.has('./explorer-canvas.js') && shared.has('./explorer-panel.js')).toBe(true);
    for (const [path, source] of shared) {
      const deps = imports(source);
      if (COMPOSERS.has(path)) {
        for (const dep of deps) expect(COMPOSERS.has(dep), `${path} imports composer ${dep}`).toBe(false);
      } else {
        expect(deps, `leaf ${path} must import nothing`).toEqual([]);
      }
    }
    expect(imports(read('./view.js'))).toEqual(['./lib/graph.js', './lib/filetext.js']);
    expect(imports(read('./explorer-canvas.js')).sort()).toEqual(['./lib/camera.js', './lib/spatial.js']);
    expect(imports(read('./explorer-panel.js'))).toEqual([]);
    // The explorer's layout pass is a leaf too: runSandboxed serialises it.
    expect(imports(read('./lib/layout.js'))).toEqual([]);
    expect(imports(read('./mind.js'))).not.toContain('./view.js');
    for (const leaf of ['./defaults.js', ...LIB]) expect(imports(read(leaf)), leaf).toEqual([]);
  });

  it('uses only single-line static imports, no re-exports, and no import text in comments', () => {
    for (const path of RUNTIME) {
      const source = read(path);
      expect(source, `${path} uses a dynamic import`).not.toMatch(/\bimport\s*\(/);
      expect(source, `${path} re-exports`).not.toMatch(REEXPORT_RE);
      for (const line of source.split('\n')) {
        if (!/^import\b/.test(line)) continue;
        expect(line, `${path}: multi-line import`).toMatch(/^import\s.*\sfrom\s+'\.\/[^']+\.js';$|^import\s+'\.\/[^']+\.js';$/);
      }
      expect(imports(source).length).toBe(source.split('\n').filter((l) => /^import\b/.test(l)).length);
      for (const comment of comments(source)) {
        expect(comment, `${path}: import-like text in a comment`).not.toMatch(/\bfrom\s+['"]\.{1,2}\/|\bimport\s*\(\s*['"]\.{1,2}\//);
      }
      // Every specifier is written from the extension root.
      for (const spec of imports(source)) expect(spec, path).toMatch(/^\.\/(?:lib\/)?[a-z0-9-]+\.js$/);
    }
  });

  it('the re-export pattern catches real re-exports only', () => {
    expect(REEXPORT_RE.test("export * from './lib/text.js';")).toBe(true);
    expect(REEXPORT_RE.test("export { stem, tokenize } from './lib/text.js';")).toBe(true);
    expect(REEXPORT_RE.test("export const FILLER = ['about', 'from', 'to'];")).toBe(false);
  });

  it('rejects a nested graph and demonstrates its actual load failure', async () => {
    const entries = { search: "import './mind.js'; export default class MindMapSearchProvider {}" };
    const sources = {
      './mind.js': "import './view.js';",
      './view.js': "import './lib/graph.js';",
      './lib/graph.js': 'export const LANES = [];',
    };
    const shared = discover(entries, (path) => sources[path]);
    expect(() => checkDepth(shared)).toThrow('imports non-leaf');
    await expect(loadLikeHost(entries, shared)).rejects.toThrow();
  });
});
