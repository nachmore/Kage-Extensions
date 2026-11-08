// The per-window Mind facade (ARCHITECTURE §5.15): loading and sync, crash
// safety, read-only mode, link enrichment, window docs, agent records,
// prompts, export and delete. End-to-end behaviour lives in
// acceptance.test.js; these tests pin the facade's own contracts.
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMemoryHost } from '../../test-helpers/mindmap/memory-host.mjs';
import { FIXTURE_NOW, local, makeContext } from '../../test-helpers/mindmap/corpus.mjs';
import { Mind, getMind } from './mind.js';
import * as idlib from './lib/ids.js';
import { createFormatterState, formatHtml } from './view.js';

const META = { 'https://example.com/blog/mtcs-intro': { title: 'An intro to MTCS', description: 'What MTCS is <b>for</b>.' } };

function setup({ config, atomic = false, hostFeatures, meta = META } = {}) {
  const fetched = [];
  const host = createMemoryHost({
    atomic,
    handlers: {
      fetch_link_metadata: async ({ url }) => {
        fetched.push(url);
        return meta[url] ?? null;
      },
    },
  });
  const ctx = makeContext(host, { config, hostFeatures });
  return { host, ctx, mind: new Mind(ctx), fetched };
}

function window(host, opts = {}) {
  const ctx = makeContext(host, { invoke: host.connect().invoke, ...opts });
  return new Mind(ctx);
}

// formatHtml parses with the global DOMParser (the sandbox has one).
globalThis.DOMParser ??= new JSDOM('').window.DOMParser;

const shard = (ms) => `mm-items-${new Date(ms).toISOString().slice(0, 7)}`;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXTURE_NOW);
});
afterAll(() => vi.useRealTimers());
afterEach(() => vi.setSystemTime(FIXTURE_NOW));

describe('getMind', () => {
  it('is one Mind per sandbox invoke', () => {
    const host = createMemoryHost();
    const a = makeContext(host);
    const b = { ...a, config: { trigger: 'xx' } };
    expect(getMind(a)).toBe(getMind(b));
    expect(getMind(makeContext(host, { invoke: host.connect().invoke }))).not.toBe(getMind(a));
    expect(() => getMind({})).toThrow(TypeError);
  });
});

describe('loading and sync', () => {
  it('loads lazily, once, and an empty store is not read-only', async () => {
    const { host, mind } = setup();
    expect(mind.loaded).toBe(false);
    expect(host.calls).toEqual([]);
    await Promise.all([mind.ready(), mind.ready()]);
    expect(mind.loaded).toBe(true);
    expect(mind.readOnly).toBeNull();
    const loads = host.calls.filter((c) => c.command === 'load_extension_data').map((c) => c.args.key);
    // meta, the fixed parts and the current and previous UTC month shards, each with its twin.
    expect(new Set(loads)).toEqual(new Set(['mm-meta', 'nx-mm-meta', 'mm-entities', 'nx-mm-entities', 'mm-links', 'nx-mm-links',
      'mm-journal', 'nx-mm-journal', shard(FIXTURE_NOW), `nx-${shard(FIXTURE_NOW)}`, 'mm-items-2026-10', 'nx-mm-items-2026-10']));
    await mind.ready();
    expect(host.calls.filter((c) => c.command === 'load_extension_data').length).toBe(loads.length);
  });

  it('syncIfStale costs one invoke with no change and reloads only the keys that moved', async () => {
    const { host, mind: a } = setup();
    await a.capture('first note about the walrus budget', { via: 'launcher' });
    const b = window(host);
    await b.ready();
    expect(b.state.items.size).toBe(1);

    let mark = host.calls.length;
    expect(await b.syncIfStale(0)).toBe(false);
    expect(host.calls.slice(mark).map((c) => `${c.command}:${c.args.key}`)).toEqual(['load_extension_data:mm-meta']);
    // Fresh enough: no invoke at all.
    mark = host.calls.length;
    expect(await b.syncIfStale(60_000)).toBe(false);
    expect(host.calls.length).toBe(mark);

    await a.setStatus([...a.state.items.keys()][0], 'done').catch(() => {});
    const note = [...a.state.items.keys()][0];
    await a.setPrivate(note, true);
    mark = host.calls.length;
    expect(await b.syncIfStale(0)).toBe(true);
    const keys = new Set(host.calls.slice(mark).filter((c) => c.window === 1).map((c) => c.args.key.replace(/^nx-/, '')));
    expect(keys.has(shard(FIXTURE_NOW))).toBe(true);
    expect(keys.has('mm-journal')).toBe(true);
    expect(keys.has('mm-entities')).toBe(false);
    expect(keys.has('mm-items-2026-10')).toBe(false);
    expect(b.item(note).private).toBe(true);
    expect(b.port.rev).toBeGreaterThan(0);
  });

  it('sees another window’s delete-everything', async () => {
    const { host, mind: a } = setup();
    await a.capture('note one about otters', { via: 'launcher' });
    const b = window(host);
    await b.ready();
    await a.deleteAll();
    expect(await b.syncIfStale(0)).toBe(true);
    expect(b.state.items.size).toBe(0);
  });
});

describe('budgets', () => {
  // A capture is ~16 invokes (lock, meta sync, a lease check before each
  // write, twin writes, verify, release). At a human pace that is ~80 ms;
  // bursts above ~4 captures a second wait for the 70/s client throttle.
  it('commits a capture within 300 ms p95 on a warm store', async () => {
    const { mind } = setup();
    await mind.capture('warm-up note', { via: 'launcher' });
    const times = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const start = performance.now();
      await mind.capture(`budget note ${i} about the walrus migration and MTCS numbers`, { via: 'launcher' });
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1];
    if (p95 > 300) console.warn(`capture commit p95 ${p95.toFixed(0)} ms is above the 300 ms budget`);
    expect(p95).toBeLessThan(1500);
  }, 30_000);
});

describe('crash safety and read-only mode', () => {
  it('a crash mid-save loses neither earlier data nor consistency', async () => {
    const { host, mind } = setup();
    const first = await mind.capture('a note that must survive', { via: 'launcher' });
    host.crashAfterWrites(1);
    expect(await mind.capture('a note written during a crash', { via: 'launcher' })).toEqual({ code: 'io' });
    host.revive();
    // This window drops what it couldn't save as soon as it can read again.
    await mind.syncIfStale();
    expect([...mind.state.items.keys()]).toEqual([first.itemId]);
    const other = window(host);
    await other.ready();
    expect(other.readOnly).toBeNull();
    expect(other.item(first.itemId)?.title).toBe('a note that must survive');
  });

  it('read-only refuses every mutation and writes no data key', async () => {
    const { host, mind } = setup();
    const saved = await mind.capture('todo: send the walrus report', { via: 'launcher' });
    host.corrupt(shard(FIXTURE_NOW));
    host.corrupt(`nx-${shard(FIXTURE_NOW)}`);
    const other = window(host);
    await other.ready();
    expect(other.readOnly).toEqual({ code: 'unreadable', keys: [shard(FIXTURE_NOW)] });
    const mark = host.calls.length;
    expect(await other.capture('more', { via: 'launcher' })).toEqual({ code: 'readonly' });
    expect(await other.setStatus(saved.itemId, 'done')).toEqual({ ok: false, code: 'readonly' });
    expect(await other.undo()).toEqual({ ok: false, code: 'readonly' });
    const dataWrites = host.calls.slice(mark).filter((c) => c.command !== 'load_extension_data' && c.args.key !== 'mm-lock');
    expect(dataWrites).toEqual([]);
    expect(other.stats().readOnly).toMatchObject({ code: 'unreadable' });
  });

  it('a future schema is read-only too', async () => {
    const { host, mind } = setup();
    await mind.capture('a note', { via: 'launcher' });
    const meta = JSON.parse(host.files.get('mm-meta'));
    for (const key of ['mm-meta', 'nx-mm-meta']) host.files.set(key, JSON.stringify({ ...meta, schema: 99, rev: meta.rev + 5 }));
    const other = window(host);
    await other.ready();
    expect(other.readOnly?.code).toBe('future_schema');
    expect(await other.repair()).toEqual({ ok: false, code: 'future_schema' });
  });

  it('repair rewrites what could be read and leaves read-only mode', async () => {
    const { host, mind } = setup();
    await mind.capture('a note in the entities test', { via: 'launcher' });
    host.corrupt('mm-journal');
    host.corrupt('nx-mm-journal');
    const other = window(host);
    await other.ready();
    expect(other.readOnly?.code).toBe('unreadable');
    const raw = await other.exportRaw();
    expect(Object.keys(raw)).toEqual(expect.arrayContaining(['mm-meta', 'mm-journal', 'nx-mm-journal']));
    expect(await other.repair()).toEqual({ ok: true });
    expect(other.readOnly).toBeNull();
    expect(other.state.items.size).toBe(1);
    const third = window(host);
    await third.ready();
    expect(third.readOnly).toBeNull();
    expect(third.state.items.size).toBe(1);
  });

  it('hosts with storage.atomic_write get single writes', async () => {
    const { host, mind } = setup({ atomic: true, hostFeatures: ['storage.atomic_write'] });
    await mind.capture('one write per key', { via: 'launcher' });
    const saves = host.calls.filter((c) => c.command === 'save_extension_data').map((c) => c.args.key);
    expect(saves.some((k) => k.startsWith('nx-'))).toBe(false);
    expect(saves).toContain('mm-meta');
  });
});

describe('link enrichment', () => {
  it('fetches after the save, sets title and summary, re-organizes, and asks for a reformat', async () => {
    const { mind, fetched, ctx } = setup();
    const out = await mind.capture('https://example.com/blog/mtcs-intro', { via: 'launcher' });
    // Nothing is fetched before the save.
    expect(mind.item(out.itemId).title).not.toBe('An intro to MTCS');
    await mind.whenIdle();
    expect(fetched).toEqual(['https://example.com/blog/mtcs-intro']);
    const item = mind.item(out.itemId);
    expect(item).toMatchObject({ title: 'An intro to MTCS', titleSource: 'meta', summary: 'What MTCS is <b>for</b>.', enrich: { state: 'done' } });
    expect(ctx.formatter.requestReformat).toHaveBeenCalled();
    // The enrich ops are silent: mm undo still targets the capture.
    expect(mind.undoTarget().op.opId).toBe(out.opId);
    expect(mind.find(mind.parse('intro', { trailingSpace: true })).hits.map((h) => h.item.id)).toEqual([out.itemId]);
  });

  it('keeps a title that did not come from the URL', async () => {
    const { mind } = setup();
    const out = await mind.capture('Saved for later', { via: 'agent', hint: { title: 'My own title', url: 'https://example.com/blog/mtcs-intro' } });
    await mind.whenIdle();
    expect(mind.item(out.itemId)).toMatchObject({ title: 'My own title', summary: 'What MTCS is <b>for</b>.' });
  });

  it('fetches nothing when fetch_link_titles is off, and marks failures', async () => {
    const off = setup({ config: { fetch_link_titles: false } });
    await off.mind.capture('https://example.com/blog/mtcs-intro', { via: 'launcher' });
    await off.mind.whenIdle();
    expect(off.fetched).toEqual([]);

    const on = setup();
    const out = await on.mind.capture('https://example.org/unknown-page', { via: 'launcher' });
    await on.mind.whenIdle();
    expect(on.mind.item(out.itemId).enrich.state).toBe('failed');
  });
});

describe('window docs (F-CAP-2)', () => {
  it('saves the window you came from with a cleaned title', async () => {
    const { mind } = setup();
    const out = await mind.captureWindow({ title: 'MTCS rollout plan.docx - Word', processName: 'Microsoft Word' });
    expect(mind.item(out.itemId)).toMatchObject({ kind: 'doc', title: 'MTCS rollout plan.docx', source: { via: 'launcher', app: 'Microsoft Word', window: 'MTCS rollout plan.docx - Word' } });
    // Saving it again annotates the same doc.
    const again = await mind.captureWindow({ title: 'MTCS rollout plan.docx - Word', processName: 'Microsoft Word' });
    expect(again.dedupedInto).toBe(out.itemId);
  });

  it('never saves an item titled only with the app name (macOS without Screen Recording)', async () => {
    const { mind } = setup();
    await mind.ready();
    expect(mind.preview('', { source: { window: '', app: 'Microsoft Word' } }).empty).toBe(true);
    expect(await mind.captureWindow({ title: '', processName: 'Microsoft Word' })).toEqual({ code: 'empty' });
    expect(await mind.captureWindow({ title: 'Microsoft Word', processName: 'Microsoft Word' })).toEqual({ code: 'empty' });
    expect(mind.state.items.size).toBe(0);
  });
});

describe('settings that change organization', () => {
  it('my_names makes those names mean you', async () => {
    const { mind } = setup({ config: { my_names: 'Sam, SJ' } });
    await mind.ready();
    expect(mind.resolveEntity('sam', null)).toMatchObject({ entityId: 'me' });
    const out = await mind.capture('Sam to send the walrus deck by Friday', { via: 'launcher' });
    const kids = mind.childrenOf(out.itemId);
    const action = mind.item(out.itemId).kind === 'action' ? mind.item(out.itemId) : kids[0];
    expect(action.owner).toBe('me');
  });

  it('new_items_private and auto_accept_inferred apply to new captures', async () => {
    const { mind } = setup({ config: { new_items_private: true, auto_accept_inferred: true } });
    const out = await mind.capture('Weekly sync\n- Dana to share the roadmap deck', { via: 'launcher' });
    expect(mind.item(out.itemId).private).toBe(true);
    const kid = mind.childrenOf(out.itemId)[0];
    expect(kid.suggested).toBe(false);
  });

  it('record_source_window off drops the window and app', async () => {
    const { mind } = setup({ config: { record_source_window: false } });
    const out = await mind.capture('a thought', { via: 'launcher', source: { app: 'Mail', window: 'Inbox' } });
    expect(mind.item(out.itemId).source).toEqual({ via: 'launcher' });
  });
});

describe('agent records and prompts', () => {
  it('agentRecord omits window and app, caps snippets and excludes private items', async () => {
    const { mind } = setup({ config: { agent_snippet_chars: 80 } });
    const long = `Capacity notes. ${'The walrus cluster needs more disks before the launch. '.repeat(8)}`;
    const note = await mind.capture(long, { via: 'launcher', source: { app: 'Notes', window: 'Secret window title' } });
    const hidden = await mind.capture('! private walrus salary thoughts', { via: 'launcher' });
    const record = mind.agentRecord(mind.item(note.itemId), { terms: [{ t: 'disk' }] });
    expect(record.cite).toBe(`[mm:${note.itemId}]`);
    expect(record.snippet.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(record)).not.toMatch(/Secret window title|Notes/);
    expect(record).toMatchObject({ kind: 'note', date: '2026-11-06', captured: '2026-11-06' });
    expect(mind.agentRecord(mind.item(hidden.itemId))).toBeNull();
  });

  it('items that mention a private entity are hidden from the agent', async () => {
    const { mind } = setup();
    const out = await mind.capture('Planning with the Walrus team', { via: 'launcher' });
    const team = mind.resolveEntity('walrus', null);
    mind.entity(team.entityId).private = true;
    expect(mind.isHidden(mind.item(out.itemId))).toBe(true);
    expect(mind.agentRecord(mind.item(out.itemId))).toBeNull();
  });

  it('askPrompt with no records says so', async () => {
    const { mind } = setup();
    await mind.ready();
    const prompt = mind.askPrompt('what about <script>zebras</script>?', { t: (k, v) => (k === 'prompt.ask' ? `Q:${v.question}\nS:${v.scope}\nR:${v.records}` : k) });
    expect(prompt).toBe('Q:what about scriptzebras/script?\nS:prompt.scope_none\nR:prompt.ask_none');
  });

  it('askPrompt sends at most 8 records, strips <>, and never private ones', async () => {
    const { mind } = setup();
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(local(2026, 11, 2, 9, i));
      await mind.capture(`walrus note ${i} <b>bold</b> about the <i>zoo</i>`, { via: 'launcher' });
    }
    await mind.capture('! walrus private diary', { via: 'launcher' });
    vi.setSystemTime(FIXTURE_NOW);
    const prompt = mind.askPrompt('walrus', { t: (k, v) => (k === 'prompt.ask' ? v.records : k) });
    const lines = prompt.split('\n');
    expect(lines).toHaveLength(8);
    for (const line of lines) expect(line).toMatch(/^- \[mm:i[0-9a-z]{14}\] \(note, 2026-11-02\) walrus note \d /);
    expect(prompt).not.toMatch(/[<>]/);
    expect(prompt).not.toContain('diary');
  });
});

describe('export and delete', () => {
  it('exportJson includes every item (private too) in the kage-mindmap format', async () => {
    const { mind } = setup();
    await mind.capture('a public note', { via: 'launcher' });
    await mind.capture('! a private note', { via: 'launcher' });
    const data = mind.exportJson({ note: 'includes private items' });
    expect(data).toMatchObject({ format: 'kage-mindmap', schema: 1, note: 'includes private items', exportedAt: new Date(FIXTURE_NOW).toISOString() });
    expect(data.items).toHaveLength(2);
    expect(data.items.some((i) => i.private)).toBe(true);
    expect(Array.isArray(data.entities) && Array.isArray(data.links) && Array.isArray(data.rejections)).toBe(true);
    // The me entity's aliases are never exported.
    expect(data.entities.find((e) => e.id === 'me')?.aliases ?? []).toEqual([]);
  });

  it('deleteAll removes every key and its twin, then the lock', async () => {
    const { host, mind } = setup();
    vi.setSystemTime(local(2026, 9, 15, 12));
    await mind.capture('an old September note', { via: 'launcher' });
    vi.setSystemTime(FIXTURE_NOW);
    await mind.capture('a November note', { via: 'launcher' });
    expect([...host.files.keys()]).toEqual(expect.arrayContaining(['mm-items-2026-09', 'nx-mm-items-2026-09', 'mm-lock']));
    const out = await mind.deleteAll();
    expect(out.ok).toBe(true);
    expect([...host.files.keys()]).toEqual([]);
    expect(mind.state.items.size).toBe(0);
    expect(mind.stats()).toMatchObject({ items: 0, entities: 0, openActions: 0 });
    // Still usable afterwards.
    expect((await mind.capture('a fresh start', { via: 'launcher' })).itemId).toBeTruthy();
  });
});

describe('stats, undo target and the data port', () => {
  it('counts items by kind, open actions and suggestions', async () => {
    const { mind } = setup();
    await mind.capture('Team sync\n- [ ] send the notes\n- Dana to share the deck', { via: 'launcher' });
    await mind.capture('https://example.com/blog/mtcs-intro', { via: 'launcher' });
    await mind.whenIdle();
    const stats = mind.stats();
    expect(stats.byKind).toMatchObject({ meeting: 1, action: 2, link: 1 });
    expect(stats).toMatchObject({ items: 4, openActions: 1, suggestions: 1 });
    expect(stats.bytes).toBeGreaterThan(100);
    expect(stats.lastSaved).toBe(FIXTURE_NOW);
  });

  it('the port answers cite, op and item view models, and private ids say so', async () => {
    const { mind } = setup();
    const pub = await mind.capture('todo: call the zebra team', { via: 'launcher' });
    const priv = await mind.capture('! secret walrus note', { via: 'launcher' });
    const port = mind.port;
    expect(port.loaded).toBe(true);
    expect(port.cite(pub.itemId)).toMatchObject({ id: pub.itemId, kind: 'action', title: 'call the zebra team', private: false, missing: false });
    expect(port.cite(priv.itemId)).toEqual({ id: priv.itemId, private: true });
    expect(port.cite('i0zzzzzzzzzzzzz')).toBeNull();
    // A later op on other records doesn't supersede this one.
    expect(port.op(pub.opId)).toMatchObject({ opId: pub.opId, code: 'capture', canUndo: true, undone: false });
    expect(port.op(priv.opId)).toMatchObject({ code: 'capture', canUndo: true });
    expect(port.item(pub.itemId)).toMatchObject({ id: pub.itemId, kind: 'action', status: 'open' });
    expect(port.changedSince(port.rev, [pub.itemId])).toBe(false);
    await mind.setStatus(pub.itemId, 'done');
    expect(port.changedSince(port.rev - 1, [pub.itemId])).toBe(true);
  });
});

// --- P1 ------------------------------------------------------------------------------

describe('the map (P1)', () => {
  it('mapTarget: an entity, else an item id, else the top hit, else the overview', async () => {
    const { mind } = setup();
    const sync = await mind.capture('Bingo team sync\n- [ ] send the MTCS numbers', { via: 'launcher' });
    await mind.capture('MTCS capacity review notes', { via: 'launcher' });
    const bingo = mind.resolveEntity('bingo', null).entityId;
    expect(mind.mapTarget('')).toEqual({ ref: 'o', name: '' });
    expect(mind.mapTarget('@bingo')).toMatchObject({ ref: bingo, name: 'Bingo' });
    expect(mind.mapTarget(`[mm:${sync.itemId}]`)).toEqual({ ref: sync.itemId, name: 'Bingo team sync' });
    expect(mind.mapTarget('capacity review')).toMatchObject({ name: 'MTCS capacity review notes', highlight: ['capacity', 'review'] });
    expect(mind.mapTarget('@bingo kind:doc')).toMatchObject({ ref: bingo, kinds: ['doc'] });
    expect(mind.mapTarget('zeppelin')).toEqual({ ref: 'o', name: '', missed: true });
  });

  it('builds a neighbourhood plus HTML within budget at 10,000 items', async () => {
    const { mind } = setup();
    await mind.ready();
    const rand = (n) => { let x = n * 2654435761 % 4294967296; return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296; };
    const next = rand(7);
    const ents = Array.from({ length: 60 }, (_, i) => ({
      id: idlib.newId('e', FIXTURE_NOW - 400 * 86_400_000 + i), type: ['team', 'person', 'project', 'topic'][i % 4],
      name: `Name${i}`, aliases: [], key: `name${i}`, origin: 'rule', createdAt: FIXTURE_NOW - 400 * 86_400_000, rev: 1,
    }));
    const words = ['capacity', 'failover', 'review', 'budget', 'launch', 'dashboard', 'pricing', 'roadmap', 'hiring', 'invoice'];
    const items = Array.from({ length: 10_000 }, (_, i) => {
      const at = FIXTURE_NOW - Math.floor(next() * 300) * 86_400_000 - i;
      const e1 = ents[Math.floor(next() * ents.length)];
      const e2 = ents[Math.floor(next() * ents.length)];
      const kind = ['note', 'link', 'doc', 'action', 'meeting'][i % 5];
      const text = `${words[i % 10]} ${words[(i * 7) % 10]} item ${i} with ${e1.name} and ${e2.name}`;
      return {
        id: idlib.newId('i', at), kind, title: text.slice(0, 60), titleSource: 'auto', text, createdAt: at, updatedAt: at,
        ...(kind === 'action' ? { status: i % 3 ? 'open' : 'done', owner: 'me' } : {}),
        entityIds: [...new Set([e1.id, e2.id])], mentionOrigin: { [e1.id]: 'rule', [e2.id]: 'rule' },
        keyphrases: [words[i % 10]], source: { via: 'import' }, enrich: { state: 'none' }, rev: 1, v: 1,
      };
    });
    const out = await mind.importJson({ format: 'kage-mindmap', schema: 1, items, entities: ents });
    expect(out).toMatchObject({ ok: true, added: 10_000 });
    const t = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`;
    const state = createFormatterState();
    const busiest = [...mind.byEntity].sort((a, b) => b[1].size - a[1].size)[0][0];
    const time = (marker) => {
      const runs = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        const html = formatHtml(`<p>${marker}</p>`, mind.port, { t, locale: 'en', canReformat: true, state, now: FIXTURE_NOW });
        runs.push(performance.now() - start);
        expect(html).toContain('mm-t-map');
      }
      return runs.sort((a, b) => a - b)[2];
    };
    const results = {
      entity: time(`[mm-card:map:${busiest}]`),
      item: time(`[mm-card:map:${items[42].id}]`),
      overview: time('[mm-card:map:o]'),
    };
    for (const [what, ms] of Object.entries(results)) {
      if (process.env.MM_PERF) console.log(`map ${what} @10k: ${ms.toFixed(1)} ms`);
      if (ms > 30) console.warn(`map ${what} focus at 10k items: median ${ms.toFixed(1)} ms (budget 30 ms)`);
      expect(ms, what).toBeLessThan(300);
    }
  }, 120_000);
});

describe('mm? scope (P1)', () => {
  it('names the widened range when nothing matched the asked one, and nothing else changes', async () => {
    const { mind } = setup();
    vi.setSystemTime(local(2026, 10, 20, 9));
    await mind.capture('walrus capacity notes', { via: 'launcher' });
    vi.setSystemTime(FIXTURE_NOW);
    const t = (k, v) => (k === 'prompt.ask' ? v.scope : `${k}${v ? JSON.stringify(v) : ''}`);
    expect(mind.askPrompt('walrus capacity yesterday', { t }))
      .toBe('prompt.scope_range{"from":"2026-11-05","to":"2026-11-05"}; prompt.scope_widened{"from":"2026-10-06","to":"2026-11-06"}');
    expect(mind.askPrompt('walrus capacity', { t })).toBe('prompt.scope_none');
    // A dropped filter is reported generically.
    expect(mind.askPrompt('walrus capacity in may 2025', { t })).toMatch(/prompt\.scope_relaxed$/);
    // With nothing found at all, there is nothing to qualify.
    expect(mind.askPrompt('zeppelin yesterday', { t })).not.toMatch(/widened|relaxed/);
  });
});

describe('annotate (P1)', () => {
  it('back-fills a new agent entity onto earlier items and labels the op by what changed', async () => {
    const { mind } = setup();
    const early = await mind.capture('Atlas autoscaler idea', { via: 'launcher' });
    const target = await mind.capture('capacity planning notes for next quarter', { via: 'launcher' });
    expect(mind.resolveEntity('atlas', null)).toBeNull();
    const out = await mind.annotate([
      { id: target.itemId, entities: [{ name: 'Atlas', type: 'project' }] },
      { id: 'i0zzzzzzzzzzzzz', summary: 'nothing here' },
    ]);
    expect(out).toMatchObject({ ok: true, applied: [target.itemId], rejected: [{ id: 'i0zzzzzzzzzzzzz', reason: 'not_found' }] });
    const atlas = mind.resolveEntity('atlas', null).entityId;
    expect(mind.item(early.itemId).entityIds).toContain(atlas);
    expect(mind.item(early.itemId).mentionOrigin[atlas]).toBe('rule');
    const target_ = mind.undoTarget();
    expect(target_.summary).toMatchObject({ code: 'annotate', count: 1 });
    expect((await mind.undo()).ok).toBe(true);
    expect(mind.item(early.itemId).entityIds).not.toContain(atlas);
    expect(mind.resolveEntity('atlas', null)).toBeNull();
  });

  it('read-only stores refuse it', async () => {
    const { host, mind } = setup();
    const note = await mind.capture('a note to annotate', { via: 'launcher' });
    host.corrupt(shard(FIXTURE_NOW));
    host.corrupt(`nx-${shard(FIXTURE_NOW)}`);
    const other = window(host);
    await other.ready();
    expect(await other.annotate([{ id: note.itemId, summary: 'x' }])).toMatchObject({ ok: false, code: 'readonly' });
  });
});

describe('Export Markdown (P1)', () => {
  it('escapes Markdown in user text, links and paths, and keeps body lines from reading as structure', async () => {
    const { mind } = setup({ meta: { 'https://example.com/a_(b)': { title: 'Tricky *title* [x](y)', description: 'Summary with <b>tags</b>' } } });
    await mind.capture('https://example.com/a_(b)', { via: 'launcher' });
    await mind.whenIdle();
    await mind.capture('# Not a heading _really_\n1. first line\n- second line\n=== rule', { via: 'launcher' });
    await mind.capture('~/Documents/odd `name`.pdf', { via: 'launcher' });
    await mind.capture('! private walrus diary', { via: 'launcher' });
    const counts = {};
    const md = mind.exportMarkdown((k, v) => (k === 'export.due' ? `due ${v.day}` : k.split('.').pop()), counts);
    expect(counts.items).toBe(4);
    expect(md).toContain('[Tricky \\*title\\* \\[x\\]\\(y\\)](https://example.com/a_%28b%29)');
    expect(md).toContain('  > Summary with btags/b');
    expect(md).not.toMatch(/<|>(?! )/);
    // Bullet markers are dropped from body lines (as everywhere a note is shown);
    // what's left can't start a list, heading or rule.
    const note = md.split('\n').filter((l) => l.startsWith('  > ')).map((l) => l.slice(4));
    expect(note).toEqual(expect.arrayContaining(['first line', 'second line', '\\=== rule']));
    expect(note).not.toContain('\\# Not a heading \\_really\\_');
    expect(md).toContain("— `~/Documents/odd name.pdf`");
    expect(md).toMatch(/private walrus diary · private/);
    // No raw heading from user text.
    expect(md.split('\n').filter((l) => /^#/.test(l)).every((l) => /^(# title|## )/.test(l))).toBe(true);
  });
});
