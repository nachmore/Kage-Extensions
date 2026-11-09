/**
 * A fake of Kage's folder sync for extensions (`context.sync`) for the Mind
 * Map tests, coded against Kage's docs/design/SYNC.md §12.2 and §12.6 (the
 * host side is built in parallel; nothing here is copied from it).
 *
 *   - SYNC_FEATURES: what a Kage with the API puts in context.hostFeatures
 *     for an extension that holds `sync` (§12.3).
 *   - createSyncHost({ manifest }): one sync folder. Each computer keeps
 *     its own replica, as Kage does; exchange() plays the folder: every
 *     computer merges every other's cells, newest stamp first, and is told
 *     (onChanges, reason 'remote') when a record's merged value differs
 *     from what its Mind Map last saw.
 *   - host.computer(name, opts) → a computer. Its install(context) adds
 *     `context.sync` (§12.6) and the host feature to one window's context;
 *     every window of a computer shares its replica, base and cursor.
 *
 * The cell rules (§12.2) come from the manifest's `sync.collections`:
 * `whole` records are one cell; otherwise every top-level field is a cell,
 * a `together` group is one cell, a `sets` field is a cell per element
 * (present or removed) and a `maps` field a cell per key; `local` fields
 * are dropped. Stamps are a small hybrid logical clock: (wall ms, counter,
 * computer), compared in that order.
 *
 * §12.6 semantics the fake keeps:
 *   - the base: a pushed field equal to what the extension last saw there
 *     wasn't changed, so a newer value from elsewhere is kept; a pushed
 *     record equal to the merged value is `unchanged`;
 *   - `initial: true` stamps from each record's updatedAt (capped at now),
 *     with no floor, so the newer copy wins;
 *   - pull delivers the newest merged value per id, oldest first, for
 *     every record whose merged value differs from the base; ack moves the
 *     base forward (never back), and delivery is at least once;
 *   - while sync is off for the extension, push returns { off: true } and
 *     pull returns nothing;
 *   - refusals: bad_collection, bad_id, too_large (maxBytes), and
 *     sensitive_field (a credential-named field), and rate_limited past
 *     `rateLimit` records per push window (opts).
 *
 * Computer controls: setAvailable(on), enable() (on, needsInitialPush,
 * reason 'enabled'), purge() (off, reason 'purged'), failNext(method,
 * { error, times }), clearFailures(), and `calls` ([{ method, collection?,
 * n?, ids?, deleted?, deletedIds?, initial? }]).
 */

export const SYNC_FEATURES = Object.freeze(['sync.records']);

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CREDENTIAL_RE = /(token|secret|credential|creds|password|passwd|api[-_]?key|auth|oauth|session|cookie)/i;
const utf8 = new TextEncoder();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function cmp(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  return a.t - b.t || a.c - b.c || a.d - b.d;
}
const newest = (a, b) => (cmp(a, b) >= 0 ? a : b);

function hexOf(seed, length) {
  let out = '';
  for (let round = 0; out.length < length; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

// The cells of a record (id and local fields dropped), as Map<cellKey, value>.
function cellsOf(spec, record) {
  const cells = new Map();
  const body = { ...record };
  delete body.id;
  for (const field of spec.local || []) delete body[field];
  if (spec.whole) {
    cells.set('*', clone(body));
    return cells;
  }
  const groups = spec.together || [];
  const grouped = new Map();
  groups.forEach((group, i) => group.forEach((field) => grouped.set(field, i)));
  for (let i = 0; i < groups.length; i++) {
    const value = {};
    for (const field of groups[i]) if (body[field] !== undefined) value[field] = clone(body[field]);
    if (Object.keys(value).length) cells.set(`g:${i}`, value);
  }
  for (const [field, value] of Object.entries(body)) {
    if (value === undefined || grouped.has(field)) continue;
    if ((spec.sets || []).includes(field) && Array.isArray(value)) {
      cells.set(`S:${field}`, true);
      for (const element of value) cells.set(`s:${field}:${JSON.stringify(element)}`, true);
    } else if ((spec.maps || []).includes(field) && isRecord(value)) {
      cells.set(`M:${field}`, true);
      for (const [key, v] of Object.entries(value)) cells.set(`m:${field}:${key}`, clone(v));
    } else {
      cells.set(`f:${field}`, clone(value));
    }
  }
  return cells;
}

// A cell that holds a value (a set element's `false` means removed).
const alive = (key, cell) => cell.v !== undefined && !(key.startsWith('s:') && cell.v === false);

// A record from its live cells.
function recordOf(spec, id, cells) {
  if (spec.whole) {
    const whole = cells.get('*');
    return whole && whole.v !== undefined ? { id, ...clone(whole.v) } : null;
  }
  const out = { id };
  const sets = new Map();
  for (const [key, cell] of [...cells].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!alive(key, cell)) continue;
    const kind = key.slice(0, 2);
    const rest = key.slice(2);
    if (kind === 'g:') Object.assign(out, clone(cell.v));
    else if (kind === 'f:') out[rest] = clone(cell.v);
    else if (kind === 'S:') {
      if (!sets.has(rest)) sets.set(rest, []);
    } else if (kind === 's:') {
      const at = rest.indexOf(':');
      const field = rest.slice(0, at);
      if (!sets.has(field)) sets.set(field, []);
      sets.get(field).push(JSON.parse(rest.slice(at + 1)));
    } else if (kind === 'M:') {
      out[rest] ||= {};
    } else if (kind === 'm:') {
      const at = rest.indexOf(':');
      const field = rest.slice(0, at);
      (out[field] ||= {})[rest.slice(at + 1)] = clone(cell.v);
    }
  }
  for (const [field, list] of sets) out[field] = list;
  return out;
}

// Merged value of a replica or base entry: a record, or null when deleted or empty.
function valueOf(spec, id, entry) {
  if (!entry) return null;
  const live = [...entry.cells].filter(([key, cell]) => alive(key, cell)).map(([, cell]) => cell);
  if (!live.length) return null;
  const top = live.reduce((m, cell) => newest(m, cell.s), null);
  if (entry.del && cmp(entry.del, top) >= 0) return null;
  return recordOf(spec, id, entry.cells);
}

export function createSyncHost({ manifest, schema } = {}) {
  const collections = manifest?.sync?.collections || {};
  const extSchema = schema ?? manifest?.sync?.schema ?? 1;
  const computers = [];

  function makeComputer(name, { available = true, needsInitialPush = true, rateLimit = Infinity } = {}) {
    const index = computers.length;
    const tag = hexOf(`device:${name}`, 24);
    const replica = new Map();
    const base = new Map();
    const deliveries = new Map();
    const listeners = new Set();
    const calls = [];
    const failures = [];
    let clock = { t: 0, c: 0, d: index };
    let cursor = 0;
    let pushed = 0;
    let lastSyncAt = null;
    const self = {
      name, tag, replica, base, calls,
      available, needsInitialPush, rateLimit,
      contexts: 0,
    };

    const tick = (floor) => {
      const now = Date.now();
      const t = Math.max(now, clock.t, floor?.t ?? 0);
      const c = t === clock.t || t === floor?.t ? Math.max(clock.t === t ? clock.c : -1, floor?.t === t ? floor.c : -1) + 1 : 0;
      clock = { t, c, d: index };
      return clock;
    };
    self.observe = (stamp) => {
      if (stamp && cmp(stamp, clock) > 0) clock = { t: stamp.t, c: stamp.c, d: index };
    };

    const fail = (method) => {
      const at = failures.findIndex((f) => f.method === method);
      if (at < 0) return null;
      const [f] = failures.splice(at, 1);
      return f.error;
    };

    const keyOf = (collection, id) => `${collection}/${id}`;
    const entry = (map, key) => {
      if (!map.has(key)) map.set(key, { cells: new Map(), del: null, schema: extSchema });
      return map.get(key);
    };

    function pushOne(collection, spec, record, initial) {
      const id = record.id;
      const key = keyOf(collection, id);
      const rep = entry(replica, key);
      const was = base.get(key) || { cells: new Map(), del: null };
      const pushedCells = cellsOf(spec, record);
      const merged = valueOf(spec, id, rep);
      if (merged && same(cellsKeyed(cellsOf(spec, merged)), cellsKeyed(pushedCells))) {
        base.set(key, { cells: new Map([...rep.cells].map(([k, c]) => [k, { ...c }])), del: rep.del });
        return 'unchanged';
      }
      const next = { cells: new Map(was.cells), del: null };
      const keys = new Set([...pushedCells.keys(), ...was.cells.keys()]);
      const now = Date.now();
      const at = Math.min(Number(record.updatedAt) || now, now);
      let changed = false;
      for (const cellKey of keys) {
        const pv = pushedCells.has(cellKey) ? pushedCells.get(cellKey) : cellKey.startsWith('s:') ? false : undefined;
        const bv = was.cells.get(cellKey)?.v;
        if (same(pv, bv) && was.cells.has(cellKey)) continue;
        const cur = rep.cells.get(cellKey);
        if (initial && cur && same(cur.v, pv)) {
          next.cells.set(cellKey, { ...cur });
          continue;
        }
        const stamp = initial ? { t: at, c: 0, d: index } : tick(newest(newest(was.cells.get(cellKey)?.s, cur?.s), rep.del));
        const cell = { v: clone(pv), s: stamp };
        if (!cur || cmp(stamp, cur.s) > 0) rep.cells.set(cellKey, cell);
        next.cells.set(cellKey, cell);
        changed = true;
      }
      base.set(key, next);
      return changed ? 'accepted' : 'unchanged';
    }

    function deleteOne(collection, id) {
      const key = keyOf(collection, id);
      const rep = entry(replica, key);
      const stamp = tick(rep.del);
      rep.del = newest(rep.del, stamp);
      base.set(key, { cells: new Map(), del: stamp });
    }

    const api = {
      get available() {
        return self.available;
      },
      async status() {
        calls.push({ method: 'status' });
        const error = fail('status');
        if (error) throw error;
        let usedBytes = 0;
        for (const rep of replica.values()) usedBytes += utf8.encode(JSON.stringify([...rep.cells])).length;
        return {
          available: self.available, paused: false, needsInitialPush: self.needsInitialPush, deviceTag: tag,
          devices: computers.map((c) => ({ tag: c.tag, os: 'macos', lastSeenAt: lastSyncAt, thisDevice: c === self })),
          usedBytes, maxBytes: 128 * 1024 * 1024, lastSyncAt,
        };
      },
      async push(collection, records, { deleted = [], initial = false } = {}) {
        const list = Array.isArray(records) ? records : [];
        calls.push({ method: 'push', collection, n: list.length, deleted: deleted.length, initial: !!initial, ids: list.map((r) => r.id), deletedIds: [...deleted] });
        const error = fail('push');
        if (error) throw error;
        if (!self.available) return { accepted: 0, unchanged: 0, rejected: [], off: true };
        const spec = collections[collection];
        const rejected = [];
        let accepted = 0;
        let unchanged = 0;
        if (!spec) {
          for (const r of list) rejected.push({ id: r?.id, code: 'bad_collection' });
          for (const id of deleted) rejected.push({ id, code: 'bad_collection' });
          return { accepted, unchanged, rejected, off: false };
        }
        const maxBytes = spec.maxBytes ?? 65536;
        for (const record of list) {
          const id = record?.id;
          if (typeof id !== 'string' || !ID_RE.test(id)) { rejected.push({ id, code: 'bad_id' }); continue; }
          if (Object.keys(record).some((field) => CREDENTIAL_RE.test(field) && !(spec.local || []).includes(field))) { rejected.push({ id, code: 'sensitive_field' }); continue; }
          if (utf8.encode(JSON.stringify(record)).length > maxBytes) { rejected.push({ id, code: 'too_large' }); continue; }
          if (pushed >= self.rateLimit) { rejected.push({ id, code: 'rate_limited' }); continue; }
          pushed++;
          if (pushOne(collection, spec, record, initial) === 'accepted') accepted++;
          else unchanged++;
        }
        for (const id of deleted) {
          if (typeof id !== 'string' || !ID_RE.test(id)) { rejected.push({ id, code: 'bad_id' }); continue; }
          if (pushed >= self.rateLimit) { rejected.push({ id, code: 'rate_limited' }); continue; }
          pushed++;
          deleteOne(collection, id);
          accepted++;
        }
        if (initial) self.needsInitialPush = false;
        return { accepted, unchanged, rejected, off: false };
      },
      async pull({ max = 500 } = {}) {
        calls.push({ method: 'pull', max });
        const error = fail('pull');
        if (error) throw error;
        if (!self.available) return { cursor: null, more: false, changes: [] };
        const due = [];
        for (const [key, rep] of replica) {
          if (rep.schema > extSchema) continue;
          const at = key.indexOf('/');
          const collection = key.slice(0, at);
          const id = key.slice(at + 1);
          const spec = collections[collection];
          if (!spec) continue;
          const merged = valueOf(spec, id, rep);
          const seen = valueOf(spec, id, base.get(key));
          if (same(merged, seen)) continue;
          const top = [...rep.cells.values()].reduce((m, cell) => newest(m, cell.s), rep.del);
          due.push({ key, collection, id, record: merged, top, rep });
        }
        due.sort((a, b) => cmp(a.top, b.top) || (a.key < b.key ? -1 : 1));
        const page = due.slice(0, max);
        cursor += 1;
        deliveries.set(cursor, page.map((d) => ({ key: d.key, cells: new Map([...d.rep.cells].map(([k, c]) => [k, { ...c }])), del: d.rep.del })));
        return {
          cursor: String(cursor),
          more: due.length > max,
          changes: page.map((d) => ({ collection: d.collection, id: d.id, record: clone(d.record), from: { device: computers[d.top?.d]?.tag ?? tag, at: d.top?.t ?? 0 } })),
        };
      },
      async ack(cursorId) {
        calls.push({ method: 'ack' });
        const error = fail('ack');
        if (error) throw error;
        const page = deliveries.get(Number(cursorId));
        if (!page) return;
        deliveries.delete(Number(cursorId));
        for (const d of page) {
          const was = base.get(d.key) || { cells: new Map(), del: null };
          const next = { cells: new Map(was.cells), del: newest(was.del, d.del) };
          for (const [k, cell] of d.cells) if (!next.cells.has(k) || cmp(cell.s, next.cells.get(k).s) > 0) next.cells.set(k, { ...cell });
          base.set(d.key, next);
        }
        lastSyncAt = Date.now();
      },
      onChanges(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };

    self.api = api;
    self.emit = (reason, cols = Object.keys(collections)) => {
      for (const fn of [...listeners]) fn({ collections: cols, reason });
    };
    // Records whose merged value differs from what Mind Map last saw.
    self.dueCount = () => {
      let n = 0;
      for (const [key, rep] of replica) {
        const at = key.indexOf('/');
        const spec = collections[key.slice(0, at)];
        if (spec && !same(valueOf(spec, key.slice(at + 1), rep), valueOf(spec, key.slice(at + 1), base.get(key)))) n++;
      }
      return n;
    };
    /** The merged record here for (collection, id), or null. */
    self.record = (collection, id) => {
      const spec = collections[collection];
      return spec ? valueOf(spec, id, replica.get(keyOf(collection, id))) : null;
    };
    /** Every live record here in `collection`: Map<id, record>. */
    self.records = (collection) => {
      const out = new Map();
      for (const [key, rep] of replica) {
        if (!key.startsWith(`${collection}/`)) continue;
        const id = key.slice(collection.length + 1);
        const value = valueOf(collections[collection], id, rep);
        if (value) out.set(id, value);
      }
      return out;
    };
    self.install = (context) => {
      const features = new Set([...(Array.isArray(context.hostFeatures) ? context.hostFeatures : []), ...SYNC_FEATURES]);
      context.hostFeatures = Object.freeze([...features]);
      context.sync = api;
      self.contexts++;
      return context;
    };
    self.setAvailable = (on) => {
      self.available = !!on;
    };
    self.enable = () => {
      self.available = true;
      self.needsInitialPush = true;
      self.emit('enabled');
    };
    self.purge = () => {
      self.available = false;
      self.emit('purged');
    };
    self.failNext = (method, { error = new Error(`fake sync: ${method} failed`), times = 1 } = {}) => {
      for (let i = 0; i < times; i++) failures.push({ method, error });
    };
    self.clearFailures = () => { failures.length = 0; };
    self.resetRate = () => { pushed = 0; };
    return self;
  }

  // Cells by key, for comparing two records' cells.
  function cellsKeyed(cells) {
    return [...cells].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  return {
    computers,
    computer(name, opts) {
      const c = makeComputer(name, opts);
      computers.push(c);
      return c;
    },
    /**
     * The sync folder: every computer takes every other's cells (newest
     * stamp wins per cell), then hears about records its Mind Map hasn't
     * seen. → how many computers were told.
     */
    exchange() {
      for (const a of computers) {
        for (const b of computers) {
          if (a === b) continue;
          for (const [key, rep] of b.replica) {
            if (!a.replica.has(key)) a.replica.set(key, { cells: new Map(), del: null, schema: rep.schema });
            const mine = a.replica.get(key);
            for (const [k, cell] of rep.cells) {
              if (!mine.cells.has(k) || cmp(cell.s, mine.cells.get(k).s) > 0) mine.cells.set(k, { ...cell });
              a.observe(cell.s);
            }
            mine.del = newest(mine.del, rep.del);
            a.observe(rep.del);
            mine.schema = Math.max(mine.schema, rep.schema);
          }
        }
      }
      let told = 0;
      for (const c of computers) {
        if (c.available && c.dueCount()) {
          told++;
          c.emit('remote');
        }
      }
      return told;
    },
  };
}
