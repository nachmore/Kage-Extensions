// Leaf module: imports nothing (the host rewrites one level of shared imports).
//
// Mind Map's data model (SPEC §6, §7): validation and migration of persisted
// parts, the in-memory State, and every mutation as a pure-ish `apply*`
// function that edits State in place and records undo data in a journal op.
//
// Contract for every apply* (env = { now, newId(prefix), journal, … }):
//   - `env.journal` is the lib/journal.js namespace (leaves can't import);
//     `env.lib.text` (normalizeKey, containsQuote) is optional: the
//     fallbacks below follow the same rules.
//   - It returns a Change { op, touched: Set<part>, … }. The caller appends
//     change.op to state.ops (journal.appendOp) and persists every part in
//     `touched` plus 'journal' and 'meta'. A refusal or a no-op returns
//     { op: null, touched: ∅, code } with code 'not_found' | 'not_action' |
//     'bad_status' | 'noop' | 'same' | 'me' | 'conflict' | 'bad_format' |
//     'future_schema' | 'bad_file' | 'not_file' | 'storage_full' | 'bad_org';
//     nothing changed and nothing needs saving.
//   - Documents (applyIngest, applyReread) also return `bodies`: [{ key,
//     value }] to write before the shard. Bodies are never deleted here: the
//     caller takes bodyKeys(state) before a change and deletes
//     releasedBodies(held, state) once it is committed (undo, a delete that
//     left the journal, a lossy op).
//   - Idempotent re-apply (SPEC §7.4): every id the op could need is drawn
//     from env.newId up front, in an order that depends only on the inputs,
//     so a retry with a reset id pool gets the same ids. A re-applied op
//     reuses the before-snapshots of its own earlier attempt when that
//     attempt's journal landed. Records are compared before writing, so an
//     unchanged record keeps its rev, and annotation lines and mentions are
//     never added twice.
//
// Precedence is user > agent > rule: rule-derived updates never overwrite
// user or agent fields. Records stay plain JSON; Maps exist only in State.

export const SCHEMA = 1;
export const KINDS = Object.freeze(['note', 'link', 'doc', 'action', 'meeting']);
export const ENTITY_TYPES = Object.freeze(['person', 'team', 'project', 'topic', 'org', 'term']);
export const STATUSES = Object.freeze(['open', 'done', 'dismissed']);
export const LIMITS = Object.freeze({
  text: 8000, title: 120, entityName: 80, aliases: 20, entitiesPerItem: 24, children: 50,
  keyphrases: 5, terms: 20, term: 60, summary: 600, agentSummaryWords: 25, quote: 1000,
  sample: 5, backfill: 200, annotate: 15, url: 4096, app: 120, window: 300, annotation: 1000,
  // Documents from Kage's file_text (EXTENSION_FILE_TEXT §11.4–11.8).
  docKeyphrases: 64, fileName: 255, fileRefs: 8, warnings: 32, pageStarts: 256, bodyPageStarts: 2000,
  bodyBytes: 64 * 1024 * 1024,
});
export const BODY_SCHEMA = 1;

const ITEM_ID = /^i[0-9a-z]{14}$/;
const ENTITY_ID = /^(?:e[0-9a-z]{14}|me)$/;
const OP_ID = /^o[0-9a-z]{14}$/;
const TITLE_SOURCES = ['auto', 'meta', 'user', 'agent'];
const SUMMARY_SOURCES = ['meta', 'agent', 'user'];
const ORIGINS = ['user', 'agent', 'rule'];
const ORIGIN_RANK = { rule: 0, agent: 1, user: 2 };
const VIAS = ['launcher', 'chat', 'agent', 'import', 'explorer', 'file', 'background'];
const ENRICH_STATES = ['none', 'pending', 'done', 'failed'];
const LINK_TYPES = ['related', 'about', 'duplicate_of'];
const REJECTION_TYPES = ['mention', 'link', 'entity'];
const CANDIDATE_TYPES = ['term', 'person'];
const URL_RE = /(?:\bhttps?:\/\/|\bwww\.|\bfile:\/\/)[^\s<>]+/gi;
// The same shapes lib/files.js validateFileText checks (leaves can't import).
const FILE_REF_RE = /^fr1_[A-Za-z0-9_-]{22}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const FILE_EXT_RE = /^[a-z0-9]{1,16}$/;
const FILE_FORMAT_RE = /^[a-z][a-z0-9_]{0,15}$/;
const FILE_WARNING_RE = /^[a-z][a-z0-9_]{0,47}$/;
// Never in a stored file name: controls and line breaks, or a path.
const FILE_NAME_BAD_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\/|^[A-Za-z]:\\|^\\\\/;
const BODY_KEY_RE = /^mm-body-(i[0-9a-z]{14})-([1-9][0-9]{0,14})$/;
// Background organizing (Kage's EXTENSION_AGENT_CALLS §11.5), the same
// shapes lib/organize.js uses: the mark's states, its text hash (FNV-1a 32,
// base36; a little room for a later hash), and agent_call_status().machine_tag.
export const ORG_STATES = Object.freeze(['done', 'skipped', 'failed']);
const ORG_HASH_RE = /^[0-9a-z]{1,16}$/;
const MACHINE_TAG_RE = /^[0-9a-f]{16}$/;
// Kage folder sync (SYNC §12.6, §12.9), the same shapes lib/syncmap.js
// uses: the collections, the host's id rule, a pending mark ('p' push or
// 'd' delete, and the op that made it), a full push's modes and cursor, and
// the 24-hex device tag of the computer whose initial push is done.
const SYNC_COLLECTIONS = ['items', 'entities', 'links', 'rejections', 'bodies', 'pins'];
const SYNC_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SYNC_MARK_RE = /^[pd]:o[0-9a-z]{14}$/;
const SYNC_FULL_MODES = ['initial', 'all'];
const SYNC_TAG = /^[0-9a-f]{24}$/;

// ---------------------------------------------------------------------------
// Small pure helpers

const clone = (value) => JSON.parse(JSON.stringify(value));
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
// Stored times are ms epoch from 1970 up to the end of year 9999: shards are
// named by the UTC month (mm-items-YYYY-MM) and Date can't format beyond
// ±8.64e15, so anything outside is not a time.
const MAX_TIME = 253402300800000;
const time = (value) => (finite(value) !== undefined && value >= 0 && value < MAX_TIME ? value : undefined);
const isItemId = (id) => typeof id === 'string' && ITEM_ID.test(id);
const isEntityId = (id) => typeof id === 'string' && ENTITY_ID.test(id);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const relationId = (r) => `${r.type}|${r.s}|${r.t}`;
const byRelation = (a, b) => (relationId(a) < relationId(b) ? -1 : relationId(a) > relationId(b) ? 1 : 0);

function trunc(value, max) {
  let s = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (s.length <= max) return s;
  s = s.slice(0, max);
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

const clean = (value, max) => trunc(String(value ?? '').replace(/\s+/g, ' ').trim(), max);

function strings(list, max, each = LIMITS.term) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const value of list) {
    if (typeof value !== 'string') continue;
    const s = clean(value, each);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function deepEqual(a, b, skip) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const keys = Object.keys(a).filter((k) => a[k] !== undefined && !skip?.has(k));
  const other = Object.keys(b).filter((k) => b[k] !== undefined && !skip?.has(k));
  return keys.length === other.length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}
const VOLATILE = new Set(['rev', 'updatedAt']);

function localDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoDayStart(value) {
  const m = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : undefined;
}

// Same rules as lib/text.js normalizeKey and containsQuote; used when the
// caller doesn't inject env.lib.text and for alias keys in entityByKey.
function foldKey(s) {
  let v = String(s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '');
  v = v.replace(/(?:\p{L}\.){2,}/gu, (m) => m.replace(/\./g, ''));
  v = v.replace(/['’]s\b/gu, '');
  v = v.replace(/['’&]/gu, '');
  v = v.toLowerCase();
  v = v.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return v.trim().replace(/\s+/g, ' ');
}

const quoteForm = (s) => String(s ?? '').normalize('NFKC')
  .replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"')
  .replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

function textLib(env) {
  const text = env?.lib?.text;
  return {
    normalizeKey: typeof text?.normalizeKey === 'function' ? text.normalizeKey : foldKey,
    containsQuote: typeof text?.containsQuote === 'function' ? text.containsQuote
      : (haystack, quote) => { const q = quoteForm(quote); return !!q && quoteForm(haystack).includes(q); },
  };
}

function firstLine(text, max) {
  const line = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return clean(line, max);
}

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;

// Unicode scalar values in s (a lone surrogate counts as one).
function scalarCount(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++, n++) {
    if (isHighSurrogate(s.charCodeAt(i)) && isLowSurrogate(s.charCodeAt(i + 1))) i++;
  }
  return n;
}

// s cut to at most `max` scalar values.
function capScalars(s, max) {
  for (let i = 0, n = 0; i < s.length; i++, n++) {
    if (n === max) return s.slice(0, i);
    if (isHighSurrogate(s.charCodeAt(i)) && isLowSurrogate(s.charCodeAt(i + 1))) i++;
  }
  return s;
}

// UTF-8 length of s, as TextEncoder would write it (a lone surrogate is 3).
function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (isHighSurrogate(c) && isLowSurrogate(s.charCodeAt(i + 1))) { n += 4; i++; } else n += 3;
  }
  return n;
}

// Ascending offsets, each at most `end`, at most `limit` of them; else undefined.
function offsets(list, end, limit) {
  if (!Array.isArray(list) || !list.length || list.length > limit) return undefined;
  for (let i = 0; i < list.length; i++) {
    if (!isCount(list[i]) || list[i] > end || (i && list[i] < list[i - 1])) return undefined;
  }
  return list.slice();
}

// The file name without its extension (lib/files.js docTitle's fallback).
function nameStem(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && /^[A-Za-z0-9]{1,16}$/.test(name.slice(dot + 1)) ? name.slice(0, dot).trim() : name;
}

// ---------------------------------------------------------------------------
// Parts, shards and keys

export function shardOf(item) {
  const at = Number(item?.createdAt);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 7) : '1970-01';
}

const itemPart = (item) => `items:${shardOf(item)}`;

/** Storage key for a part: 'items:2026-11' → 'mm-items-2026-11', 'entities' → 'mm-entities'. */
export function partKey(part) {
  if (typeof part === 'string' && /^items:\d{4}-\d{2}$/.test(part)) return `mm-items-${part.slice(6)}`;
  return ['entities', 'links', 'journal', 'meta'].includes(part) ? `mm-${part}` : null;
}

/** Inverse of partKey; null for twins, the lock and unknown keys. */
export function keyPart(key) {
  const m = typeof key === 'string' && /^mm-items-(\d{4}-\d{2})$/.exec(key);
  if (m) return `items:${m[1]}`;
  return ['mm-entities', 'mm-links', 'mm-journal', 'mm-meta'].includes(key) ? key.slice(3) : null;
}

/** Every data part State currently holds (for repair and full rewrites). */
export function listParts(state) {
  const shards = new Set([...state.items.values()].map(itemPart));
  for (const part of state.raw?.keys() || []) if (part.startsWith('items:')) shards.add(part);
  return [...[...shards].sort(), 'entities', 'links', 'journal'];
}

// ---------------------------------------------------------------------------
// State

const GEN_RE = /^[a-z0-9]{6,32}$/;
// Entity types a child item inherits from its parent (see applyCapture).
export const INHERITED_TYPES = Object.freeze(new Set(['team', 'project', 'topic', 'org']));

function meEntity(now) {
  return { id: 'me', type: 'person', name: 'Me', aliases: [], key: 'me', origin: 'user', createdAt: now, updatedAt: now, rev: 1 };
}

// `gen` names this store's generation: a fresh store (or Delete
// everything) starts a new one, so a window that still holds the old data
// knows to drop it rather than merge it back.
export function emptyState(now = 0, { extractorVersion = 1, gen = null } = {}) {
  return {
    meta: {
      schema: SCHEMA, rev: 0, txn: null, gen: GEN_RE.test(gen ?? '') ? gen : null, keys: {}, counts: { items: 0, entities: 0 },
      extractorVersion, createdAt: now, updatedAt: now,
    },
    items: new Map(),
    entities: new Map([['me', meEntity(now)]]),
    candidates: new Map(),
    links: [],
    rejections: [],
    ops: [],
    shardRevs: new Map(),
    partRevs: { entities: 0, links: 0, journal: 0 },
    // Stored records this version can't read (an unknown kind from a newer
    // version, a hand-edited file), per part: written back unchanged so a
    // save never erases them.
    raw: new Map(),
  };
}

function schemaError(code) {
  const error = new Error(`mindmap model: ${code}`);
  error.code = code;
  return error;
}

// Returns the payload in the current schema, or throws {code:'future_schema'}
// (the caller goes read-only rather than guess) or {code:'bad_payload'}.
export function migrate(payload, part) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw schemaError('bad_payload');
  const schema = payload.schema === undefined ? 1 : payload.schema;
  if (!Number.isInteger(schema) || schema < 1) throw schemaError('bad_payload');
  if (schema > SCHEMA) throw schemaError('future_schema');
  // Schema 1 is the first; later versions add steps here, keyed on `part`.
  return payload.schema === undefined ? { ...payload, schema: 1 } : payload;
}

// `dev` is the machine tag of the computer that saved the item (opaque, 16
// hex characters), so two computers split background organizing (§11.3).
function validSource(raw) {
  const source = { via: VIAS.includes(raw?.via) ? raw.via : 'launcher' };
  if (typeof raw?.app === 'string' && raw.app.trim()) source.app = clean(raw.app, LIMITS.app);
  if (typeof raw?.window === 'string' && raw.window.trim()) source.window = clean(raw.window, LIMITS.window);
  if (typeof raw?.dev === 'string' && MACHINE_TAG_RE.test(raw.dev)) source.dev = raw.dev;
  return source;
}

/**
 * Item.org in canonical form, or null when it isn't one (§11.5): what
 * background organizing did with the note, `{ state, v, at, hash }`, plus
 * `tries` and `next` on a failed one. A mark without a known state, a hash,
 * a version or a time is dropped whole, so the note is simply organized
 * again; anything else in it is dropped.
 */
export function normalizeOrg(raw) {
  if (!isRecord(raw) || !ORG_STATES.includes(raw.state)) return null;
  if (typeof raw.hash !== 'string' || !ORG_HASH_RE.test(raw.hash)) return null;
  if (!Number.isSafeInteger(raw.v) || raw.v < 1 || time(raw.at) === undefined) return null;
  const org = { state: raw.state, v: raw.v, at: raw.at, hash: raw.hash };
  if (raw.state === 'failed') {
    if (isCount(raw.tries) && raw.tries > 0) org.tries = raw.tries;
    if (time(raw.next) !== undefined) org.next = raw.next;
  }
  return org;
}

// ---------------------------------------------------------------------------
// Documents (EXTENSION_FILE_TEXT §11.4)

/** Storage key of a document body: `mm-body-<item id>-<n>`. */
export function bodyKey(id, n) {
  return `mm-body-${id}-${n}`;
}

/** { id, n } for a body key, else null. */
export function parseBodyKey(key) {
  const m = typeof key === 'string' && BODY_KEY_RE.exec(key);
  return m ? { id: m[1], n: Number(m[2]) } : null;
}

// Item.file: what Kage said about the file, never its text or path. The
// name, extension, format and sha256 are required; the rest is repaired.
// Unknown fields are dropped, so nothing the host adds later is stored.
function normalizeFile(raw) {
  if (!isRecord(raw)) return null;
  const { name, ext, format, sha256 } = raw;
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || FILE_NAME_BAD_RE.test(name)) return null;
  if (typeof ext !== 'string' || !FILE_EXT_RE.test(ext) || typeof format !== 'string' || !FILE_FORMAT_RE.test(format)) return null;
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) return null;
  const file = { name: capScalars(name, LIMITS.fileName), ext, format, size: isCount(raw.size) ? raw.size : 0 };
  if (Number.isSafeInteger(raw.modifiedAt)) file.modifiedAt = raw.modifiedAt;
  file.sha256 = sha256.toLowerCase();
  const pages = raw.pages;
  if (isRecord(pages) && isCount(pages.count) && isCount(pages.read) && pages.read <= pages.count) {
    file.pages = { count: pages.count, read: pages.read };
  }
  file.chars = isCount(raw.chars) ? raw.chars : 0;
  file.truncated = raw.truncated === true;
  file.warnings = [];
  for (const warning of Array.isArray(raw.warnings) ? raw.warnings : []) {
    if (file.warnings.length >= LIMITS.warnings) break;
    if (typeof warning === 'string' && FILE_WARNING_RE.test(warning) && !file.warnings.includes(warning)) file.warnings.push(warning);
  }
  return file;
}

// Item.body: { key, chars, bytes } of the full text, for this item only.
function normalizeBodyRef(raw, id) {
  const parsed = isRecord(raw) ? parseBodyKey(raw.key) : null;
  if (!parsed || parsed.id !== id) return null;
  return { key: raw.key, chars: isCount(raw.chars) ? raw.chars : 0, bytes: isCount(raw.bytes) ? raw.bytes : 0 };
}

// Item.fileRefs: this computer's file_refs, newest last, at most 8 (`add`
// joins as the newest).
function refsOf(list, add) {
  const out = [];
  for (const ref of Array.isArray(list) ? list : []) {
    if (typeof ref === 'string' && FILE_REF_RE.test(ref) && ref !== add && !out.includes(ref)) out.push(ref);
  }
  if (typeof add === 'string' && FILE_REF_RE.test(add)) out.push(add);
  return out.length > LIMITS.fileRefs ? out.slice(out.length - LIMITS.fileRefs) : out;
}

function bodyRecord(id, n, format, chars, text, pageStarts) {
  const value = { schema: BODY_SCHEMA, id, rev: n, format, chars, text };
  const starts = offsets(pageStarts, text.length, LIMITS.bodyPageStarts);
  if (starts) value.pageStarts = starts;
  return value;
}

/**
 * A loaded body (the value stored under `key`) in canonical form, or null
 * when it isn't one: not an object, no text, a newer schema, or another
 * item's or revision's body. → { schema, id, rev, format, chars, text,
 * pageStarts? } (pageStarts: offsets into text).
 */
export function normalizeBody(raw, key) {
  const parsed = parseBodyKey(key);
  if (!parsed || !isRecord(raw) || typeof raw.text !== 'string') return null;
  if (!Number.isInteger(raw.schema) || raw.schema < 1 || raw.schema > BODY_SCHEMA) return null;
  if (raw.id !== parsed.id || raw.rev !== parsed.n) return null;
  const format = typeof raw.format === 'string' && FILE_FORMAT_RE.test(raw.format) ? raw.format : 'text';
  return bodyRecord(parsed.id, parsed.n, format, isCount(raw.chars) ? raw.chars : scalarCount(raw.text), raw.text, raw.pageStarts);
}

/** A valid Item in canonical form (unknown fields kept), or null when malformed. */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isItemId(raw.id) || !KINDS.includes(raw.kind) || time(raw.createdAt) === undefined) return null;
  const item = clone(raw);
  item.title = trunc(typeof raw.title === 'string' ? raw.title : '', LIMITS.title);
  item.titleSource = TITLE_SOURCES.includes(raw.titleSource) ? raw.titleSource : 'auto';
  item.text = trunc(typeof raw.text === 'string' ? raw.text : '', LIMITS.text);
  item.updatedAt = time(raw.updatedAt) ?? raw.createdAt;
  for (const field of ['truncated', 'private', 'archived', 'pinned']) if (raw[field] !== true) delete item[field];
  for (const field of ['url', 'canonicalUrl', 'path', 'docKey']) {
    if (typeof raw[field] === 'string' && raw[field]) item[field] = trunc(raw[field], LIMITS.url);
    else delete item[field];
  }
  for (const field of ['occurredAt', 'dueAt', 'doneAt']) if (time(raw[field]) === undefined) delete item[field];
  if (!STATUSES.includes(raw.status)) delete item.status;
  if (item.kind === 'action' && !item.status) item.status = 'open';
  if (typeof raw.suggested !== 'boolean') delete item.suggested;
  if (!(finite(raw.confidence) >= 0 && raw.confidence <= 1)) delete item.confidence;
  if (!isEntityId(raw.owner)) delete item.owner;
  if (typeof raw.quote === 'string') item.quote = trunc(raw.quote, LIMITS.quote); else delete item.quote;
  if (!isItemId(raw.parentId) || raw.parentId === raw.id) delete item.parentId;
  if (!(Number.isInteger(raw.seg) && raw.seg >= 0)) delete item.seg;
  if (!ORIGINS.includes(raw.origin)) delete item.origin;
  if (raw.kindSource !== 'user') delete item.kindSource;
  const ids = [];
  for (const id of Array.isArray(raw.entityIds) ? raw.entityIds : []) {
    if (isEntityId(id) && !ids.includes(id) && ids.length < LIMITS.entitiesPerItem) ids.push(id);
  }
  item.entityIds = ids;
  const origins = {};
  for (const id of ids) origins[id] = ORIGINS.includes(raw.mentionOrigin?.[id]) ? raw.mentionOrigin[id] : 'rule';
  item.mentionOrigin = origins;
  // A document the user picked: its file, this computer's refs, and the
  // full text's body key when the text is longer than `text` holds.
  const body = normalizeBodyRef(raw.body, raw.id);
  if (body) item.body = body; else delete item.body;
  const file = normalizeFile(raw.file);
  if (file) {
    // Page starts are offsets into `text`, so only a doc without a body keeps them here.
    const starts = body ? undefined : offsets(raw.file.pageStarts, item.text.length, LIMITS.pageStarts);
    if (starts) file.pageStarts = starts;
    item.file = file;
  } else delete item.file;
  const refs = refsOf(raw.fileRefs);
  if (refs.length) item.fileRefs = refs; else delete item.fileRefs;
  item.keyphrases = strings(raw.keyphrases, file ? LIMITS.docKeyphrases : LIMITS.keyphrases);
  if (Array.isArray(raw.terms)) item.terms = strings(raw.terms, LIMITS.terms); else delete item.terms;
  if (typeof raw.summary === 'string' && raw.summary.trim()) {
    item.summary = trunc(raw.summary.trim(), LIMITS.summary);
    item.summarySource = SUMMARY_SOURCES.includes(raw.summarySource) ? raw.summarySource : 'user';
  } else {
    delete item.summary;
    delete item.summarySource;
  }
  item.source = validSource(raw.source);
  const org = normalizeOrg(raw.org);
  if (org) item.org = org; else delete item.org;
  const enrich = { state: ENRICH_STATES.includes(raw.enrich?.state) ? raw.enrich.state : 'none' };
  if (time(raw.enrich?.at) !== undefined) enrich.at = raw.enrich.at;
  item.enrich = enrich;
  item.rev = Number.isInteger(raw.rev) && raw.rev > 0 ? raw.rev : 1;
  item.v = Number.isInteger(raw.v) && raw.v > 0 ? raw.v : 1;
  return item;
}

function normalizeEntity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isEntityId(raw.id) || !ENTITY_TYPES.includes(raw.type)) return null;
  const name = clean(raw.name, LIMITS.entityName);
  if (!name) return null;
  const entity = clone(raw);
  entity.name = name;
  entity.key = typeof raw.key === 'string' && raw.key ? raw.key : foldKey(name);
  entity.aliases = strings(raw.aliases, LIMITS.aliases, LIMITS.entityName);
  entity.origin = ORIGINS.includes(raw.origin) ? raw.origin : 'rule';
  entity.createdAt = time(raw.createdAt) ?? 0;
  entity.updatedAt = time(raw.updatedAt) ?? entity.createdAt;
  entity.rev = Number.isInteger(raw.rev) && raw.rev > 0 ? raw.rev : 1;
  if (raw.private !== true) delete entity.private;
  if (!isEntityId(raw.mergedInto) || raw.mergedInto === raw.id) delete entity.mergedInto;
  return entity;
}

function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || !raw.key) return null;
  const candidate = clone(raw);
  candidate.display = clean(raw.display ?? raw.key, LIMITS.entityName) || raw.key;
  candidate.type = CANDIDATE_TYPES.includes(raw.type) ? raw.type : 'term';
  candidate.n = Number.isInteger(raw.n) && raw.n >= 0 ? raw.n : 0;
  candidate.firstSeen = time(raw.firstSeen) ?? 0;
  candidate.sample = (Array.isArray(raw.sample) ? raw.sample : []).filter(isItemId).slice(0, LIMITS.sample);
  return candidate;
}

function normalizeRelation(raw, types) {
  if (!raw || typeof raw !== 'object' || typeof raw.s !== 'string' || typeof raw.t !== 'string') return null;
  if (!types.includes(raw.type)) return null;
  // kage-sensitive-data: not-sensitive — reviewed: a stored record, not a settings control
  const relation = { s: raw.s, t: raw.t, type: raw.type };
  if (ORIGINS.includes(raw.origin)) relation.origin = raw.origin;
  relation.at = time(raw.at) ?? 0;
  return relation;
}

function normalizeOp(raw) {
  if (!raw || typeof raw !== 'object' || !OP_ID.test(raw.opId ?? '') || typeof raw.kind !== 'string') return null;
  const op = clone(raw);
  op.at = finite(raw.at) ?? 0;
  if (!op.label || typeof op.label !== 'object') op.label = { code: raw.kind, params: {} };
  for (const part of ['before', 'created']) {
    const groups = raw[part] && typeof raw[part] === 'object' ? raw[part] : {};
    op[part] = {};
    for (const type of ['items', 'entities', 'links', 'rejections', 'candidates']) {
      const list = Array.isArray(groups[type]) ? groups[type] : [];
      op[part][type] = part === 'created'
        ? list.filter((v) => typeof v === 'string')
        : list.filter((v) => v && typeof v === 'object');
    }
  }
  op.after = raw.after && typeof raw.after === 'object' && !Array.isArray(raw.after) ? raw.after : {};
  return op;
}

function normalizeMeta(raw, now) {
  const meta = emptyState(now).meta;
  for (const field of ['rev', 'createdAt', 'updatedAt', 'extractorVersion']) {
    if (finite(raw[field]) !== undefined) meta[field] = raw[field];
  }
  meta.txn = typeof raw.txn === 'string' ? raw.txn : null;
  meta.gen = typeof raw.gen === 'string' && GEN_RE.test(raw.gen) ? raw.gen : null;
  if (raw.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys)) {
    for (const [key, rev] of Object.entries(raw.keys)) if (keyPart(key) && Number.isFinite(rev)) meta.keys[key] = rev;
  }
  if (raw.counts && typeof raw.counts === 'object') {
    meta.counts = { items: finite(raw.counts.items) ?? 0, entities: finite(raw.counts.entities) ?? 0 };
    if (isCount(raw.counts.bodyBytes) && raw.counts.bodyBytes > 0) meta.counts.bodyBytes = raw.counts.bodyBytes;
  }
  // Background organizing considers notes created from then on (§11.3);
  // missing until the user first turns it on, 0 for "older notes too".
  if (time(raw.orgSince) !== undefined) meta.orgSince = raw.orgSince;
  // Kage folder sync (SYNC §12.9): this computer's bookkeeping, never synced.
  const pending = normalizeSyncPending(raw.syncPending);
  if (pending) meta.syncPending = pending;
  const full = normalizeSyncFull(raw.syncFull);
  if (full) meta.syncFull = full;
  if (typeof raw.syncTag === 'string' && SYNC_TAG.test(raw.syncTag)) meta.syncTag = raw.syncTag;
  return meta;
}

// meta.syncPending: collection → sync id → mark, the records this
// computer changed that Kage hasn't accepted yet. undefined when empty.
function normalizeSyncPending(raw) {
  if (!isRecord(raw)) return undefined;
  const out = {};
  let n = 0;
  for (const c of SYNC_COLLECTIONS) {
    if (!isRecord(raw[c])) continue;
    for (const [id, value] of Object.entries(raw[c])) {
      if (!SYNC_ID_RE.test(id) || typeof value !== 'string' || !SYNC_MARK_RE.test(value)) continue;
      (out[c] ||= {})[id] = value;
      n++;
    }
  }
  return n ? out : undefined;
}

// meta.syncFull: a push of every record still to finish, { mode, next, by?,
// at }: `next` is the last lib/syncmap.js fullKeys key pushed, `by` the
// window (store owner) working on it and `at` when it last made progress.
function normalizeSyncFull(raw) {
  if (!isRecord(raw) || !SYNC_FULL_MODES.includes(raw.mode)) return undefined;
  const full = { mode: raw.mode, next: typeof raw.next === 'string' && raw.next.length <= 160 ? raw.next : '' };
  if (typeof raw.by === 'string' && raw.by && raw.by.length <= 128) full.by = raw.by;
  full.at = time(raw.at) ?? 0;
  return full;
}

// meta.counts: items and entities, plus bodyBytes once there are bodies.
function countsOf(state) {
  const counts = { items: state.items.size, entities: state.entities.size };
  const bytes = bodyBytes(state);
  if (bytes) counts.bodyBytes = bytes;
  return counts;
}

const revOf = (payload) => (Number.isFinite(payload?.rev) ? payload.rev : 0);

// parts = { meta, shards: {[ym]: payload}, entities, links, journal }; any
// payload may be null (missing). Malformed records are kept aside in
// `state.raw` (payloadFor writes them back) and listed in `problems`
// ({part, code: 'bad_record'|'duplicate'|'wrong_shard', id?}); unusable
// payloads are skipped with code 'bad_payload' or 'future_schema' (the
// caller goes read-only rather than overwrite them).
export function fromPersisted(parts = {}, { now = 0 } = {}) {
  const state = emptyState(now);
  const problems = [];
  const keep = (part, field, raw) => {
    let bag = state.raw.get(part);
    if (!bag) state.raw.set(part, (bag = {}));
    (bag[field] ||= []).push(raw);
  };
  const open = (payload, part) => {
    if (payload === null || payload === undefined) return null;
    try { return migrate(payload, part); }
    catch (error) {
      problems.push({ part, code: error.code || 'bad_payload' });
      return null;
    }
  };

  const meta = open(parts.meta, 'meta');
  if (meta) state.meta = normalizeMeta(meta, now);

  for (const ym of Object.keys(parts.shards || {}).sort()) {
    const part = `items:${ym}`;
    const payload = open(parts.shards[ym], part);
    if (!payload) continue;
    if (!Array.isArray(payload.items)) { problems.push({ part, code: 'bad_payload' }); continue; }
    state.shardRevs.set(ym, revOf(payload));
    for (const raw of payload.items) {
      const item = normalizeItem(raw);
      if (!item) {
        problems.push({ part, code: 'bad_record' });
        keep(part, 'items', raw);
        continue;
      }
      if (shardOf(item) !== ym) problems.push({ part, code: 'wrong_shard', id: item.id });
      const existing = state.items.get(item.id);
      if (existing) {
        problems.push({ part, code: 'duplicate', id: item.id });
        if (existing.rev >= item.rev) continue;
      }
      state.items.set(item.id, item);
    }
  }

  const listsOk = (payload, fields) => fields.every((f) => payload[f] === undefined || Array.isArray(payload[f]));
  let entities = open(parts.entities, 'entities');
  if (entities && !listsOk(entities, ['entities', 'candidates'])) {
    problems.push({ part: 'entities', code: 'bad_payload' });
    entities = null;
  }
  if (entities) {
    state.partRevs.entities = revOf(entities);
    for (const raw of Array.isArray(entities.entities) ? entities.entities : []) {
      const entity = normalizeEntity(raw);
      if (!entity) {
        problems.push({ part: 'entities', code: 'bad_record' });
        keep('entities', 'entities', raw);
        continue;
      }
      // The me entity's aliases come from settings, never from storage.
      if (entity.id === 'me') entity.aliases = state.entities.get('me').aliases;
      state.entities.set(entity.id, entity);
    }
    for (const raw of Array.isArray(entities.candidates) ? entities.candidates : []) {
      const candidate = normalizeCandidate(raw);
      if (!candidate) {
        problems.push({ part: 'entities', code: 'bad_record' });
        keep('entities', 'candidates', raw);
        continue;
      }
      state.candidates.set(candidate.key, candidate);
    }
  }

  let links = open(parts.links, 'links');
  if (links && !listsOk(links, ['links', 'rejections'])) {
    problems.push({ part: 'links', code: 'bad_payload' });
    links = null;
  }
  if (links) {
    state.partRevs.links = revOf(links);
    for (const [field, types] of [['links', LINK_TYPES], ['rejections', REJECTION_TYPES]]) {
      const seen = new Set();
      for (const raw of Array.isArray(links[field]) ? links[field] : []) {
        const relation = normalizeRelation(raw, types);
        if (!relation) {
          problems.push({ part: 'links', code: 'bad_record' });
          keep('links', field, raw);
          continue;
        }
        if (seen.has(relationId(relation))) continue;
        seen.add(relationId(relation));
        state[field].push(relation);
      }
      state[field].sort(byRelation);
    }
  }

  const journal = open(parts.journal, 'journal');
  if (journal) {
    state.partRevs.journal = revOf(journal);
    for (const raw of Array.isArray(journal.ops) ? journal.ops : []) {
      const op = normalizeOp(raw);
      if (op) state.ops.push(op);
      else problems.push({ part: 'journal', code: 'bad_record' });
    }
  }
  state.meta.counts = countsOf(state);
  return { state, problems };
}

// The persisted object for one part, without rev/txn (the caller stamps those).
export function payloadFor(state, part) {
  // Records this version couldn't read go back unchanged, after the rest.
  const kept = (field) => state.raw?.get(part)?.[field] || [];
  if (typeof part === 'string' && part.startsWith('items:')) {
    const ym = part.slice(6);
    const items = [...state.items.values()].filter((item) => shardOf(item) === ym).sort(byId);
    return { schema: SCHEMA, items: [...items, ...kept('items')] };
  }
  if (part === 'entities') {
    const entities = [...state.entities.values()].sort(byId)
      .map((entity) => (entity.id === 'me' ? { ...entity, name: 'Me', aliases: [] } : entity));
    const candidates = [...state.candidates.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { schema: SCHEMA, entities: [...entities, ...kept('entities')], candidates: [...candidates, ...kept('candidates')] };
  }
  if (part === 'links') {
    return {
      schema: SCHEMA, links: [...[...state.links].sort(byRelation), ...kept('links')],
      rejections: [...[...state.rejections].sort(byRelation), ...kept('rejections')],
    };
  }
  if (part === 'journal') return { schema: SCHEMA, ops: state.ops };
  if (part === 'meta') {
    const { keys, extractorVersion, createdAt, updatedAt, gen, orgSince } = state.meta;
    const pending = normalizeSyncPending(state.meta.syncPending);
    const full = normalizeSyncFull(state.meta.syncFull);
    const tag = SYNC_TAG.test(state.meta.syncTag ?? '') ? state.meta.syncTag : null;
    return {
      schema: SCHEMA, ...(gen ? { gen } : {}), keys: { ...keys }, counts: countsOf(state),
      ...(time(orgSince) !== undefined ? { orgSince } : {}),
      ...(pending ? { syncPending: pending } : {}), ...(full ? { syncFull: full } : {}), ...(tag ? { syncTag: tag } : {}),
      extractorVersion, createdAt, updatedAt,
    };
  }
  throw new TypeError('mindmap model: unknown part');
}

// ---------------------------------------------------------------------------
// Lookups

function follow(state, entity) {
  let current = entity;
  for (let hops = 0; current?.mergedInto && hops < 16; hops++) {
    const next = state.entities.get(current.mergedInto);
    if (!next) break;
    current = next;
  }
  return current || null;
}

/** The entity with this key (or an alias with this key), same type first; follows mergedInto. */
export function entityByKey(state, key, type) {
  if (typeof key !== 'string' || !key) return null;
  let best = null;
  let bestRank = Infinity;
  for (const entity of state.entities.values()) {
    let rank;
    if (entity.key === key) rank = 0;
    else if (entity.aliases?.some((alias) => foldKey(alias) === key)) rank = 2;
    else continue;
    if (type && entity.type !== type) rank += 1;
    if (rank < bestRank || (rank === bestRank && (entity.createdAt < best.createdAt
        || (entity.createdAt === best.createdAt && entity.id < best.id)))) {
      best = entity;
      bestRank = rank;
    }
  }
  return best ? follow(state, best) : null;
}

const samePath = (a, b) => a === b || (/^[a-z]:\\|^\\\\/i.test(a) && a.toLowerCase() === b.toLowerCase());

/** The existing item this capture duplicates (canonical URL, path, window doc key), or null. */
// `skip(item)` → true leaves an item out (an agent capture never merges
// into an item the agent may not see).
export function findDuplicate(state, extraction, { exclude, skip } = {}) {
  if (!extraction || extraction.isDump) return null;
  const { canonicalUrl, path, docKey } = extraction;
  if (!canonicalUrl && !path && !docKey) return null;
  let best = null;
  const better = (item) => {
    if (!best) return true;
    const a = item.kind === 'action' ? 1 : 0;
    const b = best.kind === 'action' ? 1 : 0;
    if (a !== b) return a < b;
    return item.createdAt < best.createdAt || (item.createdAt === best.createdAt && item.id < best.id);
  };
  for (const item of state.items.values()) {
    if (exclude?.has(item.id)) continue;
    if (typeof skip === 'function' && skip(item)) continue;
    const match = (canonicalUrl && item.canonicalUrl === canonicalUrl)
      || (path && item.path && samePath(item.path, path))
      || (docKey && item.docKey === docKey);
    if (match && better(item)) best = item;
  }
  return best ? best.id : null;
}

// Every body key State still needs, with its bytes: live items, records
// kept aside unread, and the journal's undo snapshots (a deleted or re-read
// doc's body stays while its op can still be undone).
function bodyRefs(state) {
  const refs = new Map();
  const note = (record) => {
    const body = record?.body;
    const parsed = parseBodyKey(body?.key);
    if (!parsed || parsed.id !== record.id || refs.has(body.key)) return;
    refs.set(body.key, isCount(body.bytes) ? body.bytes : 0);
  };
  for (const item of state.items?.values() || []) note(item);
  for (const bag of state.raw?.values() || []) for (const record of bag.items || []) note(record);
  for (const op of state.ops || []) for (const record of op.before?.items || []) note(record);
  return refs;
}

/** The body keys State still references (items, kept-aside records, undo snapshots). */
export function bodyKeys(state) {
  return new Set(bodyRefs(state).keys());
}

/** UTF-8 bytes of the referenced bodies' text, each counted once (the 64 MB budget). */
export function bodyBytes(state, { except } = {}) {
  let total = 0;
  for (const [key, bytes] of bodyRefs(state)) if (key !== except) total += bytes;
  return total;
}

/**
 * Body keys in `held` (bodyKeys(state) taken before a change) that State no
 * longer references: delete them once the change is committed. Covers undo,
 * a journal trim that dropped a delete or re-read, and lossy ops. Sorted.
 */
export function releasedBodies(held, state) {
  const live = bodyKeys(state);
  return [...(held || [])].filter((key) => !live.has(key)).sort();
}

const rejectedKey = (state, key) => state.rejections.some((r) => r.type === 'entity' && r.t === key);
const rejectedMention = (state, itemId, entityId) =>
  state.rejections.some((r) => r.type === 'mention' && r.s === itemId && r.t === entityId);

// A private name, itself or through the entity it redirects to (sync's
// dedupe leaves items naming the merged-away copy).
function privateEntity(state, id) {
  const entity = state.entities.get(id);
  if (!entity) return false;
  return !!entity.private || (!!entity.mergedInto && !!follow(state, entity)?.private);
}

function mentionsPrivate(state, item) {
  if (item.private) return true;
  return item.entityIds.some((id) => privateEntity(state, id));
}

// True when `key` is a private entity's key or one of its aliases (merged
// away or not): background organizing never links that entity or makes a
// public one with its name.
function privateKey(state, key) {
  if (typeof key !== 'string' || !key) return false;
  for (const entity of state.entities.values()) {
    if (entity.private && (entity.key === key || entity.aliases.some((alias) => foldKey(alias) === key))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Transaction plumbing

function requireJournal(env) {
  const j = env?.journal;
  if (!j || ['newOp', 'snapshotBefore', 'noteCreated', 'sealOp'].some((f) => typeof j[f] !== 'function')) {
    throw new TypeError('mindmap model: env.journal is required');
  }
  if (typeof env.newId !== 'function' || !Number.isFinite(env.now)) {
    throw new TypeError('mindmap model: env.now and env.newId are required');
  }
  return j;
}

const refusal = (code) => ({ op: null, touched: new Set(), code });

function begin(state, env, kind, label, { silent = false } = {}) {
  const journal = requireJournal(env);
  const opId = env.newId('o');
  const op = journal.newOp({
    opId, kind: env.opKind || kind, at: env.now, label: env.label || label, silent: env.silent ?? silent,
  });
  const prior = state.ops.find((o) => o.opId === opId);
  if (prior) {
    // A retry of an op whose journal already landed: keep its snapshots,
    // which describe the state before the first attempt.
    op.at = prior.at;
    op.before = clone(prior.before);
    op.created = clone(prior.created);
  }
  return { state, env, journal, op, prior: !!prior, touched: new Set(), dirty: false, newEntityIds: [] };
}

function resume(state, env, change) {
  const journal = requireJournal(env);
  return {
    state, env, journal, op: change.op, prior: true, touched: change.touched || new Set(), dirty: true,
    newEntityIds: change.newEntityIds || [],
  };
}

function finish(tx, extra = {}, { always = false } = {}) {
  if (!tx.dirty && !tx.prior && !always) return { ...refusal('noop'), ...extra };
  tx.journal.sealOp(tx.op, tx.state);
  return { op: tx.op, touched: tx.touched, newEntityIds: tx.newEntityIds, ...extra };
}

function putItem(tx, draft, { created = false, keepRev = false } = {}) {
  const item = normalizeItem(draft);
  if (!item) return null;
  const current = tx.state.items.get(item.id);
  if (created) tx.journal.noteCreated(tx.op, 'items', item.id);
  if (current && deepEqual(current, item, VOLATILE)) return current;
  if (current && !created) tx.journal.snapshotBefore(tx.op, 'items', current);
  if (!keepRev) {
    // A record this op creates is (re)written fresh, so a retry that finds
    // its earlier attempt's copy lands on the same rev.
    item.rev = created || !current ? 1 : current.rev + 1;
    item.updatedAt = created ? item.createdAt : tx.env.now;
  }
  if (current && shardOf(current) !== shardOf(item)) tx.touched.add(itemPart(current));
  tx.state.items.set(item.id, item);
  tx.touched.add(itemPart(item));
  tx.dirty = true;
  return item;
}

function removeItem(tx, id) {
  const current = tx.state.items.get(id);
  if (!current) return false;
  tx.journal.snapshotBefore(tx.op, 'items', current);
  tx.state.items.delete(id);
  tx.touched.add(itemPart(current));
  tx.dirty = true;
  return true;
}

function putEntity(tx, draft, { created = false, keepRev = false } = {}) {
  const entity = normalizeEntity(draft);
  if (!entity) return null;
  const current = tx.state.entities.get(entity.id);
  if (created) {
    tx.journal.noteCreated(tx.op, 'entities', entity.id);
    if (!tx.newEntityIds.includes(entity.id)) tx.newEntityIds.push(entity.id);
  }
  if (current && deepEqual(current, entity, VOLATILE)) return current;
  if (current && !created) tx.journal.snapshotBefore(tx.op, 'entities', current);
  if (!keepRev) {
    entity.rev = created || !current ? 1 : current.rev + 1;
    entity.updatedAt = created ? entity.createdAt : tx.env.now;
  }
  tx.state.entities.set(entity.id, entity);
  tx.touched.add('entities');
  tx.dirty = true;
  return entity;
}

function removeEntity(tx, id) {
  const current = tx.state.entities.get(id);
  if (!current) return false;
  tx.journal.snapshotBefore(tx.op, 'entities', current);
  tx.state.entities.delete(id);
  tx.touched.add('entities');
  tx.dirty = true;
  return true;
}

function addRelation(tx, field, relation) {
  const id = relationId(relation);
  if (tx.state[field].some((r) => relationId(r) === id)) return false;
  tx.journal.noteCreated(tx.op, field, id);
  tx.state[field].push(relation);
  tx.state[field].sort(byRelation);
  tx.touched.add('links');
  tx.dirty = true;
  return true;
}

function removeRelations(tx, field, predicate) {
  const keep = [];
  for (const relation of tx.state[field]) {
    if (predicate(relation)) {
      tx.journal.snapshotBefore(tx.op, field, relation);
      tx.touched.add('links');
      tx.dirty = true;
    } else keep.push(relation);
  }
  tx.state[field] = keep;
}

// Candidates are counted by lib/entities.js bumpCandidates after the apply;
// snapshot them first so undo can take the sightings back.
function snapshotCandidates(tx, candidates) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const key = candidate?.key;
    if (typeof key !== 'string' || !key) continue;
    const current = tx.state.candidates.get(key);
    if (current) tx.journal.snapshotBefore(tx.op, 'candidates', current);
    else tx.journal.noteCreated(tx.op, 'candidates', key);
    tx.touched.add('entities');
  }
}

const stronger = (a, b) => ((ORIGIN_RANK[b] ?? 0) > (ORIGIN_RANK[a] ?? -1) ? b : a);

function addMention(draft, entityId, origin = 'rule') {
  draft.entityIds ||= [];
  draft.mentionOrigin ||= {};
  if (!draft.entityIds.includes(entityId)) {
    if (draft.entityIds.length >= LIMITS.entitiesPerItem) return false;
    draft.entityIds.push(entityId);
    draft.mentionOrigin[entityId] = origin;
    return true;
  }
  const next = stronger(draft.mentionOrigin[entityId], origin);
  if (next === draft.mentionOrigin[entityId]) return false;
  draft.mentionOrigin[entityId] = next;
  return true;
}

function mention(tx, itemId, entityId, origin) {
  const item = tx.state.items.get(itemId);
  if (!item || item.entityIds.includes(entityId) || rejectedMention(tx.state, itemId, entityId)) return false;
  const draft = clone(item);
  if (!addMention(draft, entityId, origin)) return false;
  return !!putItem(tx, draft);
}

// Resolves an entity reference to an id, creating the entity with `slot`
// (an id drawn up front) when no entity has the key. Rejected keys
// (mm forget) resolve to null.
function resolveEntity(tx, { key, name, type, origin = 'rule', entityId, alias }, slot) {
  const { state } = tx;
  if (entityId) {
    const known = follow(state, state.entities.get(entityId));
    if (known) return known.id;
  }
  if (typeof key !== 'string' || !key || rejectedKey(state, key)) return null;
  const hit = entityByKey(state, key, type);
  if (hit) {
    // Our own slot: an earlier attempt of this op created it.
    if (hit.id === slot) {
      tx.journal.noteCreated(tx.op, 'entities', slot);
      if (!tx.newEntityIds.includes(slot)) tx.newEntityIds.push(slot);
    }
    return hit.id;
  }
  if (!slot) return null;
  const existing = state.entities.get(slot);
  if (existing) return existing.key === key ? existing.id : null;
  // kage-sensitive-data: not-sensitive — reviewed: a stored record, not a settings control
  const entity = putEntity(tx, {
    id: slot, type: ENTITY_TYPES.includes(type) ? type : 'term', name: clean(name || key, LIMITS.entityName) || key,
    // An email mention keeps the address as an alias.
    aliases: typeof alias === 'string' && alias ? [alias] : [], key, origin: ORIGINS.includes(origin) ? origin : 'rule',
    createdAt: tx.env.now, updatedAt: tx.env.now, rev: 1,
  }, { created: true });
  return entity ? entity.id : null;
}

function resolveOwner(tx, owner, slot, origin = 'rule') {
  if (owner === 'me' || owner == null) return owner === 'me' ? 'me' : undefined;
  if (typeof owner === 'string' && isEntityId(owner) && tx.state.entities.has(owner)) return owner;
  if (typeof owner !== 'object' || (!owner.key && !owner.entityId)) return undefined;
  const id = resolveEntity(tx, { key: owner.key, name: owner.name, type: 'person', origin, entityId: owner.entityId }, slot);
  return id || undefined;
}

// "Long Form (LF)" aliases attach to the short form's entity; until that
// entity exists they ride on its candidate so a later promotion gets them.
function attachAliases(tx, aliases) {
  const pending = [];
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    if (!alias?.shortKey || !alias.long) continue;
    const entity = entityByKey(tx.state, alias.shortKey);
    if (!entity) { pending.push(alias); continue; }
    addAlias(tx, entity, alias.long);
  }
  return pending;
}

function addAlias(tx, entity, alias) {
  const name = clean(alias, LIMITS.entityName);
  const key = foldKey(name);
  if (!key || key === entity.key || entity.aliases.some((a) => foldKey(a) === key)) return;
  if (entity.aliases.length >= LIMITS.aliases) return;
  putEntity(tx, { ...clone(entity), aliases: [...entity.aliases, name] });
}

// env.dev: this computer's machine tag, stamped on everything it saves
// whether or not the source window is recorded.
function sourceOf(env) {
  return validSource({ via: env.via, app: env.source?.app, window: env.source?.window, dev: env.dev });
}

const httpUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);

function enrichFor(url, env) {
  return httpUrl(url) && env.enrichLinks !== false ? { state: 'pending' } : { state: 'none' };
}

function actionFields(draft, action, owner, now) {
  draft.status = action.status === 'done' ? 'done' : 'open';
  draft.suggested = !!action.suggested && draft.status !== 'done';
  if (finite(action.confidence) !== undefined) draft.confidence = Math.max(0, Math.min(1, action.confidence));
  if (owner) draft.owner = owner;
  if (finite(action.dueAt) !== undefined) draft.dueAt = action.dueAt;
  if (draft.status === 'done') draft.doneAt = now;
  if (typeof action.quote === 'string' && action.quote) draft.quote = trunc(action.quote, LIMITS.quote);
  draft.origin = ORIGINS.includes(action.origin) ? action.origin : 'rule';
  if (Number.isInteger(action.seg) && action.seg >= 0) draft.seg = action.seg;
}

// The text a duplicate capture adds: extract's `extra` (the input without
// its URL or path span) when present, else the text with URLs and the path cut.
function annotationText(x, existing) {
  let text = typeof x.extra === 'string' ? x.extra : String(x.text ?? '').replace(URL_RE, ' ');
  if (typeof x.extra !== 'string' && x.path) {
    const lower = text.toLowerCase();
    const at = lower.indexOf(String(x.path).toLowerCase());
    if (at >= 0) text = text.slice(0, at) + ' ' + text.slice(at + x.path.length);
  }
  text = text.replace(/\s+/g, ' ').trim().replace(/^[-–—:;,|]+\s*/, '').trim();
  if (!text) return '';
  const folded = foldKey(text);
  // (A title the extractor took from these same words isn't a reason to skip them.)
  if (folded === foldKey(existing.title) || (!x.titleFromText && folded === foldKey(x.title))) return '';
  return trunc(text, LIMITS.annotation);
}

function appendLine(text, line) {
  const base = text ? `${text}\n${line}` : line;
  return base.length <= LIMITS.text ? base : null;
}

const childrenOf = (state, parentId) => [...state.items.values()].filter((item) => item.parentId === parentId);

// What a child inherits from its parent (F-CAP-3): the parent's teams,
// projects, topics and orgs, and the names on the heading line; people and
// terms only from its own line, so "book the offsite" doesn't become an
// MTCS action because a sibling line names MTCS. `resolved` are the
// change's mentions ({ id, origin, segs }).
function inheritor(state, resolved, specs) {
  const childSegs = new Set(specs.map((spec) => (spec.action ? spec.action.seg : spec.link?.seg)).filter(Number.isInteger));
  const headSeg = (seg) => Number.isInteger(seg) && (seg < 0 || (seg === 0 && !childSegs.has(0)));
  return (draft, parent, ownSeg, { fresh = true } = {}) => {
    for (const eid of parent.entityIds) {
      const type = state.entities.get(eid)?.type;
      const r = resolved.find((x) => x.id === eid);
      const own = Number.isInteger(ownSeg) && r?.segs.includes(ownSeg);
      if (INHERITED_TYPES.has(type) || own || (fresh && r?.segs.some(headSeg))) addMention(draft, eid, parent.mentionOrigin[eid]);
    }
    // A name on the child's own line that the parent doesn't carry (a dedup
    // merge adds lines to an existing item).
    if (Number.isInteger(ownSeg)) for (const r of resolved) if (r.segs.includes(ownSeg)) addMention(draft, r.id, r.origin);
  };
}

function actionChild(id, action, parentId, owner, source, now, v) {
  const draft = {
    id, kind: 'action', title: clean(action.title || action.text || action.quote, LIMITS.title), titleSource: 'auto',
    text: trunc(String(action.text ?? action.quote ?? ''), LIMITS.text), createdAt: now, updatedAt: now,
    parentId, entityIds: [], mentionOrigin: {}, keyphrases: [], source,
    enrich: { state: 'none' }, rev: 1, v: v ?? 1,
  };
  actionFields(draft, action, owner, now);
  return draft;
}

// Actions found in a document the user picked are always open suggestions,
// because someone else may have written it: unassigned ones are owned by
// "me", "<Name> to …" by Name. Done lines (`[x]`) are left out.
function docActions(x) {
  const actions = [];
  let droppedDone = 0;
  for (const action of [x.self, ...(Array.isArray(x.actions) ? x.actions : [])]) {
    if (!isRecord(action)) continue;
    if (action.status === 'done') { droppedDone++; continue; }
    actions.push({ ...action, status: 'open', suggested: true, owner: action.owner || 'me' });
  }
  return { actions, droppedDone };
}

const pickedFile = (ingest) => {
  const file = isRecord(ingest) ? ingest.file : null;
  const stored = normalizeFile(file);
  if (!stored || typeof file.text !== 'string' || !FILE_REF_RE.test(file.fileRef ?? '')) return null;
  return { file, stored, text: file.text, long: file.text.length > LIMITS.text, secret: stored.warnings.includes('possible_secret') };
};

function overBudget(state, bytes, env, except) {
  const budget = finite(env?.bodyBudget) >= 0 ? env.bodyBudget : LIMITS.bodyBytes;
  return bodyBytes(state, { except }) + bytes > budget;
}

// The number in a new body key for `base` (the item as it was before this
// op): past its rev and every body key of this item that a snapshot still
// holds, so a body undo might bring back is never overwritten. Ignores
// this op's own earlier attempt, so a retry gets the same key.
function bodyNumber(state, base, opId) {
  let n = Number.isInteger(base.rev) ? base.rev : 0;
  const bump = (record) => {
    const parsed = parseBodyKey(record?.body?.key);
    if (parsed && parsed.id === base.id && parsed.n > n) n = parsed.n;
  };
  bump(base);
  for (const op of state.ops) {
    if (op.opId !== opId) for (const record of op.before?.items || []) if (record?.id === base.id) bump(record);
  }
  return n + 1;
}

// ---------------------------------------------------------------------------
// Mutations

// Creates the parent item, its children (actions, links) and any new
// entities; or, for a URL/path/window doc that's already saved, merges into
// that item (annotation line `— YYYY-MM-DD: <text>`, mentions, new actions).
export function applyCapture(state, extraction, env) {
  return captureInto(state, extraction || {}, env, null);
}

// doc (applyIngest): { fields(parentId) } adds the document's own fields to
// the new parent, the op is an 'ingest', and keyphrases keep up to 64.
function captureInto(state, x, env, doc) {
  const kind = doc ? 'ingest' : 'capture';
  const tx = begin(state, env, kind, { code: kind, params: {} });
  const now = env.now;
  // Draw every id up front, in an order fixed by the extraction alone.
  const parentId = env.newId('i');
  const specs = [
    ...(Array.isArray(x.actions) ? x.actions : []).map((action) => ({ action })),
    ...(Array.isArray(x.links) ? x.links : []).map((link) => ({ link })),
  ].slice(0, LIMITS.children);
  const childIds = specs.map(() => env.newId('i'));
  const mentions = Array.isArray(x.mentions) ? x.mentions : [];
  const mentionSlots = mentions.map(() => env.newId('e'));
  const ownerActions = [x.self, ...specs.map((s) => s.action)];
  const ownerSlots = ownerActions.map((a) => (a && typeof a.owner === 'object' && a.owner ? env.newId('e') : null));

  const ours = new Set([parentId, ...childIds, ...tx.op.created.items]);
  const skipDuplicate = typeof env.skipDuplicate === 'function' ? env.skipDuplicate : undefined;
  const dupId = findDuplicate(state, x, { exclude: ours, skip: skipDuplicate });

  const resolved = [];
  mentions.forEach((m, i) => {
    const id = m && resolveEntity(tx, m, mentionSlots[i]);
    if (id) resolved.push({ id, origin: ORIGINS.includes(m.origin) ? m.origin : 'rule', segs: Array.isArray(m.segs) ? m.segs : [m.seg] });
  });
  const inherit = inheritor(state, resolved, specs);
  const owners = ownerActions.map((a, i) => (a ? resolveOwner(tx, a.owner, ownerSlots[i], a.origin) : undefined));
  snapshotCandidates(tx, x.candidates);
  const pendingAliases = attachAliases(tx, x.aliases);
  const source = sourceOf(env);
  const childIdsMade = [];
  const linkDupes = [];

  const makeChild = (spec, i, parent) => {
    const id = childIds[i];
    if (spec.action) {
      const a = spec.action;
      const draft = actionChild(id, a, parent.id, owners[i + 1], source, now, x.v);
      inherit(draft, parent, a.seg, { fresh: parent.id === parentId });
      if (draft.owner && draft.owner !== 'me') addMention(draft, draft.owner, 'rule');
      if (parent.private) draft.private = true;
      return draft;
    }
    const l = spec.link;
    if (!l?.url) return null;
    const linkDup = l.canonicalUrl ? findDuplicate(state, { canonicalUrl: l.canonicalUrl }, { exclude: ours, skip: skipDuplicate }) : null;
    if (linkDup) {
      linkDupes.push(linkDup);
      return null;
    }
    const draft = {
      id, kind: l.isDoc ? 'doc' : 'link', title: clean(l.title || l.url, LIMITS.title), titleSource: 'auto',
      text: trunc(l.url, LIMITS.text), url: l.url, canonicalUrl: l.canonicalUrl, createdAt: now, updatedAt: now,
      parentId: parent.id, entityIds: [], mentionOrigin: {}, keyphrases: [], source,
      enrich: enrichFor(l.url, env), rev: 1, v: x.v ?? 1,
    };
    if (Number.isInteger(l.seg) && l.seg >= 0) draft.seg = l.seg;
    inherit(draft, parent, l.seg, { fresh: parent.id === parentId });
    if (parent.private) draft.private = true;
    return draft;
  };

  if (dupId) {
    const existing = state.items.get(dupId);
    const draft = clone(existing);
    const note = annotationText(x, existing);
    let annotated = false;
    if (note) {
      const line = `— ${localDay(now)}: ${note}`;
      if (draft.text.split('\n').includes(line)) annotated = true;
      else {
        const text = appendLine(draft.text, line);
        if (text !== null) { draft.text = text; annotated = true; }
      }
    }
    for (const r of resolved) if (!rejectedMention(state, dupId, r.id)) addMention(draft, r.id, r.origin);
    for (const phrase of strings(x.keyphrases, LIMITS.keyphrases)) {
      if (draft.keyphrases.length < LIMITS.keyphrases && !draft.keyphrases.includes(phrase)) draft.keyphrases.push(phrase);
    }
    if (Array.isArray(x.terms) && x.terms.length) draft.terms = strings([...(draft.terms || []), ...x.terms], LIMITS.terms);
    if (x.summary && !draft.summary) {
      draft.summary = trunc(String(x.summary).trim(), LIMITS.summary);
      draft.summarySource = x.summarySource || (env.via === 'agent' ? 'agent' : 'user');
    }
    if (x.private) draft.private = true;
    if (finite(draft.occurredAt) === undefined && finite(x.occurredAt) !== undefined) draft.occurredAt = x.occurredAt;
    const parent = putItem(tx, draft) || existing;
    const known = new Set(childrenOf(state, dupId).map((c) => quoteForm(c.quote || c.text)));
    specs.forEach((spec, i) => {
      if (!spec.action) return;
      const form = quoteForm(spec.action.quote || spec.action.text);
      if (known.has(form) && !state.items.has(childIds[i])) return;
      const child = makeChild(spec, i, parent);
      if (child && putItem(tx, child, { created: true })) { childIdsMade.push(child.id); known.add(form); }
    });
    tx.op.label = env.label || { code: 'capture_dedup', params: { itemId: dupId, count: childIdsMade.length } };
    return {
      ...finish(tx, {}, { always: true }), itemId: dupId, dedupedInto: dupId, childIds: childIdsMade, pendingAliases,
      result: { annotated, rejectedActions: x.rejectedActions || [], truncated: !!x.truncated, linkDupes },
    };
  }

  const text = trunc(String(x.text ?? ''), LIMITS.text);
  const draft = {
    id: parentId, kind: KINDS.includes(x.kind) ? x.kind : 'note',
    title: clean(x.title, LIMITS.title) || firstLine(text, LIMITS.title) || clean(x.url || x.path || '', LIMITS.title),
    titleSource: TITLE_SOURCES.includes(x.titleSource) ? x.titleSource : 'auto',
    text, createdAt: now, updatedAt: now,
    entityIds: [], mentionOrigin: {}, keyphrases: strings(x.keyphrases, doc ? LIMITS.docKeyphrases : LIMITS.keyphrases),
    source, enrich: enrichFor(x.url, env), rev: 1, v: x.v ?? 1,
  };
  if (doc) Object.assign(draft, doc.fields(parentId));
  if (x.truncated) draft.truncated = true;
  for (const field of ['url', 'canonicalUrl', 'path', 'docKey']) if (x[field]) draft[field] = x[field];
  if (finite(x.occurredAt) !== undefined) draft.occurredAt = x.occurredAt;
  if (Array.isArray(x.terms) && x.terms.length) draft.terms = strings(x.terms, LIMITS.terms);
  if (x.summary) {
    draft.summary = String(x.summary);
    draft.summarySource = x.summarySource || (env.via === 'agent' ? 'agent' : 'user');
  }
  if (x.private) draft.private = true;
  if (x.self && draft.kind === 'action') actionFields(draft, x.self, owners[0], now);
  for (const r of resolved) addMention(draft, r.id, r.origin);
  if (draft.owner && draft.owner !== 'me') addMention(draft, draft.owner, 'rule');
  const parent = putItem(tx, draft, { created: true });
  if (!parent) throw new TypeError('mindmap model: env.newId produced an invalid item id');
  specs.forEach((spec, i) => {
    const child = makeChild(spec, i, parent);
    if (child && putItem(tx, child, { created: true })) childIdsMade.push(child.id);
  });
  tx.op.label = env.label || { code: kind, params: { itemId: parentId, count: 1 + childIdsMade.length } };
  return {
    ...finish(tx, {}, { always: true }), itemId: parentId, childIds: childIdsMade, pendingAliases,
    result: { annotated: false, rejectedActions: x.rejectedActions || [], truncated: !!x.truncated, linkDupes },
  };
}

// A document the user picked through Kage's file_text (EXTENSION_FILE_TEXT
// §11.4, case N: the caller decided with lib/files.js dedupeDecision).
// ingest = { file, extraction?, title?, titleSource?, keyphrases?, private? }:
//   file        lib/files.js validateFileText's `file` (camelCase, with text and fileRef);
//   extraction  extract() of the first 8,000 characters, without a kind hint;
//   title       lib/files.js docTitle(file); keyphrases: bodyKeyphrases(file.text);
//   private     "Make new items private".
// The new item is a doc with `file`, `fileRefs` and, when the text is
// longer than `text` holds, `body`. It never merges into a saved link or
// path and gets no link children; its actions are open suggestions (done
// lines are left out). `possible_secret` or a `#private` tag makes it
// private. env.via is always 'file'. → Change & { itemId, childIds,
// pendingAliases, bodies: [{ key, value }], result }. Refusals: 'bad_file',
// 'storage_full' (more than env.bodyBudget, default LIMITS.bodyBytes).
export function applyIngest(state, ingest, env) {
  const pick = pickedFile(ingest);
  if (!pick) return refusal('bad_file');
  const { file, stored, text, long, secret } = pick;
  const bytes = long ? utf8Bytes(text) : 0;
  if (long && overBudget(state, bytes, env)) return refusal('storage_full');
  const x = isRecord(ingest.extraction) ? ingest.extraction : {};
  const { actions, droppedDone } = docActions(x);
  const title = clean(ingest.title, LIMITS.title);
  const isPrivate = !!(ingest.private || x.private || secret);
  const docX = {
    ...x, kind: 'doc', text, truncated: long,
    title: title || clean(nameStem(stored.name), LIMITS.title), titleSource: title && ingest.titleSource === 'meta' ? 'meta' : 'auto',
    url: undefined, canonicalUrl: undefined, path: undefined, docKey: undefined, self: null, actions, links: [],
    keyphrases: Array.isArray(ingest.keyphrases) ? ingest.keyphrases : x.keyphrases, private: isPrivate,
  };
  const fields = (id) => ({
    file: long ? stored : { ...stored, pageStarts: file.pageStarts },
    fileRefs: [file.fileRef],
    ...(long ? { body: { key: bodyKey(id, 1), chars: stored.chars, bytes } } : {}),
  });
  const change = captureInto(state, docX, { ...env, via: 'file' }, { fields });
  const bodies = long ? [{ key: bodyKey(change.itemId, 1), value: bodyRecord(change.itemId, 1, stored.format, stored.chars, text, file.pageStarts) }] : [];
  return {
    ...change, bodies,
    result: { rejectedActions: change.result.rejectedActions, droppedDone, truncated: stored.truncated, private: isPrivate, secret },
  };
}

// "Update from file…" or a changed file (§11.4, case U). The doc's text,
// file, body, keyphrases and rule mentions come from the new read; what the
// user or an agent set (a user or agent title, the kind, summary, terms,
// their names and actions) stays. Pending rule suggestions the new text no
// longer has go; its new actions arrive as suggestions. The old body key
// stays in the op's before-snapshot, so undo brings it back. ingest as for
// applyIngest; only possible_secret or a `#private` tag makes it private.
// → Change & { itemId, childIds (new), removedIds, pendingAliases, bodies,
// result }. Refusals: 'not_found', 'not_file' (an item without `file`),
// 'bad_file', 'storage_full'.
export function applyReread(state, itemId, ingest, env) {
  const item = state.items.get(itemId);
  if (!item) return refusal('not_found');
  if (!item.file) return refusal('not_file');
  const pick = pickedFile(ingest);
  if (!pick) return refusal('bad_file');
  const { file, stored, text, long, secret } = pick;
  const tx = begin(state, env, 'reread', { code: 'reread', params: { itemId } });
  const base = (tx.prior && tx.op.before.items.find((record) => record.id === itemId)) || item;
  const n = long ? bodyNumber(state, base, tx.op.opId) : 0;
  const key = long ? bodyKey(itemId, n) : null;
  const bytes = long ? utf8Bytes(text) : 0;
  if (long && overBudget(state, bytes, env, key)) return refusal('storage_full');
  const x = isRecord(ingest.extraction) ? ingest.extraction : {};
  const { actions, droppedDone } = docActions(x);
  const specs = actions.slice(0, LIMITS.children).map((action) => ({ action }));
  const childIds = specs.map(() => env.newId('i'));
  const mentions = Array.isArray(x.mentions) ? x.mentions : [];
  const mentionSlots = mentions.map(() => env.newId('e'));
  const ownerSlots = specs.map(({ action: a }) => (typeof a.owner === 'object' ? env.newId('e') : null));

  const resolved = [];
  mentions.forEach((m, i) => {
    const id = m && resolveEntity(tx, m, mentionSlots[i]);
    if (id && !rejectedMention(state, itemId, id)) {
      resolved.push({ id, origin: ORIGINS.includes(m.origin) ? m.origin : 'rule', segs: Array.isArray(m.segs) ? m.segs : [m.seg] });
    }
  });
  const owners = specs.map(({ action: a }, i) => resolveOwner(tx, a.owner, ownerSlots[i], a.origin));
  snapshotCandidates(tx, x.candidates);
  const pendingAliases = attachAliases(tx, x.aliases);

  const draft = clone(item);
  if (draft.titleSource === 'auto' || draft.titleSource === 'meta') {
    const title = clean(ingest.title, LIMITS.title);
    draft.title = title || clean(nameStem(stored.name), LIMITS.title);
    draft.titleSource = title && ingest.titleSource === 'meta' ? 'meta' : 'auto';
  }
  draft.text = trunc(text, LIMITS.text);
  if (long) draft.truncated = true; else delete draft.truncated;
  draft.file = long ? stored : { ...stored, pageStarts: file.pageStarts };
  draft.fileRefs = refsOf(item.fileRefs, file.fileRef);
  if (long) draft.body = { key, chars: stored.chars, bytes }; else delete draft.body;
  draft.keyphrases = strings(Array.isArray(ingest.keyphrases) ? ingest.keyphrases : x.keyphrases, LIMITS.docKeyphrases);
  if (Array.isArray(x.terms) && x.terms.length) draft.terms = strings([...(draft.terms || []), ...x.terms], LIMITS.terms);
  if (finite(draft.occurredAt) === undefined && finite(x.occurredAt) !== undefined) draft.occurredAt = x.occurredAt;
  if (Number.isInteger(x.v) && x.v > 0) draft.v = x.v;
  if (secret || x.private) draft.private = true;
  // Rule mentions the new text no longer has go; user and agent ones stay.
  const found = new Set(resolved.map((r) => r.id));
  if (draft.owner) found.add(draft.owner);
  draft.entityIds = draft.entityIds.filter((id) => draft.mentionOrigin[id] !== 'rule' || found.has(id));
  for (const id of Object.keys(draft.mentionOrigin)) if (!draft.entityIds.includes(id)) delete draft.mentionOrigin[id];
  for (const r of resolved) addMention(draft, r.id, r.origin);
  const parent = putItem(tx, draft) || item;

  // Children: a suggestion the user hasn't acted on, found by the rules,
  // goes when the new text doesn't have it; everything else stays.
  const wanted = new Set(specs.map(({ action: a }) => quoteForm(a.quote || a.text)));
  const removedIds = [];
  for (const child of childrenOf(state, itemId).sort(byId)) {
    const pending = child.kind === 'action' && child.status === 'open' && child.suggested === true && (child.origin ?? 'rule') === 'rule';
    if (pending && !wanted.has(quoteForm(child.quote || child.text))) {
      if (removeItem(tx, child.id)) removedIds.push(child.id);
    } else if (parent.private && !child.private) putItem(tx, { ...clone(child), private: true });
  }
  const inherit = inheritor(state, resolved, specs);
  const known = new Set(childrenOf(state, itemId).map((c) => quoteForm(c.quote || c.text)));
  const source = sourceOf({ ...env, via: 'file' });
  const made = [];
  specs.forEach(({ action: a }, i) => {
    const form = quoteForm(a.quote || a.text);
    if (known.has(form) && !state.items.has(childIds[i])) return;
    const child = actionChild(childIds[i], a, itemId, owners[i], source, env.now, x.v);
    inherit(child, parent, a.seg);
    if (child.owner && child.owner !== 'me') addMention(child, child.owner, 'rule');
    if (parent.private) child.private = true;
    if (putItem(tx, child, { created: true })) { made.push(child.id); known.add(form); }
  });
  tx.op.label = env.label || { code: 'reread', params: { itemId, count: made.length } };
  const change = finish(tx);
  if (!change.op) return change;
  const after = state.items.get(itemId);
  const bodies = long && after?.body?.key === key
    ? [{ key, value: bodyRecord(itemId, n, stored.format, stored.chars, text, file.pageStarts) }] : [];
  return {
    ...change, itemId, childIds: made, removedIds, pendingAliases, bodies,
    result: { rejectedActions: x.rejectedActions || [], droppedDone, truncated: stored.truncated, private: !!after?.private, secret },
  };
}

// The same content saved on another computer, or a copy (§11.4, case C):
// adds this computer's file_ref to the doc, newest last, at most 8. A
// silent op. Refusals: 'not_found', 'not_file', 'bad_file', 'same' (it is
// already the newest ref).
export function applyAddRef(state, itemId, fileRef, env) {
  const item = state.items.get(itemId);
  if (!item) return refusal('not_found');
  if (!item.file) return refusal('not_file');
  if (typeof fileRef !== 'string' || !FILE_REF_RE.test(fileRef)) return refusal('bad_file');
  const refs = refsOf(item.fileRefs, fileRef);
  if (deepEqual(refs, item.fileRefs || [])) return refusal('same');
  const tx = begin(state, env, 'enrich', { code: 'file_ref', params: { itemId } }, { silent: true });
  putItem(tx, { ...clone(item), fileRefs: refs });
  return { ...finish(tx), itemId };
}

// promote = [{key, display, type, itemIds}] from entities.bumpCandidates.
// Creates each entity (or links an existing one with that key) and mentions
// it on the items it was seen in, plus the children of the captured parent.
// Joins change.op, so one undo removes it with the capture.
export function applyPromotions(state, change, promote, env) {
  const list = Array.isArray(promote) ? promote : [];
  if (!change?.op || (!list.length && !change.pendingAliases?.length)) return change;
  const tx = resume(state, env, change);
  const snapshots = new Map((change.op.before.candidates || []).map((c) => [c.key, c]));
  for (const p of list) {
    const slot = env.newId('e');
    if (!p?.key || rejectedKey(state, p.key)) continue;
    const id = resolveEntity(tx, { key: p.key, name: p.display, type: p.type === 'person' ? 'person' : 'term', origin: 'rule' }, slot);
    if (!id) continue;
    const entity = state.entities.get(id);
    const aliasSources = [
      ...(change.pendingAliases || []).filter((a) => a.shortKey === p.key).map((a) => a.long),
      ...(state.candidates.get(p.key)?.aliases || snapshots.get(p.key)?.aliases || []),
    ];
    for (const alias of aliasSources) addAlias(tx, state.entities.get(id) || entity, alias);
    const targets = new Set(Array.isArray(p.itemIds) ? p.itemIds : []);
    // A promoted term or person reaches the captured parent's children only
    // where their own line names it.
    if (targets.has(change.itemId)) {
      const fold = textLib(env).normalizeKey;
      for (const childId of change.childIds || []) {
        const child = state.items.get(childId);
        if (child && ` ${fold(`${child.title} ${child.text}`)} `.includes(` ${p.key} `)) targets.add(childId);
      }
    }
    for (const itemId of [...targets].sort()) mention(tx, itemId, id, 'rule');
  }
  // Aliases whose short form is still only a candidate wait on the candidate.
  for (const alias of change.pendingAliases || []) {
    if (entityByKey(state, alias.shortKey)) continue;
    const candidate = state.candidates.get(alias.shortKey);
    if (!candidate) continue;
    const aliases = strings([...(candidate.aliases || []), alias.long], LIMITS.aliases, LIMITS.entityName);
    if (aliases.length === (candidate.aliases || []).length) continue;
    if (!snapshots.has(alias.shortKey)) {
      tx.journal.snapshotBefore(tx.op, 'candidates', candidate);
    }
    state.candidates.set(alias.shortKey, { ...candidate, aliases });
    tx.touched.add('entities');
  }
  tx.journal.sealOp(tx.op, state);
  change.touched = tx.touched;
  change.newEntityIds = tx.newEntityIds;
  return change;
}

// Adds a rule mention of `entityId` to earlier items whose text names it
// (the caller finds them through the BM25 postings). Joins change.op.
export function applyBackfill(state, change, entityId, itemIds, env) {
  if (!change?.op || !state.entities.has(entityId)) return change;
  const tx = resume(state, env, change);
  for (const itemId of (Array.isArray(itemIds) ? itemIds : []).slice(0, LIMITS.backfill)) {
    mention(tx, itemId, entityId, 'rule');
  }
  tx.journal.sealOp(tx.op, state);
  change.touched = tx.touched;
  return change;
}

export function applyStatus(state, itemId, status, env) {
  const item = state.items.get(itemId);
  if (!item) return refusal('not_found');
  if (item.kind !== 'action') return refusal('not_action');
  if (!STATUSES.includes(status)) return refusal('bad_status');
  const code = status === 'done' ? 'status_done' : status === 'open' ? 'status_open' : 'dismiss';
  const tx = begin(state, env, status === 'dismissed' ? 'dismiss' : 'status', { code, params: { itemId } });
  const draft = clone(item);
  draft.status = status;
  if (status === 'done') {
    draft.doneAt = item.status === 'done' && finite(item.doneAt) !== undefined ? item.doneAt : env.now;
    draft.suggested = false;
  } else delete draft.doneAt;
  putItem(tx, draft);
  return { ...finish(tx), itemId };
}

export function applyAccept(state, itemId, env) {
  const item = state.items.get(itemId);
  if (!item) return refusal('not_found');
  if (item.kind !== 'action') return refusal('not_action');
  const tx = begin(state, env, 'accept', { code: 'accept', params: { itemId } });
  const draft = clone(item);
  draft.suggested = false;
  if (draft.status === 'dismissed') draft.status = 'open';
  putItem(tx, draft);
  return { ...finish(tx), itemId };
}

// patch = {title?, kind?, private?, pinned?, archived?}; origin user.
// Privacy also applies to the item's children.
export function applyEdit(state, itemId, patch, env) {
  const item = state.items.get(itemId);
  if (!item) return refusal('not_found');
  const fields = Object.keys(patch || {}).filter((k) => ['title', 'kind', 'private', 'pinned', 'archived'].includes(k));
  if (!fields.length) return refusal('noop');
  const privacyOnly = fields.length === 1 && fields[0] === 'private';
  const code = privacyOnly ? (patch.private ? 'privacy_on' : 'privacy_off') : 'edit';
  const tx = begin(state, env, privacyOnly ? 'privacy' : 'edit', { code, params: { itemId } });
  const draft = clone(item);
  if (typeof patch.title === 'string' && clean(patch.title, LIMITS.title)) {
    draft.title = clean(patch.title, LIMITS.title);
    draft.titleSource = 'user';
  }
  if (KINDS.includes(patch.kind)) {
    draft.kind = patch.kind;
    draft.kindSource = 'user';
    if (patch.kind === 'action' && !draft.status) {
      draft.status = 'open';
      draft.owner ||= 'me';
    }
  }
  for (const flag of ['private', 'pinned', 'archived']) {
    if (typeof patch[flag] !== 'boolean') continue;
    if (patch[flag]) draft[flag] = true;
    else delete draft[flag];
  }
  putItem(tx, draft);
  if (typeof patch.private === 'boolean') {
    for (const child of childrenOf(state, itemId)) {
      const next = clone(child);
      if (patch.private) next.private = true;
      else delete next.private;
      putItem(tx, next);
    }
  }
  return { ...finish(tx), itemId };
}

/** Deletes items and their children (and explicit links touching them). */
export function applyDelete(state, itemIds, env) {
  const requested = (Array.isArray(itemIds) ? itemIds : [itemIds]).filter((id) => state.items.has(id));
  if (!requested.length) return refusal('not_found');
  const ids = new Set(requested);
  for (const item of state.items.values()) if (item.parentId && ids.has(item.parentId)) ids.add(item.id);
  const sorted = [...ids].sort();
  const tx = begin(state, env, 'delete', { code: 'delete', params: { itemId: requested[0], count: sorted.length } });
  for (const id of sorted) removeItem(tx, id);
  removeRelations(tx, 'links', (link) => ids.has(link.s) || ids.has(link.t));
  return { ...finish(tx), deleted: sorted };
}

// meta = {title?, description?} from fetch_link_metadata, or null when the
// fetch failed. Sets the title only while it's still automatic. Silent op.
export function applyEnrichLink(state, itemId, meta, env) {
  const item = state.items.get(itemId);
  if (!item) return refusal('not_found');
  const tx = begin(state, env, 'enrich', { code: 'enrich', params: { itemId } }, { silent: true });
  const draft = clone(item);
  const title = clean(meta?.title, LIMITS.title);
  const description = clean(meta?.description, LIMITS.summary);
  if (meta && !meta.error && (title || description)) {
    if (title && draft.titleSource === 'auto') {
      draft.title = title;
      draft.titleSource = 'meta';
    }
    if (description && (!draft.summary || draft.summarySource === 'meta')) {
      draft.summary = description;
      draft.summarySource = 'meta';
    }
    draft.enrich = { state: 'done', at: env.now };
  } else {
    draft.enrich = { state: 'failed', at: env.now };
  }
  putItem(tx, draft);
  return { ...finish(tx), itemId };
}

// Re-derives rule-origin fields from a fresh extraction (after enrichment,
// or P2 re-derivation): keyphrases, rule mentions (added; with
// env.replaceRule, rule mentions that are no longer found are removed),
// occurredAt when unset, and the extractor version. Silent by default. A
// picked document keeps its body keyphrases unless x.bodyKeyphrases is set.
export function applyReextract(state, itemId, extraction, env) {
  const item = state.items.get(itemId);
  if (!item) return refusal('not_found');
  const x = extraction || {};
  const tx = begin(state, env, 'enrich', { code: 'reextract', params: { itemId } }, { silent: true });
  const mentions = Array.isArray(x.mentions) ? x.mentions : [];
  const slots = mentions.map(() => env.newId('e'));
  const draft = clone(item);
  const found = [];
  mentions.forEach((m, i) => {
    const id = m && resolveEntity(tx, m, slots[i]);
    if (id && !rejectedMention(state, itemId, id)) found.push({ id, origin: ORIGINS.includes(m.origin) ? m.origin : 'rule' });
  });
  if (env.replaceRule) {
    const keep = new Set(found.map((f) => f.id));
    if (draft.owner) keep.add(draft.owner);
    draft.entityIds = draft.entityIds.filter((id) => draft.mentionOrigin[id] !== 'rule' || keep.has(id));
  }
  const added = [];
  for (const f of found) if (addMention(draft, f.id, f.origin)) added.push(f);
  // A picked document's keyphrases come from its whole body: they change
  // only when the caller passes bodyKeyphrases (it loaded the body).
  if (!item.file) draft.keyphrases = strings(x.keyphrases, LIMITS.keyphrases);
  else if (Array.isArray(x.bodyKeyphrases)) draft.keyphrases = strings(x.bodyKeyphrases, LIMITS.docKeyphrases);
  if (finite(draft.occurredAt) === undefined && finite(x.occurredAt) !== undefined) draft.occurredAt = x.occurredAt;
  if (Number.isInteger(x.v) && x.v > 0) draft.v = x.v;
  putItem(tx, draft);
  for (const child of childrenOf(state, itemId)) {
    const next = clone(child);
    let changed = false;
    for (const f of added) if (!rejectedMention(state, child.id, f.id) && addMention(next, f.id, 'rule')) changed = true;
    if (changed) putItem(tx, next);
  }
  snapshotCandidates(tx, x.candidates);
  const pendingAliases = attachAliases(tx, x.aliases);
  const childIds = childrenOf(state, itemId).map((c) => c.id).sort();
  return { ...finish(tx), itemId, childIds, pendingAliases };
}

function stripId(value) {
  if (typeof value !== 'string') return null;
  const m = /^\s*(?:\[mm:)?(?:mm:)?(?:i:)?([ie][0-9a-z]{14}|me)\]?\s*$/.exec(value);
  return m ? m[1] : null;
}

function capWords(text, max) {
  const words = String(text).trim().split(/\s+/);
  return words.length <= max ? words.join(' ') : `${words.slice(0, max).join(' ')}…`;
}

// P1 agent enrichment (the `annotate` tool), and background organizing's
// results (Kage's EXTENSION_AGENT_CALLS §11.5). entries =
// [{id, summary?, terms?, entities?:[{name,type}], actions?:[{text, quote, owner?, due?}], kind?}].
// Additive only: it never overwrites user-origin fields, never touches
// private items, and rejects actions whose quote isn't in the item's text.
// Agent actions are suggestions unless env.autoAccept (and always on a
// picked document). One undoable op. Other env options:
//   maxNewEntitiesPerItem  at most this many new entities (names and owners
//                          together) per entry. Past it a new name is left
//                          out, and an action whose owner would be new is
//                          rejected ('entity_cap'): it's never given to "me".
//   via: 'background'      a background result: a silent op (`mm undo` skips
//                          it) with op.via 'background'. Its actions are
//                          suggestions whatever autoAccept says, with
//                          source.via 'background'. No kind changes. A name
//                          or owner whose key is a private entity's is never
//                          linked or created ('private_entity'). A link whose
//                          title fetch is pending or failed keeps it.
// rejected = [{ id, reason, text? (an action's), name? (a name's) }].
export function applyAnnotate(state, entries, env) {
  const list = (Array.isArray(entries) ? entries : []).slice(0, LIMITS.annotate);
  const text = textLib(env);
  const background = env?.via === 'background';
  const cap = isCount(env?.maxNewEntitiesPerItem) ? env.maxNewEntitiesPerItem : Infinity;
  const tx = begin(state, background ? { ...env, silent: true } : env, 'annotate', { code: 'annotate', params: { count: list.length } });
  if (background) tx.op.via = 'background';
  const applied = [];
  const rejected = [];
  const childIds = [];
  for (const entry of list) {
    const entities = Array.isArray(entry?.entities) ? entry.entities.slice(0, LIMITS.entitiesPerItem) : [];
    const actions = Array.isArray(entry?.actions) ? entry.actions.slice(0, LIMITS.children) : [];
    const entitySlots = entities.map(() => env.newId('e'));
    const actionSlots = actions.map(() => ({ item: env.newId('i'), owner: env.newId('e') }));
    const id = stripId(entry?.id);
    const item = id ? state.items.get(id) : null;
    if (!item) { rejected.push({ id: id || null, reason: 'not_found' }); continue; }
    if (mentionsPrivate(state, item)) { rejected.push({ id, reason: 'private' }); continue; }
    // A name (or owner) → { id } of its entity, or { reason } it was left
    // out (null: nothing to link, as for a forgotten name). An entity this
    // entry creates takes its own slot and counts against the cap, and so
    // does one an earlier attempt of this op created, so a retry decides
    // the same way.
    let made = 0;
    const pick = (key, resolve, slot) => {
      if (background && privateKey(state, key)) return { reason: 'private_entity' };
      const full = made >= cap;
      const eid = resolve(full ? null : slot);
      if (!eid) return { reason: full && key && !rejectedKey(state, key) ? 'entity_cap' : null };
      if (background && privateEntity(state, eid)) return { reason: 'private_entity' };
      if (eid === slot) made++;
      return { id: eid };
    };
    const draft = clone(item);
    if (typeof entry.summary === 'string' && entry.summary.trim()
        && (!draft.summary || draft.summarySource === 'agent')) {
      draft.summary = trunc(capWords(entry.summary, LIMITS.agentSummaryWords), LIMITS.summary);
      draft.summarySource = 'agent';
    }
    if (Array.isArray(entry.terms) && entry.terms.length) {
      draft.terms = strings([...(draft.terms || []), ...entry.terms], LIMITS.terms);
    }
    entities.forEach((e, i) => {
      const key = text.normalizeKey(e?.name);
      const type = ENTITY_TYPES.includes(e?.type) ? e.type : 'topic';
      // kage-sensitive-data: not-sensitive — reviewed: a stored record, not a settings control
      const got = pick(key, (slot) => resolveEntity(tx, { key, name: e?.name, type, origin: 'agent' }, slot), entitySlots[i]);
      if (got.reason === 'entity_cap') rejected.push({ id, reason: got.reason, name: clean(e?.name, LIMITS.entityName) });
      else if (got.reason) rejected.push({ id, reason: got.reason });
      if (got.id && !rejectedMention(state, id, got.id)) addMention(draft, got.id, 'agent');
    });
    if (!background && KINDS.includes(entry.kind) && entry.kind !== draft.kind && draft.kindSource !== 'user') {
      draft.kind = entry.kind;
      if (entry.kind === 'action' && !draft.status) { draft.status = 'open'; draft.owner ||= 'me'; draft.suggested = !env.autoAccept; }
    }
    // The background never ends a link's title fetch that is still to come.
    const fetching = background && (draft.enrich?.state === 'pending' || draft.enrich?.state === 'failed');
    if (!fetching) draft.enrich = { state: 'done', at: env.now };
    const parent = putItem(tx, draft) || item;
    const known = new Set(childrenOf(state, id).map((c) => quoteForm(c.quote || c.text)));
    actions.forEach((a, i) => {
      const quote = typeof a?.quote === 'string' ? a.quote.trim() : '';
      if (!quote || !text.containsQuote(item.text, quote)) {
        rejected.push({ id, reason: 'quote_not_found', text: clean(a?.text, LIMITS.title) });
        return;
      }
      const form = quoteForm(quote);
      if (known.has(form) && !state.items.has(actionSlots[i].item)) return;
      let owner = 'me';
      if (typeof a.owner === 'string' && a.owner.trim() && !/^(?:me|i|myself)$/i.test(a.owner.trim())) {
        const key = text.normalizeKey(a.owner);
        const got = pick(key, (slot) => resolveOwner(tx, { key, name: a.owner }, slot, 'agent'), actionSlots[i].owner);
        if (got.reason) {
          rejected.push({ id, reason: got.reason, text: clean(a.text || quote, LIMITS.title) });
          return;
        }
        owner = got.id || 'me';
      }
      const child = {
        id: actionSlots[i].item, kind: 'action', title: clean(a.text || quote, LIMITS.title), titleSource: 'agent',
        text: trunc(quote, LIMITS.text), createdAt: env.now, updatedAt: env.now, parentId: id,
        entityIds: [], mentionOrigin: {}, keyphrases: [], source: { via: background ? 'background' : 'agent' },
        enrich: { state: 'none' }, rev: 1, v: item.v,
      };
      // A picked document's actions stay suggestions, auto-accept or not,
      // and so do the background's.
      const suggested = background || !env.autoAccept || !!item.file;
      actionFields(child, { status: 'open', suggested, confidence: 0.6, quote, origin: 'agent', dueAt: isoDayStart(a.due) }, owner, env.now);
      for (const eid of parent.entityIds) addMention(child, eid, parent.mentionOrigin[eid]);
      if (owner !== 'me') addMention(child, owner, 'agent');
      if (putItem(tx, child, { created: true })) { childIds.push(child.id); known.add(form); }
    });
    applied.push(id);
  }
  return { ...finish(tx), applied, rejected, childIds };
}

const noGroups = () => ({ items: [], entities: [], links: [], rejections: [], candidates: [] });

// A silent op of background organizing's own: label fixed, never `mm undo`'s.
const orgEnv = (env) => ({ ...env, opKind: undefined, label: undefined, silent: true });

/**
 * Background organizing's marks (§11.5): marks = [{ id, org }], each org
 * from lib/organize.js markDone or markFailed (checked with normalizeOrg).
 * A silent op that keeps no before-snapshots (nobody undoes a mark, and the
 * journal's 256 KB stays for the user's undo history) but records the revs
 * it left, so an earlier op on the same note can still be undone. Write it
 * before the batch's applyAnnotate, in the same _mutate: undoing that op
 * then brings the note back with its mark, so it isn't sent again.
 * → Change & { marked: id[], skipped: [{ id, reason: 'not_found'|'bad_org' }] }.
 * Refusal: 'noop' (nothing to mark).
 */
export function applyOrgMarks(state, marks, env) {
  const wanted = new Map();
  const skipped = [];
  for (const mark of Array.isArray(marks) ? marks : []) {
    const id = isRecord(mark) && isItemId(mark.id) ? mark.id : null;
    if (!id || !state.items.has(id)) { skipped.push({ id, reason: 'not_found' }); continue; }
    const org = normalizeOrg(mark.org);
    if (!org) { skipped.push({ id, reason: 'bad_org' }); continue; }
    wanted.set(id, org);
  }
  const tx = begin(state, orgEnv(env), 'enrich', { code: 'org_mark', params: { count: wanted.size } });
  for (const [id, org] of wanted) putItem(tx, { ...clone(state.items.get(id)), org });
  const marked = [...wanted.keys()];
  const change = finish(tx, { marked, skipped });
  if (!change.op) return change;
  change.op.before = noGroups();
  change.op.after = {};
  for (const id of marked) change.op.after[id] = state.items.get(id).rev;
  change.op.lossy = true;
  return change;
}

/**
 * Sets meta.orgSince (§11.3): background organizing considers notes created
 * from then on. The caller passes lib/organize.js initialOrgSince(now) the
 * first time the user turns it on, and 0 for "Organize older notes too".
 * Meta is written with every commit, so this is a silent op with no records.
 * → Change & { orgSince }. Refusals: 'bad_org' (not a time), 'same'.
 */
export function applyOrgSince(state, since, env) {
  if (time(since) === undefined) return refusal('bad_org');
  if (state.meta.orgSince === since) return refusal('same');
  const tx = begin(state, orgEnv(env), 'enrich', { code: 'org_since', params: {} });
  state.meta.orgSince = since;
  const change = finish(tx, {}, { always: true });
  change.op.lossy = true;
  return { ...change, orgSince: since };
}

// P2 `mm merge`: `fromId` becomes an alias of `intoId` and redirects to it.
export function applyMerge(state, fromId, intoId, env) {
  const from = state.entities.get(fromId);
  const into = follow(state, state.entities.get(intoId));
  if (!from || !into) return refusal('not_found');
  if (from.id === into.id || (from.mergedInto && follow(state, from)?.id === into.id)) return refusal('same');
  if (from.id === 'me') return refusal('me');
  const tx = begin(state, env, 'merge', { code: 'merge', params: { fromId: from.id, intoId: into.id } });
  let target = clone(into);
  for (const alias of [from.name, ...from.aliases]) {
    const key = foldKey(alias);
    if (!key || key === target.key || target.aliases.some((a) => foldKey(a) === key)) continue;
    if (target.aliases.length < LIMITS.aliases) target.aliases.push(clean(alias, LIMITS.entityName));
  }
  target = putEntity(tx, target) || target;
  putEntity(tx, { ...clone(from), mergedInto: into.id });
  for (const item of [...state.items.values()].sort(byId)) {
    if (!item.entityIds.includes(from.id) && item.owner !== from.id) continue;
    const draft = clone(item);
    if (draft.entityIds.includes(from.id)) {
      const origin = draft.mentionOrigin[from.id];
      draft.entityIds = draft.entityIds.filter((id) => id !== from.id);
      delete draft.mentionOrigin[from.id];
      addMention(draft, into.id, origin);
    }
    if (draft.owner === from.id) draft.owner = into.id;
    putItem(tx, draft);
  }
  return { ...finish(tx), entityId: into.id };
}

// P2 `mm forget`: removes the entity and its mentions, and adds a Rejection
// so the organizer never re-creates it.
export function applyForget(state, entityId, env) {
  const entity = state.entities.get(entityId);
  if (!entity) return refusal('not_found');
  if (entity.id === 'me') return refusal('me');
  const tx = begin(state, env, 'forget', { code: 'forget', params: { entityId } });
  for (const item of [...state.items.values()].sort(byId)) {
    if (!item.entityIds.includes(entityId) && item.owner !== entityId) continue;
    const draft = clone(item);
    draft.entityIds = draft.entityIds.filter((id) => id !== entityId);
    delete draft.mentionOrigin[entityId];
    if (draft.owner === entityId) delete draft.owner;
    putItem(tx, draft);
  }
  const candidate = state.candidates.get(entity.key);
  if (candidate) {
    tx.journal.snapshotBefore(tx.op, 'candidates', candidate);
    state.candidates.delete(entity.key);
    tx.touched.add('entities');
  }
  addRelation(tx, 'rejections', { s: '*', t: entity.key, type: 'entity', at: env.now });
  removeEntity(tx, entityId);
  return { ...finish(tx), entityId };
}

// P2 `mm rename`: the old name stays as an alias. 'conflict' when another
// entity already has the new key (merge instead).
export function applyRename(state, entityId, name, key, env) {
  const entity = state.entities.get(entityId);
  if (!entity) return refusal('not_found');
  const display = clean(name, LIMITS.entityName);
  const nextKey = (typeof key === 'string' && key) || textLib(env).normalizeKey(display);
  if (!display || !nextKey) return refusal('noop');
  const other = entityByKey(state, nextKey);
  if (other && other.id !== entity.id) return refusal('conflict');
  const tx = begin(state, env, 'rename', { code: 'rename', params: { entityId } });
  const draft = clone(entity);
  if (draft.name !== display && foldKey(draft.name) !== foldKey(display)
      && !draft.aliases.some((a) => foldKey(a) === foldKey(draft.name)) && draft.aliases.length < LIMITS.aliases) {
    draft.aliases.push(draft.name);
  }
  draft.aliases = draft.aliases.filter((a) => foldKey(a) !== nextKey);
  draft.name = display;
  draft.key = nextKey;
  draft.origin = 'user';
  putEntity(tx, draft);
  return { ...finish(tx), entityId };
}

// P2 Import JSON: {format:'kage-mindmap', schema, items, entities, links,
// rejections}. Ids dedupe with the newer updatedAt winning. One undoable op.
export function applyImport(state, data, env) {
  if (!data || typeof data !== 'object' || data.format !== 'kage-mindmap') return refusal('bad_format');
  if (Number.isInteger(data.schema) && data.schema > SCHEMA) return refusal('future_schema');
  const tx = begin(state, env, 'import', { code: 'import', params: {} });
  const counts = { added: 0, updated: 0, skipped: 0 };
  const take = (incoming, current, put) => {
    if (!current) { put(incoming, true); counts.added++; }
    else if (incoming.updatedAt > current.updatedAt) {
      put({ ...incoming, rev: Math.max(incoming.rev, current.rev + 1) }, false);
      counts.updated++;
    } else counts.skipped++;
  };
  for (const raw of Array.isArray(data.entities) ? data.entities : []) {
    const entity = normalizeEntity(raw);
    if (!entity || entity.id === 'me') { counts.skipped++; continue; }
    take(entity, state.entities.get(entity.id), (e, created) => putEntity(tx, e, { created, keepRev: true }));
  }
  for (const raw of Array.isArray(data.items) ? data.items : []) {
    const item = normalizeItem(raw);
    if (!item) { counts.skipped++; continue; }
    item.entityIds = item.entityIds.filter((id) => state.entities.has(id));
    for (const id of Object.keys(item.mentionOrigin)) if (!item.entityIds.includes(id)) delete item.mentionOrigin[id];
    if (item.owner && !state.entities.has(item.owner)) delete item.owner;
    take(item, state.items.get(item.id), (i, created) => putItem(tx, i, { created, keepRev: true }));
  }
  for (const [field, types] of [['links', LINK_TYPES], ['rejections', REJECTION_TYPES]]) {
    for (const raw of Array.isArray(data[field]) ? data[field] : []) {
      const relation = normalizeRelation(raw, types);
      if (relation) addRelation(tx, field, relation);
    }
  }
  tx.op.label = env.label || { code: 'import', params: { count: counts.added + counts.updated } };
  return { ...finish(tx), result: counts };
}

// ---------------------------------------------------------------------------
// Kage folder sync (SYNC §12.9)

const pairsOf = (value) => (value instanceof Map ? [...value] : Array.isArray(value) ? value : []);
const REV_ONLY = new Set(['rev']);

/**
 * Changes another computer made, from Kage folder sync (SYNC §12.9 item 2):
 * remote = { items, entities, links, rejections, bodies }, each a Map (or
 * [id, value] pairs) of the newest merged record per sync id, null for a
 * delete. Item and entity values already carry this computer's local fields
 * (lib/syncmap.js withLocal); a changed record gets rev = local.rev + 1 (1
 * when new). Body values are lib/syncmap.js bodyFromRecord's { key, value }.
 *
 * A silent op of kind 'sync' that `mm undo` skips. It keeps no snapshots:
 * it records only the revs it left on records an earlier op could still
 * undo, so that undo is refused as superseded (lib/journal.js), and it takes
 * the place of the sync op before it when that one is the newest op. With
 * no such record it isn't journaled (change.unjournaled).
 *
 * Then the deterministic entity dedupe (item 3): entities with the same
 * (type, key) and no mergedInto merge, the larger id getting mergedInto the
 * smaller. Every computer reaches the same result; change.dedupe lists the
 * merged ids, which the caller pushes (nothing else here is pushed).
 *
 * env.syncPrivate === false leaves this computer's private items and names
 * as they are. env.relationId(relation) is lib/syncmap.js relationId.
 * → Change & { remote: true, unjournaled, ids: { items, entities } (Sets),
 *   bodies: [{ key, value }], dedupe: entityId[], counts: { applied, skipped } }
 * Refusal: 'noop' (nothing differs).
 */
export function applyRemote(state, remote, env) {
  const journal = requireJournal(env);
  const syncId = typeof env.relationId === 'function' ? env.relationId : relationId;
  const keepPrivate = env.syncPrivate === false;
  const touched = new Set();
  const ids = { items: new Set(), entities: new Set() };
  const counts = { applied: 0, skipped: 0 };
  const bodies = [];
  // Records an earlier op could still undo: the ones whose rev this op must record.
  const watched = new Set();
  for (const o of state.ops) {
    if (o.kind === 'sync' || o.kind === 'undo' || o.undoneBy || o.lossy) continue;
    for (const id of Object.keys(o.after || {})) watched.add(id);
  }
  const after = {};
  const left = (id, rev) => { if (watched.has(id)) after[id] = rev; };

  for (const [id, value] of pairsOf(remote?.items)) {
    const current = state.items.get(id);
    if (keepPrivate && current?.private) { counts.skipped++; continue; }
    if (value === null) {
      if (!current) continue;
      state.items.delete(id);
      touched.add(itemPart(current));
      ids.items.add(id);
      left(id, null);
      counts.applied++;
      continue;
    }
    const item = normalizeItem({ ...value, id });
    if (!item) { counts.skipped++; continue; }
    if (current && deepEqual(current, item, REV_ONLY)) continue;
    item.rev = current ? current.rev + 1 : 1;
    if (current && shardOf(current) !== shardOf(item)) touched.add(itemPart(current));
    state.items.set(id, item);
    touched.add(itemPart(item));
    ids.items.add(id);
    left(id, item.rev);
    counts.applied++;
  }

  for (const [id, value] of pairsOf(remote?.entities)) {
    if (id === 'me') continue;
    const current = state.entities.get(id);
    if (keepPrivate && current?.private) { counts.skipped++; continue; }
    if (value === null) {
      if (!current) continue;
      state.entities.delete(id);
      touched.add('entities');
      ids.entities.add(id);
      left(id, null);
      counts.applied++;
      continue;
    }
    const entity = normalizeEntity({ ...value, id });
    if (!entity) { counts.skipped++; continue; }
    if (current && deepEqual(current, entity, REV_ONLY)) continue;
    entity.rev = current ? current.rev + 1 : 1;
    state.entities.set(id, entity);
    touched.add('entities');
    ids.entities.add(id);
    left(id, entity.rev);
    counts.applied++;
  }

  for (const [field, types] of [['links', LINK_TYPES], ['rejections', REJECTION_TYPES]]) {
    const list = pairsOf(remote?.[field]);
    if (!list.length) continue;
    const known = new Map(state[field].map((r) => [syncId(r), r]));
    let changed = false;
    for (const [id, value] of list) {
      if (value === null) {
        if (known.delete(id)) { changed = true; counts.applied++; }
        continue;
      }
      const relation = normalizeRelation(value, types);
      if (!relation || syncId(relation) !== id) { counts.skipped++; continue; }
      if (known.has(id) && deepEqual(known.get(id), relation)) continue;
      known.set(id, relation);
      changed = true;
      counts.applied++;
    }
    if (changed) {
      state[field] = [...known.values()].sort(byRelation);
      touched.add('links');
    }
  }

  // A body is written unless this computer's item already names a newer one.
  for (const [id, value] of pairsOf(remote?.bodies)) {
    if (value === null) continue;
    const body = value && normalizeBody(value.value, value.key);
    const parsed = parseBodyKey(value?.key);
    if (!body || !parsed || parsed.id !== id) { counts.skipped++; continue; }
    const item = state.items.get(id);
    if (keepPrivate && item?.private) { counts.skipped++; continue; }
    const have = parseBodyKey(item?.body?.key);
    if (have && have.n > parsed.n) { counts.skipped++; continue; }
    bodies.push({ key: value.key, value: body });
    counts.applied++;
  }

  // Two computers can promote the same name before they sync: one entity
  // per (type, key), the smallest id, the others redirecting to it.
  const groups = new Map();
  for (const entity of state.entities.values()) {
    if (entity.id === 'me' || entity.mergedInto) continue;
    const key = `${entity.type}|${entity.key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entity);
  }
  const dedupe = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort(byId);
    for (const entity of list.slice(1)) {
      // updatedAt stays: every computer pushes the same value.
      const merged = { ...clone(entity), mergedInto: list[0].id, rev: entity.rev + 1 };
      state.entities.set(entity.id, merged);
      touched.add('entities');
      ids.entities.add(entity.id);
      left(entity.id, merged.rev);
      dedupe.push(entity.id);
    }
  }

  if (!touched.size && !bodies.length) return { ...refusal('noop'), counts };
  const op = journal.newOp({ opId: env.newId('o'), kind: 'sync', at: env.now, label: { code: 'sync', params: { count: counts.applied } }, silent: true });
  // The newest op is the previous pull's: this one replaces it, so pulls
  // never push the user's own undo history out of the journal.
  const last = state.ops[state.ops.length - 1];
  if (last?.kind === 'sync') {
    for (const [id, rev] of Object.entries(last.after || {})) if (!Object.hasOwn(after, id)) after[id] = rev;
  }
  op.after = after;
  const unjournaled = !Object.keys(after).length;
  if (!unjournaled && last?.kind === 'sync') state.ops = state.ops.slice(0, -1);
  return { op, touched, remote: true, unjournaled, ids, bodies, dedupe: dedupe.sort(), counts };
}
