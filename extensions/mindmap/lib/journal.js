// Leaf module: imports nothing (the host rewrites one level of shared imports).
//
// Journal ops (SPEC §6.4, §7.6). An op records what one user mutation
// changed, so Undo can put it back exactly:
//   before  - a deep copy of every record the op modified or deleted, taken
//             the first time the op touched it (first snapshot wins);
//   created - ids of records the op created (undo deletes them);
//   after   - the rev each touched item/entity was left at (null: deleted).
//             Undo is refused ('superseded') when a later change moved one.
// Record types: items and entities (by id), candidates (by key), links and
// rejections (by "type|s|t"). Candidates carry no rev, so `cand` stores a
// small signature per key: undo restores the snapshot when the candidate is
// as this op left it, and otherwise only removes this op's items from it.
//
// Ops are plain JSON. They never hold user text outside the record
// snapshots, and never use user text as an object key.

export const RECORD_TYPES = Object.freeze(['items', 'entities', 'links', 'rejections', 'candidates']);
const REV_TYPES = ['items', 'entities'];

const clone = (value) => JSON.parse(JSON.stringify(value));
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value)).length;

/** Stable identity of a record within its type. */
export function recordId(type, record) {
  if (!record || typeof record !== 'object') return null;
  if (type === 'items' || type === 'entities') return typeof record.id === 'string' ? record.id : null;
  if (type === 'candidates') return typeof record.key === 'string' ? record.key : null;
  return `${record.type}|${record.s}|${record.t}`;
}

/** Canonical order for links and rejections, so restores are deterministic. */
export function sortRelations(list, type = 'links') {
  return list.sort((a, b) => {
    const x = recordId(type, a);
    const y = recordId(type, b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function emptyGroups() {
  return { items: [], entities: [], links: [], rejections: [], candidates: [] };
}

function group(op, part, type) {
  op[part] ||= {};
  op[part][type] ||= [];
  return op[part][type];
}

function shardOf(item) {
  const at = Number(item?.createdAt);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 7) : '1970-01';
}

const candidateSig = (candidate) => candidate
  ? `${candidate.n}|${(Array.isArray(candidate.sample) ? candidate.sample : []).join(',')}`
  : null;

export function newOp({ opId, kind, at, label, silent } = {}) {
  const op = {
    opId,
    at,
    kind,
    label: label || { code: kind, params: {} },
    before: emptyGroups(),
    created: emptyGroups(),
    after: {},
  };
  if (silent) op.silent = true;
  return op;
}

// Copies `record` into op.before the first time the op touches it. Records
// the op created itself have no "before". Returns true when it snapshotted.
export function snapshotBefore(op, type, record) {
  if (!RECORD_TYPES.includes(type)) return false;
  const id = recordId(type, record);
  if (id === null) return false;
  if (group(op, 'created', type).includes(id)) return false;
  const list = group(op, 'before', type);
  if (list.some((r) => recordId(type, r) === id)) return false;
  list.push(clone(record));
  return true;
}

export function noteCreated(op, type, id) {
  if (!RECORD_TYPES.includes(type) || typeof id !== 'string') return;
  // A record that existed before the op was modified, not created.
  if (group(op, 'before', type).some((r) => recordId(type, r) === id)) return;
  const list = group(op, 'created', type);
  if (!list.includes(id)) list.push(id);
}

function currentRev(state, id) {
  if (state.items?.has(id)) return state.items.get(id).rev ?? null;
  if (state.entities?.has(id)) return state.entities.get(id).rev ?? null;
  return null;
}

// Records op.after = {[id]: rev | null} for every item and entity the op
// touched or created, and the candidate signatures. Safe to call again
// after more changes join the op (promotions, back-fill).
export function sealOp(op, state) {
  const after = {};
  for (const type of REV_TYPES) {
    const ids = [...group(op, 'before', type).map((r) => r.id), ...group(op, 'created', type)];
    for (const id of ids) after[id] = currentRev(state, id);
  }
  op.after = after;
  const keys = [...group(op, 'before', 'candidates').map((c) => c.key), ...group(op, 'created', 'candidates')];
  if (keys.length) op.cand = keys.map((key) => [key, candidateSig(state.candidates?.get(key))]);
  else delete op.cand;
  return op;
}

// A record whose rev moved after `op` may still be undone when every later
// op that touched it was silent (link enrichment) and left it as it is now.
function onlySilentlyTouched(ops, index, id, rev) {
  const later = ops.slice(index + 1).filter((o) => o.after && Object.hasOwn(o.after, id));
  if (!later.length || later.some((o) => !o.silent)) return false;
  return later[later.length - 1].after[id] === rev;
}

export function canUndo(state, op) {
  if (!op || typeof op.opId !== 'string' || op.kind === 'undo' || op.lossy) return { ok: false, code: 'missing' };
  if (op.undoneBy) return { ok: false, code: 'already_undone' };
  const ops = state.ops || [];
  const index = ops.findIndex((o) => o.opId === op.opId);
  if (index < 0) return { ok: false, code: 'missing' };
  for (const [id, rev] of Object.entries(op.after || {})) {
    const now = currentRev(state, id);
    if (now === rev) continue;
    if (!onlySilentlyTouched(ops, index, id, now)) return { ok: false, code: 'superseded' };
  }
  return { ok: true };
}

function referencedEntities(state, candidates) {
  const found = new Set();
  for (const item of state.items.values()) {
    for (const id of item.entityIds || []) if (candidates.has(id)) found.add(id);
    if (candidates.has(item.owner)) found.add(item.owner);
  }
  for (const link of state.links || []) {
    if (candidates.has(link.s)) found.add(link.s);
    if (candidates.has(link.t)) found.add(link.t);
  }
  for (const entity of state.entities.values()) {
    if (candidates.has(entity.mergedInto)) found.add(entity.mergedInto);
  }
  return found;
}

// Undoes `op` in place: restores its before-snapshots, deletes what it
// created (entities only when nothing else still mentions them), marks it
// undone, and returns a Change whose op (kind 'undo') the caller journals.
// env = { now, newId(prefix) }. Refusals return { op: null, code }.
export function applyUndo(state, op, env) {
  const verdict = canUndo(state, op);
  if (!verdict.ok) return { op: null, touched: new Set(), code: verdict.code };
  const undo = newOp({
    opId: env.newId('o'), kind: 'undo', at: env.now,
    label: { code: 'undo', params: { opId: op.opId, kind: op.kind } },
  });
  const touched = new Set();
  const changed = new Set();

  for (const id of group(op, 'created', 'items')) {
    const item = state.items.get(id);
    if (!item) continue;
    touched.add(`items:${shardOf(item)}`);
    state.items.delete(id);
    changed.add(id);
  }
  for (const record of group(op, 'before', 'items')) {
    const current = state.items.get(record.id);
    if (current) touched.add(`items:${shardOf(current)}`);
    touched.add(`items:${shardOf(record)}`);
    state.items.set(record.id, clone(record));
    changed.add(record.id);
  }

  for (const record of group(op, 'before', 'entities')) {
    state.entities.set(record.id, clone(record));
    touched.add('entities');
    changed.add(record.id);
  }
  const created = new Set(group(op, 'created', 'entities').filter((id) => state.entities.has(id)));
  if (created.size) {
    const kept = referencedEntities(state, created);
    for (const id of created) {
      if (kept.has(id)) continue;
      state.entities.delete(id);
      touched.add('entities');
      changed.add(id);
    }
  }

  const sigs = new Map(Array.isArray(op.cand) ? op.cand : []);
  const snapshots = new Map(group(op, 'before', 'candidates').map((c) => [c.key, c]));
  const removedItems = new Set(group(op, 'created', 'items'));
  for (const key of [...snapshots.keys(), ...group(op, 'created', 'candidates')]) {
    const current = state.candidates.get(key);
    if (sigs.has(key) && candidateSig(current) === sigs.get(key)) {
      if (snapshots.has(key)) state.candidates.set(key, clone(snapshots.get(key)));
      else state.candidates.delete(key);
    } else if (current) {
      // A later capture bumped it too: take back only this op's sightings.
      const sample = (current.sample || []).filter((id) => !removedItems.has(id));
      const dropped = (current.sample || []).length - sample.length;
      if (!dropped) continue;
      const n = (Number(current.n) || 0) - dropped;
      if (n <= 0) state.candidates.delete(key);
      else state.candidates.set(key, { ...current, n, sample });
    } else continue;
    touched.add('entities');
  }

  for (const type of ['links', 'rejections']) {
    const createdIds = new Set(group(op, 'created', type));
    const restored = new Map(group(op, 'before', type).map((r) => [recordId(type, r), r]));
    if (!createdIds.size && !restored.size) continue;
    const next = (state[type] || []).filter((r) => {
      const id = recordId(type, r);
      return !createdIds.has(id) && !restored.has(id);
    });
    for (const record of restored.values()) next.push(clone(record));
    state[type] = sortRelations(next, type);
    touched.add('links');
  }

  op.undoneBy = undo.opId;
  for (const id of changed) undo.after[id] = currentRev(state, id);
  return { op: undo, touched, result: { undone: op.opId, kind: op.kind } };
}

// Returns a new ops array with `op` appended (or replaced in place when an op
// with its id is already there, as when a retried mutation re-applies),
// trimmed oldest first to maxOps and maxBytes. An op too big to fit even on
// its own keeps its created ids but drops its snapshots (`lossy`: not undoable).
export function appendOp(ops, op, { maxOps = 200, maxBytes = 262144 } = {}) {
  const next = Array.isArray(ops) ? [...ops] : [];
  const at = next.findIndex((o) => o.opId === op.opId);
  if (at >= 0) next[at] = op;
  else next.push(op);
  const sizes = next.map(bytes);
  let total = 2 + sizes.reduce((sum, n) => sum + n, 0) + Math.max(0, next.length - 1);
  while (next.length > 1 && (next.length > maxOps || total > maxBytes)) {
    total -= sizes.shift() + 1;
    next.shift();
  }
  if (total > maxBytes && next.length === 1) {
    next[0] = { ...next[0], before: emptyGroups(), lossy: true };
  }
  return next;
}

/** The op `mm undo` targets: newest, not silent, not undone, not itself an undo. */
export function lastUndoable(ops) {
  for (let i = (ops?.length || 0) - 1; i >= 0; i--) {
    const op = ops[i];
    if (!op.silent && !op.undoneBy && op.kind !== 'undo') return op;
  }
  return null;
}
