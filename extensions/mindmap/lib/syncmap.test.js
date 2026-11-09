// lib/syncmap.js: Mind Map's records as Kage folder sync sees them (Kage
// docs/design/SYNC.md §12.9): collections, sync ids, local fields, what may
// leave this computer, push batches and the full push's keys.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as syncmap from './syncmap.js';
import * as model from './model.js';

const MANIFEST = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 10, 6, 10);
const ID = (n) => `i${String(n).padStart(14, '0')}`;
const EID = (n) => `e${String(n).padStart(14, '0')}`;

function item(n, extra = {}) {
  return model.normalizeItem({
    id: ID(n), kind: 'note', title: `Note ${n}`, text: `Note ${n}`, createdAt: NOW, updatedAt: NOW,
    entityIds: [], mentionOrigin: {}, keyphrases: [], source: { via: 'launcher' }, enrich: { state: 'none' }, rev: 3, v: 2, ...extra,
  });
}

describe('the manifest and the leaf agree', () => {
  it('declares every collection the leaf writes, with the same local fields', () => {
    const collections = MANIFEST.sync.collections;
    expect(Object.keys(collections).sort()).toEqual([...syncmap.COLLECTIONS].sort());
    expect(collections.items.local).toEqual([...syncmap.LOCAL_FIELDS.items]);
    expect(collections.entities.local).toEqual([...syncmap.LOCAL_FIELDS.entities]);
    expect(MANIFEST.permissions).toContain('sync');
  });

  it('keeps the design groups, sets and maps for items (SYNC §12.9)', () => {
    const items = MANIFEST.sync.collections.items;
    expect(items.together).toEqual([['status', 'doneAt', 'suggested', 'confidence'], ['title', 'titleSource'], ['summary', 'summarySource'], ['url', 'canonicalUrl']]);
    expect(items.sets).toEqual(['entityIds', 'terms']);
    expect(items.maps).toEqual(['mentionOrigin']);
    expect(MANIFEST.sync.collections.bodies).toEqual({ whole: true, large: true, maxBytes: 4194304 });
  });

  it('syncs my_names everywhere and background organizing on this computer only', () => {
    expect(MANIFEST.config.my_names.sync).toBe('shared');
    expect(MANIFEST.config.background_organize.sync).toBe('machine');
    expect(MANIFEST.config.sync_private_items).toEqual({ type: 'boolean', default: true });
  });
});

describe('records', () => {
  it('strips the local fields of an item and keeps everything else', () => {
    const x = item(1, { fileRefs: ['fr1_AAAAAAAAAAAAAAAAAAAAAA'], org: { state: 'done', v: 1, at: NOW, hash: 'abc' }, source: { via: 'launcher', app: 'Notes', window: 'Plan' } });
    const record = syncmap.itemRecord(x);
    for (const field of ['rev', 'enrich', 'v', 'fileRefs']) expect(record).not.toHaveProperty(field);
    expect(record).toMatchObject({ id: ID(1), title: 'Note 1', org: { state: 'done' }, source: { app: 'Notes', window: 'Plan' } });
    expect(x.rev).toBe(3);
  });

  it('never makes a record of me, and strips an entity rev', () => {
    expect(syncmap.entityRecord({ id: 'me', type: 'person', name: 'Me', rev: 1 })).toBeNull();
    expect(syncmap.entityRecord({ id: EID(1), type: 'team', name: 'Bingo', key: 'bingo', aliases: [], rev: 4 })).toEqual({ id: EID(1), type: 'team', name: 'Bingo', key: 'bingo', aliases: [] });
  });

  it('puts this computer’s local fields back on a record from elsewhere', () => {
    const local = item(1, { enrich: { state: 'failed', at: NOW }, fileRefs: ['fr1_AAAAAAAAAAAAAAAAAAAAAA'] });
    const remote = { ...syncmap.itemRecord(local), title: 'Renamed', rev: 99, enrich: { state: 'pending' } };
    const back = syncmap.withLocal('items', remote, local, { extractorVersion: 5 });
    expect(back).toMatchObject({ title: 'Renamed', rev: 3, v: 2, enrich: { state: 'failed', at: NOW }, fileRefs: ['fr1_AAAAAAAAAAAAAAAAAAAAAA'] });
  });

  it('gives an item new here enrich done (its title was fetched where it was saved) and this organizer’s version', () => {
    const back = syncmap.withLocal('items', syncmap.itemRecord(item(2)), undefined, { extractorVersion: 5 });
    expect(back.enrich).toEqual({ state: 'done' });
    expect(back.v).toBe(5);
    expect(back).not.toHaveProperty('rev');
    expect(back).not.toHaveProperty('fileRefs');
  });

  it('shapes relations, bodies and pins', () => {
    expect(syncmap.relationRecord({ s: ID(1), t: EID(1), type: 'mention', at: 5, extra: 1 })).toEqual({ s: ID(1), t: EID(1), type: 'mention', at: 5 });
    const body = { schema: 1, id: ID(1), rev: 4, format: 'pdf', chars: 3, text: 'abc', pageStarts: [0, 2] };
    expect(syncmap.bodyRecord(`mm-body-${ID(1)}-4`, body)).toEqual({ key: `mm-body-${ID(1)}-4`, format: 'pdf', chars: 3, text: 'abc', pageStarts: [0, 2] });
    expect(syncmap.pinRecord({ x: 1, y: -2, at: 7 })).toEqual({ x: 1, y: -2, at: 7 });
  });

  it('turns a body record back into the stored value, only for its own item', () => {
    const record = { key: `mm-body-${ID(1)}-4`, format: 'pdf', chars: 3, text: 'abc', pageStarts: [0, 2] };
    const out = syncmap.bodyFromRecord(ID(1), record);
    expect(out.key).toBe(record.key);
    expect(model.normalizeBody(out.value, out.key)).toEqual({ schema: 1, id: ID(1), rev: 4, format: 'pdf', chars: 3, text: 'abc', pageStarts: [0, 2] });
    expect(syncmap.bodyFromRecord(ID(2), record)).toBeNull();
    expect(syncmap.bodyFromRecord(ID(1), { ...record, key: 'mm-meta' })).toBeNull();
    expect(syncmap.bodyFromRecord(ID(1), { ...record, text: 5 })).toBeNull();
  });
});

describe('relation ids', () => {
  it('is s:t:type when that fits the host’s id rule', () => {
    expect(syncmap.relationId({ s: ID(1), t: EID(2), type: 'mention' })).toBe(`${ID(1)}:${EID(2)}:mention`);
    expect(syncmap.relationId({ s: ID(1), t: ID(2), type: 'related' })).toMatch(syncmap.ID_RE);
  });

  it('hashes an id that names a key, the same way on every computer', () => {
    const forget = { s: '*', t: 'zebra crew', type: 'entity' };
    const id = syncmap.relationId(forget);
    expect(id).toMatch(/^h\.[0-9a-f]{32}$/);
    expect(id).toMatch(syncmap.ID_RE);
    expect(id).not.toContain('zebra');
    expect(syncmap.relationId({ ...forget })).toBe(id);
    expect(syncmap.relationId({ s: '*', t: 'zebra crew!', type: 'entity' })).not.toBe(id);
  });
});

describe('what leaves this computer', () => {
  const secret = (extra = {}) => item(3, { kind: 'doc', file: { name: 'keys.txt', ext: 'txt', format: 'text', sha256: 'a'.repeat(64), warnings: ['possible_secret'] }, ...extra });

  it('keeps a possible_secret document and the actions that quote it here', () => {
    expect(syncmap.itemSyncs(secret())).toBe(false);
    expect(syncmap.itemSyncs(item(4, { kind: 'action', parentId: ID(3) }), { parent: secret() })).toBe(false);
    expect(syncmap.itemSyncs(item(4))).toBe(true);
  });

  it('syncs private items unless "Sync private items" is off', () => {
    const p = item(5, { private: true });
    expect(syncmap.itemSyncs(p)).toBe(true);
    expect(syncmap.itemSyncs(p, { syncPrivate: false })).toBe(false);
    expect(syncmap.entitySyncs({ id: EID(1), private: true }, { syncPrivate: false })).toBe(false);
    expect(syncmap.entitySyncs({ id: 'me' })).toBe(false);
  });

  it('plans a push, a delete when a record stops syncing, and nothing for one that never synced', () => {
    const syncs = (r) => !r.private;
    expect(syncmap.plan(undefined, { id: 1 }, syncs)).toBe('p');
    expect(syncmap.plan({ id: 1 }, undefined, syncs)).toBe('d');
    expect(syncmap.plan({ id: 1 }, { id: 1, private: true }, syncs)).toBe('d');
    expect(syncmap.plan({ id: 1, private: true }, { id: 1, private: true, title: 'x' }, syncs)).toBeNull();
    expect(syncmap.plan(undefined, { id: 1, private: true }, syncs)).toBeNull();
    expect(syncmap.plan(undefined, undefined, syncs)).toBeNull();
  });
});

describe('changes, marks and batches', () => {
  it('groups pulled changes by collection and drops what isn’t ours', () => {
    const grouped = syncmap.groupChanges([
      { collection: 'items', id: ID(1), record: { title: 'a' } },
      { collection: 'items', id: ID(1), record: { title: 'b' } },
      { collection: 'entities', id: 'me', record: {} },
      { collection: 'items', id: 'bad id', record: {} },
      { collection: 'other', id: ID(2), record: {} },
      { collection: 'items', id: ID(3), record: null },
      { collection: 'items', id: ID(4), record: 'x' },
      { collection: 'pins', id: 'o', record: { x: 1, y: 2 } },
    ]);
    expect([...grouped.items]).toEqual([[ID(1), { title: 'b' }], [ID(3), null]]);
    expect(grouped.pins.get('o')).toEqual({ x: 1, y: 2 });
    expect(grouped.skipped).toBe(4);
  });

  it('round-trips pending marks, and mm-meta keeps only well-formed ones', () => {
    const op = 'o00000000000001';
    expect(syncmap.parseMark(syncmap.mark('d', op))).toEqual({ action: 'd', opId: op });
    expect(syncmap.mark('x', op)).toBe(`p:${op}`);
    expect(syncmap.parseMark('x:1')).toBeNull();
    const meta = { schema: 1, rev: 3, syncPending: { items: { [ID(1)]: `p:${op}`, 'bad id': `p:${op}`, [ID(2)]: 'nope' }, other: { a: `p:${op}` } },
      syncFull: { mode: 'initial', next: '0|x', by: 'w1', at: 5 }, syncTag: 'a'.repeat(24) };
    const { state } = model.fromPersisted({ meta });
    expect(state.meta.syncPending).toEqual({ items: { [ID(1)]: `p:${op}` } });
    expect(model.payloadFor(state, 'meta')).toMatchObject({ syncPending: { items: { [ID(1)]: `p:${op}` } }, syncFull: { mode: 'initial', next: '0|x', by: 'w1', at: 5 }, syncTag: 'a'.repeat(24) });
    const bad = model.fromPersisted({ meta: { ...meta, syncPending: { items: { 'bad id': 'p:1' } }, syncFull: { mode: 'later' }, syncTag: 'xyz' } }).state;
    expect(model.payloadFor(bad, 'meta')).not.toHaveProperty('syncPending');
    expect(model.payloadFor(bad, 'meta')).not.toHaveProperty('syncFull');
    expect(model.payloadFor(bad, 'meta')).not.toHaveProperty('syncTag');
  });

  it('splits pushes by collection, count and size', () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, i) => ({ collection: 'items', id: ID(i), record: { title: 'x'.repeat(100) } })),
      { collection: 'items', id: ID(9), record: null },
      { collection: 'entities', id: EID(1), record: { name: 'n' } },
    ];
    const out = syncmap.batches(entries, { maxRecords: 2, maxBytes: 1 << 20 });
    expect(out.map((b) => [b.collection, b.records.length, b.deleted.length])).toEqual([['items', 2, 0], ['items', 2, 0], ['items', 1, 1], ['entities', 1, 0]]);
    expect(out[0].records[0]).toEqual({ id: ID(0), title: 'x'.repeat(100) });
    const big = syncmap.batches(entries.slice(0, 3), { maxRecords: 10, maxBytes: 200 });
    expect(big.map((b) => b.records.length)).toEqual([1, 1, 1]);
  });

  it('walks every record of a full push in a fixed order, without what stays here', () => {
    const state = model.emptyState(NOW);
    state.items.set(ID(1), item(1, { body: { key: `mm-body-${ID(1)}-4`, chars: 9, bytes: 9 } }));
    state.items.set(ID(2), item(2, { private: true }));
    state.items.set(ID(3), item(3, { kind: 'doc', file: { name: 'k.txt', ext: 'txt', format: 'text', sha256: 'a'.repeat(64), warnings: ['possible_secret'] } }));
    state.entities.set(EID(1), { id: EID(1), type: 'team', name: 'Bingo', key: 'bingo', aliases: [], rev: 1 });
    state.rejections.push({ s: '*', t: 'walrus', type: 'entity', at: 1 });
    const keys = syncmap.fullKeys(state, { pins: { o: { x: 1, y: 1, at: 1 } } });
    const split = keys.map((k) => syncmap.splitKey(k));
    expect(split.map((k) => k.collection)).toEqual(['items', 'items', 'entities', 'rejections', 'bodies', 'pins']);
    expect(split.filter((k) => k.collection === 'items').map((k) => k.id)).toEqual([ID(1), ID(2)]);
    expect(syncmap.fullKeys(state, { syncPrivate: false }).map((k) => syncmap.splitKey(k).id)).not.toContain(ID(2));
    expect([...keys].sort()).toEqual(keys);
  });
});
