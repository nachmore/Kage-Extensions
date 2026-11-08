/**
 * The SPEC §3.1 fixture corpus for the Mind Map tests, and a harness that
 * builds it the way a user would: every capture goes through the real
 * search provider (`match` / `matchAsync` → `execute`), on the fixture
 * clock, with link metadata mocked and awaited (`mind.whenIdle()`) before
 * the next capture.
 *
 * The clock is pinned with vi.useFakeTimers({ toFake: ['Date'] }) so the
 * store's setTimeout/performance.now throttling and lock waits still run.
 *
 *   const h = await makeHarness();
 *   const ids = await buildCorpus(h);       // { F1: itemId, …, F11: itemId }
 *   h.at(FIXTURE_NOW);                      // Fri 2026-11-06 10:00 local
 *   h.search.match('mm …');
 *
 * URLs use example.com / example.org only.
 */

import { vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryHost } from './memory-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '../../extensions/mindmap');

/** Local-time epoch ms for a calendar date (month is 1-based). */
export function local(y, m, d, h = 0, min = 0) {
  return new Date(y, m - 1, d, h, min).getTime();
}

/** The fixture clock: Fri 2026-11-06 10:00 local. */
export const FIXTURE_NOW = local(2026, 11, 6, 10, 0);

export const F6_DUMP = [
  'Bingo team sync',
  '- [ ] Send MTCS numbers to Dana by Friday',
  '- Dana to share the roadmap deck',
  '- I\'ll book the offsite',
  'Action items:',
  '- review the Bingo launch checklist',
].join('\n');

export const F2_WINDOW = Object.freeze({ title: 'MTCS rollout plan.docx - Word', processName: 'Microsoft Word' });

/** F1–F11 (SPEC §3.1), in table order. `at` is createdAt (local). */
export const FIXTURES = Object.freeze([
  { name: 'F1', at: local(2026, 10, 26, 9, 12), input: 'mm+ https://wiki.example.com/mtcs/design-review', meta: { title: 'MTCS design review', description: 'Failover and capacity plan for MTCS.' } },
  { name: 'F2', at: local(2026, 10, 28, 14, 3), input: 'mm+', window: F2_WINDOW },
  { name: 'F3', at: local(2026, 11, 3, 11, 0), input: 'mm+ ~/Documents/MTCS capacity notes.pdf' },
  { name: 'F4', at: local(2026, 10, 22, 8, 30), input: 'mm+ https://example.com/blog/mtcs-intro', meta: { title: 'An intro to MTCS' } },
  { name: 'F5', at: local(2026, 10, 29, 13, 10), input: 'mm+ Lunch with Dana, talked about MTCS hiring' },
  { name: 'F6', at: local(2026, 10, 30, 16, 0), input: `mm+ ${F6_DUMP}` },
  { name: 'F7', at: local(2026, 11, 2, 9, 0), input: 'mm+ todo: email the bingo team about the demo date' },
  { name: 'F8', at: local(2026, 11, 3, 9, 0), input: 'mm+ call the Zebra team about invoices' },
  { name: 'F9', at: local(2026, 11, 4, 9, 0), input: 'mm+ [x] update the Bingo dashboard' },
  { name: 'F10', at: local(2026, 11, 4, 12, 0), input: 'mm+ ! bingo salary thoughts' },
  { name: 'F11', at: local(2026, 10, 29, 15, 0), input: 'mm+ https://example.org/pricing', meta: { title: 'Pricing page' } },
]);

/** The fixtures in capture (createdAt) order. */
export const CHRONOLOGICAL = Object.freeze([...FIXTURES].sort((a, b) => a.at - b.at));

/** The EN catalog as { key: { message } }. */
export function loadCatalog() {
  return JSON.parse(readFileSync(join(EXT, '_locales/en/messages.json'), 'utf8'));
}

// The host's ICU subset (ui/js/shared/icu-message.js): {name}, plural with
// CLDR categories, =N arms and #, and select.
function matching(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function splitTop(s) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth === 0 && ch === ',') {
      out.push(buf);
      buf = '';
    } else buf += ch;
  }
  out.push(buf);
  return out;
}

function arms(body) {
  const map = new Map();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    const open = body.indexOf('{', i);
    if (open < 0) break;
    const close = matching(body, open);
    if (close < 0) break;
    map.set(body.slice(i, open).trim(), body.slice(open + 1, close));
    i = close + 1;
  }
  return map;
}

export function formatIcu(template, vars = {}, locale = 'en') {
  if (typeof template !== 'string' || !template.includes('{')) return template || '';
  let out = '';
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== '{') {
      out += template[i];
      continue;
    }
    const close = matching(template, i);
    if (close < 0) return out + template.slice(i);
    const inner = template.slice(i + 1, close);
    const parts = splitTop(inner);
    if (parts.length === 1) {
      const v = vars[inner.trim()];
      out += v === undefined || v === null ? `{${inner.trim()}}` : String(v);
    } else {
      const [name, kind, ...rest] = parts.map((p) => p.trim());
      const a = arms(rest.join(', '));
      const v = vars[name];
      if (kind === 'plural') {
        const n = Number(v);
        const arm = a.get(`=${n}`) ?? a.get(new Intl.PluralRules(locale).select(n)) ?? a.get('other') ?? '';
        out += formatIcu(arm.replace(/#/g, String(n)), vars, locale);
      } else if (kind === 'select') {
        out += formatIcu(a.get(String(v)) ?? a.get('other') ?? '', vars, locale);
      } else out += `{${inner}}`;
    }
    i = close;
  }
  return out;
}

/** context.i18n backed by the EN catalog (or `catalog`). */
export function makeI18n(catalog = loadCatalog(), { language = 'en', rtl = false } = {}) {
  return {
    t: (key, vars) => formatIcu(catalog[key]?.message ?? key, vars || {}, language),
    language: () => language,
    isRtl: () => rtl,
  };
}

export function quietLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A sandbox `context` for one Kage window over `host` (createMemoryHost). */
export function makeContext(host, { config = {}, invoke, formatter = true, hostFeatures, i18n } = {}) {
  const context = {
    invoke: invoke || host.invoke,
    config: { week_start: 'mon', ...config },
    log: quietLog(),
    i18n: i18n || makeI18n(),
  };
  if (formatter) context.formatter = { requestReformat: vi.fn() };
  if (hostFeatures) context.hostFeatures = Object.freeze([...hostFeatures]);
  return context;
}

/**
 * A host plus a floating window (search + tools + formatter sharing one
 * Mind), with the commands Mind Map uses mocked:
 *   - fetch_link_metadata → `meta` by URL (null for unknown URLs)
 *   - get_source_window → `h.sourceWindow` (null unless a test sets it)
 *   - list_open_windows → `h.openWindows`; focus_open_window / open_url recorded
 */
export async function makeHarness({ atomic = false, config = {}, formatter = true, hostFeatures, latency, i18n } = {}) {
  const [{ default: Search }, { default: Tools }, { default: Formatter }, { getMind }] = await Promise.all([
    import('../../extensions/mindmap/search.js'),
    import('../../extensions/mindmap/tools.js'),
    import('../../extensions/mindmap/formatter.js'),
    import('../../extensions/mindmap/mind.js'),
  ]);
  const h = {
    meta: new Map(FIXTURES.filter((f) => f.meta).map((f) => [f.input.slice(4), f.meta])),
    sourceWindow: null,
    openWindows: [],
    opened: [],
    focused: [],
    metaCalls: [],
  };
  h.host = createMemoryHost({
    atomic,
    latency,
    handlers: {
      fetch_link_metadata: async ({ url }) => {
        h.metaCalls.push(url);
        return h.meta.get(url) ?? null;
      },
      get_source_window: async () => h.sourceWindow,
      list_open_windows: async () => h.openWindows,
      focus_open_window: async ({ handle }) => {
        h.focused.push(handle);
        return null;
      },
      open_url: async ({ url }) => {
        h.opened.push(url);
        return null;
      },
    },
  });
  h.context = makeContext(h.host, { config, formatter, hostFeatures, i18n });
  h.search = new Search();
  h.tools = new Tools();
  h.formatter = new Formatter();
  for (const p of [h.search, h.tools, h.formatter]) p.initialize(h.context);
  h.mind = getMind(h.context);
  h.at = (ms) => vi.setSystemTime(ms);
  return h;
}

/** Selects the row with `id` from `rows` (throws when absent). */
export function rowById(rows, id) {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no row ${id} in [${rows.map((r) => r.id).join(', ')}]`);
  return row;
}

/** One capture the way the launcher does it. → the execute() result. */
export async function captureVia(h, input, { window } = {}) {
  const query = input;
  if (window) {
    h.sourceWindow = window;
    h.search.match(query);
    const rows = await h.search.matchAsync(query);
    const out = await h.search.execute(rowById(rows, 'mm:window'));
    h.sourceWindow = null;
    await h.mind.whenIdle();
    return out;
  }
  let rows = h.search.match(query);
  if (!rows.some((r) => r.id === 'mm:capture')) rows = await h.search.matchAsync(query);
  const out = await h.search.execute(rowById(rows, 'mm:capture'));
  await h.mind.whenIdle();
  return out;
}

/** Captures F1–F11 in createdAt order on the fixture clock. → { F1: itemId, … }. */
export async function buildCorpus(h, { only } = {}) {
  const ids = {};
  for (const f of CHRONOLOGICAL) {
    if (only && !only.includes(f.name)) continue;
    h.at(f.at);
    const out = await captureVia(h, f.input, { window: f.window });
    const op = /\[mm-card:op:(o[0-9a-z]{14})\]/.exec(out?.value || '')?.[1];
    if (!op) throw new Error(`${f.name} was not saved: ${JSON.stringify(out)}`);
    const record = h.mind.state.ops.find((o) => o.opId === op);
    ids[f.name] = record?.label?.params?.itemId || record?.created?.items?.[0];
  }
  h.at(FIXTURE_NOW);
  return ids;
}
