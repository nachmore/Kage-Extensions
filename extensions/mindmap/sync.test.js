// Mind Map on Kage folder sync (Kage docs/design/SYNC.md §12.6, §12.9,
// §18.6): two simulated computers, each with its own extension data and
// Mind Map windows, on the fake `context.sync` of
// test-helpers/mindmap/sync-host.mjs. host.exchange() plays the sync folder.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMemoryHost } from '../../test-helpers/mindmap/memory-host.mjs';
import { createSyncHost, SYNC_FEATURES } from '../../test-helpers/mindmap/sync-host.mjs';
import { FIXTURE_NOW, makeContext } from '../../test-helpers/mindmap/corpus.mjs';
import { Mind } from './mind.js';
import * as idlib from './lib/ids.js';
import * as journal from './lib/journal.js';
import * as model from './lib/model.js';
import * as syncmap from './lib/syncmap.js';
import MindMapSettingsProvider from './settings.js';
import { renderOpCard } from './view.js';

const MANIFEST = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const FEATURES = ['storage.atomic_write', 'storage.change_events', 'config.manifest_defaults'];
const META_KEY = 'mm-meta';

function computer(folder, name, { config = {}, sync = {}, hostFeatures = FEATURES, offline = false } = {}) {
  const disk = createMemoryHost({ atomic: true, handlers: { fetch_link_metadata: async () => null } });
  const node = offline ? null : folder.computer(name, sync);
  const open = (invoke) => {
    const ctx = makeContext(disk, { config, hostFeatures, invoke });
    if (node) node.install(ctx);
    return new Mind(ctx, { idleDelayMs: 1e9 });
  };
  const c = { name, disk, sync: node, mind: open(), open: () => open(disk.connect().invoke) };
  c.meta = () => JSON.parse(disk.files.get(META_KEY) || 'null');
  c.pushes = () => (node?.calls || []).filter((call) => call.method === 'push');
  return c;
}

async function settle(...computers) {
  for (let round = 0; round < 3; round++) {
    for (const c of computers) await c.mind.whenIdle();
  }
}

// The sync folder carries every computer's changes to the others, and each
// pulls what it was told about.
async function exchange(folder, ...computers) {
  for (let round = 0; round < 4; round++) {
    await settle(...computers);
    if (!folder.exchange()) break;
  }
  await settle(...computers);
}

async function pair(opts = {}) {
  const folder = createSyncHost({ manifest: MANIFEST });
  const a = computer(folder, 'A', opts.a);
  const b = computer(folder, 'B', opts.b);
  await Promise.all([a.mind.ready(), b.mind.ready()]);
  await exchange(folder, a, b);
  return { folder, a, b };
}

const titles = (mind) => [...mind.state.items.values()].map((item) => item.title).sort();

describe('model.applyRemote and the journal', () => {
  const NOW = FIXTURE_NOW;
  const env = (extra = {}) => {
    const pool = idlib.createIdPool();
    return { now: NOW, newId: (prefix) => pool.next(prefix, NOW), journal, relationId: syncmap.relationId, ...extra };
  };
  const item = (id, extra = {}) => model.normalizeItem({
    id, kind: 'note', title: id, text: id, createdAt: NOW - 1000, updatedAt: NOW - 1000, entityIds: [], mentionOrigin: {}, keyphrases: [],
    source: { via: 'launcher' }, enrich: { state: 'failed', at: 5 }, rev: 4, v: 3, ...extra,
  });
  const I1 = 'i000000000000a1';
  const I2 = 'i000000000000a2';
  const remoteItems = (pairs) => ({ items: new Map(pairs) });

  it('bumps rev past the local one, keeps local fields, and journals nothing no op can undo', () => {
    const state = model.emptyState(NOW);
    state.items.set(I1, item(I1));
    const record = { ...syncmap.itemRecord(item(I1)), title: 'Renamed', updatedAt: NOW };
    const change = model.applyRemote(state, remoteItems([[I1, syncmap.withLocal('items', record, state.items.get(I1))]]), env());
    expect(state.items.get(I1)).toMatchObject({ title: 'Renamed', rev: 5, v: 3, enrich: { state: 'failed', at: 5 } });
    expect(change).toMatchObject({ remote: true, unjournaled: true });
    expect(change.op).toMatchObject({ kind: 'sync', silent: true, after: {} });
    expect([...change.touched]).toEqual([`items:${new Date(NOW - 1000).toISOString().slice(0, 7)}`]);
    // The same record again changes nothing.
    expect(model.applyRemote(state, remoteItems([[I1, syncmap.withLocal('items', record, state.items.get(I1))]]), env()).code).toBe('noop');
  });

  it('records revs only for what an op could undo, and takes the previous sync op’s place', () => {
    const state = model.emptyState(NOW);
    state.items.set(I1, item(I1));
    state.items.set(I2, item(I2));
    state.ops = [{ ...journal.newOp({ opId: 'o00000000000001', kind: 'capture', at: NOW }), after: { [I1]: 4 } }];
    const first = model.applyRemote(state, remoteItems([[I1, null], [I2, { ...syncmap.itemRecord(item(I2)), title: 'x' }]]), env());
    expect(first.op.after).toEqual({ [I1]: null });
    state.ops = journal.appendOp(state.ops, first.op);
    expect(journal.canUndo(state, state.ops[0])).toEqual({ ok: false, code: 'superseded' });
    expect(journal.canUndo(state, first.op)).toEqual({ ok: false, code: 'missing' });
    // A later pull replaces it, keeping what it recorded.
    const second = model.applyRemote(state, remoteItems([[I2, { ...syncmap.itemRecord(item(I2)), title: 'y' }]]), env({ newId: () => 'o00000000000009' }));
    expect(second.unjournaled).toBe(false);
    expect(second.op.after).toEqual({ [I1]: null });
    expect(state.ops.map((o) => o.kind)).toEqual(['capture']);
  });

  it('keeps an undo superseded even when a silent op touched the record after the pull', () => {
    const state = model.emptyState(NOW);
    state.items.set(I1, item(I1, { rev: 1 }));
    const capture = { ...journal.newOp({ opId: 'o00000000000001', kind: 'capture', at: NOW }), after: { [I1]: 1 } };
    state.ops = [capture];
    const pull = model.applyRemote(state, remoteItems([[I1, { ...syncmap.itemRecord(item(I1)), title: 'there' }]]), env());
    state.ops = journal.appendOp(state.ops, pull.op);
    const enrich = { ...journal.newOp({ opId: 'o00000000000003', kind: 'enrich', at: NOW, silent: true }), after: { [I1]: 3 } };
    state.items.set(I1, { ...state.items.get(I1), rev: 3 });
    state.ops = journal.appendOp(state.ops, enrich);
    expect(journal.lastUndoable(state.ops)).toBe(capture);
    expect(journal.canUndo(state, capture)).toEqual({ ok: false, code: 'superseded' });
  });

  it('leaves private items alone with "Sync private items" off', () => {
    const state = model.emptyState(NOW);
    state.items.set(I1, item(I1, { private: true }));
    const remote = remoteItems([[I1, { ...syncmap.itemRecord(item(I1)), title: 'shared copy' }]]);
    expect(model.applyRemote(state, remote, env({ syncPrivate: false })).code).toBe('noop');
    expect(model.applyRemote(state, remoteItems([[I1, null]]), env({ syncPrivate: false })).code).toBe('noop');
    expect(state.items.get(I1).title).toBe(I1);
    expect(model.applyRemote(state, remote, env()).op).toBeTruthy();
  });

  it('merges same-name entities into the smallest id, and skips me, stale bodies and relations under the wrong id', () => {
    const state = model.emptyState(NOW);
    const ea = { id: 'e00000000000002', type: 'topic', name: 'MTCS', key: 'mtcs', aliases: [], origin: 'rule', createdAt: 1, updatedAt: 1, rev: 1 };
    state.entities.set(ea.id, ea);
    state.items.set(I1, item(I1, { body: { key: `mm-body-${I1}-5`, chars: 9, bytes: 9 } }));
    const change = model.applyRemote(state, {
      entities: new Map([['e00000000000001', { ...ea, id: 'e00000000000001', updatedAt: 7 }], ['me', { name: 'Not me' }]]),
      bodies: new Map([[I1, syncmap.bodyFromRecord(I1, { key: `mm-body-${I1}-2`, format: 'text', chars: 3, text: 'old' })]]),
      links: new Map([['wrong-id', { s: I1, t: I2, type: 'related', at: 1 }]]),
    }, env());
    expect(state.entities.get('e00000000000002')).toMatchObject({ mergedInto: 'e00000000000001', updatedAt: 1, rev: 2 });
    expect(state.entities.get('me').name).toBe('Me');
    expect(change.dedupe).toEqual(['e00000000000002']);
    expect(change.bodies).toEqual([]);
    expect(state.links).toEqual([]);
    expect(change.counts.skipped).toBe(2);
  });
});

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXTURE_NOW);
});
afterAll(() => vi.useRealTimers());
afterEach(() => vi.setSystemTime(FIXTURE_NOW));

describe('two computers converge', () => {
  it('on a capture: the note, its actions and its names', async () => {
    const { folder, a, b } = await pair();
    const out = await a.mind.capture('Bingo team sync\n- [ ] Send MTCS numbers to Dana by Friday\n- I’ll book the offsite');
    await exchange(folder, a, b);
    const note = b.mind.item(out.itemId);
    expect(note).toMatchObject({ title: 'Bingo team sync', kind: 'meeting' });
    expect(out.childIds.map((id) => b.mind.item(id)?.title).sort()).toEqual(out.childIds.map((id) => a.mind.item(id).title).sort());
    expect(b.mind.resolveEntity('bingo')?.entityId).toBe(a.mind.resolveEntity('bingo')?.entityId);
    // Local fields stay local: an item new on B was fetched where it was saved.
    expect(note.enrich).toEqual({ state: 'done' });
    expect(titles(b.mind)).toEqual(titles(a.mind));
  });
});

describe('changes on either side', () => {
  it('a status change on one computer reaches the other, and an applied change is never pushed back', async () => {
    const { folder, a, b } = await pair();
    const { itemId } = await a.mind.capture('todo: email the bingo team about the demo date');
    await exchange(folder, a, b);
    const pushedByB = b.pushes().flatMap((call) => call.ids);
    expect(pushedByB).not.toContain(itemId);
    expect((await b.mind.setStatus(itemId, 'done')).ok).toBe(true);
    await exchange(folder, a, b);
    expect(a.mind.item(itemId)).toMatchObject({ status: 'done' });
    expect(a.mind.item(itemId).doneAt).toBe(b.mind.item(itemId).doneAt);
  });

  it('merges edits to different fields made on both computers before they sync', async () => {
    const { folder, a, b } = await pair();
    const { itemId } = await a.mind.capture('todo: call the Zebra team about invoices');
    await exchange(folder, a, b);
    await a.mind.setArchived(itemId, true);
    await b.mind.setStatus(itemId, 'done');
    await exchange(folder, a, b);
    for (const c of [a, b]) expect(c.mind.item(itemId)).toMatchObject({ archived: true, status: 'done' });
  });

  it('a delete on one computer removes the item on the other', async () => {
    const { folder, a, b } = await pair();
    const { itemId } = await a.mind.capture('Lunch with Dana, talked about hiring');
    await exchange(folder, a, b);
    expect(b.mind.item(itemId)).not.toBeNull();
    expect((await b.mind.remove(itemId)).ok).toBe(true);
    await exchange(folder, a, b);
    expect(a.mind.item(itemId)).toBeNull();
    expect(b.mind.item(itemId)).toBeNull();
  });

  it('undo of a local op that another computer changed since is refused as superseded', async () => {
    const { folder, a, b } = await pair();
    const { itemId, opId } = await a.mind.capture('todo: review the Bingo launch checklist');
    await exchange(folder, a, b);
    await b.mind.setStatus(itemId, 'done');
    await exchange(folder, a, b);
    // The pull is silent: mm undo still targets the capture, and refuses it.
    expect(a.mind.undoTarget()).toMatchObject({ op: { opId }, verdict: { ok: false, code: 'superseded' } });
    expect(await a.mind.undo()).toEqual({ ok: false, code: 'superseded' });
    expect(a.mind.item(itemId)).toMatchObject({ status: 'done' });
  });

  it('undo still works for a change nobody else touched, and the undo syncs', async () => {
    const { folder, a, b } = await pair();
    const first = await a.mind.capture('Notes on the Atlas project');
    await b.mind.capture('Lunch with Dana');
    await exchange(folder, a, b);
    expect((await a.mind.undo()).ok).toBe(true);
    await exchange(folder, a, b);
    expect(a.mind.item(first.itemId)).toBeNull();
    expect(b.mind.item(first.itemId)).toBeNull();
    expect(titles(a.mind)).toEqual(['Lunch with Dana']);
  });
});

describe('names', () => {
  it('two computers that both made the same name end up with one', async () => {
    const { folder, a, b } = await pair();
    const one = await a.mind.capture('Draft the #mtcs capacity plan');
    const two = await b.mind.capture('Ask about the #mtcs budget');
    const ea = a.mind.resolveEntity('mtcs').entityId;
    const eb = b.mind.resolveEntity('mtcs').entityId;
    expect(ea).not.toBe(eb);
    await exchange(folder, a, b);
    const keep = [ea, eb].sort()[0];
    const gone = [ea, eb].sort()[1];
    for (const c of [a, b]) {
      expect(c.mind.state.entities.get(gone).mergedInto).toBe(keep);
      expect(c.mind.state.entities.get(keep).mergedInto).toBeUndefined();
      expect(c.mind.resolveEntity('mtcs').entityId).toBe(keep);
      // Items that name the merged-away copy resolve through the redirect.
      expect(c.mind.itemsOf(keep).map((item) => item.id).sort()).toEqual([one.itemId, two.itemId].sort());
    }
    // Both computers pushed the same redirect: nothing is left to deliver.
    expect(folder.exchange()).toBe(0);
    expect(a.sync.record('entities', gone)).toMatchObject({ mergedInto: keep });
  });
});

describe('private items', () => {
  it('sync, encrypted, with the setting on, and stay away from the agent on every computer', async () => {
    const { folder, a, b } = await pair();
    const { itemId } = await a.mind.capture('! bingo salary thoughts');
    await exchange(folder, a, b);
    const there = b.mind.item(itemId);
    expect(there.private).toBe(true);
    expect(b.mind.isHidden(there)).toBe(true);
    expect(b.mind.find(b.mind.parse('salary'), { forAgent: true }).hits).toEqual([]);
  });

  it('stay on their computer with the setting off; making a synced item private takes it off the others', async () => {
    const config = { sync_private_items: false };
    const { folder, a, b } = await pair({ a: { config }, b: { config } });
    const secret = await a.mind.capture('! bingo salary thoughts');
    const lunch = await a.mind.capture('Lunch with Dana, talked about hiring');
    await exchange(folder, a, b);
    expect(b.mind.item(secret.itemId)).toBeNull();
    expect(a.pushes().flatMap((call) => call.ids)).not.toContain(secret.itemId);
    expect(b.mind.item(lunch.itemId)).not.toBeNull();
    const out = await a.mind.setPrivate(lunch.itemId, true);
    expect(out).toMatchObject({ ok: true, keptHere: true });
    await exchange(folder, a, b);
    expect(b.mind.item(lunch.itemId)).toBeNull();
    expect(a.mind.item(lunch.itemId)).toMatchObject({ private: true });
    // The card says where it went.
    const html = renderOpCard(a.mind.opVM(out.opId), { t: (key) => key });
    expect(html).toContain('card.kept_here');
    // Back to shared: it comes back.
    await a.mind.setPrivate(lunch.itemId, false);
    await exchange(folder, a, b);
    expect(b.mind.item(lunch.itemId)).toMatchObject({ title: a.mind.item(lunch.itemId).title });
  });

  it('turning the setting back on sends the private items this computer kept', async () => {
    const config = { sync_private_items: false };
    const { folder, a, b } = await pair({ a: { config }, b: { config } });
    const secret = await a.mind.capture('! bingo salary thoughts');
    await exchange(folder, a, b);
    expect(b.mind.item(secret.itemId)).toBeNull();
    a.mind.setConfig({ sync_private_items: true });
    await exchange(folder, a, b);
    expect(b.mind.item(secret.itemId)).toMatchObject({ private: true });
  });
});

describe('crash safety', () => {
  it('a commit whose push never went out is pushed by the next window that loads', async () => {
    const { folder, a, b } = await pair();
    // Every push fails until this window is gone (Kage quit before they went out).
    a.sync.failNext('push', { times: 50 });
    const { itemId } = await a.mind.capture('Notes on the Atlas project');
    await settle(a);
    expect(a.meta().syncPending?.items?.[itemId]).toMatch(/^p:o/);
    folder.exchange();
    await settle(b);
    expect(b.mind.item(itemId)).toBeNull();
    // Kage restarts: a new window on the same data pushes what's marked.
    a.sync.clearFailures();
    const again = a.open();
    await again.ready();
    await again.whenIdle();
    await exchange(folder, a, b);
    expect(b.mind.item(itemId)).toMatchObject({ title: 'Notes on the Atlas project' });
    await again.whenIdle();
    expect(a.meta().syncPending).toBeUndefined();
  });

  it('a pull waits while this computer’s own changes haven’t gone out, so they aren’t overwritten', async () => {
    const { folder, a, b } = await pair();
    const { itemId } = await a.mind.capture('todo: call the Zebra team about invoices');
    await exchange(folder, a, b);
    // A's push fails (Kage busy); B changes another field of the same item.
    a.sync.failNext('push', { times: 50 });
    await a.mind.setArchived(itemId, true);
    await b.mind.setStatus(itemId, 'done');
    await exchange(folder, a, b);
    expect(a.mind.item(itemId)).toMatchObject({ archived: true });
    expect(a.meta().syncPending?.items?.[itemId]).toMatch(/^p:o/);
    // Once A's push goes out, both computers have both changes.
    a.sync.clearFailures();
    a.mind._syncKick('pending', 'pull');
    await exchange(folder, a, b);
    for (const c of [a, b]) expect(c.mind.item(itemId)).toMatchObject({ archived: true, status: 'done' });
  });

  it('clears what Kage accepted from mm-meta', async () => {
    const { folder, a, b } = await pair();
    await a.mind.capture('Notes on the Atlas project');
    await exchange(folder, a, b);
    expect(a.meta().syncPending).toBeUndefined();
  });
});

describe('the first push', () => {
  it('sends what a computer had before sync, stamped by updatedAt so the newer copy wins', async () => {
    const folder = createSyncHost({ manifest: MANIFEST });
    const a = computer(folder, 'A', { sync: { available: false } });
    const b = computer(folder, 'B', { sync: { available: false } });
    await Promise.all([a.mind.ready(), b.mind.ready()]);
    // The same item on both computers (one export imported twice), changed later on A.
    const { itemId } = await a.mind.capture('Notes on the Atlas project');
    const data = a.mind.exportJson();
    expect((await b.mind.importJson(JSON.stringify(data))).ok).toBe(true);
    vi.setSystemTime(FIXTURE_NOW + 60_000);
    await a.mind.setArchived(itemId, true);
    await settle(a, b);
    expect(a.pushes()).toEqual([]);
    // A turns sync on first, then B, whose copy is older.
    a.sync.enable();
    await exchange(folder, a, b);
    b.sync.enable();
    await exchange(folder, a, b);
    expect(b.pushes().some((call) => call.initial)).toBe(true);
    for (const c of [a, b]) expect(c.mind.item(itemId)).toMatchObject({ archived: true });
  });

  it('pulls only after this computer’s own first push', async () => {
    const folder = createSyncHost({ manifest: MANIFEST });
    const a = computer(folder, 'A');
    await a.mind.ready();
    await a.mind.capture('Lunch with Dana');
    await settle(a);
    const b = computer(folder, 'B');
    folder.exchange();
    await b.mind.ready();
    await settle(a, b);
    const calls = b.sync.calls.map((call) => call.method);
    const firstPull = calls.indexOf('pull');
    expect(firstPull).toBeGreaterThan(-1);
    expect(calls.slice(0, firstPull)).toContain('status');
    expect(b.meta()?.syncTag).toBe(b.sync.tag);
    expect(titles(b.mind)).toEqual(['Lunch with Dana']);
  });
});

describe('documents, pins and delete everything', () => {
  const ITEM = 'i0000000000doc1';
  const SECRET = 'i0000000000doc2';
  const text = 'Q3 plan. '.repeat(1200);
  function exportWithDocs() {
    const at = FIXTURE_NOW - 86_400_000;
    const doc = (id, extra) => ({
      id, kind: 'doc', title: `${id} plan`, titleSource: 'auto', text: text.slice(0, 8000), truncated: true, createdAt: at, updatedAt: at,
      entityIds: [], mentionOrigin: {}, keyphrases: [], source: { via: 'file' }, enrich: { state: 'none' }, rev: 1, v: 1,
      file: { name: 'plan.txt', ext: 'txt', format: 'text', size: text.length, sha256: 'b'.repeat(64), chars: text.length, truncated: false, warnings: [] },
      body: { key: `mm-body-${id}-2`, chars: text.length, bytes: text.length },
      ...extra,
    });
    return {
      format: 'kage-mindmap', schema: 1, exportedAt: FIXTURE_NOW,
      items: [doc(ITEM), doc(SECRET, { private: true, file: { name: 'keys.txt', ext: 'txt', format: 'text', size: text.length, sha256: 'c'.repeat(64), chars: text.length, truncated: false, warnings: ['possible_secret'] } })],
      entities: [], links: [], rejections: [],
      bodies: { [ITEM]: text, [SECRET]: text },
    };
  }

  it('a document’s full text syncs; one Kage thinks holds a password or key never leaves', async () => {
    const { folder, a, b } = await pair();
    expect((await a.mind.importJson(JSON.stringify(exportWithDocs()))).ok).toBe(true);
    await exchange(folder, a, b);
    const doc = b.mind.item(ITEM);
    expect(doc).toMatchObject({ title: `${ITEM} plan` });
    expect((await b.mind.loadBody(doc))?.text).toBe(text);
    expect(b.mind.item(SECRET)).toBeNull();
    const sent = a.pushes().flatMap((call) => [...call.ids, ...call.deletedIds]);
    expect(sent).not.toContain(SECRET);
  });

  it('pins move between computers, and Reset map layout resets them everywhere', async () => {
    const { folder, a, b } = await pair();
    const { itemId } = await a.mind.capture('Notes on the Atlas project');
    await exchange(folder, a, b);
    expect((await a.mind.setPins({ [itemId]: { x: 120, y: -40 } })).ok).toBe(true);
    await exchange(folder, a, b);
    expect((await b.mind.loadLayout({ force: true })).pins[itemId]).toMatchObject({ x: 120, y: -40 });
    await b.mind.resetLayout();
    await exchange(folder, a, b);
    expect((await a.mind.loadLayout({ force: true })).pins).toEqual({});
  });

  it('Delete everything with sync on deletes the mind map on the other computers too', async () => {
    const { folder, a, b } = await pair();
    await a.mind.capture('Notes on the #atlas project');
    await b.mind.capture('Lunch with Dana');
    await exchange(folder, a, b);
    expect(titles(b.mind)).toHaveLength(2);
    expect((await a.mind.deleteAll()).synced).toBe(true);
    await exchange(folder, a, b);
    expect(titles(b.mind)).toEqual([]);
    expect([...b.mind.state.entities.keys()]).toEqual(['me']);
    await a.mind.whenIdle();
    expect(a.meta().syncPending).toBeUndefined();
  });
});

describe('without Kage folder sync', () => {
  it('works unchanged on a Kage without sync.records', async () => {
    const folder = createSyncHost({ manifest: MANIFEST });
    const c = computer(folder, 'Old', { offline: true });
    expect(c.mind.canSync).toBe(false);
    expect(c.mind.syncOn).toBe(false);
    const { itemId } = await c.mind.capture('Notes on the Atlas project');
    await c.mind.whenIdle();
    expect(c.mind.item(itemId)).not.toBeNull();
    expect(c.meta().syncPending).toBeUndefined();
    expect(c.meta().syncTag).toBeUndefined();
    expect(await c.mind.syncInfo()).toEqual({ supported: false, available: false });
  });

  it('ignores a context.sync without the host feature', async () => {
    const folder = createSyncHost({ manifest: MANIFEST });
    const node = folder.computer('Half');
    const disk = createMemoryHost({ atomic: true });
    const ctx = makeContext(disk, { hostFeatures: FEATURES });
    ctx.sync = node.api;
    const mind = new Mind(ctx, { idleDelayMs: 1e9 });
    await mind.capture('Lunch with Dana');
    await mind.whenIdle();
    expect(node.calls).toEqual([]);
    expect(SYNC_FEATURES).toEqual(['sync.records']);
  });

  it('pushes nothing while Kage sync is off for Mind Map here', async () => {
    const folder = createSyncHost({ manifest: MANIFEST });
    const c = computer(folder, 'Off', { sync: { available: false } });
    await c.mind.capture('Lunch with Dana');
    await c.mind.whenIdle();
    expect(c.pushes()).toEqual([]);
    expect(c.meta().syncPending).toBeUndefined();
  });
});

describe('settings', () => {
  const controls = (schema) => schema.sections.flatMap((section) => section.controls);
  const html = (schema) => controls(schema).filter((c) => c.type === 'info').map((c) => c.html).join('\n');
  function settings({ sync, hostFeatures = FEATURES, config = {} } = {}) {
    const disk = createMemoryHost({ atomic: true });
    const ctx = makeContext(disk, { hostFeatures, config });
    if (sync) sync.install(ctx);
    const p = new MindMapSettingsProvider();
    p.initialize(ctx);
    return p;
  }

  it('shows where the mind map is kept, the status and "Sync private items" right after Privacy', async () => {
    const folder = createSyncHost({ manifest: MANIFEST });
    folder.computer('Other');
    const p = settings({ sync: folder.computer('This one') });
    const schema = await p.getSettings();
    const titles = schema.sections.map((section) => section.label);
    expect(titles.slice(0, 2)).toEqual(['Privacy', 'Sync between your computers']);
    const section = schema.sections[1];
    expect(section.controls.find((c) => c.id === 'sync_private_items')).toMatchObject({ type: 'checkbox', default: true });
    expect(section.controls[0].html).toContain('On through Kage sync, with 1 other computer.');
    expect(html(schema)).toContain('With Kage sync on, your mind map is also kept, encrypted, in your sync folder');
    // Delete everything says it goes from the other computers too.
    expect(controls(schema).find((c) => c.id === 'delete_all').confirm).toContain('from your other computers');
    await p.mind.whenIdle();
  });

  it('says so when Kage sync is off for Mind Map here', async () => {
    const folder = createSyncHost({ manifest: MANIFEST });
    const p = settings({ sync: folder.computer('Off', { available: false }) });
    const schema = await p.getSettings();
    expect(html(schema)).toContain('Kage sync is off for Mind Map on this computer');
    expect(controls(schema).find((c) => c.id === 'delete_all').confirm).not.toContain('other computers');
    await p.mind.whenIdle();
  });

  it('shows none of it on a Kage without folder sync, and keeps the saved value on an older one', async () => {
    const schema = await settings().getSettings();
    expect(schema.sections.map((section) => section.label)).not.toContain('Sync between your computers');
    expect(html(schema)).not.toContain('sync folder');
    expect(controls(schema).find((c) => c.id === 'sync_private_items')).toBeUndefined();
    const old = await settings({ hostFeatures: [] }).getSettings();
    expect(controls(old).find((c) => c.id === 'sync_private_items')).toMatchObject({ default: true, showWhen: { id: 'sync_private_items', oneOf: [] } });
  });
});
