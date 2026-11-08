// permissions: storage — commands are routed through dataInvoke.
// Leaf module: imports nothing (the host rewrites one level of shared imports).
//
// Mind Map's only I/O. Everything goes through the host's extension-data
// commands, so this module adds what they lack:
//   - a client-side throttle (≤70 invokes per rolling second, below the
//     host's 100/s per sandbox) with retry on "invoke rate limit exceeded";
//   - corrupt-versus-missing reads: a missing key is null, a key that holds
//     anything but a JSON object is StoreError('unreadable'), and an I/O
//     failure is StoreError('io'), never "missing" (fail closed);
//   - crash-safe twin copies (`nx-<key>` is written first) for hosts whose
//     save is a plain truncating write (SPEC §7.3);
//   - a cross-window lock with compare-and-set by nonce read-back (SPEC §7.4).
//
// The host has no atomic compare-and-set, so a lock write is confirmed by
// reading it back after a settle delay longer than an invoke round trip
// (Fischer's mutual exclusion). Two windows that both saw the lock free
// both write; only the last write survives, and only its writer proceeds.
// Callers still re-check the lease before every data write (lease.check())
// and verify their transaction id afterwards (mind.js), because a host that
// stalls for longer than the settle delay can still interleave.
//
// Clocks: lock expiry is wall-clock (`now`, shared between windows); the
// throttle, waits and renewals use performance.now(), so tests that pin
// Date with fake timers still make progress.

export const ATOMIC_FEATURE = 'storage.atomic_write';
export const TWIN_PREFIX = 'nx-';

const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RATE_LIMIT_RE = /invoke rate limit exceeded/i;
const RATE_RETRIES = 2;
const POLL_MIN_MS = 15;
const POLL_JITTER_MS = 25;
// Longer than the slowest poll above, so a window that just released the
// lock gives a waiting window one chance to take it before re-acquiring.
const HANDOFF_MS = 60;
const RENEW_AFTER_MS = 1500;
const MAX_SETTLE_MS = 250;

const mono = () => globalThis.performance?.now?.() ?? Date.now();
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hasRev = (value) => Number.isFinite(value?.rev);

function randomOwner() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function checkKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key) || key.includes('..')
      || key.length > 128 - TWIN_PREFIX.length) {
    throw new TypeError('mindmap store: invalid data key');
  }
}

function parseRecord(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new StoreError('unreadable');
  let value;
  try { value = JSON.parse(raw); } catch { throw new StoreError('unreadable'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError('unreadable');
  return value;
}

/** True when the host advertises atomic `save_extension_data` (WP-H). */
export function hasAtomicWrites(hostFeatures) {
  return Array.isArray(hostFeatures) && hostFeatures.includes(ATOMIC_FEATURE);
}

export class StoreError extends Error {
  // code: 'io' | 'unreadable' | 'busy' | 'readonly' | 'conflict'. The message
  // is English and never holds user text; `detail` is a host error message
  // ('io') or the holder's expiry ('busy').
  constructor(code, detail) {
    super(`mindmap store: ${code}`);
    this.name = 'StoreError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

class Lease {
  constructor(store, nonce, ttlMs) {
    this.store = store;
    this.nonce = nonce;
    this.owner = store.owner;
    this.ttlMs = ttlMs;
    this.renewedAt = mono();
    this.lost = false;
  }

  // Confirms the lock still carries our nonce; throws StoreError('busy')
  // after a takeover. Renews automatically once the work passes 1.5 s.
  async check() {
    const lock = await this.store.readLock();
    if (lock?.nonce !== this.nonce) {
      this.lost = true;
      throw new StoreError('busy', lock?.expiresAt);
    }
    if (mono() - this.renewedAt >= RENEW_AFTER_MS || !(lock.expiresAt > this.store.now())) {
      await this.extend();
    }
  }

  async renew() {
    const lock = await this.store.readLock();
    if (lock?.nonce !== this.nonce) {
      this.lost = true;
      throw new StoreError('busy', lock?.expiresAt);
    }
    await this.extend();
  }

  async extend() {
    await this.store.writeLock({ owner: this.owner, nonce: this.nonce, expiresAt: this.store.now() + this.ttlMs });
    this.renewedAt = mono();
    const lock = await this.store.readLock();
    if (lock?.nonce !== this.nonce) {
      this.lost = true;
      throw new StoreError('busy', lock?.expiresAt);
    }
  }
}

export class Store {
  constructor({ invoke, atomic = false, owner, maxPerSecond = 70, sleep, now, settleMs = 20, random } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('mindmap store: invoke is required');
    this.invoke = invoke;
    this.atomic = !!atomic;
    // Keys whose old-host twin this store already deleted (atomic mode).
    this.twinsCleared = new Set();
    this.owner = owner || randomOwner();
    this.maxPerSecond = Math.max(1, maxPerSecond);
    this.sleep = sleep || defaultSleep;
    this.now = now || (() => Date.now());
    this.settleMs = settleMs;
    this.random = random || Math.random;
    // Set by the caller when stored data couldn't be read: data writes and
    // deletes then fail with StoreError('readonly') unless forced (repair).
    this.readOnly = false;
    this.times = [];
    this.counts = { invokes: 0, retries: 0, reads: 0, writes: 0 };
    this.tail = Promise.resolve();
    this.releasedAt = -Infinity;
    this.rtt = 0;
    this.seq = 0;
  }

  get stats() {
    return { ...this.counts };
  }

  // Takes a slot in the rolling second and returns 0, or returns how long to
  // wait for one. Synchronous, so the slot is stamped in the same turn as
  // the invoke it pays for (an await in between lets the two drift apart).
  reserveSlot() {
    const t = mono();
    while (this.times.length && this.times[0] <= t - 1000) this.times.shift();
    if (this.times.length < this.maxPerSecond) {
      this.times.push(t);
      return 0;
    }
    return Math.max(1, this.times[0] + 1001 - t);
  }

  async dataInvoke(command, args) {
    for (let attempt = 0; ; attempt++) {
      for (let wait = this.reserveSlot(); wait > 0; wait = this.reserveSlot()) await this.sleep(wait);
      this.counts.invokes++;
      const started = mono();
      try {
        // kage-sensitive-data: not-sensitive — Mind Map stores the user's notes, never credentials; every key is mm-* or its nx- twin (reviewed, SPEC §15).
        const result = await this.invoke(command, args);
        this.rtt = Math.max(mono() - started, this.rtt * 0.9);
        return result;
      } catch (error) {
        const message = String(error?.message ?? error);
        if (attempt < RATE_RETRIES && RATE_LIMIT_RE.test(message)) {
          this.counts.retries++;
          await this.sleep(1050 + this.random() * 50);
          continue;
        }
        throw new StoreError('io', message.slice(0, 300));
      }
    }
  }

  /** The stored string, or null when missing. For "export raw copies". */
  async readRaw(key) {
    checkKey(key);
    this.counts.reads++;
    const raw = await this.dataInvoke('load_extension_data', { key });
    return raw === undefined ? null : raw;
  }

  /** A JSON object, or null when missing. Throws StoreError('unreadable'|'io'). */
  async readJson(key) {
    return parseRecord(await this.readRaw(key));
  }

  async probe(key, valid) {
    let value;
    try { value = await this.readJson(key); }
    catch (error) {
      if (error?.code === 'unreadable') return { state: 'bad' };
      throw error;
    }
    if (value === null) return { state: 'missing' };
    return valid(value) ? { state: 'ok', value } : { state: 'bad' };
  }

  // Picks the best copy of a twinned key (SPEC §7.3). Without atomic writes
  // both copies are read: the valid one with the higher rev wins, the
  // primary on a tie. A primary that is missing while its twin exists means
  // the first write of that key never committed: a valid twin is taken, a
  // torn one is ignored. With atomic writes the twin is read only when the
  // primary exists but doesn't parse. `unreadable` means a committed value
  // exists and no copy of it can be read: the caller must not overwrite it.
  async readBest(key, { valid = hasRev } = {}) {
    checkKey(key);
    const twinKey = `${TWIN_PREFIX}${key}`;
    if (this.atomic) {
      const primary = await this.probe(key, valid);
      if (primary.state === 'ok') return { value: primary.value, from: 'primary', unreadable: false };
      if (primary.state === 'missing') return { value: null, from: null, unreadable: false };
      const twin = await this.probe(twinKey, valid);
      if (twin.state === 'ok') return { value: twin.value, from: 'twin', unreadable: false };
      return { value: null, from: null, unreadable: true };
    }
    const [primary, twin] = await Promise.all([this.probe(key, valid), this.probe(twinKey, valid)]);
    if (primary.state === 'ok' && twin.state === 'ok') {
      return twin.value.rev > primary.value.rev
        ? { value: twin.value, from: 'twin', unreadable: false }
        : { value: primary.value, from: 'primary', unreadable: false };
    }
    if (primary.state === 'ok') return { value: primary.value, from: 'primary', unreadable: false };
    if (twin.state === 'ok') return { value: twin.value, from: 'twin', unreadable: false };
    if (primary.state === 'missing') return { value: null, from: null, unreadable: false };
    return { value: null, from: null, unreadable: true };
  }

  async write(key, value, { force = false } = {}) {
    checkKey(key);
    if (this.readOnly && !force) throw new StoreError('readonly');
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isFinite(value.rev)) {
      throw new TypeError('mindmap store: value.rev must be a number');
    }
    const data = JSON.stringify(value);
    // Twin first: a crash during the primary write leaves a complete twin.
    if (!this.atomic) await this.dataInvoke('save_extension_data', { key: `nx-${key}`, data });
    await this.dataInvoke('save_extension_data', { key, data });
    this.counts.writes++;
    // With atomic writes the twin isn't kept up to date, so a twin left by an
    // older host would go stale: the first atomic write of each key deletes
    // it. A primary that later fails to parse then reads as unreadable
    // (read-only, Export raw copies) instead of silently falling back to
    // months-old data.
    if (this.atomic && !this.twinsCleared.has(key)) {
      try {
        await this.dataInvoke('delete_extension_data', { key: `nx-${key}` });
        this.twinsCleared.add(key);
      } catch {
        // Retried with the next write of this key.
      }
    }
  }

  async remove(key, { force = false } = {}) {
    checkKey(key);
    if (this.readOnly && !force) throw new StoreError('readonly');
    // Twin first: an interrupted delete leaves the primary, which reads back
    // as the old value rather than resurrecting a stale twin.
    await this.dataInvoke('delete_extension_data', { key: `nx-${key}` });
    await this.dataInvoke('delete_extension_data', { key });
  }

  async readLock() {
    let lock;
    try { lock = await this.readJson('mm-lock'); }
    catch (error) {
      // A torn lock can't name a live holder; an I/O failure fails closed.
      if (error?.code === 'unreadable') return null;
      throw error;
    }
    return lock && typeof lock.nonce === 'string' && Number.isFinite(lock.expiresAt) ? lock : null;
  }

  async writeLock(lock) {
    await this.dataInvoke('save_extension_data', { key: 'mm-lock', data: JSON.stringify(lock) });
  }

  settleDelay() {
    return Math.min(MAX_SETTLE_MS, Math.max(this.settleMs, 3 * this.rtt));
  }

  nonce() {
    this.seq += 1;
    return `${this.owner}:${this.seq.toString(36)}:${Math.floor(this.random() * 2 ** 32).toString(36)}`;
  }

  async acquire(ttlMs, waitMs) {
    const since = mono() - this.releasedAt;
    if (since < HANDOFF_MS) await this.sleep(HANDOFF_MS - since);
    const deadline = mono() + waitMs;
    const pause = () => this.sleep(Math.max(1, Math.min(deadline - mono(), POLL_MIN_MS + this.random() * POLL_JITTER_MS)));
    for (;;) {
      const lock = await this.readLock();
      if (lock && lock.owner !== this.owner && lock.expiresAt > this.now()) {
        if (mono() >= deadline) throw new StoreError('busy', lock.expiresAt);
        await pause();
        continue;
      }
      const lease = new Lease(this, this.nonce(), ttlMs);
      await this.writeLock({ owner: this.owner, nonce: lease.nonce, expiresAt: this.now() + ttlMs });
      await this.sleep(this.settleDelay());
      const confirmed = await this.readLock();
      if (confirmed?.nonce === lease.nonce) return lease;
      if (mono() >= deadline) throw new StoreError('busy', confirmed?.expiresAt);
      await pause();
    }
  }

  async release(lease) {
    try {
      if ((await this.readLock())?.nonce === lease.nonce) {
        await this.writeLock({ owner: this.owner, nonce: lease.nonce, expiresAt: 0 });
      }
    } catch { /* The lease also expires on its own. */ }
    this.releasedAt = mono();
  }

  // Runs fn(lease) while holding the cross-window lock. Calls from one
  // window queue behind each other (it is not reentrant: don't call
  // withLock from inside fn). Throws StoreError('busy') when another
  // window holds the lock for longer than waitMs.
  withLock(fn, { ttlMs = 4000, waitMs = 3000 } = {}) {
    const work = async () => {
      const lease = await this.acquire(ttlMs, waitMs);
      try { return await fn(lease); }
      finally { await this.release(lease); }
    };
    const run = this.tail.then(work, work);
    this.tail = run.then(() => {}, () => {});
    return run;
  }
}
