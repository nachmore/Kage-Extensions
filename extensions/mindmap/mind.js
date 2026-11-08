// Mind Map's per-window facade (ARCHITECTURE §5.15): data, mutations, agent
// records, prompts and the formatter's data port.
//
// Composer: it imports only leaves (lib/*.js and defaults.js), never
// view.js, so the host's one-level module rewrite can load it.
//
// One Mind per sandbox (getMind keys a WeakMap on context.invoke, like
// stocks' getClient), so every provider in a window shares one in-memory
// snapshot. The only cross-window state is extension data:
//   - reads are lazy (ready()) and refreshed by syncIfStale(), which reads
//     only mm-meta and reloads the keys whose rev moved (SPEC §7.4, §7.5);
//   - every write runs under the store's cross-window lock: re-sync, apply
//     the pure model mutation with a replayable id pool, write the touched
//     parts (twin first), the journal and then mm-meta, and verify the
//     transaction id; a conflict reloads and re-applies (SPEC §7.4).
//
// Logs are English and carry ids and counts only, never user text.

import * as idlib from './lib/ids.js';
import * as text from './lib/text.js';
import * as dates from './lib/dates.js';
import * as url from './lib/url.js';
import * as entities from './lib/entities.js';
import * as extractor from './lib/extract.js';
import * as query from './lib/query.js';
import * as storage from './lib/store.js';
import * as model from './lib/model.js';
import * as journal from './lib/journal.js';
import * as bm25 from './lib/bm25.js';
import * as rank from './lib/rank.js';
import * as graph from './lib/graph.js';
import { DEFAULTS, LIMITS, snippetChars, triggerOf } from './defaults.js';

const LIB = Object.freeze({ text, dates, url, entities, ids: idlib });
const DAY_MS = 86_400_000;
const FIXED_KEYS = Object.freeze(['mm-entities', 'mm-links', 'mm-journal']);
const RETRYABLE = new Set(['busy', 'conflict']);
const MAX_ATTEMPTS = 4;
const BACKFILL_MAX = 200;
// Idle work after a load (P2): link titles that never arrived, and items an
// older organizer saw. It waits so it never competes with the first keystrokes.
const IDLE_DELAY_MS = 20_000;
// Every Kage window loads at startup; spreading their idle work out lets the
// later ones find the first one's results (after a sync) instead of
// fetching the same links again.
const IDLE_JITTER_MS = 10_000;
const ENRICH_RETRY_MAX = 20;
// A failed fetch (offline, a slow site) is retried on later loads, at most
// once an hour, for a week after the capture.
const ENRICH_RETRY_GAP_MS = 60 * 60_000;
const ENRICH_RETRY_WINDOW_MS = 7 * 86_400_000;
const REDERIVE_BATCH = 200;
const REDERIVE_PAUSE_MS = 250;
const CONTEXT_EDGE_MS = 10 * 60_000;
const CONTEXT_EDGE_WEIGHT = 0.5;
const OVERVIEW_DAYS = 90;
const EMPTY = Object.freeze(new Set());
const URL_TEXT_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const NOOP_LOG = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const KIND_ORDER = Object.freeze(['note', 'link', 'doc', 'action', 'meeting']);
// Ops about an entity rather than an item (P2 mm merge / forget / rename).
const ENTITY_OPS = new Set(['merge', 'forget', 'rename']);

const mono = () => globalThis.performance?.now?.() ?? Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isHttp = (value) => typeof value === 'string' && /^https?:\/\/\S+$/i.test(value);
const stripAngles = (value) => String(value ?? '').replace(/[<>]/g, '');
const isoDay = (ms) => (Number.isFinite(ms) ? dates.toIsoDay(ms) : undefined);
const byIdDesc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

function prevUtcMonth(ms) {
  const d = new Date(ms);
  return dates.utcMonthKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}

function withoutUrls(value) {
  return String(value ?? '').replace(URL_TEXT_RE, ' ');
}

const MARKER_RE = /^\s*(?:[-*•]\s+|\d+[.)]\s+)?(?:\[[ xX]?\]\s*)?/;

// An item's text as a reader sees it: URLs dropped, bullet and checkbox
// markers removed, a first line that only repeats the title skipped, and
// lines joined with " · ".
function readableText(item) {
  const head = text.collapseWs(item.title || '').toLowerCase();
  const lines = withoutUrls(item.text).split(/\r?\n/).map((line) => text.collapseWs(line.replace(MARKER_RE, ''))).filter(Boolean);
  if (lines.length > 1 && lines[0].toLowerCase() === head) lines.shift();
  return lines.join(' · ');
}

function addTo(map, key, value) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function normTitle(value) {
  return text.collapseWs(String(value ?? '').toLowerCase().normalize('NFKC'));
}

function partOrder(a, b) {
  const rank = (p) => (p.startsWith('items:') ? 0 : p === 'entities' ? 1 : p === 'links' ? 2 : 3);
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** An error with a stable code (`readonly`, `busy`, `conflict`, `empty`, …). */
export class MindError extends Error {
  constructor(code, detail) {
    super(`mindmap: ${code}`);
    this.name = 'MindError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const minds = new WeakMap();

/** The per-window Mind for this sandbox context. */
export function getMind(context) {
  const key = context?.invoke;
  if (typeof key !== 'function') throw new TypeError('mindmap: context.invoke is required');
  let mind = minds.get(key);
  if (!mind) {
    mind = new Mind(context);
    minds.set(key, mind);
  }
  return mind;
}

export class Mind {
  /**
   * `options` exist for tests: `now` (clock), `extractorVersion` (simulates
   * an organizer upgrade, so stored items look older than it), and
   * `idleDelayMs` (how long after loading the idle work starts).
   */
  constructor(context = {}, { now, extractorVersion, idleDelayMs } = {}) {
    this.context = context;
    this.invoke = context.invoke;
    this.log = context.log || NOOP_LOG;
    this.now = now || (() => Date.now());
    this.extractorVersion = Number.isInteger(extractorVersion) && extractorVersion > 0 ? extractorVersion : extractor.EXTRACTOR_VERSION;
    this.idleDelayMs = Number.isFinite(idleDelayMs) && idleDelayMs >= 0 ? idleDelayMs : IDLE_DELAY_MS + Math.random() * IDLE_JITTER_MS;
    this.store = new storage.Store({ invoke: context.invoke, atomic: storage.hasAtomicWrites(context.hostFeatures) });
    this.state = model.emptyState(this.now(), { extractorVersion: this.extractorVersion });
    this.keyRevs = new Map();
    this.dataRev = Math.max(1, Math.floor(Date.now()));
    this.loadRev = this.dataRev;
    this.changedAt = new Map();
    this._loaded = false;
    this._ready = null;
    this._readOnly = null;
    this._stale = false;
    this._lastSync = -Infinity;
    this._background = new Set();
    // Writes in flight in this window, and the shared in-flight sync (syncIfStale).
    this._writes = 0;
    this._syncing = null;
    this._seen = new Map();
    this._mapFilters = new Map();
    this._rederiving = false;
    this._resetIndexes();
    this.settings = { ...DEFAULTS };
    this.myNames = [];
    this.weekStart = 1;
    this.setConfig(context.config);
  }

  // --- configuration -------------------------------------------------------

  language() {
    try {
      return this.context.i18n?.language?.() || 'en';
    } catch {
      return 'en';
    }
  }

  /** Applies a (possibly partial) config: me aliases, week start, toggles. */
  setConfig(config) {
    const source = config && typeof config === 'object' ? config : {};
    const next = {};
    for (const key of Object.keys(DEFAULTS)) next[key] = source[key] ?? DEFAULTS[key];
    next.enabled = source.enabled !== false;
    const namesChanged = next.my_names !== this.settings?.my_names;
    this.settings = next;
    this.trigger = triggerOf(next);
    this.myNames = entities.parseNameList(next.my_names);
    this.weekStart = dates.resolveWeekStart(next.week_start, this.language());
    if (namesChanged) {
      this._applyMe();
      this._dict = null;
    }
  }

  _applyMe() {
    const me = this.state?.entities.get('me');
    if (me) me.aliases = [...(this.myNames || [])];
  }

  // --- lifecycle -------------------------------------------------------------

  get loaded() { return this._loaded; }
  get rev() { return this.dataRev; }
  get readOnly() { return this._readOnly; }

  /** Loads the store once per window (SPEC §7.5). */
  ready() {
    if (!this._ready) {
      this._ready = this._loadAll().then(
        () => {
          this._loaded = true;
          this._afterLoad();
        },
        (error) => {
          this._ready = null;
          this.log.warn?.(`mindmap: load failed (${error?.code || error?.name || 'error'})`);
          throw error;
        },
      );
    }
    return this._ready;
  }

  /** Resolves once background work (link enrichment, retries) settles. */
  async whenIdle() {
    if (this._ready) await this._ready.catch(() => {});
    while (this._background.size) await Promise.allSettled([...this._background]);
  }

  _track(promise) {
    const tracked = Promise.resolve(promise).catch(() => {}).finally(() => this._background.delete(tracked));
    this._background.add(tracked);
    return tracked;
  }

  requestReformat() {
    try {
      this.context.formatter?.requestReformat?.();
    } catch {
      // Older hosts: nothing to repaint.
    }
  }

  async _readKeys(keys) {
    return Promise.all([...keys].sort().map(async (key) => [key, await this.store.readBest(key)]));
  }

  // Reads every key: meta, the keys meta lists, the fixed parts, and the
  // current and previous UTC month shards even when meta doesn't list them
  // (a crash between a shard write and the meta write).
  async _loadAll() {
    const now = this.now();
    const metaRes = await this.store.readBest('mm-meta');
    const meta = metaRes.value;
    const keys = new Set(FIXED_KEYS);
    for (const key of Object.keys(meta?.keys || {})) if (model.keyPart(key) && key !== 'mm-meta') keys.add(key);
    keys.add(`mm-items-${dates.utcMonthKey(now)}`);
    keys.add(`mm-items-${prevUtcMonth(now)}`);
    for (const item of this.state.items.values()) keys.add(model.partKey(`items:${model.shardOf(item)}`));
    const loaded = await this._readKeys(keys);
    const unreadable = metaRes.unreadable ? ['mm-meta'] : [];
    const parts = { meta, shards: {}, entities: null, links: null, journal: null };
    const revs = new Map();
    if (meta) revs.set('mm-meta', meta.rev);
    for (const [key, res] of loaded) {
      if (res.unreadable) {
        unreadable.push(key);
        continue;
      }
      if (!res.value) continue;
      revs.set(key, res.value.rev);
      const part = model.keyPart(key);
      if (part.startsWith('items:')) parts.shards[part.slice(6)] = res.value;
      else parts[part] = res.value;
    }
    const { state, problems } = model.fromPersisted(parts, { now });
    for (const [key, rev] of revs) if (key !== 'mm-meta' && state.meta.keys[key] === undefined) state.meta.keys[key] = rev;
    const future = problems.some((p) => p.code === 'future_schema');
    if (problems.length) this.log.warn?.(`mindmap: ${problems.length} stored record(s) skipped`);
    const prior = this.state;
    this.state = state;
    this.keyRevs = revs;
    this._applyMe();
    this._resetIndexes();
    for (const item of state.items.values()) this._indexItem(item);
    const changed = new Set([...prior.items.keys(), ...state.items.keys(), ...prior.entities.keys(), ...state.entities.keys()]);
    this._bump(changed);
    this.loadRev = this.dataRev;
    this._lastSync = mono();
    this._stale = false;
    if (unreadable.length || future) {
      this._readOnly = { code: unreadable.length ? 'unreadable' : 'future_schema', keys: unreadable };
      this.store.readOnly = true;
      this.log.warn?.(`mindmap: read-only (${this._readOnly.code}, ${unreadable.length} key(s))`);
    } else {
      this._readOnly = null;
      this.store.readOnly = false;
    }
  }

  // Schedules the idle work (P2) once per load, when there is any.
  _afterLoad() {
    if (this._readOnly || this._idleTimer) return;
    const now = this.now();
    const items = [...this.state.items.values()];
    const work = items.some((item) => item.v < this.extractorVersion)
      || (this.settings.fetch_link_titles && items.some((item) => this._wantsEnrich(item, now)));
    if (!work) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      this._track(this.runIdleWork());
    }, this.idleDelayMs);
    this._idleTimer?.unref?.();
  }

  /**
   * The idle work (P2): retries link titles that never arrived, then
   * re-derives items an older organizer saw. Safe in every window at once:
   * each step re-checks under the lock. → { enriched, rederived }
   */
  async runIdleWork() {
    const enriched = await this.retryEnrichment();
    const rederived = await this.rederive();
    return { enriched, rederived };
  }

  // A link whose title should be (re)fetched: still pending (the window
  // closed mid-fetch), or failed recently enough to try again.
  _wantsEnrich(item, now) {
    if (!isHttp(item?.url) || item.archived) return false;
    const state = item.enrich?.state;
    if (state === 'pending') return true;
    if (state !== 'failed') return false;
    return now - item.createdAt <= ENRICH_RETRY_WINDOW_MS && now - (item.enrich.at ?? 0) >= ENRICH_RETRY_GAP_MS;
  }

  /** P2 enrich retry on load: fetches up to 20 missing link titles, newest first. → count tried */
  async retryEnrichment() {
    if (!this.settings.fetch_link_titles) return 0;
    await this.ready();
    // Another window may have fetched them already.
    await this.syncIfStale(0).catch(() => false);
    if (this._readOnly) return 0;
    const now = this.now();
    const ids = [...this.state.items.values()].filter((item) => this._wantsEnrich(item, now))
      .map((item) => item.id).sort(byIdDesc).slice(0, ENRICH_RETRY_MAX);
    if (ids.length) {
      this.log.info?.(`mindmap: retrying ${ids.length} link title(s)`);
      await this._enrichAll(ids, { retry: true });
    }
    return ids.length;
  }

  // --- sync --------------------------------------------------------------------

  /**
   * Re-reads mm-meta when the snapshot is older than maxAgeMs; true when
   * data changed. Never runs alongside this window's own write: a write
   * syncs under the lock itself, and a read that swapped or merged state
   * underneath it would put stale records back (in memory, then on disk).
   * Concurrent calls share one sync.
   */
  async syncIfStale(maxAgeMs = LIMITS.syncMaxAgeMs) {
    if (!this._loaded) {
      await this.ready();
      return false;
    }
    if (this._writes > 0) return false;
    // A failed write that couldn't reload leaves `_stale`: reload at once.
    if (!this._stale && mono() - this._lastSync < maxAgeMs && !this._syncing) return false;
    if (!this._syncing) {
      const run = this._sync().finally(() => {
        if (this._syncing === run) this._syncing = null;
      });
      this._syncing = run;
    }
    const changed = await this._syncing;
    if (changed) this.requestReformat();
    return changed;
  }

  // Runs fn while counted as this window's write (see syncIfStale), after
  // any sync that was already reading has finished.
  async _exclusive(fn) {
    this._writes += 1;
    try {
      if (this._syncing) await this._syncing.catch(() => {});
      return await fn();
    } finally {
      this._writes -= 1;
    }
  }

  async _readMeta() {
    try {
      const value = await this.store.readJson('mm-meta');
      if (value !== null && Number.isFinite(value?.rev)) return { value, unreadable: false };
    } catch (error) {
      if (error?.code !== 'unreadable') throw error;
    }
    return this.store.readBest('mm-meta');
  }

  async _sync() {
    if (this._stale) {
      await this._loadAll();
      return true;
    }
    const res = await this._readMeta();
    this._lastSync = mono();
    if (res.unreadable) {
      if (!this._readOnly) {
        this._readOnly = { code: 'unreadable', keys: ['mm-meta'] };
        this.store.readOnly = true;
      }
      return false;
    }
    return this._absorbMeta(res.value);
  }

  async _absorbMeta(meta) {
    if (!meta) {
      if (!this.keyRevs.size) return false;
      // Another window deleted everything.
      await this._loadAll();
      return true;
    }
    if (this.keyRevs.get('mm-meta') === meta.rev && meta.txn === this.state.meta.txn) return false;
    const keys = new Set(FIXED_KEYS);
    for (const key of Object.keys(meta.keys || {})) if (model.keyPart(key) && key !== 'mm-meta') keys.add(key);
    const changedKeys = [...keys].filter((key) => (meta.keys?.[key] ?? 0) !== (this.keyRevs.get(key) ?? 0));
    const loaded = await this._readKeys(changedKeys);
    const unreadable = loaded.filter(([, res]) => res.unreadable).map(([key]) => key);
    if (unreadable.length) {
      this._readOnly = { code: 'unreadable', keys: unreadable };
      this.store.readOnly = true;
    }
    const parts = { meta, shards: {}, entities: null, links: null, journal: null };
    for (const [key, res] of loaded) {
      if (res.unreadable || !res.value) continue;
      const part = model.keyPart(key);
      if (part.startsWith('items:')) parts.shards[part.slice(6)] = res.value;
      else parts[part] = res.value;
    }
    const { state: fresh, problems } = model.fromPersisted(parts, { now: this.now() });
    if (problems.some((p) => p.code === 'future_schema')) {
      this._readOnly = { code: 'future_schema', keys: [] };
      this.store.readOnly = true;
    }
    const state = this.state;
    const changedItems = new Set();
    const changedEntities = new Set();
    for (const [key, res] of loaded) {
      if (res.unreadable) continue;
      this.keyRevs.set(key, res.value?.rev ?? 0);
      const part = model.keyPart(key);
      if (part.startsWith('items:')) {
        const ym = part.slice(6);
        for (const [id, item] of state.items) {
          if (model.shardOf(item) === ym && !fresh.items.has(id)) {
            state.items.delete(id);
            changedItems.add(id);
          }
        }
        for (const [id, item] of fresh.items) {
          if (model.shardOf(item) !== ym) continue;
          const old = state.items.get(id);
          if (!old || old.rev !== item.rev || old.updatedAt !== item.updatedAt) changedItems.add(id);
          state.items.set(id, item);
        }
      } else if (part === 'entities') {
        for (const [id, entity] of fresh.entities) {
          const old = state.entities.get(id);
          if (!old || old.rev !== entity.rev || old.updatedAt !== entity.updatedAt) changedEntities.add(id);
        }
        for (const id of state.entities.keys()) if (!fresh.entities.has(id)) changedEntities.add(id);
        state.entities = fresh.entities;
        state.candidates = fresh.candidates;
      } else if (part === 'links') {
        state.links = fresh.links;
        state.rejections = fresh.rejections;
      } else if (part === 'journal') {
        state.ops = fresh.ops;
      }
    }
    state.meta = fresh.meta;
    this.keyRevs.set('mm-meta', meta.rev);
    this._applyMe();
    this._reindex(changedItems, changedEntities);
    return true;
  }

  // --- mutations -----------------------------------------------------------------

  _env(now, pool, extra = {}) {
    return {
      now,
      newId: (prefix) => pool.next(prefix, now),
      journal,
      lib: LIB,
      autoAccept: !!this.settings.auto_accept_inferred,
      enrichLinks: !!this.settings.fetch_link_titles,
      ...extra,
    };
  }

  // Runs `apply(state, env)` under the cross-window lock (SPEC §7.4).
  // apply is synchronous and returns { changes: Change[], ...extra } or a
  // refusal { code }. Retries 'busy' (lost lease) and 'conflict' (another
  // writer interleaved) with the same clock and id pool. Counts as this
  // window's write for its whole run (see syncIfStale).
  _mutate(apply, { allowReadOnly = false } = {}) {
    return this._exclusive(() => this._mutateLocked(apply, { allowReadOnly }));
  }

  async _mutateLocked(apply, { allowReadOnly }) {
    await this.ready();
    if (this._readOnly && !allowReadOnly) throw new MindError('readonly');
    const now = this.now();
    const pool = idlib.createIdPool();
    let lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.store.withLock(async (lease) => {
          try {
            if (this._stale) await this._loadAll();
            else await this._sync();
            if (this._readOnly && !allowReadOnly) throw new MindError('readonly');
            pool.reset();
            // apply mutates the snapshot in place: from here until the
            // commit is confirmed, memory may hold an unsaved change.
            this._stale = true;
            const result = apply(this.state, this._env(now, pool)) || {};
            const changes = (result.changes || []).filter((change) => change?.op);
            if (!changes.length) {
              // A refusal changes nothing (lib/model.js contract).
              this._stale = false;
              return { ...result, committed: false };
            }
            for (const change of changes) this.state.ops = journal.appendOp(this.state.ops, change.op);
            await this._persist(changes, lease, now);
            const check = await this.store.readJson('mm-meta');
            if (check?.txn !== changes[changes.length - 1].op.opId) throw new MindError('conflict');
            this._stale = false;
            this._afterCommit(changes);
            return { ...result, committed: true, opId: changes[0].op.opId };
          } catch (error) {
            // Drop the unsaved change while still holding the lock, so no
            // other write in this window builds on it. If the reload fails,
            // `_stale` stays set and the next sync or write reloads.
            if (this._stale) await this._loadAll().catch(() => {});
            throw error;
          }
        });
      } catch (error) {
        lastError = error;
        if (!RETRYABLE.has(error?.code)) break;
        this.log.debug?.(`mindmap: retrying a write (${error.code}, attempt ${attempt + 1})`);
        await sleep(20 + Math.random() * 80);
      }
    }
    throw lastError;
  }

  _nextRev(key) {
    if (key === 'mm-meta') return Math.max(this.keyRevs.get(key) ?? 0, this.state.meta.rev ?? 0) + 1;
    return Math.max(this.keyRevs.get(key) ?? 0, this.state.meta.keys[key] ?? 0) + 1;
  }

  async _writePart(part, txn, lease, { force = false } = {}) {
    const key = model.partKey(part);
    if (!key) return;
    const rev = this._nextRev(key);
    const payload = { ...model.payloadFor(this.state, part), rev, txn };
    if (lease) await lease.check();
    await this.store.write(key, payload, { force });
    this.keyRevs.set(key, rev);
    this.state.meta.keys[key] = rev;
  }

  async _writeMeta(txn, lease, now, { force = false } = {}) {
    const meta = this.state.meta;
    meta.rev = this._nextRev('mm-meta');
    meta.txn = txn;
    meta.updatedAt = now;
    meta.extractorVersion = this.extractorVersion;
    const payload = { ...model.payloadFor(this.state, 'meta'), rev: meta.rev, txn };
    if (lease) await lease.check();
    await this.store.write('mm-meta', payload, { force });
    this.keyRevs.set('mm-meta', meta.rev);
  }

  async _persist(changes, lease, now) {
    const txn = changes[changes.length - 1].op.opId;
    const parts = new Set(['journal']);
    for (const change of changes) for (const part of change.touched || []) if (part !== 'meta') parts.add(part);
    for (const part of [...parts].sort(partOrder)) await this._writePart(part, txn, lease);
    await this._writeMeta(txn, lease, now);
  }

  _afterCommit(changes) {
    const items = new Set();
    const ents = new Set();
    const note = (id) => {
      if (idlib.isItemId(id)) items.add(id);
      else if (idlib.isEntityId(id)) ents.add(id);
    };
    for (const change of changes) {
      const op = change.op;
      for (const id of Object.keys(op.after || {})) note(id);
      for (const id of op.created?.items || []) note(id);
      for (const id of op.created?.entities || []) note(id);
      for (const record of op.before?.items || []) note(record.id);
      for (const record of op.before?.entities || []) note(record.id);
    }
    this._reindex(items, ents);
  }

  // --- indexes -------------------------------------------------------------------

  _resetIndexes() {
    this.index = bm25.createIndex();
    this.byEntity = new Map();
    this.itemEnts = new Map();
    this.children = new Map();
    this.parentOf = new Map();
    this._newest = null;
    this._dict = null;
    this._alias = new Map();
    // P2 context edges: items captured from each source window title.
    this.byWindow = new Map();
    this.itemWindow = new Map();
  }

  _fields(item) {
    const ent = [];
    for (const eid of item.entityIds || []) {
      if (eid === 'me') continue;
      const entity = this.state.entities.get(eid);
      if (!entity) continue;
      ent.push(...text.tokenize(entity.name));
      for (const alias of entity.aliases || []) ent.push(...text.tokenize(alias));
    }
    const host = [];
    for (const link of [item.url, ...url.findUrls(item.text).map((u) => u.url)]) {
      if (!isHttp(link)) continue;
      host.push(...text.tokenize(url.urlHost(link) || ''));
      try {
        host.push(...text.tokenize(decodeURIComponent(new URL(link).pathname).replace(/[/_-]+/g, ' ')));
      } catch {
        // Not a parseable URL: its host is enough.
      }
    }
    if (item.path) host.push(...text.tokenize(url.baseName(item.path).replace(/[._-]+/g, ' ')));
    return {
      title: text.tokenize(item.title),
      kp: text.tokenize([...(item.keyphrases || []), ...(item.terms || [])].join(' . ')),
      ent,
      sum: text.tokenize(item.summary || ''),
      body: text.tokenize(withoutUrls(item.text)),
      host,
    };
  }

  _indexItem(item) {
    this.index.add(item.id, this._fields(item));
    const ents = [...(item.entityIds || [])];
    this.itemEnts.set(item.id, ents);
    for (const eid of ents) addTo(this.byEntity, eid, item.id);
    if (item.parentId) {
      this.parentOf.set(item.id, item.parentId);
      addTo(this.children, item.parentId, item.id);
    }
    if (item.source?.window) {
      addTo(this.byWindow, item.source.window, item.id);
      this.itemWindow.set(item.id, item.source.window);
    }
    this._seen.set(item.id, { kind: item.kind, title: item.title, private: !!item.private });
  }

  _unindexItem(id) {
    this.index.remove(id);
    for (const eid of this.itemEnts.get(id) || []) this.byEntity.get(eid)?.delete(id);
    this.itemEnts.delete(id);
    const parent = this.parentOf.get(id);
    if (parent) {
      this.children.get(parent)?.delete(id);
      this.parentOf.delete(id);
    }
    const window = this.itemWindow.get(id);
    if (window !== undefined) {
      const set = this.byWindow.get(window);
      set?.delete(id);
      if (set && !set.size) this.byWindow.delete(window);
      this.itemWindow.delete(id);
    }
  }

  _reindex(itemIds, entityIds = EMPTY) {
    const items = new Set(itemIds);
    // An entity's name is indexed on every item that mentions it.
    for (const eid of entityIds) for (const iid of this.byEntity.get(eid) || []) items.add(iid);
    for (const id of items) {
      this._unindexItem(id);
      const item = this.state.items.get(id);
      if (item) this._indexItem(item);
    }
    this._newest = null;
    if (entityIds.size) {
      this._dict = null;
      this._alias.clear();
    }
    this._bump([...items, ...entityIds]);
  }

  _bump(ids) {
    this.dataRev += 1;
    for (const id of ids) this.changedAt.set(id, this.dataRev);
  }

  /** True when any of `ids` changed after data revision `since`. */
  changedSince(since, ids) {
    if (!(since >= this.loadRev)) return true;
    return [...(ids || [])].some((id) => (this.changedAt.get(id) ?? 0) > since);
  }

  get dict() {
    if (!this._dict) {
      const list = [];
      for (const entity of this.state.entities.values()) {
        if (entity.mergedInto) continue;
        if (entity.id === 'me') {
          if (this.myNames.length) list.push({ entityId: 'me', type: 'person', names: this.myNames, key: 'me' });
          continue;
        }
        // kage-sensitive-data: not-sensitive — reviewed: an entity view model, not a settings control
        list.push({ entityId: entity.id, type: entity.type, names: [entity.name, ...(entity.aliases || [])], key: entity.key });
      }
      this._dict = entities.buildDictionary(list, LIB);
    }
    return this._dict;
  }

  _newestIds() {
    if (!this._newest) this._newest = [...this.state.items.keys()].sort(byIdDesc);
    return this._newest;
  }

  _idsInRange(start, end, field) {
    const lo = Number.isFinite(start) ? start : -Infinity;
    const hi = Number.isFinite(end) ? end : Infinity;
    const out = [];
    for (const id of this._newestIds()) {
      const item = this.state.items.get(id);
      const times = field === 'due' ? [item.dueAt] : [item.createdAt, item.occurredAt];
      if (times.some((t) => Number.isFinite(t) && t >= lo && t < hi)) out.push(id);
    }
    return out;
  }

  _aliasTerms(eid) {
    let list = this._alias.get(eid);
    if (!list) {
      const entity = this.entity(eid);
      list = [];
      if (entity) {
        const own = new Set(text.tokenize(entity.id === 'me' ? '' : entity.name));
        for (const t of own) list.push({ t, w: 1 });
        const aliases = entity.id === 'me' ? this.myNames : entity.aliases || [];
        for (const alias of aliases) {
          for (const t of text.tokenize(alias)) {
            if (!own.has(t) && !list.some((a) => a.t === t)) list.push({ t, w: rank.WEIGHTS.alias });
          }
        }
      }
      this._alias.set(eid, list);
    }
    return list;
  }

  // --- reads -----------------------------------------------------------------------

  entity(id) {
    let entity = this.state.entities.get(id) || null;
    for (let hops = 0; entity?.mergedInto && hops < 16; hops++) entity = this.state.entities.get(entity.mergedInto) || entity;
    return entity;
  }

  item(id) {
    return this.state.items.get(id) || null;
  }

  nameOf(id) {
    if (id === 'o') return '';
    const entity = this.entity(id);
    if (entity) return entity.id === 'me' ? entity.name || 'Me' : entity.name;
    return this.state.items.get(id)?.title || this._seen.get(id)?.title || '';
  }

  resolveEntity(phrase, typeHint) {
    const key = text.normalizeKey(phrase);
    if (!key) return null;
    if (key === 'me' || this.myNames.some((name) => text.normalizeKey(name) === key)) {
      return { entityId: 'me', name: this.state.entities.get('me')?.name || 'Me', type: 'person' };
    }
    const entity = model.entityByKey(this.state, key, typeHint || undefined);
    // kage-sensitive-data: not-sensitive — reviewed: an entity view model, not a settings control
    return entity ? { entityId: entity.id, name: entity.name, type: entity.type } : null;
  }

  /** True for items the agent must never see (private, or mentioning a private entity). */
  isHidden(item) {
    if (!item) return true;
    if (item.private) return true;
    return (item.entityIds || []).some((id) => this.state.entities.get(id)?.private);
  }

  groupOf(item) {
    let topic = null;
    for (const id of item?.entityIds || []) {
      const entity = this.entity(id);
      if (!entity || entity.id === 'me') continue;
      if (entity.type === 'team' || entity.type === 'project') return entity.id;
      if (!topic && entity.type === 'topic') topic = entity.id;
    }
    return topic;
  }

  _extract(input, now) {
    return extractor.extract(input, {
      lib: LIB,
      now,
      weekStart: this.weekStart,
      dict: this.dict,
      myNames: this.myNames,
      autoAccept: !!this.settings.auto_accept_inferred,
      idf: (term) => this.index.idf(term),
    });
  }

  /** What a save would do (the mm+ preview row). */
  preview(rawText, { source } = {}) {
    const x = this._extract({ text: String(rawText ?? ''), via: 'launcher', source }, this.now());
    const preview = extractor.previewOf(x);
    if (this.settings.new_items_private) preview.private = true;
    return { ...preview, title: x.title, empty: !!x.empty, extraction: x };
  }

  parse(input, { trailingSpace } = {}) {
    return query.parseQuery(String(input ?? ''), {
      lib: LIB,
      now: this.now(),
      weekStart: this.weekStart,
      resolveEntity: (phrase, type) => this.resolveEntity(phrase, type),
      dict: this.dict,
      trailingSpace,
      nameOf: (id) => this.nameOf(id),
    });
  }

  _rankCtx({ forAgent = false, limit = 50 } = {}) {
    const state = this.state;
    return {
      now: this.now(),
      index: this.index,
      limit,
      getItem: (id) => state.items.get(id),
      idsNewestFirst: () => this._newestIds(),
      idsInRange: (start, end, field) => this._idsInRange(start, end, field),
      entityItems: (eid) => this.byEntity.get(eid) || EMPTY,
      aliasTerms: (eid) => this._aliasTerms(eid),
      groupOf: (item) => this.groupOf(item),
      hidden: forAgent ? (id) => this.isHidden(state.items.get(id)) : undefined,
    };
  }

  /** Ranked hits for a QuerySpec (SPEC §8.2). */
  find(spec, { forAgent = false, limit = LIMITS.findRows } = {}) {
    const result = rank.runQuery(spec, this._rankCtx({ forAgent, limit }));
    const hits = [];
    for (const hit of result.hits) {
      const item = this.state.items.get(hit.id);
      if (item) hits.push({ item, score: hit.score, why: hit.why, terms: hit.terms });
    }
    return { hits, relaxed: result.relaxed, total: result.total, hiddenPrivate: result.hiddenPrivate };
  }

  /** Actions for a QuerySpec, ordered and grouped (SPEC §8.2). */
  actions(spec, { forAgent = false, limit = LIMITS.actionsMax } = {}) {
    const result = rank.runActions(spec, this._rankCtx({ forAgent, limit }));
    const get = (id) => this.state.items.get(id);
    return {
      open: result.open.map(get).filter(Boolean),
      suggested: result.suggested.map(get).filter(Boolean),
      done: result.done.map(get).filter(Boolean),
      groups: result.groups.map((g) => ({ entity: g.entityId ? this.entity(g.entityId) : null, items: g.ids.map(get).filter(Boolean) })),
      total: result.total,
      hiddenPrivate: result.hiddenPrivate,
    };
  }

  /** A display snippet: the summary or text window around a matched term. */
  snippetFor(item, terms = [], max = 200) {
    const sources = [item.summary, readableText(item)].map((s) => text.collapseWs(s || '')).filter(Boolean);
    const want = (terms || []).map((q) => (typeof q === 'string' ? q : q?.neg ? null : q?.t)).filter(Boolean);
    let pick = sources[0] || '';
    if (want.length) {
      for (const source of sources) {
        if (text.tokenize(source).some((t) => want.some((w) => t === w || t.startsWith(w)))) {
          pick = source;
          break;
        }
      }
    }
    if (!pick) pick = item.title || '';
    return text.snippet(pick, terms, { max });
  }

  /** Items related to `id` (SPEC §5 S8): BM25 similarity, shared entities, same source window. */
  related(id, limit = 5, { forAgent = false } = {}) {
    const item = this.state.items.get(id);
    if (!item) return [];
    const exclude = new Set([id]);
    if (item.parentId) exclude.add(item.parentId);
    for (const child of this.children.get(id) || []) exclude.add(child);
    const ok = (other) => {
      if (!other || exclude.has(other.id) || other.archived) return false;
      if (other.kind === 'action' && other.status === 'dismissed') return false;
      if (other.parentId && other.parentId === item.parentId) return false;
      return !(forAgent && this.isHidden(other));
    };
    const scores = new Map();
    const similar = this.index.similar(id, { limit: 10, minRatio: 0.25 });
    const top = similar.reduce((max, s) => Math.max(max, s.score), 0) || 1;
    for (const s of similar) scores.set(s.id, s.score / top);
    for (const eid of item.entityIds || []) {
      if (eid === 'me') continue;
      const set = this.byEntity.get(eid);
      if (!set) continue;
      const weight = 1 / Math.log2(2 + set.size);
      for (const other of [...set].sort(byIdDesc).slice(0, 200)) {
        const otherItem = this.state.items.get(other);
        const target = otherItem?.parentId && !exclude.has(otherItem.parentId) ? otherItem.parentId : other;
        scores.set(target, (scores.get(target) || 0) + weight);
      }
    }
    // P2 context edges (SPEC §5 S8): captured from the same window within
    // 10 minutes, so things saved together stay together. Window titles
    // are local; only the relation reaches the agent, never the title.
    for (const other of this.contextOf(id)) {
      const otherItem = this.state.items.get(other);
      const target = otherItem?.parentId && !exclude.has(otherItem.parentId) ? otherItem.parentId : other;
      scores.set(target, (scores.get(target) || 0) + CONTEXT_EDGE_WEIGHT);
    }
    return [...scores]
      .filter(([other]) => ok(this.state.items.get(other)))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([other, score]) => ({ id: other, score }));
  }

  /** Items captured from the same source window as `id` within 10 minutes of it (P2 context edges). */
  contextOf(id) {
    const item = this.state.items.get(id);
    const window = item?.source?.window;
    if (!window) return [];
    const out = [];
    for (const other of this.byWindow.get(window) || []) {
      if (other === id) continue;
      const otherItem = this.state.items.get(other);
      if (otherItem && Math.abs(otherItem.createdAt - item.createdAt) <= CONTEXT_EDGE_MS) out.push(other);
    }
    return out.sort();
  }

  /** Entities that share items with `eid`, weighted by how many. */
  cooccur(eid) {
    const counts = new Map();
    for (const iid of this.byEntity.get(eid) || []) {
      const item = this.state.items.get(iid);
      if (!item || item.archived) continue;
      for (const other of item.entityIds || []) {
        if (other === eid || other === 'me') continue;
        counts.set(other, (counts.get(other) || 0) + 1);
      }
    }
    return [...counts].map(([id, w]) => ({ id, w })).sort((a, b) => b.w - a.w || (a.id < b.id ? -1 : 1));
  }

  overview() {
    const now = this.now();
    const since = now - OVERVIEW_DAYS * DAY_MS;
    const n = new Map();
    for (const item of this.state.items.values()) {
      if (item.archived || item.createdAt < since) continue;
      for (const eid of item.entityIds || []) n.set(eid, (n.get(eid) || 0) + 1);
    }
    const lists = { team: [], project: [], person: [], topic: [] };
    for (const entity of this.state.entities.values()) {
      if (entity.id === 'me' || entity.mergedInto) continue;
      const bucket = entity.type === 'term' || entity.type === 'org' ? lists.topic : lists[entity.type];
      if (bucket) bucket.push({ id: entity.id, n: n.get(entity.id) || 0 });
    }
    let reviewCount = 0;
    let openCount = 0;
    for (const item of this.state.items.values()) {
      if (item.kind !== 'action' || item.archived || item.status !== 'open') continue;
      if (item.suggested) reviewCount++;
      else if ((item.owner || 'me') === 'me') openCount++;
    }
    return {
      teams: lists.team, projects: lists.project, people: lists.person, topics: lists.topic,
      reviewCount, openCount, recent: this.recent(5).map((item) => item.id),
      counts: { items: this.state.items.size, entities: Math.max(0, this.state.entities.size - 1) },
    };
  }

  /** Newest top-level items. */
  recent(n = LIMITS.recentRows) {
    const out = [];
    for (const id of this._newestIds()) {
      const item = this.state.items.get(id);
      if (!item || item.parentId || item.archived) continue;
      if (item.kind === 'action' && item.status === 'dismissed') continue;
      out.push(item);
      if (out.length >= n) break;
    }
    return out;
  }

  _graphCtx(page, kinds) {
    const state = this.state;
    return {
      getItem: (id) => state.items.get(id),
      getEntity: (id) => this.entity(id),
      itemsOfEntity: (eid) => [...(this.byEntity.get(eid) || [])],
      cooccur: (eid) => this.cooccur(eid),
      related: (iid) => this.related(iid, 8),
      childrenOf: (iid) => [...(this.children.get(iid) || [])],
      overview: () => this.overview(),
      page: page || {},
      kinds,
      now: this.now(),
    };
  }

  /** The map neighbourhood of a focus (SPEC §9.2). */
  neighborhood(focus, page) {
    if (!this._loaded) return null;
    const ref = focus?.type === 'overview' ? 'o' : focus?.id;
    const filter = this._mapFilters.get(ref);
    const neigh = graph.neighborhood(focus, this._graphCtx(page, filter?.kinds));
    if (neigh?.center && filter?.highlight?.length) neigh.center.highlight = filter.highlight;
    return neigh;
  }

  /** Remembers lane kinds / highlighted words for a map card focus (`mm map @x kind:doc`). */
  setMapFilter(ref, { kinds, highlight } = {}) {
    if (!kinds?.length && !highlight?.length) this._mapFilters.delete(ref);
    else this._mapFilters.set(ref, { kinds: kinds?.length ? [...kinds] : undefined, highlight: highlight?.length ? [...highlight] : undefined });
    while (this._mapFilters.size > 50) this._mapFilters.delete(this._mapFilters.keys().next().value);
  }

  /** The exclusive end of the week containing `ms` (the configured week start). */
  weekEnd(ms) {
    return dates.addDays(dates.startOfWeek(ms, this.weekStart), 7);
  }

  /** Items that mention entity `eid`. */
  itemsOf(eid) {
    return [...(this.byEntity.get(eid) || [])].map((id) => this.state.items.get(id)).filter(Boolean);
  }

  /** Open actions (anyone's) that mention `eid`, in SPEC §8.2 order. */
  entityActions(eid, { limit = 8 } = {}) {
    const spec = this.parse('actions owner:anyone', { trailingSpace: true });
    spec.entities.push({ entityId: eid, hard: true, via: 'marker' });
    return this.actions(spec, { limit }).open;
  }

  /**
   * What `mm map <args>` centres on (F-MAP-1): an entity, else an item id,
   * else the top find hit, else the overview. → { ref, name, kinds?,
   * highlight?, missed? } — `missed` is set when `args` matched nothing and
   * the overview stands in.
   */
  mapTarget(args) {
    const raw = String(args ?? '').trim();
    if (!raw) return { ref: 'o', name: '' };
    const direct = idlib.stripCite(raw);
    if (direct && (this.state.items.has(direct) || (direct !== 'me' && this.entity(direct)))) {
      return { ref: this.entity(direct)?.id || direct, name: this.nameOf(direct) };
    }
    const spec = this.parse(raw, { trailingSpace: true });
    const kinds = spec.kinds?.length ? [...spec.kinds] : undefined;
    const hard = spec.entities.find((e) => e.hard)
      || (spec.entities.length === 1 && !spec.terms.some((t) => !t.neg) ? spec.entities[0] : null);
    if (hard && this.entity(hard.entityId)) {
      const entity = this.entity(hard.entityId);
      return { ref: entity.id, name: this.nameOf(entity.id), kinds };
    }
    const hit = this.find(spec, { limit: 1 }).hits[0];
    if (hit) {
      const highlight = spec.terms.filter((t) => !t.neg && (t.w ?? 1) >= 1).map((t) => t.raw || t.t);
      return { ref: hit.item.id, name: hit.item.title, kinds, highlight };
    }
    return { ref: 'o', name: '', missed: true };
  }

  /**
   * Resolves `mm merge @a into @b`, `mm forget @x` and `mm rename @x to New
   * name` (P2). → { ok, fromId, fromName, intoId?, intoName?, newName? } |
   * { ok: false, code?, name? } (no code: show the usage line).
   */
  planEntityCommand(command, args) {
    const raw = String(args ?? '').trim();
    const find = (phrase) => {
      const name = String(phrase ?? '').trim().replace(/^[@#]/, '').replace(/[-_]+/g, ' ').trim();
      if (!name) return { name };
      const hit = this.resolveEntity(name, null);
      return hit && hit.entityId !== 'me' ? { name, entity: this.entity(hit.entityId) } : { name };
    };
    let from;
    let rest = '';
    if (command === 'merge') {
      const parts = raw.split(/\s+(?:into|in|with|->|→)\s+/i);
      let pair = parts.length === 2 ? parts : null;
      if (!pair) {
        const marks = raw.match(/[@#][^\s@#]+/g);
        if (marks?.length === 2) pair = marks;
      }
      if (!pair) return { ok: false };
      const a = find(pair[0]);
      const b = find(pair[1]);
      if (!a.entity) return { ok: false, code: 'not_found', name: a.name };
      if (!b.entity) return { ok: false, code: 'not_found', name: b.name };
      if (a.entity.id === b.entity.id) return { ok: false };
      return { ok: true, fromId: a.entity.id, fromName: a.entity.name, intoId: b.entity.id, intoName: b.entity.name };
    }
    if (command === 'rename') {
      const m = /^(.+?)\s+(?:to|as|->|→)\s+(.+)$/i.exec(raw);
      if (!m) return { ok: false };
      from = find(m[1]);
      rest = text.collapseWs(m[2]).replace(/^["“]|["”]$/g, '').slice(0, 80);
      if (!rest) return { ok: false };
    } else {
      from = find(raw);
    }
    if (!from.name) return { ok: false };
    if (!from.entity) return { ok: false, code: 'not_found', name: from.name };
    return { ok: true, fromId: from.entity.id, fromName: from.entity.name, newName: rest || undefined };
  }

  entitySummary(id) {
    const entity = this.entity(id);
    if (!entity) return null;
    const counts = { items: 0, openActions: 0, suggested: 0, docs: 0, notes: 0 };
    for (const iid of this.byEntity.get(entity.id) || []) {
      const item = this.state.items.get(iid);
      if (!item || item.archived) continue;
      counts.items++;
      if (item.kind === 'action') {
        if (item.status === 'open' && item.suggested) counts.suggested++;
        else if (item.status === 'open') counts.openActions++;
      } else if (item.kind === 'doc' || item.kind === 'link') counts.docs++;
      else counts.notes++;
    }
    return { entity, counts, related: this.cooccur(entity.id).slice(0, 8) };
  }

  stats() {
    const byKind = Object.fromEntries(KIND_ORDER.map((k) => [k, 0]));
    let openActions = 0;
    let suggestions = 0;
    for (const item of this.state.items.values()) {
      byKind[item.kind] = (byKind[item.kind] || 0) + 1;
      if (item.kind === 'action' && item.status === 'open') {
        if (item.suggested) suggestions++;
        else openActions++;
      }
    }
    let bytes = 0;
    for (const part of model.listParts(this.state)) bytes += JSON.stringify(model.payloadFor(this.state, part)).length;
    return {
      items: this.state.items.size,
      byKind,
      entities: [...this.state.entities.values()].filter((e) => e.id !== 'me' && !e.mergedInto).length,
      openActions,
      suggestions,
      bytes,
      lastSaved: this.keyRevs.has('mm-meta') ? this.state.meta.updatedAt : null,
      readOnly: this._readOnly,
    };
  }

  /** The op `mm undo` targets, with whether it can still be undone. */
  undoTarget() {
    const op = journal.lastUndoable(this.state.ops);
    if (!op) return null;
    return { op, verdict: journal.canUndo(this.state, op), summary: this.opSummary(op) };
  }

  /** {code, title, count, name} describing an op for labels (no user text in codes). */
  opSummary(op) {
    const params = op?.label?.params || {};
    const code = op?.label?.code || op?.kind || 'generic';
    const itemId = params.itemId || op?.created?.items?.[0] || op?.before?.items?.[0]?.id;
    const before = (op?.before?.items || []).find((record) => record.id === itemId);
    const title = this.state.items.get(itemId)?.title || before?.title || this._seen.get(itemId)?.title || '';
    const entityId = params.intoId || params.entityId || params.fromId;
    // A forgotten entity is gone, and a merged one redirects: their own
    // names are in the op's snapshot.
    const own = (id) => (op?.before?.entities || []).find((e) => e.id === id)?.name || this.state.entities.get(id)?.name || '';
    const name = entityId ? this.nameOf(entityId) || own(entityId) : '';
    const from = params.fromId ? own(params.fromId) : code === 'rename' && params.entityId ? own(params.entityId) : '';
    return { code, title, count: Number(params.count) || 1, name, from, entityOp: ENTITY_OPS.has(code) };
  }

  // --- writes ------------------------------------------------------------------------

  _rejectedKeys(state) {
    return new Set(state.rejections.filter((r) => r.type === 'entity').map((r) => r.t));
  }

  // Back-fills every entity this change created onto earlier items whose
  // text names it (SPEC §5 S4): candidates come from the BM25 postings of
  // the name's first token, verified by a one-entity dictionary scan.
  _backfill(state, change, env) {
    const ours = new Set([change.itemId, ...(change.childIds || [])]);
    for (const eid of [...(change.newEntityIds || [])]) {
      const entity = state.entities.get(eid);
      if (!entity || eid === 'me') continue;
      const first = text.tokenize(entity.name)[0];
      if (!first) continue;
      // kage-sensitive-data: not-sensitive — reviewed: an entity view model, not a settings control
      const dict = entities.buildDictionary([{ entityId: eid, type: entity.type, names: [entity.name, ...(entity.aliases || [])], key: entity.key }], LIB);
      const hits = [];
      for (const id of [...this.index.postings(first)].sort(byIdDesc)) {
        if (hits.length >= BACKFILL_MAX) break;
        if (ours.has(id)) continue;
        const item = state.items.get(id);
        if (!item || item.entityIds.includes(eid)) continue;
        const body = [item.title, withoutUrls(item.text), item.summary || ''].join('\n');
        if (entities.scanDictionary(dict, text.scanWords(body)).length) hits.push(id);
      }
      if (hits.length) model.applyBackfill(state, change, eid, hits, env);
    }
  }

  // Candidates, promotions and back-fill for a capture or re-extract change.
  _organize(state, change, x, itemId, env) {
    const { promote } = entities.bumpCandidates(state.candidates, x.candidates, itemId, env.now, { rejected: this._rejectedKeys(state) });
    model.applyPromotions(state, change, promote, env);
    this._backfill(state, change, env);
  }

  /**
   * Saves one capture (SPEC §4). → CaptureResult, or { code } when nothing
   * was saved ('empty', 'readonly', …). Link titles are fetched afterwards.
   */
  async capture(rawText, { via = 'launcher', source, hint, keepSource = false } = {}) {
    const input = { text: String(rawText ?? ''), via, hint };
    if (source && typeof source === 'object') input.source = { app: source.app || undefined, window: source.window || undefined };
    const keep = keepSource || this.settings.record_source_window;
    let out;
    try {
      out = await this._mutate((state, env) => {
        const x = this._extract(input, env.now);
        if (x.empty) return { code: 'empty' };
        if (this.settings.new_items_private) x.private = true;
        const change = model.applyCapture(state, x, { ...env, via, source: keep ? input.source : undefined });
        if (!change.op) return { code: change.code || 'noop' };
        this._organize(state, change, x, change.dedupedInto || change.itemId, env);
        return { changes: [change], change };
      });
    } catch (error) {
      if (error?.code) return { code: error.code };
      throw error;
    }
    if (!out.committed) return { code: out.code || 'noop' };
    const change = out.change;
    const itemId = change.dedupedInto || change.itemId;
    this.log.info?.(`mindmap: saved ${1 + (change.childIds?.length || 0)} item(s)${change.dedupedInto ? ' into an existing item' : ''}`);
    const pending = [itemId, ...(change.childIds || [])].filter((id) => this.state.items.get(id)?.enrich?.state === 'pending');
    if (pending.length && this.settings.fetch_link_titles) this._track(this._enrichAll(pending));
    return {
      opId: change.op.opId,
      itemId,
      childIds: [...(change.childIds || [])],
      newEntityIds: [...(change.newEntityIds || [])],
      related: this.related(itemId, 3).map((r) => r.id),
      dedupedInto: change.dedupedInto,
      rejectedActions: change.result?.rejectedActions || [],
      truncated: !!change.result?.truncated,
    };
  }

  /** "Save the window you came from" (F-CAP-2). win = get_source_window's result. */
  captureWindow(win) {
    const window = String(win?.title ?? win?.window ?? '');
    const app = String(win?.processName ?? win?.app ?? '');
    return this.capture('', { via: 'launcher', source: { window, app }, keepSource: true });
  }

  async _simple(apply) {
    try {
      const out = await this._mutate((state, env) => {
        const change = apply(state, env);
        return change?.op ? { changes: [change], change } : { code: change?.code || 'noop' };
      });
      return out.committed ? { ok: true, opId: out.opId, change: out.change } : { ok: false, code: out.code || 'noop' };
    } catch (error) {
      if (error?.code) return { ok: false, code: error.code };
      throw error;
    }
  }

  setStatus(id, status) { return this._simple((state, env) => model.applyStatus(state, id, status, env)); }
  accept(id) { return this._simple((state, env) => model.applyAccept(state, id, env)); }
  dismiss(id) { return this.setStatus(id, 'dismissed'); }
  setPrivate(id, on) { return this._simple((state, env) => model.applyEdit(state, id, { private: !!on }, env)); }
  /** P2 archive: hides an item from lists, the map and the agent (not from exports); undoable. */
  setArchived(id, on) {
    return this._simple((state, env) => {
      const item = state.items.get(id);
      if (item && !!item.archived === !!on) return { op: null, code: 'noop' };
      const change = model.applyEdit(state, id, { archived: !!on }, env);
      // An archive is an edit to the model; its label says which, for Undo.
      if (change.op) change.op.label = { code: on ? 'archive' : 'unarchive', params: { itemId: id } };
      return change;
    });
  }

  /**
   * Archived items, most recently archived first (`mm archived`). With
   * `words`, only items whose title, summary, text or entity names contain
   * every word (the last one as a prefix while typing).
   */
  archivedItems(words = '', { limit = LIMITS.findRows, trailingSpace = true } = {}) {
    const raw = String(words ?? '').trim();
    const spec = raw ? this.parse(raw, { trailingSpace }) : null;
    const want = (spec?.terms || []).filter((term) => !term.neg && (term.w ?? 1) >= 1);
    // A word that names an entity parses as that entity, not as a term.
    const ents = (spec?.entities || []).filter((e) => e.hard || e.via === 'dict');
    const out = [];
    for (const item of this.state.items.values()) {
      if (!item.archived) continue;
      if (want.length || ents.length) {
        const tokens = new Set(text.tokenize([item.title, item.summary || '', withoutUrls(item.text), ...this._entityNames(item)].join(' \n ')));
        const has = (term) => tokens.has(term.t) || (term.prefix && [...tokens].some((tok) => tok.startsWith(term.t)));
        if (!want.every(has)) continue;
        const named = (e) => (item.entityIds || []).includes(e.entityId) || text.tokenize(this.nameOf(e.entityId)).every((tok) => tokens.has(tok));
        if (!ents.every(named)) continue;
      }
      out.push(item);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt || byIdDesc(a.id, b.id));
    return Number.isFinite(limit) ? out.slice(0, limit) : out;
  }
  remove(id) { return this._simple((state, env) => model.applyDelete(state, [id], env)); }

  /** Toggles an action: open → done, done → open, suggested → accepted. */
  async toggle(id) {
    const item = this.state.items.get(id);
    if (!item || item.kind !== 'action') return { ok: false, code: 'not_action' };
    if (item.status === 'open' && item.suggested) return this.accept(id);
    return this.setStatus(id, item.status === 'done' ? 'open' : 'done');
  }

  /** Undoes `opId`, or the newest undoable op (SPEC §7.6). */
  async undo(opId) {
    try {
      const out = await this._mutate((state, env) => {
        const op = opId ? state.ops.find((o) => o.opId === opId) : journal.lastUndoable(state.ops);
        if (!op) return { code: 'nothing' };
        const change = journal.applyUndo(state, op, env);
        if (!change.op) return { code: change.code };
        return { changes: [change], undone: op.opId };
      });
      if (!out.committed) return { ok: false, code: out.code || 'nothing' };
      return { ok: true, opId: out.opId, undone: out.undone };
    } catch (error) {
      if (error?.code) return { ok: false, code: error.code };
      throw error;
    }
  }

  /**
   * Agent enrichment (the annotate tool, P1; SPEC §5 S11). Additive; one
   * undoable op. Entities the agent introduces are back-filled onto earlier
   * items that name them (SPEC §5 S4), in the same op, so undo removes both.
   */
  async annotate(entries) {
    try {
      const out = await this._mutate((state, env) => {
        const change = model.applyAnnotate(state, entries, env);
        if (!change.op) return { code: change.code || 'noop', applied: change.applied || [], rejected: change.rejected || [] };
        // The annotated items already carry the new mentions.
        this._backfill(state, change, env);
        // The undo label counts the items changed, not the entries sent.
        if (change.op.label?.params) change.op.label.params.count = Math.max(1, change.applied?.length || 0);
        return { changes: [change], applied: change.applied, rejected: change.rejected };
      });
      return { ok: !!out.committed, opId: out.opId, applied: out.applied || [], rejected: out.rejected || [], code: out.code };
    } catch (error) {
      if (error?.code) return { ok: false, code: error.code, applied: [], rejected: [] };
      throw error;
    }
  }

  merge(fromId, intoId) { return this._simple((state, env) => model.applyMerge(state, fromId, intoId, env)); }
  forget(id) { return this._simple((state, env) => model.applyForget(state, id, env)); }
  rename(id, name) { return this._simple((state, env) => model.applyRename(state, id, name, text.normalizeKey(name), env)); }

  // --- background enrichment -------------------------------------------------------

  async _enrichAll(ids, { retry = false } = {}) {
    for (const id of ids) {
      try {
        await this._enrich(id, { retry });
      } catch (error) {
        this.log.warn?.(`mindmap: link enrichment failed (${error?.code || error?.name || 'error'})`);
      }
    }
    this.requestReformat();
  }

  // Fetches a link's title and description after the save, then re-runs the
  // organizer on the new text (SPEC §5 S10). Both ops are silent. A retry
  // (P2, after a later load) also takes links whose last fetch failed.
  async _enrich(itemId, { retry = false } = {}) {
    const due = (item) => item?.enrich?.state === 'pending' || (retry && item?.enrich?.state === 'failed');
    const item = this.state.items.get(itemId);
    if (!isHttp(item?.url) || !due(item) || !this.settings.fetch_link_titles) return;
    let meta = null;
    try {
      meta = await this.invoke('fetch_link_metadata', { url: item.url });
    } catch {
      meta = null;
    }
    await this._mutate((state, env) => {
      const current = state.items.get(itemId);
      if (!current || !due(current)) return { code: 'noop' };
      const enriched = model.applyEnrichLink(state, itemId, meta && typeof meta === 'object' ? meta : null, env);
      const changes = [enriched];
      const after = state.items.get(itemId);
      if (enriched.op && after?.enrich?.state === 'done') {
        const x = this._extract({
          text: after.text, via: after.source?.via || 'launcher',
          hint: { title: after.titleSource === 'auto' ? undefined : after.title, summary: after.summary },
        }, env.now);
        const re = model.applyReextract(state, itemId, x, env);
        if (re.op) {
          this._organize(state, re, x, itemId, env);
          changes.push(re);
        }
      }
      // One journal slot per link, not two (the 200-op cap is the undo history).
      const done = changes.filter((change) => change.op);
      return { changes: done.length > 1 ? [this._silentBatch(done, state, { code: 'enrich', params: { itemId } })] : done };
    });
  }

  // The extraction re-derivation reads for one stored item: its text plus
  // what it was saved with (title, summary, terms, source window), so a
  // link's page title or a window doc's title still yields its names.
  _rederiveExtraction(state, item, env) {
    const x = this._extract({
      text: item.text, via: item.source?.via || 'launcher', source: item.source,
      hint: { title: item.title, summary: item.summary, terms: item.terms },
    }, env.now);
    if (x.empty) return { v: this.extractorVersion, mentions: [], keyphrases: item.keyphrases, candidates: [], aliases: [], empty: true };
    x.v = this.extractorVersion;
    // A child keeps the names it inherits from its parent (SPEC §5 S5).
    const parent = item.parentId ? state.items.get(item.parentId) : null;
    for (const eid of parent?.entityIds || []) {
      const entity = state.entities.get(eid);
      if (!entity || x.mentions.some((m) => m.entityId === eid)) continue;
      // kage-sensitive-data: not-sensitive — reviewed: an extraction mention, not a settings control
      x.mentions.push({ entityId: eid, key: entity.key, name: entity.name, type: entity.type, origin: 'rule', explicit: false, seg: -3 });
    }
    return x;
  }

  // Folds several silent changes into one compact silent op: the revs they
  // left and the ids they created, without before-snapshots (nobody undoes
  // a re-derivation). One op per batch keeps the user's undo history from
  // being pushed out of the 200-op journal by an organizer upgrade.
  _silentBatch(changes, state, label) {
    const op = journal.newOp({ opId: changes[0].op.opId, kind: 'enrich', at: changes[0].op.at, label, silent: true });
    const ids = new Set();
    const touched = new Set();
    const newEntityIds = [];
    for (const change of changes) {
      for (const id of Object.keys(change.op.after || {})) ids.add(id);
      for (const type of journal.RECORD_TYPES) for (const id of change.op.created?.[type] || []) journal.noteCreated(op, type, id);
      for (const part of change.touched || []) touched.add(part);
      for (const id of change.newEntityIds || []) if (!newEntityIds.includes(id)) newEntityIds.push(id);
    }
    journal.sealOp(op, state);
    for (const id of ids) op.after[id] = state.items.get(id)?.rev ?? state.entities.get(id)?.rev ?? null;
    op.lossy = true;
    return { op, touched, newEntityIds };
  }

  /**
   * P2 re-derivation (SPEC §5): items an older organizer saw
   * (item.v < extractor version) are organized again when idle, in
   * batches of 200. Only rule-origin fields change: user and agent facts,
   * rejections and owners stay. → the number of items re-derived.
   */
  async rederive() {
    if (this._rederiving || this._readOnly) return 0;
    this._rederiving = true;
    const target = this.extractorVersion;
    const tried = new Set();
    let done = 0;
    try {
      await this.ready();
      for (;;) {
        // Parents first, so a child re-derived later sees its parent's names.
        const batch = [...this.state.items.values()]
          .filter((item) => item.v < target && !tried.has(item.id))
          .sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || (a.id < b.id ? -1 : 1))
          .slice(0, REDERIVE_BATCH).map((item) => item.id);
        if (!batch.length || this._readOnly) break;
        for (const id of batch) tried.add(id);
        const out = await this._mutate((state, env) => {
          const changes = [];
          for (const id of batch) {
            const item = state.items.get(id);
            // Another window may have re-derived it already.
            if (!item || item.v >= target) continue;
            const x = this._rederiveExtraction(state, item, env);
            const change = model.applyReextract(state, id, x, { ...env, replaceRule: !x.empty });
            if (!change.op) continue;
            if (!x.empty) this._organize(state, change, x, id, env);
            changes.push(change);
          }
          if (!changes.length) return { changes: [], count: 0 };
          return { changes: [this._silentBatch(changes, state, { code: 'reextract', params: { count: changes.length } })], count: changes.length };
        });
        done += out.count || 0;
        if (batch.length === REDERIVE_BATCH) await sleep(REDERIVE_PAUSE_MS);
      }
    } finally {
      this._rederiving = false;
    }
    if (done) this.log.info?.(`mindmap: re-organized ${done} item(s) for organizer v${target}`);
    return done;
  }

  // --- agent records and prompts ---------------------------------------------------------

  cite(id) { return idlib.cite(id); }
  stripCite(value) { return idlib.stripCite(String(value ?? '').trim().replace(/^mm:[ie]:/, 'mm:')); }
  isoDay(ms) { return isoDay(ms) ?? null; }
  /** Local start of an ISO day ('2026-11-02'), or null. */
  dayStart(iso) { return dates.parseIsoDay(String(iso ?? '')); }

  /** A query range for free text such as "last week" (tools' `when`). */
  rangeOf(phrase) {
    const r = dates.parseRange(String(phrase ?? ''), { now: this.now(), weekStart: this.weekStart });
    return r ? { ...r, field: 'any' } : null;
  }

  /** Text bound for an agent payload: no angle brackets, collapsed (or line-kept), capped. */
  agentText(value, max = 300, { keepLines = false } = {}) {
    const raw = stripAngles(value);
    const flat = keepLines ? raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : text.collapseWs(raw);
    return text.truncate(flat, max);
  }

  childrenOf(id) {
    return [...(this.children.get(id) || [])].map((c) => this.state.items.get(c)).filter(Boolean)
      .sort((a, b) => (a.seg ?? 0) - (b.seg ?? 0) || (a.id < b.id ? -1 : 1));
  }

  /** Entity names on an item an agent may see (no private entities, no "me"). */
  entityNames(item) { return this._entityNames(item, { forAgent: true }); }
  ownerName(item) { return this._ownerName(item); }

  /** Up to five entity names that look like `phrase` (for not-found answers). */
  suggestNames(phrase) {
    const key = text.normalizeKey(phrase);
    if (!key) return [];
    const stem = key.slice(0, 3);
    const out = [];
    for (const entity of this.state.entities.values()) {
      if (entity.id === 'me' || entity.mergedInto || entity.private) continue;
      const k = entity.key || text.normalizeKey(entity.name);
      if (k.includes(key) || key.includes(k) || (stem.length >= 3 && k.startsWith(stem))) out.push(entity.name);
    }
    return out.sort().slice(0, 5);
  }

  _entityNames(item, { forAgent = false } = {}) {
    const names = [];
    for (const id of item.entityIds || []) {
      if (id === 'me') continue;
      const entity = this.entity(id);
      if (!entity || (forAgent && entity.private)) continue;
      if (!names.includes(entity.name)) names.push(entity.name);
    }
    return names;
  }

  _ownerName(item) {
    if (!item.owner || item.owner === 'me') return 'me';
    return this.entity(item.owner)?.name || 'me';
  }

  actionStatus(item) {
    return item.status === 'open' && item.suggested ? 'suggested' : item.status;
  }

  /** The compact record an agent sees (ARCHITECTURE §6.8). Null for private items. */
  agentRecord(item, { terms = [], why } = {}) {
    if (!item || this.isHidden(item)) return null;
    const record = {
      cite: idlib.cite(item.id),
      kind: item.kind,
      title: stripAngles(item.title),
      date: isoDay(item.occurredAt ?? item.createdAt),
      captured: isoDay(item.createdAt),
      snippet: stripAngles(this.snippetFor(item, terms, snippetChars(this.settings))),
      entities: this._entityNames(item, { forAgent: true }),
    };
    if (isHttp(item.url)) record.url = item.url;
    if (item.kind === 'action') {
      record.status = this.actionStatus(item);
      if (Number.isFinite(item.dueAt)) record.due = isoDay(item.dueAt);
      record.owner = this._ownerName(item);
    }
    if (why?.length) record.why = why;
    return record;
  }

  // "Scope I inferred" for mm? (SPEC §12). When the notes come from a
  // relaxed search (SPEC §8.2), it says so, so the agent doesn't read
  // records from outside the asked range as an exact answer.
  _scopeText(spec, t, relaxed = null) {
    const parts = [];
    if (spec.intent === 'actions') parts.push(t('prompt.scope_actions'));
    if (spec.kinds?.length) parts.push(t('prompt.scope_kinds', { kinds: spec.kinds.join(', ') }));
    if (spec.range && Number.isFinite(spec.range.end)) {
      const from = spec.range.start > 0 ? isoDay(spec.range.start) : '…';
      parts.push(t('prompt.scope_range', { from, to: isoDay(spec.range.end - 1) }));
    }
    const names = (spec.entities || []).map((e) => this.entity(e.entityId)).filter((e) => e && !e.private && e.id !== 'me').map((e) => e.name);
    if (names.length) parts.push(t('prompt.scope_about', { names: [...new Set(names)].join(', ') }));
    const code = relaxed?.code;
    if (code === 'range_widened' && Number.isFinite(relaxed.range?.start) && Number.isFinite(relaxed.range?.end)) {
      parts.push(t('prompt.scope_widened', { from: isoDay(relaxed.range.start), to: isoDay(relaxed.range.end - 1) }));
    } else if (code === 'range_dropped' || code === 'kinds_dropped' || code === 'entities_softened') {
      parts.push(t('prompt.scope_relaxed'));
    }
    return parts.length ? parts.join('; ') : t('prompt.scope_none');
  }

  /** The records mm? sends: up to 8, never private. → { spec, records, relaxed } */
  askRecords(question) {
    const spec = this.parse(String(question ?? ''), { trailingSpace: true });
    let items;
    let relaxed = null;
    if (spec.intent === 'actions') {
      const r = this.actions(spec, { forAgent: true, limit: LIMITS.askRecords });
      items = [...r.open, ...r.suggested, ...r.done];
    } else {
      const found = this.find(spec, { forAgent: true, limit: LIMITS.askRecords });
      items = found.hits.map((h) => h.item);
      if (items.length && found.relaxed?.code && found.relaxed.code !== 'none') relaxed = found.relaxed;
    }
    const records = items.map((item) => this.agentRecord(item, { terms: spec.terms })).filter(Boolean).slice(0, LIMITS.askRecords);
    return { spec, records, relaxed };
  }

  /** The visible mm? prompt (SPEC §12). */
  askPrompt(question, { t = (key) => key } = {}) {
    const q = text.collapseWs(stripAngles(question));
    const { spec, records, relaxed } = this.askRecords(q);
    const lines = records.map((r) => {
      const extra = r.status ? ` [${r.status}${r.due ? `, ${r.due}` : ''}]` : '';
      const names = r.entities.length ? ` {${r.entities.map(stripAngles).join(', ')}}` : '';
      return `- ${r.cite} (${r.kind}, ${r.date}) ${r.title} — "${r.snippet}"${extra}${names}`;
    });
    return t('prompt.ask', {
      question: q,
      scope: this._scopeText(spec, t, records.length ? relaxed : null),
      records: lines.length ? lines.join('\n') : t('prompt.ask_none'),
    });
  }

  // True once the agent has organized an item (annotate, SPEC §5 S11). It
  // sets enrich.state 'done' on every item it touches, but a link's page
  // metadata does too, so for http links only an agent trace counts.
  _agentOrganized(item) {
    if (item.enrich?.state !== 'done') return false;
    if (!isHttp(item.url)) return true;
    if (item.summarySource === 'agent' || item.terms?.length) return true;
    if (Object.values(item.mentionOrigin || {}).includes('agent')) return true;
    return this.childrenOf(item.id).some((child) => child.origin === 'agent');
  }

  /**
   * Items `mm organize` would send (SPEC §12, P2): top-level, not yet
   * organized by the agent, never private (or mentioning a private
   * entity), open actions only, newest first, at most 15.
   */
  organizeItems() {
    const out = [];
    for (const id of this._newestIds()) {
      const item = this.state.items.get(id);
      if (!item || item.parentId || item.archived || this.isHidden(item)) continue;
      if (item.kind === 'action' && item.status !== 'open') continue;
      if (this._agentOrganized(item)) continue;
      out.push(item);
      if (out.length >= LIMITS.organizeItems) break;
    }
    return out;
  }

  // One item as the organize prompt shows it: the title, the summary, then
  // the text (when it says more than the title), ≤600 characters, no <>.
  // The agent quotes actions from this text, so the text itself is kept.
  _organizeBody(item) {
    const title = text.collapseWs(item.title || '');
    const body = text.collapseWs(item.text || '');
    const parts = [];
    if (title && !body.toLowerCase().startsWith(title.toLowerCase())) parts.push(title);
    if (item.summary && text.collapseWs(item.summary).toLowerCase() !== title.toLowerCase()) parts.push(text.collapseWs(item.summary));
    if (body) parts.push(body);
    return stripAngles(text.truncate(parts.filter(Boolean).join(' — '), LIMITS.organizeChars));
  }

  /** The visible mm organize prompt (SPEC §12, P2), or null with nothing to send. */
  organizePrompt({ t = (key) => key } = {}) {
    const items = this.organizeItems();
    if (!items.length) return null;
    const lines = items.map((item) => {
      const names = this._entityNames(item, { forAgent: true });
      return `- ${idlib.cite(item.id)} (${item.kind}) ${this._organizeBody(item)}${names.length ? ` {${names.map(stripAngles).join(', ')}}` : ''}`;
    });
    // The vocabulary counts only items the agent may see, so a name known
    // only from private notes never reaches it.
    const visible = new Map();
    for (const item of this.state.items.values()) {
      if (item.archived || this.isHidden(item)) continue;
      for (const eid of item.entityIds || []) visible.set(eid, (visible.get(eid) || 0) + 1);
    }
    const vocabulary = [...this.state.entities.values()]
      .filter((e) => e.id !== 'me' && !e.mergedInto && !e.private && visible.get(e.id))
      .map((e) => ({ name: e.name, n: visible.get(e.id) }))
      .sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1))
      .slice(0, LIMITS.organizeVocabulary)
      .map((e) => stripAngles(e.name));
    return t('prompt.organize', {
      count: items.length,
      items: lines.join('\n'),
      vocabulary: vocabulary.length ? vocabulary.join(', ') : t('prompt.organize_no_vocabulary'),
    });
  }

  // --- opening ---------------------------------------------------------------------------

  // Enter on a doc (SPEC C5): focus a window showing it, else open its URL,
  // else copy its path, else show its card. → null (done) | {type:'copy'} |
  // {type:'card', id} | {type:'missing'}.
  async openTarget(id) {
    await this.ready();
    const item = this.state.items.get(id);
    if (!item) return { type: 'missing' };
    if (item.kind === 'doc') {
      const handle = await this._findWindow(item);
      if (handle !== null) {
        await this.invoke('focus_open_window', { handle });
        return null;
      }
    }
    if ((item.kind === 'link' || item.kind === 'doc') && isHttp(item.url)) {
      await this.invoke('open_url', { url: item.url });
      return null;
    }
    if (item.kind === 'doc' && item.path) return { type: 'copy', value: item.path };
    return { type: 'card', id };
  }

  async _findWindow(item) {
    const want = normTitle(item.title);
    if (want.length < 3) return null;
    const bare = want.replace(/\.[a-z0-9]{1,5}$/i, '');
    let list;
    try {
      list = await this.invoke('list_open_windows');
    } catch {
      return null;
    }
    if (!Array.isArray(list)) return null;
    const app = normTitle(item.source?.app);
    let best = null;
    for (const w of list) {
      const title = normTitle(w?.title);
      if (!title || !(title.includes(want) || (bare.length >= 3 && title.includes(bare)))) continue;
      if (!Number.isFinite(Number(w.handle))) continue;
      const sameApp = app && normTitle(w.process_name ?? w.processName) === app;
      if (!best || (sameApp && !best.sameApp)) best = { handle: Number(w.handle), sameApp };
    }
    return best ? best.handle : null;
  }

  // --- data management ---------------------------------------------------------------------

  _allKeys() {
    const now = this.now();
    const keys = new Set([...FIXED_KEYS, ...Object.keys(this.state.meta.keys || {}), ...this.keyRevs.keys()]);
    keys.add(`mm-items-${dates.utcMonthKey(now)}`);
    keys.add(`mm-items-${prevUtcMonth(now)}`);
    for (const item of this.state.items.values()) keys.add(model.partKey(`items:${model.shardOf(item)}`));
    keys.delete('mm-meta');
    return [...keys].filter((key) => model.keyPart(key)).sort();
  }

  /** Export JSON (SPEC §7.7): private items included, as the note says. */
  exportJson({ note } = {}) {
    const s = this.state;
    return {
      format: 'kage-mindmap',
      schema: model.SCHEMA,
      exportedAt: new Date(this.now()).toISOString(),
      ...(note ? { note } : {}),
      items: [...s.items.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
      entities: model.payloadFor(s, 'entities').entities,
      links: [...s.links],
      rejections: [...s.rejections],
    };
  }

  /**
   * Export Markdown (P1, SPEC §7.7): one section per entity, then
   * "Unsorted". Items are bullets with their date and kind, actions are
   * `- [ ]` / `- [x]` (nested under the note or meeting they came from),
   * links are Markdown links. An item's own words (summary, the text beyond
   * its title, dated notes) follow as a quote the first time it's listed, so
   * the file reads on its own without repeating long notes per section.
   * Private items are included and marked: it's the user's own file.
   * `out.items` receives the number of items written.
   */
  exportMarkdown(t = (key) => key, out = {}) {
    const esc = (value) => text.escapeMd(text.collapseWs(value));
    // A line of body text that Markdown must not read as a list, heading or rule.
    const prose = (value) => esc(value).replace(/^([-=])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2');
    const visible = (item) => !!item && !item.archived && !(item.kind === 'action' && item.status === 'dismissed');
    const byTime = (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
    const kids = (item) => this.childrenOf(item.id).filter(visible);
    const headOf = (item) => {
      const flag = item.private ? ` · ${t('export.private')}` : '';
      if (item.kind === 'action') {
        const due = Number.isFinite(item.dueAt) && item.status !== 'done' ? ` (${t('export.due', { day: isoDay(item.dueAt) })})` : '';
        const sug = item.suggested && item.status === 'open' ? ` — ${t('export.suggested')}` : '';
        return `[${item.status === 'done' ? 'x' : ' '}] ${esc(item.title)}${due}${sug}${flag}`;
      }
      const day = isoDay(item.occurredAt ?? item.createdAt);
      // encodeURIComponent leaves ( and ) alone, and they would end the link.
      const href = isHttp(item.url) ? item.url.replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`) : '';
      const title = href ? `[${esc(item.title)}](${href})` : esc(item.title);
      const where = item.path ? ` — \`${item.path.replace(/[`\r\n]/g, '')}\`` : '';
      const app = item.kind === 'doc' && !item.path && !isHttp(item.url) && item.source?.app ? ` · ${esc(item.source.app)}` : '';
      return `${day} · ${item.kind} · ${title}${where}${app}${flag}`;
    };
    const bodyOf = (item) => {
      const title = normTitle(item.title);
      const skip = new Set([title, normTitle(item.url), normTitle(item.path)].filter(Boolean));
      for (const child of kids(item)) skip.add(normTitle(child.quote || child.title));
      const lines = [];
      if (item.summary && normTitle(item.summary) !== title) lines.push(item.summary);
      String(item.text || '').split(/\r?\n/).forEach((raw, i) => {
        const bare = text.collapseWs(raw.replace(MARKER_RE, '').replace(/^#{1,6}\s+/, ''));
        // An action's first line is the action itself.
        if (!bare || (item.kind === 'action' && i === 0)) return;
        if (skip.has(normTitle(bare)) || extractor.ACTION_HEADING_RE.test(bare)) return;
        lines.push(bare);
      });
      return lines;
    };
    const written = new Set();
    const counted = new Set();
    const entry = (item, indent = '') => {
      counted.add(item.id);
      const lines = [`${indent}- ${headOf(item)}`];
      if (!written.has(item.id)) {
        written.add(item.id);
        for (const body of bodyOf(item)) lines.push(`${indent}  > ${prose(body)}`);
      }
      for (const child of kids(item)) lines.push(...entry(child, `${indent}  `));
      return lines;
    };
    const section = (heading, items) => {
      const ids = new Set(items.map((i) => i.id));
      // A child is listed under its parent when the parent is in this section.
      const top = items.filter((i) => !(i.parentId && ids.has(i.parentId) && visible(this.state.items.get(i.parentId))));
      if (!top.length) return [];
      return [`## ${heading}`, '', ...top.sort(byTime).flatMap((item) => entry(item)), ''];
    };
    const lines = [`# ${t('export.title')}`, '', t('export.generated', { day: isoDay(this.now()) }), ''];
    const listed = new Set();
    const ents = [...this.state.entities.values()].filter((e) => e.id !== 'me' && !e.mergedInto)
      .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0) || (a.id < b.id ? -1 : 1));
    for (const entity of ents) {
      const items = [...(this.byEntity.get(entity.id) || [])].map((id) => this.state.items.get(id)).filter(visible);
      for (const item of items) listed.add(item.id);
      // i18n-keys: etype.*
      lines.push(...section(`${esc(entity.name)} (${t(`etype.${entity.type}`)})`, items));
    }
    // Unsorted: whatever no section listed, children with their parents.
    const rest = [...this.state.items.values()].filter((i) => visible(i) && !listed.has(i.id));
    lines.push(...section(t('export.unsorted'), rest.filter((i) => !(i.parentId && listed.has(i.parentId)))));
    out.items = counted.size;
    return lines.join('\n');
  }

  /** Every stored string, primary and twin, for "Export raw copies". */
  async exportRaw() {
    const out = {};
    for (const key of [...this._allKeys(), 'mm-meta']) {
      for (const name of [key, `${storage.TWIN_PREFIX}${key}`]) {
        try {
          const raw = await this.store.readRaw(name);
          if (raw !== null) out[name] = raw;
        } catch (error) {
          out[name] = null;
          this.log.warn?.(`mindmap: raw export could not read a key (${error?.code || 'error'})`);
        }
      }
    }
    return out;
  }

  // An export from another computer names the same people and teams with
  // different random ids. Ids still dedupe as SPEC §7.7 says (newer
  // updatedAt wins), but an incoming entity whose name (key or alias) is
  // already known here becomes that entity, as a capture would resolve it,
  // so "Bingo" doesn't split in two. Returns a rewritten copy of `data`.
  _unifyImport(state, data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.entities)) return data;
    const remap = new Map();
    const fresh = new Map();
    const entitiesIn = [];
    for (const raw of data.entities) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === 'me' || state.entities.has(raw.id)) {
        entitiesIn.push(raw);
        continue;
      }
      const key = typeof raw.key === 'string' && raw.key ? raw.key : text.normalizeKey(raw.name);
      const known = key ? model.entityByKey(state, key, raw.type) : null;
      const target = known && known.id !== 'me' ? known.id : key ? fresh.get(key) : undefined;
      if (target) {
        remap.set(raw.id, target);
        continue;
      }
      if (key) fresh.set(key, raw.id);
      entitiesIn.push(raw);
    }
    if (!remap.size) return data;
    const to = (id) => remap.get(id) ?? id;
    const items = (Array.isArray(data.items) ? data.items : []).map((raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const next = { ...raw };
      if (Array.isArray(raw.entityIds)) next.entityIds = [...new Set(raw.entityIds.map(to))];
      if (raw.mentionOrigin && typeof raw.mentionOrigin === 'object') {
        next.mentionOrigin = {};
        for (const [id, origin] of Object.entries(raw.mentionOrigin)) next.mentionOrigin[to(id)] ??= origin;
      }
      if (typeof raw.owner === 'string') next.owner = to(raw.owner);
      return next;
    });
    const relink = (list) => (Array.isArray(list) ? list : []).map((r) => (r && typeof r === 'object' ? { ...r, s: to(r.s), t: to(r.t) } : r));
    return {
      ...data,
      entities: entitiesIn.map((raw) => (raw?.mergedInto ? { ...raw, mergedInto: to(raw.mergedInto) } : raw)),
      items,
      links: relink(data.links),
      rejections: relink(data.rejections),
    };
  }

  /** Import JSON (P2): one undoable op; newer updatedAt wins. → {ok, added, updated, skipped} | {ok:false, code}. */
  async importJson(raw) {
    let data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return { ok: false, code: 'bad_format' };
    }
    try {
      const out = await this._mutate((state, env) => {
        // The model's counts include entities; the user is told about items.
        const prior = new Map();
        for (const raw of Array.isArray(data?.items) ? data.items : []) {
          if (typeof raw?.id === 'string') prior.set(raw.id, state.items.get(raw.id)?.updatedAt);
        }
        const change = model.applyImport(state, this._unifyImport(state, data), { ...env, via: 'import' });
        if (!change.op) return { code: change.code || 'noop' };
        let added = 0;
        let updated = 0;
        for (const [id, at] of prior) {
          const now = state.items.get(id);
          if (!now) continue;
          if (at === undefined) added++;
          else if (now.updatedAt !== at) updated++;
        }
        // The Undo label counts items too ("Imported 5 items").
        if (change.op.label?.params) change.op.label.params.count = Math.max(1, added + updated);
        return { changes: [change], counts: { added, updated, skipped: prior.size - added - updated } };
      });
      if (!out.committed) return { ok: false, code: out.code || 'noop' };
      this._resetIndexes();
      for (const item of this.state.items.values()) this._indexItem(item);
      this._bump([...this.state.items.keys(), ...this.state.entities.keys()]);
      return { ok: true, ...out.counts };
    } catch (error) {
      if (error?.code) return { ok: false, code: error.code };
      throw error;
    }
  }

  /** Delete everything (SPEC §7.7): every known key and its twin, then the lock. */
  deleteAll() {
    return this._exclusive(() => this._deleteAll());
  }

  async _deleteAll() {
    await this.ready().catch(() => {});
    const keys = this._allKeys();
    await this.store.withLock(async () => {
      for (const key of keys) await this.store.remove(key, { force: true });
      await this.store.remove('mm-meta', { force: true });
    });
    try {
      await this.store.remove('mm-lock', { force: true });
    } catch {
      // The lock expires on its own.
    }
    const prior = this.state;
    this.state = model.emptyState(this.now(), { extractorVersion: this.extractorVersion });
    this.keyRevs = new Map();
    this._applyMe();
    this._resetIndexes();
    this._bump([...prior.items.keys(), ...prior.entities.keys()]);
    this._readOnly = null;
    this.store.readOnly = false;
    this._stale = false;
    this._loaded = true;
    this._ready = Promise.resolve();
    this.log.info?.('mindmap: deleted all data');
    return { ok: true, keys: keys.length + 1 };
  }

  /** Repair (read-only mode): writes the readable state over every key, after confirmation. */
  repair() {
    return this._exclusive(() => this._repair());
  }

  async _repair() {
    if (!this._readOnly) return { ok: false, code: 'not_readonly' };
    if (this._readOnly.code === 'future_schema') return { ok: false, code: 'future_schema' };
    const now = this.now();
    const txn = idlib.newId('o', now);
    await this.store.withLock(async (lease) => {
      const parts = new Set([...model.listParts(this.state), 'entities', 'links', 'journal']);
      for (const key of this._allKeys()) parts.add(model.keyPart(key));
      for (const part of [...parts].filter(Boolean).sort(partOrder)) {
        const key = model.partKey(part);
        // Above any rev an unreadable copy could carry.
        this.keyRevs.set(key, Math.max(this._nextRev(key), now));
        await this._writePart(part, txn, lease, { force: true });
      }
      this.keyRevs.set('mm-meta', Math.max(this._nextRev('mm-meta'), now));
      await this._writeMeta(txn, lease, now, { force: true });
    });
    this._readOnly = null;
    this.store.readOnly = false;
    await this._loadAll();
    this.log.info?.('mindmap: repaired stored data');
    return { ok: !this._readOnly };
  }

  // --- formatter data port (ARCHITECTURE §6.7) -----------------------------------------------

  get port() {
    if (!this._port) {
      const mind = this;
      this._port = {
        get loaded() { return mind._loaded; },
        get rev() { return mind.dataRev; },
        ensureLoaded: () => mind.ready(),
        cite: (id) => mind.citeVM(id),
        op: (opId) => mind.opVM(opId),
        item: (id) => mind.itemVM(id),
        map: (focus, page) => mind.neighborhood(focus, page),
        nameOf: (id) => mind.nameOf(id),
        changedSince: (since, ids) => mind.changedSince(since, ids),
      };
    }
    return this._port;
  }

  citeVM(id) {
    const item = this.state.items.get(id);
    if (item) {
      if (this.isHidden(item)) return { id, private: true };
      return {
        id, kind: item.kind, title: item.title, day: item.occurredAt ?? item.createdAt,
        snippet: this.snippetFor(item, [], 160), url: isHttp(item.url) ? item.url : undefined,
        private: false, missing: false,
        status: item.kind === 'action' ? item.status : undefined, suggested: item.kind === 'action' ? !!item.suggested : undefined,
      };
    }
    const entity = this.entity(id);
    if (entity && entity.id !== 'me') {
      if (entity.private) return { id, private: true };
      const summary = this.entitySummary(entity.id);
      return { id: entity.id, kind: entity.type, title: entity.name, day: null, snippet: '', private: false, missing: false, counts: summary?.counts };
    }
    return null;
  }

  _actionVM(item) {
    const owner = item.owner && item.owner !== 'me' ? this.entity(item.owner) : null;
    return {
      id: item.id, title: item.title, status: item.status || 'open', suggested: !!item.suggested,
      dueAt: item.dueAt, doneAt: item.doneAt, private: !!item.private,
      owner: owner ? { id: owner.id, name: owner.name } : undefined,
    };
  }

  _localCite(id) {
    const item = this.state.items.get(id);
    if (!item) return null;
    return {
      id, kind: item.kind, title: item.title, day: item.occurredAt ?? item.createdAt, private: !!item.private,
      status: item.kind === 'action' ? item.status : undefined, suggested: item.kind === 'action' ? !!item.suggested : undefined,
    };
  }

  opVM(opId) {
    const op = this.state.ops.find((o) => o.opId === opId);
    if (!op) return null;
    const summary = this.opSummary(op);
    const params = op.label?.params || {};
    if (summary.entityOp) {
      // Merge, forget and rename are about an entity: the card names it
      // (the merge target, the new name, or the forgotten one) and offers
      // Undo, not the first item the op happened to relabel.
      const id = params.intoId || params.entityId;
      const live = this.entity(id);
      const gone = (op.before?.entities || []).find((e) => e.id === id);
      const shown = live || gone;
      return {
        opId: op.opId, code: summary.code, undone: !!op.undoneBy,
        canUndo: !op.silent && journal.canUndo(this.state, op).ok, at: op.at,
        // kage-sensitive-data: not-sensitive — reviewed: an entity view model, not a settings control
        entities: shown && shown.id !== 'me' ? [{ id: shown.id, name: shown.name, type: shown.type }] : [],
        actions: [], related: [], truncated: false,
      };
    }
    const itemId = params.itemId || op.created?.items?.[0] || op.before?.items?.[0]?.id;
    const item = this.state.items.get(itemId);
    const seen = item || (op.before?.items || []).find((r) => r.id === itemId) || this._seen.get(itemId);
    const created = new Set(op.created?.items || []);
    const actions = [];
    if (item) {
      if (item.kind === 'action' && (created.has(item.id) || !['capture', 'capture_dedup', 'archive', 'unarchive'].includes(summary.code))) actions.push(this._actionVM(item));
      for (const child of [...(this.children.get(item.id) || [])].sort()) {
        const c = this.state.items.get(child);
        if (c?.kind === 'action' && created.has(child)) actions.push(this._actionVM(c));
      }
    }
    const isCapture = summary.code === 'capture' || summary.code === 'capture_dedup';
    return {
      opId: op.opId,
      // view.js has no archive headline; an archive is an edit ("✓ Updated").
      code: summary.code === 'archive' || summary.code === 'unarchive' ? 'edit' : summary.code,
      undone: !!op.undoneBy,
      canUndo: !op.silent && journal.canUndo(this.state, op).ok,
      at: op.at,
      item: seen ? { id: itemId, kind: seen.kind, title: seen.title, private: !!seen.private, status: seen.status, suggested: seen.suggested } : undefined,
      dedupedInto: summary.code === 'capture_dedup' && item ? { id: item.id, day: item.createdAt } : undefined,
      entities: item ? (item.entityIds || []).filter((id) => id !== 'me').map((id) => this.entity(id)).filter(Boolean)
        // kage-sensitive-data: not-sensitive — reviewed: an entity view model, not a settings control
        .map((e) => ({ id: e.id, name: e.name, type: e.type })) : [],
      actions,
      related: isCapture && item ? this.related(item.id, 3).map((r) => this._localCite(r.id)).filter(Boolean) : [],
      truncated: !!item?.truncated && isCapture,
    };
  }

  itemVM(id) {
    const item = this.state.items.get(id);
    if (!item) return null;
    const owner = item.owner && item.owner !== 'me' ? this.entity(item.owner) : null;
    const children = [...(this.children.get(id) || [])].map((c) => this.state.items.get(c)).filter(Boolean)
      .sort((a, b) => (a.seg ?? 0) - (b.seg ?? 0) || (a.id < b.id ? -1 : 1));
    return {
      id: item.id, kind: item.kind, title: item.title,
      text: item.text === item.url || item.text === item.path ? '' : item.text,
      day: item.occurredAt ?? item.createdAt, createdAt: item.createdAt, app: item.source?.app,
      url: item.url, path: item.path, status: item.status, suggested: !!item.suggested,
      dueAt: item.dueAt, doneAt: item.doneAt, owner: owner ? { id: owner.id, name: owner.name } : undefined,
      private: !!item.private, summary: item.summary,
      entities: (item.entityIds || []).filter((e) => e !== 'me').map((e) => this.entity(e)).filter(Boolean)
        // kage-sensitive-data: not-sensitive — reviewed: an entity view model, not a settings control
        .map((e) => ({ id: e.id, name: e.name, type: e.type, private: !!e.private })),
      actions: children.filter((c) => c.kind === 'action' && c.status !== 'dismissed').map((c) => this._actionVM(c)),
      parent: item.parentId ? this._localCite(item.parentId) || undefined : undefined,
      related: [...children.filter((c) => c.kind !== 'action').map((c) => this._localCite(c.id)),
        ...this.related(id, 5).map((r) => this._localCite(r.id))].filter(Boolean).slice(0, 5),
    };
  }
}
