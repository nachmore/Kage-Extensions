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
//     'future_schema'; nothing changed and nothing needs saving.
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
});

const ITEM_ID = /^i[0-9a-z]{14}$/;
const ENTITY_ID = /^(?:e[0-9a-z]{14}|me)$/;
const OP_ID = /^o[0-9a-z]{14}$/;
const TITLE_SOURCES = ['auto', 'meta', 'user', 'agent'];
const SUMMARY_SOURCES = ['meta', 'agent', 'user'];
const ORIGINS = ['user', 'agent', 'rule'];
const ORIGIN_RANK = { rule: 0, agent: 1, user: 2 };
const VIAS = ['launcher', 'chat', 'agent', 'import'];
const ENRICH_STATES = ['none', 'pending', 'done', 'failed'];
const LINK_TYPES = ['related', 'about', 'duplicate_of'];
const REJECTION_TYPES = ['mention', 'link', 'entity'];
const CANDIDATE_TYPES = ['term', 'person'];
const URL_RE = /(?:\bhttps?:\/\/|\bwww\.|\bfile:\/\/)[^\s<>]+/gi;

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

function validSource(raw) {
  const source = { via: VIAS.includes(raw?.via) ? raw.via : 'launcher' };
  if (typeof raw?.app === 'string' && raw.app.trim()) source.app = clean(raw.app, LIMITS.app);
  if (typeof raw?.window === 'string' && raw.window.trim()) source.window = clean(raw.window, LIMITS.window);
  return source;
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
  item.keyphrases = strings(raw.keyphrases, LIMITS.keyphrases);
  if (Array.isArray(raw.terms)) item.terms = strings(raw.terms, LIMITS.terms); else delete item.terms;
  if (typeof raw.summary === 'string' && raw.summary.trim()) {
    item.summary = trunc(raw.summary.trim(), LIMITS.summary);
    item.summarySource = SUMMARY_SOURCES.includes(raw.summarySource) ? raw.summarySource : 'user';
  } else {
    delete item.summary;
    delete item.summarySource;
  }
  item.source = validSource(raw.source);
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
  }
  return meta;
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
  state.meta.counts = { items: state.items.size, entities: state.entities.size };
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
    const { keys, extractorVersion, createdAt, updatedAt, gen } = state.meta;
    return {
      schema: SCHEMA, ...(gen ? { gen } : {}), keys: { ...keys }, counts: { items: state.items.size, entities: state.entities.size },
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

const rejectedKey = (state, key) => state.rejections.some((r) => r.type === 'entity' && r.t === key);
const rejectedMention = (state, itemId, entityId) =>
  state.rejections.some((r) => r.type === 'mention' && r.s === itemId && r.t === entityId);

function mentionsPrivate(state, item) {
  if (item.private) return true;
  return item.entityIds.some((id) => state.entities.get(id)?.private);
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

function sourceOf(env) {
  return validSource({ via: env.via, app: env.source?.app, window: env.source?.window });
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

// ---------------------------------------------------------------------------
// Mutations

// Creates the parent item, its children (actions, links) and any new
// entities; or, for a URL/path/window doc that's already saved, merges into
// that item (annotation line `— YYYY-MM-DD: <text>`, mentions, new actions).
export function applyCapture(state, extraction, env) {
  const x = extraction || {};
  const tx = begin(state, env, 'capture', { code: 'capture', params: {} });
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
  // What a child inherits from its parent (F-CAP-3): the parent's teams,
  // projects, topics and orgs, and the names on the heading line; people
  // and terms only from its own line, so "book the offsite" doesn't become
  // an MTCS action because a sibling line names MTCS.
  const childSegs = new Set(specs.map((spec) => (spec.action ? spec.action.seg : spec.link?.seg)).filter(Number.isInteger));
  const headSeg = (seg) => Number.isInteger(seg) && (seg < 0 || (seg === 0 && !childSegs.has(0)));
  const inherit = (draft, parent, ownSeg, { fresh = true } = {}) => {
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
      const draft = {
        id, kind: 'action', title: clean(a.title || a.text || a.quote, LIMITS.title), titleSource: 'auto',
        text: trunc(String(a.text ?? a.quote ?? ''), LIMITS.text), createdAt: now, updatedAt: now,
        parentId: parent.id, entityIds: [], mentionOrigin: {}, keyphrases: [], source,
        enrich: { state: 'none' }, rev: 1, v: x.v ?? 1,
      };
      actionFields(draft, a, owners[i + 1], now);
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
    entityIds: [], mentionOrigin: {}, keyphrases: strings(x.keyphrases, LIMITS.keyphrases),
    source, enrich: enrichFor(x.url, env), rev: 1, v: x.v ?? 1,
  };
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
  tx.op.label = env.label || { code: 'capture', params: { itemId: parentId, count: 1 + childIdsMade.length } };
  return {
    ...finish(tx, {}, { always: true }), itemId: parentId, childIds: childIdsMade, pendingAliases,
    result: { annotated: false, rejectedActions: x.rejectedActions || [], truncated: !!x.truncated, linkDupes },
  };
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
// occurredAt when unset, and the extractor version. Silent by default.
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
  draft.keyphrases = strings(x.keyphrases, LIMITS.keyphrases);
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

// P1 agent enrichment (the `annotate` tool). entries =
// [{id, summary?, terms?, entities?:[{name,type}], actions?:[{text, quote, owner?, due?}], kind?}].
// Additive only: it never overwrites user-origin fields, never touches
// private items, and rejects actions whose quote isn't in the item's text.
// Agent actions are suggestions unless env.autoAccept. One undoable op.
export function applyAnnotate(state, entries, env) {
  const list = (Array.isArray(entries) ? entries : []).slice(0, LIMITS.annotate);
  const text = textLib(env);
  const tx = begin(state, env, 'annotate', { code: 'annotate', params: { count: list.length } });
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
      // kage-sensitive-data: not-sensitive — reviewed: a stored record, not a settings control
      const eid = resolveEntity(tx, { key, name: e?.name, type: ENTITY_TYPES.includes(e?.type) ? e.type : 'topic', origin: 'agent' }, entitySlots[i]);
      if (eid && !rejectedMention(state, id, eid)) addMention(draft, eid, 'agent');
    });
    if (KINDS.includes(entry.kind) && entry.kind !== draft.kind && draft.kindSource !== 'user') {
      draft.kind = entry.kind;
      if (entry.kind === 'action' && !draft.status) { draft.status = 'open'; draft.owner ||= 'me'; draft.suggested = !env.autoAccept; }
    }
    draft.enrich = { state: 'done', at: env.now };
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
        owner = resolveOwner(tx, { key: text.normalizeKey(a.owner), name: a.owner }, actionSlots[i].owner, 'agent') || 'me';
      }
      const child = {
        id: actionSlots[i].item, kind: 'action', title: clean(a.text || quote, LIMITS.title), titleSource: 'agent',
        text: trunc(quote, LIMITS.text), createdAt: env.now, updatedAt: env.now, parentId: id,
        entityIds: [], mentionOrigin: {}, keyphrases: [], source: { via: 'agent' },
        enrich: { state: 'none' }, rev: 1, v: item.v,
      };
      actionFields(child, { status: 'open', suggested: !env.autoAccept, confidence: 0.6, quote, origin: 'agent', dueAt: isoDayStart(a.due) }, owner, env.now);
      for (const eid of parent.entityIds) addMention(child, eid, parent.mentionOrigin[eid]);
      if (owner !== 'me') addMention(child, owner, 'agent');
      if (putItem(tx, child, { created: true })) { childIds.push(child.id); known.add(form); }
    });
    applied.push(id);
  }
  return { ...finish(tx), applied, rejected, childIds };
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
