// Leaf module: imports nothing (the host rewrites one level of shared imports).
// Background organizing (Kage docs/design/EXTENSION_AGENT_CALLS.md §11.3–11.5):
// which notes may go to the agent, what is sent for each, the request and its
// reply schema, reading the reply back as annotate entries, and the `org`
// marks. Uses lib.text, lib.dates and lib.url through the injected `lib`.
// Pure and deterministic: time comes in as `now`, nothing is random, and it
// never calls `context.*`. `t` is passed in by the caller.

export const ORGANIZE_V = 1;
export const PURPOSE = 'organize';
export const DEDUPE_KEY = 'organize';
export const ORG_STATES = Object.freeze(['done', 'skipped', 'failed']);
// agent_call_status().machine_tag: the first 16 hex characters of a SHA-256.
export const MACHINE_TAG_RE = /^[0-9a-f]{16}$/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ORGANIZE_LIMITS = Object.freeze({
  batch: 15, bodyChars: 600, vocabulary: 50, // = defaults.js LIMITS.organizeItems, organizeChars, organizeVocabulary
  titleChars: 120, entityNames: 12, nameChars: 60, urlChars: 300, fileChars: 120,
  minChars: 40, // title and text together
  settleMs: 2 * MINUTE, pendingLinkMs: 10 * MINUTE, otherMachineMs: DAY, sinceMs: 7 * DAY,
  maxTries: 3, retryMs: HOUR,
  // The host's caps (§5.6), with the manifest's lower maxPromptChars.
  promptChars: 16000, instructionsChars: 4000, inputChars: 24000, labelChars: 80,
  // The host's framing around instructions, schema and data (§5.2) is about
  // 600 characters; the rest is margin for a translated extension name.
  frameChars: 1000,
  maxResponseChars: 12000, timeoutMs: 90000,
});

const KINDS = new Set(['note', 'link', 'doc', 'meeting']);
const ENTITY_TYPES = Object.freeze(['person', 'team', 'project', 'topic', 'org', 'term']);
const ME_WORD_RE = /^(?:me|i|myself)$/i;
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// C0/C1 controls and bidi overrides, never kept from an agent reply or a label.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Reasons that only mean "not yet": the note is still waiting its turn.
const WAITS = new Set(['settling', 'pending_link', 'other_machine', 'backoff']);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => typeof v === 'number' && Number.isFinite(v);
const isHttp = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v);
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const stripAngles = (s) => String(s ?? '').replace(/[<>]/g, '');

function clip(s, max) {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

// Agent text kept as data: no controls or bidi overrides, collapsed, capped.
function agentString(v, max) {
  if (typeof v !== 'string') return '';
  return clip(collapse(v.replace(CONTROL_RE, '')), max).trim();
}

function fnv1a(s) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * FNV-1a 32-bit (base36) of the collapsed title and text. Self-contained on
 * purpose: a change to another module's whitespace rules must never re-queue
 * every organized note.
 */
export function textHash(item) {
  return fnv1a(`${collapse(item?.title)}\n${collapse(item?.text)}`).toString(36);
}

/** True for items the agent must never see: private, or naming a private entity (mind.isHidden). */
export function hidden(item, state) {
  if (!item) return true;
  if (item.private) return true;
  return (item.entityIds || []).some((id) => state?.entities?.get(id)?.private);
}

// Mind's _agentOrganized without the children check, for callers that don't
// pass `organized`: the visible `mm organize` already did this note.
function agentTouched(item) {
  if (item.enrich?.state !== 'done') return false;
  if (!isHttp(item.url)) return true;
  if (item.summarySource === 'agent' || item.terms?.length) return true;
  return Object.values(item.mentionOrigin || {}).includes('agent');
}

function orgOf(item) {
  const org = item.org;
  if (!isRecord(org) || !ORG_STATES.includes(org.state) || typeof org.hash !== 'string') return null;
  return org;
}

function contentChars(item) {
  const title = collapse(item.title);
  const body = collapse(item.text);
  if (title && body.toLowerCase().startsWith(title.toLowerCase())) return body.length;
  return title.length + body.length;
}

/** "Now minus 7 days": meta.orgSince the first time background organizing is turned on. */
export function initialOrgSince(now) {
  return now - ORGANIZE_LIMITS.sinceMs;
}

// → { reason: code | null, own }. Checks run cheapest first; the text hash
// only for a note that has an `org` mark.
function check(item, ctx) {
  const L = ORGANIZE_LIMITS;
  const now = ctx.now;
  if (!isRecord(item) || typeof item.id !== 'string' || !isTime(item.createdAt)) return { reason: 'bad' };
  if (item.parentId) return { reason: 'child' };
  if (item.archived) return { reason: 'archived' };
  if (!(KINDS.has(item.kind) || (item.kind === 'action' && item.status === 'open'))) return { reason: 'kind' };
  if (hidden(item, ctx.state)) return { reason: 'private' };
  // A picked document Kage thought holds a password or key never goes, even
  // after "Let my agent see it" (Kage EXTENSION_FILE_TEXT §11.7).
  if (Array.isArray(item.file?.warnings) && item.file.warnings.includes('possible_secret')) return { reason: 'secret' };
  if (contentChars(item) < L.minChars) return { reason: 'short' };
  const org = orgOf(item);
  let retry = false;
  if (org) {
    if (org.hash === textHash(item)) {
      if (org.state === 'done') return { reason: 'organized' };
      if (org.state === 'skipped') return { reason: 'skipped' };
      const tries = Number.isSafeInteger(org.tries) && org.tries > 0 ? org.tries : 1;
      if (tries >= L.maxTries) return { reason: 'failed' };
      retry = true;
    }
  } else if ((ctx.organized || agentTouched)(item)) {
    return { reason: 'organized' };
  }
  const since = isTime(ctx.orgSince) ? ctx.orgSince : initialOrgSince(now);
  if (item.createdAt < since) return { reason: 'out_of_scope' };
  const updated = isTime(item.updatedAt) ? item.updatedAt : item.createdAt;
  if (now - item.createdAt < L.settleMs || now - updated < L.settleMs) return { reason: 'settling' };
  if (item.enrich?.state === 'pending' && now - item.createdAt < L.pendingLinkMs) return { reason: 'pending_link' };
  const tag = typeof ctx.machineTag === 'string' && ctx.machineTag ? ctx.machineTag : null;
  const own = tag !== null && item.source?.dev === tag;
  if (!own && now - item.createdAt < L.otherMachineMs) return { reason: 'other_machine', own };
  if (retry && isTime(org.next) && org.next > now) return { reason: 'backoff', own };
  return { reason: null, own };
}

/**
 * Why `item` can't go in a batch now, or null when it can (§11.3). Codes:
 * bad, child, archived, kind, private, secret, short, organized, skipped,
 * failed, out_of_scope, settling, pending_link, other_machine, backoff.
 * ctx: { now, state, orgSince?, machineTag?, organized?(item) }.
 */
export function ineligibleReason(item, ctx) {
  return check(item, ctx).reason;
}

export function eligible(item, ctx) {
  return check(item, ctx).reason === null;
}

/**
 * The next batch, at most `max` notes: this machine's notes newest first,
 * then untagged and other machines' notes (older than a day) in
 * hash(machineTag + id) order, so two machines start from different places.
 * ctx: { now, orgSince?, machineTag?, organized?, max? }.
 */
export function selectBatch(state, ctx) {
  const c = { ...ctx, state };
  const own = [];
  const others = [];
  for (const item of state.items.values()) {
    const r = check(item, c);
    if (r.reason === null) (r.own ? own : others).push(item);
  }
  own.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const tag = typeof ctx.machineTag === 'string' ? ctx.machineTag : '';
  const order = new Map(others.map((item) => [item.id, fnv1a(tag + item.id)]));
  others.sort((a, b) => order.get(a.id) - order.get(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const max = Number.isSafeInteger(ctx.max) && ctx.max > 0 ? Math.min(ctx.max, ORGANIZE_LIMITS.batch) : ORGANIZE_LIMITS.batch;
  return [...own, ...others].slice(0, max);
}

/**
 * Settings counts: notes organized (including the ones the agent looked at
 * and had nothing to add to), waiting (eligible now, or only waiting for
 * time to pass), and older ones that "Organize older notes too" would add.
 */
export function organizeCounts(state, ctx) {
  const c = { ...ctx, state };
  const out = { organized: 0, waiting: 0, older: 0 };
  for (const item of state.items.values()) {
    const { reason } = check(item, c);
    if (reason === 'organized' || reason === 'skipped') out.organized++;
    else if (reason === null || WAITS.has(reason)) out.waiting++;
    else if (reason === 'out_of_scope') out.older++;
  }
  return out;
}

// --- what is sent -------------------------------------------------------------------

// A URL without userinfo, query or fragment.
export function stripUrl(raw) {
  return String(raw ?? '').replace(/^((?:https?:\/\/)?)[^/@\s]*@/i, '$1').replace(/[?#].*$/s, '');
}

// URLs lose their userinfo, query and fragment, and paths keep only the file
// name: a doc's text is often its path, a link's its URL as pasted.
function scrub(s, lib) {
  const str = String(s ?? '');
  if (!str) return '';
  const spans = [
    ...lib.url.findUrls(str).map((u) => ({ start: u.start, end: u.end, to: stripUrl(u.raw) })),
    ...lib.url.findPaths(str).map((p) => ({ start: p.start, end: p.end, to: lib.url.baseName(p.path) })),
  ].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const span of spans) {
    if (span.start < at) continue;
    out += str.slice(at, span.start) + span.to;
    at = span.end;
  }
  return out + str.slice(at);
}

function plain(s, lib) {
  return lib.text.collapseWs(stripAngles(scrub(s, lib)));
}

// The organize body without its title (sent on its own): the summary when
// it says more than the title, then the text. ≤600 characters, no <>.
function bodyOf(item, title, lib) {
  const body = plain(item.text, lib);
  const summary = item.summary ? plain(item.summary, lib) : '';
  const parts = [];
  if (summary && summary.toLowerCase() !== title.toLowerCase() && !body.toLowerCase().includes(summary.toLowerCase())) parts.push(summary);
  if (body) parts.push(body);
  return lib.text.truncate(parts.join(' — '), ORGANIZE_LIMITS.bodyChars);
}

function myKeys(ctx) {
  const names = Array.isArray(ctx.myNames) ? ctx.myNames : [];
  return new Set(names.map((name) => ctx.lib.text.normalizeKey(name)).filter(Boolean));
}

/**
 * What one note sends (§11.3), without its ref: kind, date, title, text,
 * the names of its non-private entities, and a link's URL (no userinfo,
 * query or fragment) or a doc's file name. Never the source window or app,
 * folders, private entities or "Names that mean you".
 * ctx: { state, lib, myNames? }.
 */
export function notePayload(item, ctx, mine = myKeys(ctx)) {
  const { lib, state } = ctx;
  const L = ORGANIZE_LIMITS;
  const title = lib.text.truncate(plain(item.title, lib), L.titleChars);
  const out = {
    kind: item.kind,
    date: lib.dates.toIsoDay(isTime(item.occurredAt) ? item.occurredAt : item.createdAt),
    title,
  };
  const text = bodyOf(item, title, lib);
  if (text) out.text = text;
  const names = [];
  const seen = new Set();
  for (const id of item.entityIds || []) {
    if (id === 'me') continue;
    const entity = state?.entities?.get(id);
    if (!entity || entity.private || entity.mergedInto) continue;
    const name = lib.text.truncate(lib.text.collapseWs(stripAngles(entity.name)), L.nameChars);
    const key = lib.text.normalizeKey(name);
    if (!name || !key || mine.has(key) || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= L.entityNames) break;
  }
  if (names.length) out.entities = names;
  if (isHttp(item.url)) {
    out.url = lib.text.truncate(stripAngles(stripUrl(item.url)), L.urlChars);
  } else if (item.kind === 'doc' && (item.path || item.url || typeof item.file?.name === 'string')) {
    // A picked document has only its file name (Kage never gives a path).
    const raw = item.path || item.url || item.file.name;
    const file = lib.text.truncate(lib.text.collapseWs(stripAngles(lib.url.baseName(raw))), L.fileChars);
    if (file) out.file = file;
  }
  return out;
}

/**
 * The names the agent may reuse (§11.3): the top `max` entities by how many
 * visible notes name them. Never private, merged, "me", or one of the
 * user's own names. → [{ name, type }].
 * ctx: { lib, myNames?, max? }.
 */
export function vocabulary(state, ctx) {
  const { lib } = ctx;
  const mine = myKeys(ctx);
  const visible = new Map();
  for (const item of state.items.values()) {
    if (item.archived || hidden(item, state)) continue;
    for (const id of item.entityIds || []) visible.set(id, (visible.get(id) || 0) + 1);
  }
  const max = Number.isSafeInteger(ctx.max) && ctx.max >= 0 ? ctx.max : ORGANIZE_LIMITS.vocabulary;
  return [...state.entities.values()]
    .filter((e) => e.id !== 'me' && !e.mergedInto && !e.private && visible.get(e.id))
    // kage-sensitive-data: not-sensitive — reviewed: a vocabulary entry for the agent, not a settings control
    .map((e) => ({ id: e.id, n: visible.get(e.id), name: lib.text.truncate(lib.text.collapseWs(stripAngles(e.name)), ORGANIZE_LIMITS.nameChars), type: e.type }))
    .filter((e) => e.name && !mine.has(lib.text.normalizeKey(e.name)))
    .sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1))
    .slice(0, max)
    // kage-sensitive-data: not-sensitive — reviewed: a vocabulary entry for the agent, not a settings control
    .map((e) => ({ name: e.name, type: ENTITY_TYPES.includes(e.type) ? e.type : 'topic' }));
}

const str = (maxLength) => ({ type: 'string', maxLength });
const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

/** The reply schema (§11.4), in the host's JSON Schema subset (§5.3). */
export const SCHEMA = deepFreeze({
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array', maxItems: ORGANIZE_LIMITS.batch,
      items: {
        type: 'object', additionalProperties: false, required: ['ref'],
        properties: {
          ref: str(4),
          skip: { type: 'boolean' },
          summary: str(240),
          terms: { type: 'array', maxItems: 5, items: str(40) },
          entities: {
            type: 'array', maxItems: 8,
            items: {
              type: 'object', additionalProperties: false, required: ['name', 'type'],
              // kage-sensitive-data: not-sensitive — reviewed: the reply schema, not a settings control
              properties: { name: str(60), type: { type: 'string', enum: [...ENTITY_TYPES] } },
            },
          },
          actions: {
            type: 'array', maxItems: 5,
            items: {
              type: 'object', additionalProperties: false, required: ['text', 'quote'],
              properties: { text: str(160), quote: str(240), owner: str(60), due: str(10) },
            },
          },
        },
      },
    },
  },
});

/**
 * The request for one batch (§11.4), or null when there is nothing to send.
 * Notes are dropped from the end, then vocabulary, until the framed prompt
 * fits the manifest's maxPromptChars (the host pretty-prints the data).
 * ctx: { t, today, state, lib, myNames?, maxPromptChars? }.
 * → { request, refs: Map<'n1'…, { id, rev, hash }>, ids }.
 */
export function buildRequest(batch, vocab, ctx) {
  const L = ORGANIZE_LIMITS;
  const t = typeof ctx.t === 'function' ? ctx.t : (key) => key;
  const items = (Array.isArray(batch) ? batch : []).slice(0, L.batch);
  if (!items.length) return null;
  const instructions = String(t('prompt.organize_bg') ?? '');
  if (!instructions || instructions.length > L.instructionsChars) return null;
  const mine = myKeys(ctx);
  const notes = items.map((item, i) => ({ ref: `n${i + 1}`, ...notePayload(item, ctx, mine) }));
  const words = Array.isArray(vocab) ? vocab.slice(0, L.vocabulary) : [];
  const today = typeof ctx.today === 'string' && ctx.today ? ctx.today : ctx.lib.dates.toIsoDay(ctx.now);
  const limit = Math.min(L.promptChars, Number.isSafeInteger(ctx.maxPromptChars) && ctx.maxPromptChars > 0 ? ctx.maxPromptChars : L.promptChars);
  const budget = limit - L.frameChars - instructions.length - JSON.stringify(SCHEMA, null, 1).length;
  const size = (input) => JSON.stringify(input, null, 1).length;
  const input = { today, vocabulary: words, notes };
  while (size(input) > budget && input.notes.length > 1) input.notes = input.notes.slice(0, -1);
  while (size(input) > budget && input.vocabulary.length) input.vocabulary = input.vocabulary.slice(0, -1);
  if (size(input) > budget) return null;
  const n = input.notes.length;
  const label = clip(collapse(String(t('op.organized_bg_label', { n }) ?? '').replace(CONTROL_RE, '')), L.labelChars).trim();
  const request = {
    ...(label ? { label } : {}),
    instructions,
    input,
    schema: SCHEMA,
    maxResponseChars: L.maxResponseChars,
    timeoutMs: L.timeoutMs,
  };
  if (JSON.stringify(input).length > L.inputChars) return null;
  const refs = new Map();
  const ids = [];
  for (let i = 0; i < n; i++) {
    const item = items[i];
    refs.set(`n${i + 1}`, { id: item.id, rev: item.rev, hash: textHash(item) });
    ids.push(item.id);
  }
  return { request, refs, ids };
}

// --- the reply ----------------------------------------------------------------------

function typeMatches(value, type) {
  switch (type) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

const childPath = (path, key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

// The first path where `value` breaks `schema`, or null. The host's subset
// (§5.3): type, properties, required, additionalProperties, items, enum,
// min/maxLength in characters, min/maxItems, minimum/maximum.
function mismatch(schema, value, path) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) return path;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === value)) return path;
  if (typeof value === 'string') {
    const n = Array.from(value).length;
    if (Number.isFinite(schema.minLength) && n < schema.minLength) return path;
    if (Number.isFinite(schema.maxLength) && n > schema.maxLength) return path;
  } else if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return path;
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return path;
  } else if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) return path;
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) return path;
    if (isRecord(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const bad = mismatch(schema.items, value[i], `${path}[${i}]`);
        if (bad) return bad;
      }
    }
  } else if (isRecord(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key)) return childPath(path, key);
    }
    const props = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(props, key)) {
        const bad = mismatch(props[key], value[key], childPath(path, key));
        if (bad) return bad;
      } else if (schema.additionalProperties === false) {
        return childPath(path, key);
      }
    }
  }
  return null;
}

/**
 * Checks a reply against SCHEMA with the host's rules. The host validates
 * first; this is the extension's own check of what it will apply.
 * → { ok: true } | { ok: false, code: 'not_json'|'invalid_response', path }.
 */
export function validateReply(json) {
  if (json === undefined || json === null) return { ok: false, code: 'not_json', path: '$' };
  const path = mismatch(SCHEMA, json, '$');
  return path ? { ok: false, code: 'invalid_response', path } : { ok: true };
}

function isoDay(v) {
  const m = ISO_DAY_RE.exec(typeof v === 'string' ? v.trim() : '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? m[0] : null;
}

function cleanEntry(raw) {
  const out = {};
  const summary = agentString(raw.summary, 240);
  if (summary) out.summary = summary;
  const terms = [];
  for (const term of Array.isArray(raw.terms) ? raw.terms : []) {
    const value = agentString(term, 40);
    if (value && !terms.some((t) => t.toLowerCase() === value.toLowerCase())) terms.push(value);
    if (terms.length >= 5) break;
  }
  if (terms.length) out.terms = terms;
  const entities = [];
  for (const e of Array.isArray(raw.entities) ? raw.entities : []) {
    if (!isRecord(e) || !ENTITY_TYPES.includes(e.type)) continue;
    const name = agentString(e.name, 60);
    if (!name || ME_WORD_RE.test(name) || entities.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    // kage-sensitive-data: not-sensitive — reviewed: a name from the agent's reply, not a settings control
    entities.push({ name, type: e.type });
    if (entities.length >= 8) break;
  }
  if (entities.length) out.entities = entities;
  const actions = [];
  for (const a of Array.isArray(raw.actions) ? raw.actions : []) {
    if (!isRecord(a)) continue;
    const quote = agentString(a.quote, 240);
    if (!quote) continue;
    const action = { text: agentString(a.text, 160) || quote, quote };
    const owner = agentString(a.owner, 60);
    if (owner && !ME_WORD_RE.test(owner)) action.owner = owner;
    const due = isoDay(a.due);
    if (due) action.due = due;
    actions.push(action);
    if (actions.length >= 5) break;
  }
  if (actions.length) out.actions = actions;
  return out;
}

/**
 * A validated reply as annotate entries (§11.5), in batch order. Unknown and
 * repeated refs are ignored. A note whose entry says `skip`, adds nothing or
 * is missing is listed in `skipped`. No `kind` corrections: those stay a
 * visible feature.
 * → { entries: [{ id, summary?, terms?, entities?, actions? }], skipped: id[] }.
 */
export function toAnnotateEntries(json, refs) {
  const byRef = new Map();
  for (const raw of Array.isArray(json?.items) ? json.items : []) {
    if (!isRecord(raw) || typeof raw.ref !== 'string') continue;
    const ref = raw.ref.trim().toLowerCase();
    if (!refs.has(ref) || byRef.has(ref)) continue;
    byRef.set(ref, raw);
  }
  const entries = [];
  const skipped = [];
  for (const [ref, info] of refs) {
    const raw = byRef.get(ref);
    const entry = raw && raw.skip !== true ? cleanEntry(raw) : null;
    if (entry && Object.keys(entry).length) entries.push({ id: info.id, ...entry });
    else skipped.push(info.id);
  }
  return { entries, skipped };
}

// --- marks --------------------------------------------------------------------------

/** The `org` mark for a note whose entry applied (or, with `skipped`, said skip or was missing). */
export function markDone(hash, now, { skipped = false } = {}) {
  return { state: skipped ? 'skipped' : 'done', v: ORGANIZE_V, at: now, hash };
}

/**
 * The `org` mark after a failed batch: tries count up while the text stays
 * the same, and the next try waits tries × 1 hour. After 3 tries the note
 * waits until its text changes.
 */
export function markFailed(prev, hash, now) {
  const L = ORGANIZE_LIMITS;
  const before = isRecord(prev) && prev.state === 'failed' && prev.hash === hash && Number.isSafeInteger(prev.tries) && prev.tries > 0 ? prev.tries : 0;
  const tries = Math.min(L.maxTries, before + 1);
  return { state: 'failed', v: ORGANIZE_V, at: now, hash, tries, next: now + tries * L.retryMs };
}
