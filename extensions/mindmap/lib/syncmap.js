// Leaf module: imports nothing (the host rewrites one level of shared imports).
//
// Mind Map's records as Kage folder sync sees them (Kage docs/design/SYNC.md
// §12.6, §12.9): which collection each record goes in, its sync id, the
// fields that stay on this computer, what may leave it, and how a record
// from another computer gets this computer's local fields back.
//
// Collections (manifest `sync.collections`):
//   items       an Item without rev, enrich, v and fileRefs (local)
//   entities    an Entity without rev; `me` never syncs (same id everywhere)
//   links       a Link, whole; id `${s}:${t}:${type}`
//   rejections  a Rejection, whole; same id rule
//   bodies      a document's full text, whole, id = the item id:
//               { key, format, chars, text, pageStarts? }
//   pins        an explorer pin, whole, id = the node ref: { x, y, at }
//
// What never leaves this computer: a document Kage flagged possible_secret
// (item and body) and the actions it holds, and, with "Sync private items"
// off, private items and private names.
//
// Pure: no I/O, no clock. Ids are never built from user text: a relation
// whose id wouldn't fit the host's id rule (an entity rejection names a key,
// `*:zebra crew:entity`) gets a hash of it instead.

export const FEATURE = 'sync.records';
export const COLLECTIONS = Object.freeze(['items', 'entities', 'links', 'rejections', 'bodies', 'pins']);
// The host's id rule (SYNC §12.6).
export const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
// Fields Kage keeps out of the synced copy (manifest `local`).
export const LOCAL_FIELDS = Object.freeze({ items: Object.freeze(['rev', 'enrich', 'v', 'fileRefs']), entities: Object.freeze(['rev']) });
export const SECRET_WARNING = 'possible_secret';

const ITEM_ID = /^i[0-9a-z]{14}$/;
const ENTITY_ID = /^e[0-9a-z]{14}$/;
const PIN_REF = /^(?:o|me|[ie][0-9a-z]{14})$/;
const BODY_KEY = /^mm-body-(i[0-9a-z]{14})-([1-9][0-9]{0,14})$/;
const FORMAT_RE = /^[a-z][a-z0-9_]{0,15}$/;
const MARK_RE = /^([pd]):(o[0-9a-z]{14})$/;
const utf8 = new TextEncoder();

const clone = (value) => JSON.parse(JSON.stringify(value));
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function without(record, fields) {
  const out = clone(record);
  for (const field of fields) delete out[field];
  return out;
}

// 128 bits from four FNV-1a lanes over the UTF-16 code units: the same on
// every computer, and long enough that two relations never share one.
function hash128(s) {
  let out = '';
  for (const seed of [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

/** The sync id of a link or rejection: `${s}:${t}:${type}`, or `h.<32 hex>` when that breaks the id rule. */
export function relationId(relation) {
  const id = `${relation?.s}:${relation?.t}:${relation?.type}`;
  return ID_RE.test(id) ? id : `h.${hash128(`${relation?.type}|${relation?.s}|${relation?.t}`)}`;
}

/** True when a document Kage flagged as holding a password or key (EXTENSION_FILE_TEXT §10). */
export function isSecretDoc(item) {
  return Array.isArray(item?.file?.warnings) && item.file.warnings.includes(SECRET_WARNING);
}

/**
 * True when `item` may go to the sync folder: not a possible_secret
 * document or one of its actions (`parent` is its parent item, if any), and
 * not private while "Sync private items" is off.
 */
export function itemSyncs(item, { syncPrivate = true, parent = null } = {}) {
  if (!item || !ITEM_ID.test(item.id)) return false;
  if (isSecretDoc(item) || isSecretDoc(parent)) return false;
  return syncPrivate || !item.private;
}

/** True when `entity` may go to the sync folder (never `me`; private ones only with "Sync private items"). */
export function entitySyncs(entity, { syncPrivate = true } = {}) {
  if (!entity || !ENTITY_ID.test(entity.id)) return false;
  return syncPrivate || !entity.private;
}

/**
 * What one changed record needs: 'p' (push it), 'd' (push a delete) or
 * null (nothing). `before` and `after` are the record before and after the
 * change (undefined: absent); `syncedBefore` and `syncsAfter` say whether
 * it could leave this computer then and now. A record that stops syncing
 * (made private with the setting off, flagged possible_secret) is deleted
 * on the other computers once; one that never synced isn't.
 */
export function plan(before, after, syncedBefore, syncsAfter = syncedBefore) {
  if (!after) return before ? 'd' : null;
  if (syncsAfter(after)) return 'p';
  return before && syncedBefore(before) ? 'd' : null;
}

/** An item as synced: everything but its local fields. */
export function itemRecord(item) {
  return without(item, LOCAL_FIELDS.items);
}

/** An entity as synced, or null for `me`. */
export function entityRecord(entity) {
  if (!entity || entity.id === 'me') return null;
  return without(entity, LOCAL_FIELDS.entities);
}

/** A link or rejection as synced. */
export function relationRecord(relation) {
  // kage-sensitive-data: not-sensitive — reviewed: a synced link record, not a settings control
  const out = { s: relation.s, t: relation.t, type: relation.type };
  if (typeof relation.origin === 'string') out.origin = relation.origin;
  out.at = Number.isFinite(relation.at) ? relation.at : 0;
  return out;
}

/** A document body as synced: { key, format, chars, text, pageStarts? } (body as lib/model.js normalizeBody returns it). */
export function bodyRecord(key, body) {
  const out = { key, format: body.format, chars: body.chars, text: body.text };
  if (Array.isArray(body.pageStarts) && body.pageStarts.length) out.pageStarts = body.pageStarts.slice();
  return out;
}

/** An explorer pin as synced. */
export function pinRecord(pin) {
  return { x: pin.x, y: pin.y, at: Number.isFinite(pin.at) ? pin.at : 0 };
}

/**
 * A synced body record as the value Mind Map stores under its key
 * (`mm-body-<itemId>-<n>`), or null when it isn't one for `itemId`.
 * → { key, value } for lib/model.js normalizeBody.
 */
export function bodyFromRecord(itemId, record) {
  if (!isRecord(record) || typeof record.text !== 'string' || typeof record.key !== 'string') return null;
  const m = BODY_KEY.exec(record.key);
  if (!m || m[1] !== itemId) return null;
  const value = { schema: 1, id: itemId, rev: Number(m[2]), format: FORMAT_RE.test(record.format ?? '') ? record.format : 'text', text: record.text };
  if (isCount(record.chars)) value.chars = record.chars;
  if (Array.isArray(record.pageStarts)) value.pageStarts = record.pageStarts;
  return { key: record.key, value };
}

/**
 * A record from another computer with this computer's local fields put
 * back (SYNC §12.9 item 2): `rev` is left to lib/model.js; an item keeps
 * this computer's `enrich`, `v` and `fileRefs`, and an item new here gets
 * `enrich: { state: 'done' }` (its link title was fetched where it was
 * saved) and this organizer's version.
 */
export function withLocal(collection, record, local, { extractorVersion = 1 } = {}) {
  if (!isRecord(record)) return null;
  const fields = LOCAL_FIELDS[collection] || [];
  const out = without(record, fields);
  if (collection === 'items') {
    out.enrich = local?.enrich ? clone(local.enrich) : { state: 'done' };
    out.v = Number.isInteger(local?.v) && local.v > 0 ? local.v : extractorVersion;
    if (Array.isArray(local?.fileRefs) && local.fileRefs.length) out.fileRefs = local.fileRefs.slice();
  }
  if (Number.isInteger(local?.rev)) out.rev = local.rev;
  return out;
}

/**
 * `pull()`'s changes grouped by collection, newest per id last-wins:
 * → { [collection]: Map<id, record | null> }, plus `skipped` (unknown
 * collections, bad ids, records that aren't objects).
 */
export function groupChanges(changes) {
  const out = { skipped: 0 };
  for (const c of COLLECTIONS) out[c] = new Map();
  for (const change of Array.isArray(changes) ? changes : []) {
    const c = change?.collection;
    const id = change?.id;
    if (!COLLECTIONS.includes(c) || typeof id !== 'string' || !ID_RE.test(id)) { out.skipped++; continue; }
    const record = change.record ?? null;
    if (record !== null && !isRecord(record)) { out.skipped++; continue; }
    if (c === 'items' && !ITEM_ID.test(id)) { out.skipped++; continue; }
    if (c === 'entities' && !ENTITY_ID.test(id)) { out.skipped++; continue; }
    if (c === 'bodies' && !ITEM_ID.test(id)) { out.skipped++; continue; }
    if (c === 'pins' && !PIN_REF.test(id)) { out.skipped++; continue; }
    out[c].set(id, record);
  }
  return out;
}

// --- pending marks (meta.syncPending) ----------------------------------------------

/** A pending mark: 'p:<opId>' (push) or 'd:<opId>' (delete), from the op that made it. */
export function mark(action, opId) {
  return `${action === 'd' ? 'd' : 'p'}:${opId}`;
}

/** { action, opId } of a mark, or null. */
export function parseMark(value) {
  const m = typeof value === 'string' && MARK_RE.exec(value);
  return m ? { action: m[1], opId: m[2] } : null;
}

// --- push batches ----------------------------------------------------------------------

// UTF-8 bytes of a record as JSON.
function recordBytes(record) {
  return utf8.encode(JSON.stringify(record)).length;
}

/**
 * Splits [{ collection, id, record | null }] into push calls: one
 * collection per call, at most `maxRecords` entries and `maxBytes` of
 * records each (a record larger than `maxBytes` goes alone; Kage refuses it
 * as too_large). → [{ collection, records: [{ id, ...record }], deleted: [id], entries }]
 */
export function batches(entries, { maxRecords = 200, maxBytes = 3 * 1024 * 1024 } = {}) {
  const out = [];
  const open = new Map();
  for (const entry of entries) {
    const c = entry.collection;
    const size = entry.record ? recordBytes(entry.record) + entry.id.length + 8 : entry.id.length + 4;
    let batch = open.get(c);
    if (batch && (batch.entries.length >= maxRecords || batch.bytes + size > maxBytes)) batch = null;
    if (!batch) {
      batch = { collection: c, records: [], deleted: [], entries: [], bytes: 0 };
      open.set(c, batch);
      out.push(batch);
    }
    batch.entries.push(entry);
    batch.bytes += size;
    if (entry.record) batch.records.push({ id: entry.id, ...entry.record });
    else batch.deleted.push(entry.id);
  }
  for (const batch of out) delete batch.bytes;
  return out;
}

/**
 * Every record key in a full push, in a fixed order: `${index}|${id}`
 * where index is the collection's place in COLLECTIONS, sorted. A full
 * push walks them after a cursor (meta.syncFull.next), so any window can
 * carry on where another stopped.
 */
export function fullKeys(state, { pins = {}, syncPrivate = true } = {}) {
  const keys = [];
  const add = (c, id) => keys.push(`${COLLECTIONS.indexOf(c)}|${id}`);
  for (const item of state.items.values()) {
    const parent = item.parentId ? state.items.get(item.parentId) : null;
    if (!itemSyncs(item, { syncPrivate, parent })) continue;
    add('items', item.id);
    if (item.body?.key) add('bodies', item.id);
  }
  for (const entity of state.entities.values()) if (entitySyncs(entity, { syncPrivate })) add('entities', entity.id);
  for (const link of state.links || []) add('links', relationId(link));
  for (const rejection of state.rejections || []) add('rejections', relationId(rejection));
  for (const ref of Object.keys(pins || {})) if (PIN_REF.test(ref)) add('pins', ref);
  return keys.sort();
}

/** { collection, id } of a fullKeys key. */
export function splitKey(key) {
  const at = key.indexOf('|');
  return { collection: COLLECTIONS[Number(key.slice(0, at))], id: key.slice(at + 1) };
}
