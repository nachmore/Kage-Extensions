import { describe, expect, it } from 'vitest';
import {
  appendOp, applyUndo, canUndo, lastUndoable, newOp, noteCreated, recordId, sealOp, snapshotBefore,
} from './journal.js';

const NOW = new Date(2026, 10, 6, 10).getTime();
const OCT = Date.UTC(2026, 9, 30, 15);
let seq = 0;
const id = (prefix) => `${prefix}${'0'.repeat(9)}${(seq++).toString(36).padStart(5, '0')}`;
const env = () => ({ now: NOW, newId: id });

const item = (overrides = {}) => ({
  id: id('i'), kind: 'note', title: 't', titleSource: 'auto', text: 'x', createdAt: OCT, updatedAt: OCT,
  entityIds: [], mentionOrigin: {}, keyphrases: [], source: { via: 'launcher' }, enrich: { state: 'none' },
  rev: 1, v: 1, ...overrides,
});
const entity = (overrides = {}) => ({
  id: id('e'), type: 'team', name: 'Bingo', aliases: [], key: 'bingo', origin: 'rule',
  createdAt: OCT, updatedAt: OCT, rev: 1, ...overrides,
});

function stateWith({ items = [], entities = [], candidates = [] } = {}) {
  return {
    items: new Map(items.map((i) => [i.id, i])),
    entities: new Map(entities.map((e) => [e.id, e])),
    candidates: new Map(candidates.map((c) => [c.key, c])),
    links: [], rejections: [], ops: [],
  };
}
const plain = (state) => JSON.parse(JSON.stringify({
  items: [...state.items.values()], entities: [...state.entities.values()],
  candidates: [...state.candidates.values()], links: state.links, rejections: state.rejections,
}));

// A hand-rolled mutation in the same shape model.js produces.
function edit(state, record, patch, { silent = false, kind = 'edit' } = {}) {
  const op = newOp({ opId: id('o'), kind, at: NOW, label: { code: kind, params: {} }, silent });
  snapshotBefore(op, 'items', record);
  const next = { ...record, ...patch, rev: record.rev + 1, updatedAt: NOW };
  state.items.set(record.id, next);
  sealOp(op, state);
  state.ops = appendOp(state.ops, op);
  return op;
}

describe('building ops', () => {
  it('starts with empty groups and the label', () => {
    expect(newOp({ opId: 'o1', kind: 'enrich', at: NOW, silent: true })).toEqual({
      opId: 'o1', at: NOW, kind: 'enrich', label: { code: 'enrich', params: {} }, silent: true,
      before: { items: [], entities: [], links: [], rejections: [], candidates: [] },
      created: { items: [], entities: [], links: [], rejections: [], candidates: [] },
      after: {},
    });
    expect(newOp({ opId: 'o2', kind: 'edit', at: NOW }).silent).toBeUndefined();
  });

  it('keeps the first snapshot per id as a deep copy', () => {
    const op = newOp({ opId: 'o1', kind: 'edit', at: NOW });
    const record = item({ title: 'first' });
    expect(snapshotBefore(op, 'items', record)).toBe(true);
    record.title = 'mutated';
    record.entityIds.push('me');
    expect(snapshotBefore(op, 'items', { ...record, title: 'second' })).toBe(false);
    expect(op.before.items).toHaveLength(1);
    expect(op.before.items[0]).toMatchObject({ title: 'first', entityIds: [] });
  });

  it('never snapshots a record the op created, and never calls a modified record created', () => {
    const op = newOp({ opId: 'o1', kind: 'capture', at: NOW });
    const fresh = item();
    noteCreated(op, 'items', fresh.id);
    noteCreated(op, 'items', fresh.id);
    expect(snapshotBefore(op, 'items', fresh)).toBe(false);
    const old = item();
    snapshotBefore(op, 'items', old);
    noteCreated(op, 'items', old.id);
    expect(op.created.items).toEqual([fresh.id]);
    expect(op.before.items.map((r) => r.id)).toEqual([old.id]);
  });

  it('identifies candidates by key and relations by type|s|t', () => {
    expect(recordId('candidates', { key: 'mtcs' })).toBe('mtcs');
    expect(recordId('rejections', { type: 'entity', s: '*', t: 'dana' })).toBe('entity|*|dana');
    expect(recordId('items', null)).toBeNull();
  });

  it('seals the revs the op left behind, null for deleted records', () => {
    const kept = item({ rev: 3 });
    const gone = item();
    const made = entity();
    const state = stateWith({ items: [kept, gone], entities: [made], candidates: [{ key: 'mtcs', n: 1, sample: ['i1'] }] });
    const op = newOp({ opId: 'o1', kind: 'edit', at: NOW });
    snapshotBefore(op, 'items', kept);
    snapshotBefore(op, 'items', gone);
    state.items.delete(gone.id);
    noteCreated(op, 'entities', made.id);
    snapshotBefore(op, 'candidates', state.candidates.get('mtcs'));
    noteCreated(op, 'candidates', 'qpr');
    sealOp(op, state);
    expect(op.after).toEqual({ [kept.id]: 3, [gone.id]: null, [made.id]: 1 });
    expect(op.cand).toEqual([['mtcs', '1|i1'], ['qpr', null]]);
  });
});

describe('canUndo', () => {
  it('allows the newest change and refuses it once a later edit moved the record', () => {
    const record = item();
    const state = stateWith({ items: [record] });
    const first = edit(state, record, { title: 'a' });
    expect(canUndo(state, first)).toEqual({ ok: true });
    edit(state, state.items.get(record.id), { title: 'b' });
    expect(canUndo(state, first)).toEqual({ ok: false, code: 'superseded' });
  });

  it('ignores silent ops that touched the record afterwards', () => {
    const record = item();
    const state = stateWith({ items: [record] });
    const first = edit(state, record, { status: 'done' });
    edit(state, state.items.get(record.id), { title: 'from metadata' }, { silent: true, kind: 'enrich' });
    edit(state, state.items.get(record.id), { summary: 'desc' }, { silent: true, kind: 'enrich' });
    expect(canUndo(state, first)).toEqual({ ok: true });
  });

  it('reports already-undone, missing, undo and lossy ops', () => {
    const record = item();
    const state = stateWith({ items: [record] });
    const op = edit(state, record, { title: 'a' });
    expect(canUndo(state, null)).toEqual({ ok: false, code: 'missing' });
    expect(canUndo(state, { ...op, opId: 'o-elsewhere' })).toEqual({ ok: false, code: 'missing' });
    expect(canUndo(state, { ...op, lossy: true })).toEqual({ ok: false, code: 'too_large' });
    const undo = applyUndo(state, op, env());
    state.ops = appendOp(state.ops, undo.op);
    expect(canUndo(state, op)).toEqual({ ok: false, code: 'already_undone' });
    expect(canUndo(state, undo.op)).toEqual({ ok: false, code: 'missing' });
  });
});

describe('applyUndo', () => {
  it('restores the exact before-state, deletes what the op created, and marks it undone', () => {
    const parent = item({ id: id('i') });
    const kept = entity({ name: 'MTCS', key: 'mtcs', type: 'term' });
    const state = stateWith({ items: [parent], entities: [kept], candidates: [{ key: 'mtcs', display: 'MTCS', type: 'term', n: 1, firstSeen: OCT, sample: [parent.id] }] });
    state.ops = [];
    const before = plain(state);

    const op = newOp({ opId: id('o'), kind: 'capture', at: NOW });
    const child = item({ kind: 'action', parentId: parent.id, status: 'open' });
    const team = entity();
    noteCreated(op, 'items', child.id);
    noteCreated(op, 'entities', team.id);
    state.items.set(child.id, { ...child, entityIds: [team.id] });
    state.entities.set(team.id, team);
    snapshotBefore(op, 'items', parent);
    state.items.set(parent.id, { ...parent, entityIds: [team.id, kept.id], rev: 2 });
    snapshotBefore(op, 'entities', kept);
    state.entities.set(kept.id, { ...kept, aliases: ['Multi-Tenant Control Service'], rev: 2 });
    snapshotBefore(op, 'candidates', state.candidates.get('mtcs'));
    state.candidates.set('mtcs', { ...state.candidates.get('mtcs'), n: 2, sample: [parent.id, child.id] });
    noteCreated(op, 'candidates', 'qpr');
    state.candidates.set('qpr', { key: 'qpr', display: 'QPR', type: 'term', n: 1, firstSeen: NOW, sample: [child.id] });
    noteCreated(op, 'rejections', 'mention|i1|e1');
    state.rejections.push({ s: 'i1', t: 'e1', type: 'mention', at: NOW });
    sealOp(op, state);
    state.ops = appendOp(state.ops, op);

    const change = applyUndo(state, op, env());
    expect(plain(state)).toEqual(before);
    expect(change.op).toMatchObject({ kind: 'undo', label: { code: 'undo', params: { opId: op.opId, kind: 'capture' } } });
    expect(change.op.before.items).toEqual([]);
    expect(change.touched).toEqual(new Set(['items:2026-10', 'entities', 'links']));
    expect(change.result).toEqual({ undone: op.opId, kind: 'capture' });
    expect(op.undoneBy).toBe(change.op.opId);
    expect(change.op.after).toMatchObject({ [child.id]: null, [team.id]: null, [parent.id]: 1, [kept.id]: 1 });
  });

  it('only takes back its own sightings from a candidate a later capture bumped too', () => {
    const state = stateWith({ candidates: [] });
    const op = newOp({ opId: id('o'), kind: 'capture', at: NOW });
    const mine = item();
    noteCreated(op, 'items', mine.id);
    state.items.set(mine.id, mine);
    noteCreated(op, 'candidates', 'mtcs');
    state.candidates.set('mtcs', { key: 'mtcs', display: 'MTCS', type: 'term', n: 1, firstSeen: NOW, sample: [mine.id] });
    sealOp(op, state);
    state.ops = appendOp(state.ops, op);
    state.candidates.set('mtcs', { key: 'mtcs', display: 'MTCS', type: 'term', n: 2, firstSeen: NOW, sample: [mine.id, 'i-later'] });
    applyUndo(state, op, env());
    expect(state.candidates.get('mtcs')).toEqual({ key: 'mtcs', display: 'MTCS', type: 'term', n: 1, firstSeen: NOW, sample: ['i-later'] });
  });

  it('keeps a created entity that something else still mentions', () => {
    const team = entity();
    const other = item({ entityIds: [team.id] });
    const state = stateWith({ items: [other], entities: [] });
    const op = newOp({ opId: id('o'), kind: 'capture', at: NOW });
    noteCreated(op, 'entities', team.id);
    state.entities.set(team.id, team);
    sealOp(op, state);
    state.ops = appendOp(state.ops, op);
    applyUndo(state, op, env());
    expect(state.entities.has(team.id)).toBe(true);
  });

  it('refuses with a code instead of throwing', () => {
    const record = item();
    const state = stateWith({ items: [record] });
    const op = edit(state, record, { title: 'a' });
    edit(state, state.items.get(record.id), { title: 'b' });
    expect(applyUndo(state, op, env())).toEqual({ op: null, touched: new Set(), code: 'superseded' });
    expect(op.undoneBy).toBeUndefined();
  });
});

describe('children a later silent op gave a created item', () => {
  // A capture that made a note, then background organizing (silent) that
  // gave it a suggested action.
  function organized() {
    const state = stateWith();
    const capture = newOp({ opId: id('o'), kind: 'capture', at: NOW });
    const note = item();
    noteCreated(capture, 'items', note.id);
    state.items.set(note.id, note);
    sealOp(capture, state);
    state.ops = appendOp(state.ops, capture);
    const bg = newOp({ opId: id('o'), kind: 'annotate', at: NOW, silent: true });
    snapshotBefore(bg, 'items', note);
    state.items.set(note.id, { ...note, summary: 'From the agent', rev: 2 });
    const action = item({ kind: 'action', parentId: note.id, status: 'open', suggested: true });
    noteCreated(bg, 'items', action.id);
    state.items.set(action.id, action);
    sealOp(bg, state);
    state.ops = appendOp(state.ops, bg);
    return { state, capture, note, action };
  }

  it('go with their parent when its capture is undone', () => {
    const { state, capture, note, action } = organized();
    expect(canUndo(state, capture)).toEqual({ ok: true });
    const change = applyUndo(state, capture, env());
    expect(state.items.has(note.id)).toBe(false);
    expect(state.items.has(action.id)).toBe(false);
    expect(change.op.after).toEqual({ [note.id]: null, [action.id]: null });
    expect([...change.touched]).toEqual(['items:2026-10']);
  });

  it('make the undo superseded once the user changed one', () => {
    const { state, capture, action } = organized();
    edit(state, action, { suggested: false });
    expect(canUndo(state, capture)).toEqual({ ok: false, code: 'superseded' });
  });

  it('don’t touch other items’ children', () => {
    const { state, capture } = organized();
    const other = item();
    const child = item({ kind: 'action', parentId: other.id });
    state.items.set(other.id, other);
    state.items.set(child.id, child);
    applyUndo(state, capture, env());
    expect(state.items.has(child.id)).toBe(true);
  });
});

describe('appendOp and lastUndoable', () => {
  const op = (overrides = {}) => ({ ...newOp({ opId: id('o'), kind: 'edit', at: NOW }), ...overrides });

  it('caps the journal at maxOps, oldest first out', () => {
    let ops = [];
    const all = Array.from({ length: 205 }, () => op());
    for (const o of all) ops = appendOp(ops, o);
    expect(ops).toHaveLength(200);
    expect(ops[0].opId).toBe(all[5].opId);
    expect(ops[199].opId).toBe(all[204].opId);
  });

  it('caps the serialized size, and makes an op too big on its own lossy', () => {
    const big = (n) => op({ before: { items: [item({ text: 'x'.repeat(n) })], entities: [], links: [], rejections: [], candidates: [] } });
    let ops = [];
    for (let i = 0; i < 10; i++) ops = appendOp(ops, big(1000), { maxBytes: 4000 });
    expect(new TextEncoder().encode(JSON.stringify(ops)).length).toBeLessThanOrEqual(4000);
    expect(ops.length).toBeLessThan(10);
    const kept = ops.map((o) => o.opId);
    const huge = big(10_000);
    ops = appendOp(ops, huge, { maxBytes: 4000 });
    // The huge op loses its snapshots first, so it doesn't push the earlier
    // (still undoable) ops out of the history.
    expect(ops.at(-1)).toMatchObject({ opId: huge.opId, lossy: true, before: { items: [] } });
    expect(ops.slice(0, -1).map((o) => o.opId)).toEqual(kept.slice(kept.length - (ops.length - 1)));
    expect(ops.length).toBeGreaterThan(1);
    expect(new TextEncoder().encode(JSON.stringify(ops)).length).toBeLessThanOrEqual(4000);
  });

  it('replaces an op with the same id in place (a retried mutation)', () => {
    const a = op();
    const b = op();
    const ops = appendOp(appendOp([], a), b);
    const replaced = appendOp(ops, { ...a, label: { code: 'retried', params: {} } });
    expect(replaced.map((o) => o.opId)).toEqual([a.opId, b.opId]);
    expect(replaced[0].label.code).toBe('retried');
    expect(ops[0]).toBe(a);
  });

  it('targets the newest op that is not silent, not undone and not an undo', () => {
    const user = op();
    const done = op({ undoneBy: 'o-x' });
    const silent = op({ silent: true });
    const undo = op({ kind: 'undo' });
    expect(lastUndoable([user, done, silent, undo])).toBe(user);
    expect(lastUndoable([silent])).toBeNull();
    expect(lastUndoable([])).toBeNull();
  });
});
