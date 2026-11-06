import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const imports = (source) => [...source.matchAll(/\bimport\s+(?:[^'"]+?\s+from\s+)?['"](\.{1,2}\/[^'"]+?)['"]/g)].map((match) => match[1]);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const c = manifest.contributes;
const windows = {
  floating: { search: c.searchProvider, tools: c.toolProvider, ...Object.fromEntries(c.widgets.map((w) => [w.id, w.module])) },
  settings: { settings: c.settingsProvider },
};

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
    if (/\bexport\s+[^;]*\bfrom\s*['"]/.test(source)) throw new Error(`${path}: re-export unsupported by host`);
    for (const dependency of imports(source)) {
      if (imports(shared.get(dependency)).length) throw new Error(`${path} imports non-leaf ${dependency}`);
    }
  }
}

// Faithful single rewrite pass from runtime.js. Temporary module URLs let
// Node import the result; deleting pass-1 files models revoked blob URLs.
async function loadLikeHost(entries, shared) {
  const dir = mkdtempSync(join(tmpdir(), 'stocks-host-load-'));
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

describe('host module depth and loading', () => {
  it.each(Object.entries(windows))('loads every %s provider through the host rewrite', async (name, paths) => {
    const entries = Object.fromEntries(Object.entries(paths).map(([kind, path]) => [kind, read(path)]));
    const shared = discover(entries, read);
    checkDepth(shared);
    const names = await loadLikeHost(entries, shared);
    expect(Object.keys(names)).toEqual(Object.keys(paths));
    expect(Object.values(names).every((name) => /^Stocks/.test(name))).toBe(true);
  });

  it('rejects the reviewed nested graph and demonstrates its actual load failure', async () => {
    const entries = { search: "import './client.js'; export default class StocksSearch {}" };
    const sources = {
      './client.js': "import './symbols.js';",
      './symbols.js': "import './defaults.js';",
      './defaults.js': 'export const MAX_SYMBOLS = 10;',
    };
    const shared = discover(entries, (path) => sources[path]);
    expect(() => checkDepth(shared)).toThrow('imports non-leaf');
    await expect(loadLikeHost(entries, shared)).rejects.toThrow();
  });
});
