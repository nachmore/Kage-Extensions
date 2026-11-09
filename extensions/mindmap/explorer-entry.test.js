// @vitest-environment jsdom
// The ways into the map explorer, and the data behind it (EXTENSION_VIEWS
// §24.2, §24.5, §24.8): launcher rows, card buttons, settings, and
// mind.js's links(), mm-layout and mm-view. Hosts without `views` see none
// of it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, buildCorpus, makeContext, makeHarness, rowById } from '../../test-helpers/mindmap/corpus.mjs';
import { createMemoryHost } from '../../test-helpers/mindmap/memory-host.mjs';
import MindMapFormatter from './formatter.js';
import { Mind } from './mind.js';
import MindMapSearchProvider from './search.js';
import MindMapSettingsProvider from './settings.js';
import { exploreRef, parseAction, renderItemCard, ui } from './view.js';

let h;
let F;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  h = await makeHarness();
  F = await buildCorpus(h);
  h.at(FIXTURE_NOW);
}, 60_000);
afterAll(() => vi.useRealTimers());

// The same window (same Mind) on a host that offers `features`.
function providers(features) {
  const context = { ...h.context, hostFeatures: features ? Object.freeze([...features]) : undefined };
  const search = new MindMapSearchProvider();
  search.initialize(context);
  const formatter = new MindMapFormatter();
  formatter.initialize(context);
  return { context, search, formatter };
}

const idOf = (name, type) => h.mind.resolveEntity(name, type)?.entityId;
const blkOf = (html) => / mm-b([0-9a-z]+) mm-r/.exec(html)[1];

describe('launcher rows', () => {
  it('mm map leads with “Open in explorer” when the host offers views', async () => {
    const { search } = providers(['views']);
    const bingo = idOf('bingo', 'team');
    const rows = search.match('mm map bingo');
    expect(rows.map((r) => r.id)).toEqual(['mm:explore', 'mm:map']);
    expect(rows[0]).toMatchObject({ icon: '🗺️', label: 'Open in explorer: Bingo', description: 'Pan, zoom and arrange the map in its own window', data: { a: 'explore', ref: bingo } });
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    expect(await search.execute(rows[0])).toEqual({ type: 'open_view', view: 'explorer', params: { focus: bingo } });
    const overview = rowById(search.match('mm map'), 'mm:explore');
    expect(overview.label).toBe('Open in explorer');
    expect(await search.execute(overview)).toEqual({ type: 'open_view', view: 'explorer', params: { focus: 'o' } });
    // Kinds pass through as the explorer's query (a lens).
    const docs = rowById(search.match('mm map @bingo kind:doc'), 'mm:explore');
    expect(await search.execute(docs)).toEqual({ type: 'open_view', view: 'explorer', params: { focus: bingo, query: 'kind:doc' } });
  });

  it('mm explore [focus] opens it directly', async () => {
    const { search } = providers(['views', 'storage.change_events']);
    const rows = search.match('mm explore dana');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'mm:explore', label: 'Open in explorer: Dana' });
    expect((await search.execute(rows[0])).params.focus).toBe(idOf('dana', 'person'));
    expect(search.match('mm explore')[0]).toMatchObject({ id: 'mm:explore', data: { ref: 'o' } });
    expect(search.match('mm explore walrus zzz')[0].description).toContain('Nothing matched');
  });

  it('shows nothing explorer-related without views (older host, or not approved yet)', async () => {
    for (const features of [undefined, ['storage.change_events']]) {
      const { search } = providers(features);
      expect(search.match('mm map bingo').map((r) => r.id)).toEqual(['mm:map']);
      // "explore" is just a word then.
      expect(search.match('mm explore dana').some((r) => r.id === 'mm:explore')).toBe(false);
      // A stale explorer row falls back to the map card.
      const out = await search.execute({ data: { a: 'explore', ref: 'o' } });
      expect(out).toEqual({ type: 'display', value: '🗺️ Overview\n\n[mm-card:map:o]' });
    }
  });

  it('never puts a bad ref or an over-long query into params', () => {
    const { search } = providers(['views']);
    expect(search.openExplorer('../x', 'q'.repeat(500))).toEqual({ type: 'open_view', view: 'explorer', params: { focus: 'o', query: 'q'.repeat(200) } });
  });
});

describe('card buttons', () => {
  it('the map card’s ⤢ Explorer and the item card’s Explore open the explorer on what they show', async () => {
    const { search, formatter } = providers(['views']);
    const bingo = idOf('bingo', 'team');
    const fmt = { streaming: false };
    const map = await formatter.format(`<p>[mm-card:map:${bingo}]</p>`, fmt);
    const mapBlk = blkOf(map);
    expect(map).toContain(`data-ext-action="mm:b${mapBlk}:explore"`);
    expect(map).toContain('⤢ Explorer');
    expect(await search.onResultAction(`mm:b${mapBlk}:explore`)).toEqual({ host: { type: 'open_view', view: 'explorer', params: { focus: bingo } } });
    // After moving the card to Dana, it opens on Dana.
    const dana = idOf('dana', 'person');
    await search.onResultAction(`mm:b${mapBlk}:f:${dana}`);
    expect((await search.onResultAction(`mm:b${mapBlk}:explore`)).host.params.focus).toBe(dana);
    const item = await formatter.format(`<p>[mm-card:item:${F.F1}]</p>`, fmt);
    const itemBlk = blkOf(item);
    expect(item).toContain('>Explore</button>');
    expect(await search.onResultAction(`mm:b${itemBlk}:explore`)).toEqual({ host: { type: 'open_view', view: 'explorer', params: { focus: F.F1 } } });
    // An unknown card opens nothing.
    expect(await search.onResultAction('mm:bzzzz9:explore')).toEqual({});
  });

  it('cards have no explorer buttons without views, or on hosts that can’t reformat', async () => {
    const { formatter } = providers(undefined);
    const html = await formatter.format(`<p>[mm-card:map:o]</p><p>[mm-card:item:${F.F1}]</p>`, { streaming: false });
    expect(html).not.toContain(':explore');
    expect(renderItemCard({ id: F.F1, kind: 'link', title: 'x', url: 'https://example.com/' }, { canExplore: true, canReformat: false })).not.toContain(':explore');
    const { search } = providers(undefined);
    const blk = blkOf(html);
    expect(await search.onResultAction(`mm:b${blk}:explore`)).toEqual({});
  });

  it('parses the explore action and finds its ref', () => {
    expect(parseAction('mm:b12:explore')).toEqual({ scope: 'block', blk: '12', verb: 'explore' });
    expect(parseAction('mm:b12:explore:o')).toBeNull();
    expect(exploreRef(ui, { scope: 'block', blk: 'nope', verb: 'explore' })).toBeNull();
    expect(exploreRef(ui, { scope: 'block', blk: '1', verb: 'focus' })).toBeNull();
  });
});

describe('settings', () => {
  const controls = (schema) => schema.sections.flatMap((s) => s.controls);
  const settingsWith = (features, host = h.host) => {
    const ctx = makeContext(host, { invoke: host.connect().invoke, hostFeatures: features });
    const p = new MindMapSettingsProvider();
    p.initialize(ctx);
    return p;
  };

  it('offers Open and Reset with views, a hint before approval, nothing on older hosts', async () => {
    const withViews = await settingsWith(['views']).getSettings();
    const section = withViews.sections.find((s) => s.label === 'Map explorer');
    expect(section.controls.map((c) => c.id)).toEqual(['open_explorer', 'reset_layout']);
    expect(withViews.sections.at(-1).label).toBe('Your data');
    expect(section.controls[1].confirm).toContain('Forget every position');
    const pending = await settingsWith(['storage.change_events']).getSettings();
    const hint = pending.sections.find((s) => s.label === 'Map explorer').controls;
    expect(hint).toHaveLength(1);
    expect(hint[0].html).toContain('Approve Mind Map’s new permission in the Store');
    const old = await settingsWith(undefined).getSettings();
    expect(old.sections.some((s) => s.label === 'Map explorer')).toBe(false);
    expect(controls(old).some((c) => c.id === 'open_explorer')).toBe(false);
  });

  it('Open returns the open_view effect; Reset forgets every pin', async () => {
    const host = createMemoryHost();
    const p = settingsWith(['views'], host);
    expect(await p.runAction('open_explorer')).toEqual({ host: { type: 'open_view', view: 'explorer' } });
    expect(await settingsWith(undefined, host).runAction('open_explorer')).toEqual({});
    await p.mind.ready();
    await p.mind.setPins({ o: { x: 1, y: 2 } });
    expect(host.files.has('mm-layout')).toBe(true);
    expect(await p.runAction('reset_layout')).toEqual({ status: 'Map layout reset' });
    expect(host.files.has('mm-layout')).toBe(false);
    expect(p.mind.pins).toEqual({});
  });
});

describe('mind.js: links, mm-layout and mm-view', () => {
  it('links() takes from every kind of link in turn, never archived or dismissed items', async () => {
    await h.mind.ready();
    const bingo = idOf('bingo', 'team');
    const out = h.mind.links(bingo, { limit: 8 });
    expect(out.node).toMatchObject({ ref: bingo, group: 'entity', kind: 'team', label: 'Bingo' });
    expect(out.links).toHaveLength(8);
    // Round robin: one of each kind before a second of any.
    const kinds = new Set(h.mind.links(bingo, { limit: 200 }).links.map((l) => l.role));
    expect(new Set(out.links.slice(0, kinds.size).map((l) => l.role)).size).toBe(kinds.size);
    for (const l of out.links) {
      expect(l.node.ref).toBe(l.ref);
      expect(['solid', 'dashed', 'thin']).toContain(l.style);
      expect(l.w).toBeGreaterThanOrEqual(0);
      expect(l.w).toBeLessThanOrEqual(1);
    }
    const all = h.mind.links(bingo, { limit: 200 }).links;
    expect(all.some((l) => l.ref === F.F10 && l.node.private)).toBe(true);
    const suggested = all.find((l) => l.node.suggested);
    expect(suggested?.style).toBe('dashed');
    // An item: its entities, parent and children, and related items (dashed).
    const f6 = h.mind.links(F.F6, { limit: 200 });
    expect(f6.node).toMatchObject({ ref: F.F6, kind: 'meeting' });
    expect(f6.links.some((l) => l.ref === bingo && l.role === 'entities')).toBe(true);
    expect(f6.links.filter((l) => l.role === 'actions').length).toBeGreaterThan(0);
    const child = h.mind.childrenOf(F.F6)[0];
    expect(h.mind.links(child.id).links.find((l) => l.ref === F.F6).role).toBe('parent');
    // The overview, junk and the port.
    expect(h.mind.links('o').links.length).toBeGreaterThan(0);
    expect(h.mind.links('../x')).toBeNull();
    expect(h.mind.links('e0000000000zzzz')).toBeNull();
    expect(h.mind.port.links(bingo, { limit: 2 }).links).toHaveLength(2);
  });

  it('pins merge across windows under the lock, and stay capped and clean', async () => {
    const host = createMemoryHost();
    const a = new Mind(makeContext(host));
    const b = new Mind(makeContext(host, { invoke: host.connect().invoke }));
    await a.ready();
    await b.ready();
    await a.loadLayout();
    await b.loadLayout();
    await Promise.all([a.setPins({ o: { x: 10, y: 20 } }), b.setPins({ me: { x: -5, y: 7 } })]);
    const stored = JSON.parse(host.files.get('mm-layout'));
    expect(Object.keys(stored.pins).sort()).toEqual(['me', 'o']);
    expect(stored.pins.o).toMatchObject({ x: 10, y: 20, at: FIXTURE_NOW });
    expect(await a.setPins({ o: null, '../x': { x: 1, y: 1 } })).toMatchObject({ ok: true });
    expect(Object.keys(JSON.parse(host.files.get('mm-layout')).pins)).toEqual(['me']);
    expect(await a.setPins({})).toMatchObject({ ok: false, code: 'noop' });
    // Bad stored values are dropped on read.
    host.files.set('mm-layout', JSON.stringify({ schema: 1, rev: 9, pins: { o: { x: 'a', y: 1 }, me: { x: 1, y: 2, at: 3 }, bad: { x: 1, y: 1 }, e00000000000001: { x: 1e9, y: 0 } } }));
    expect((await a.loadLayout({ force: true })).pins).toEqual({ me: { x: 1, y: 2, at: 3 } });
    // An unreadable mm-layout is never overwritten.
    host.files.set('mm-layout', '{"pins":');
    host.files.delete('nx-mm-layout');
    expect((await a.loadLayout({ force: true })).unreadable).toBe(true);
    expect(await a.setPins({ o: { x: 1, y: 1 } })).toMatchObject({ ok: false, code: 'unreadable' });
    expect(host.files.get('mm-layout')).toBe('{"pins":');
  });

  it('keeps at most 5,000 pins, the newest', () => {
    const m = new Mind(makeContext(createMemoryHost()));
    const raw = {};
    for (let i = 0; i < 5100; i++) raw[`i${String(i).padStart(14, '0')}`] = { x: i, y: i, at: i };
    const clean = m._cleanPins(raw);
    expect(Object.keys(clean)).toHaveLength(5000);
    expect(clean[`i${String(5099).padStart(14, '0')}`]).toBeTruthy();
    expect(clean[`i${String(0).padStart(14, '0')}`]).toBeUndefined();
  });

  it('mm-view is cleaned on the way in and out', async () => {
    const host = createMemoryHost();
    const m = new Mind(makeContext(host));
    const saved = await m.saveView({ camera: { x: 1.234, y: -5, zoom: 99 }, focus: 'o', history: ['me', '../x', 'o'], lens: { kinds: ['doc', 'nope'], mine: 1 }, scroll: 'sideways', panelOpen: false, extra: 'dropped' });
    expect(saved).toEqual({ schema: 1, camera: { x: 1.2, y: -5, zoom: 4 }, focus: 'o', history: ['me', 'o'], lens: { kinds: ['doc'], mine: true, done: false }, panelOpen: false, updatedAt: FIXTURE_NOW });
    expect(await m.loadView()).toEqual(saved);
    host.files.set('mm-view', 'not json');
    expect(await m.loadView()).toBeNull();
  });

  it('Delete everything removes mm-layout and mm-view; exports carry pins and imports restore them', async () => {
    const host = createMemoryHost();
    const m = new Mind(makeContext(host));
    const out = await m.capture('Bingo planning notes', { via: 'explorer' });
    expect(m.item(out.itemId).source.via).toBe('explorer');
    await m.setPins({ [out.itemId]: { x: 300, y: -40 } });
    await m.saveView({ focus: out.itemId });
    const data = m.exportJson();
    expect(data.layout.pins[out.itemId]).toMatchObject({ x: 300, y: -40 });
    const raw = await m.exportRaw();
    expect(Object.keys(raw)).toEqual(expect.arrayContaining(['mm-layout', 'mm-view']));
    await m.deleteAll();
    expect([...host.files.keys()]).toEqual([]);
    expect(m.pins).toEqual({});
    const back = await m.importJson(JSON.stringify(data));
    expect(back).toMatchObject({ ok: true, pins: 1 });
    expect(JSON.parse(host.files.get('mm-layout')).pins[out.itemId]).toMatchObject({ x: 300, y: -40 });
    // Pins for unknown refs, or older than what's here, aren't imported.
    expect(await m._importPins({ i0000000000zzzz: { x: 1, y: 1, at: 9e15 } })).toBe(0);
    expect(await m._importPins({ [out.itemId]: { x: 1, y: 1, at: 1 } })).toBe(0);
  });

  it('syncs again when a change arrives while a sync is already reading', async () => {
    const m = new Mind(makeContext(createMemoryHost(), { hostFeatures: ['storage.change_events'] }));
    await m.ready();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const sync = vi.spyOn(m, '_sync').mockImplementationOnce(() => gate.then(() => false)).mockImplementation(async () => true);
    const first = m.syncIfStale(0);
    m._onStorageChanged([{ key: 'mm-meta', op: 'save', self: false }]);
    release();
    expect(await first).toBe(true);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(m._remoteChange).toBe(false);
  });

  it('subscribes to change events only where the host has them', async () => {
    const host = createMemoryHost();
    const listeners = [];
    const storage = { onChanged: vi.fn((fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); }) };
    const withEvents = new Mind({ ...makeContext(host, { hostFeatures: ['storage.change_events'] }), storage });
    expect(storage.onChanged).toHaveBeenCalledTimes(1);
    const without = new Mind({ ...makeContext(host), storage });
    expect(storage.onChanged).toHaveBeenCalledTimes(1);
    expect(without._offChanges).toBeNull();
    await withEvents.ready();
    const seen = vi.fn();
    const off = withEvents.onRemoteChange(seen);
    listeners[0]([{ key: 'mm-meta', op: 'save', self: true }]);
    expect(seen).not.toHaveBeenCalled();
    listeners[0]([{ key: 'nx-mm-meta', op: 'save', self: false }, { key: 'mm-layout', op: 'save', self: false }]);
    expect(seen).toHaveBeenLastCalledWith({ data: false, layout: true });
    listeners[0]([{ key: '*', op: 'bulk', self: false }]);
    expect(seen).toHaveBeenLastCalledWith({ data: true, layout: true });
    off();
    withEvents._offChanges();
    expect(listeners).toHaveLength(0);
  });
});
