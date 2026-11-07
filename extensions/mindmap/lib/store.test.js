import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHost } from '../../../test-helpers/mindmap/memory-host.mjs';
import { Store, StoreError, hasAtomicWrites } from './store.js';

const FIXTURE_NOW = new Date(2026, 10, 6, 10, 0).getTime();

function setup({ atomic = false, latency, handlers, ...options } = {}) {
  const host = createMemoryHost({ atomic, latency, handlers });
  const store = new Store({ invoke: host.invoke, atomic, ...options });
  return { host, store };
}

const saves = (host) => host.calls.filter((c) => c.command === 'save_extension_data').map((c) => c.args.key);

afterEach(() => { vi.useRealTimers(); });

describe('readJson: corrupt versus missing', () => {
  it('returns null for a missing key and the object for a stored one', async () => {
    const { host, store } = setup();
    expect(await store.readJson('mm-meta')).toBeNull();
    host.files.set('mm-meta', '{"rev":3,"schema":1}');
    expect(await store.readJson('mm-meta')).toEqual({ rev: 3, schema: 1 });
  });

  it.each([['torn', '{"rev":3,"sch'], ['empty', ''], ['null', 'null'], ['array', '[1,2]'], ['number', '42']])(
    'throws unreadable for %s contents', async (_, raw) => {
      const { host, store } = setup();
      host.files.set('mm-meta', raw);
      await expect(store.readJson('mm-meta')).rejects.toMatchObject({ code: 'unreadable' });
    });

  it('fails closed on I/O errors instead of reporting a missing key', async () => {
    const store = new Store({ invoke: async () => { throw new Error('Failed to load extension data: permission denied'); } });
    const error = await store.readJson('mm-meta').catch((e) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect(error.code).toBe('io');
  });

  it('rejects invalid keys before invoking the host', async () => {
    const { host, store } = setup();
    for (const key of ['', '../x', 'a/b', 'a b', 'x'.repeat(126)]) {
      await expect(store.readJson(key)).rejects.toBeInstanceOf(TypeError);
    }
    expect(host.calls).toHaveLength(0);
  });
});

describe('twin writes and readBest', () => {
  it('writes the twin first, then the primary, when the host is not atomic', async () => {
    const { host, store } = setup();
    await store.write('mm-items-2026-11', { rev: 1, items: [] });
    expect(saves(host)).toEqual(['nx-mm-items-2026-11', 'mm-items-2026-11']);
    expect(host.files.get('nx-mm-items-2026-11')).toBe(host.files.get('mm-items-2026-11'));
  });

  it('writes once in atomic mode', async () => {
    const { host, store } = setup({ atomic: true });
    await store.write('mm-meta', { rev: 1 });
    expect(saves(host)).toEqual(['mm-meta']);
  });

  it('refuses values without a numeric rev', async () => {
    const { store } = setup();
    await expect(store.write('mm-meta', { schema: 1 })).rejects.toBeInstanceOf(TypeError);
    await expect(store.write('mm-meta', null)).rejects.toBeInstanceOf(TypeError);
  });

  it('picks the copy with the higher rev, and the primary on a tie', async () => {
    const { host, store } = setup();
    host.files.set('mm-meta', '{"rev":4,"n":"primary"}');
    host.files.set('nx-mm-meta', '{"rev":5,"n":"twin"}');
    expect(await store.readBest('mm-meta')).toEqual({ value: { rev: 5, n: 'twin' }, from: 'twin', unreadable: false });
    host.files.set('nx-mm-meta', '{"rev":4,"n":"twin"}');
    expect((await store.readBest('mm-meta')).from).toBe('primary');
    host.files.set('nx-mm-meta', '{"rev":3,"n":"twin"}');
    expect((await store.readBest('mm-meta')).value.n).toBe('primary');
  });

  it('falls back to the twin when the primary is corrupt (a crash mid primary write)', async () => {
    const { host, store } = setup();
    await store.write('mm-entities', { rev: 7, entities: [{ id: 'me' }] });
    host.corrupt('mm-entities');
    expect(await store.readBest('mm-entities')).toEqual({
      value: { rev: 7, entities: [{ id: 'me' }] }, from: 'twin', unreadable: false,
    });
  });

  it('keeps the committed primary when the twin is torn (a crash mid twin write)', async () => {
    const { host, store } = setup();
    await store.write('mm-links', { rev: 2, links: [] });
    host.crashAfterWrites(0);
    await expect(store.write('mm-links', { rev: 3, links: [] })).rejects.toMatchObject({ code: 'io' });
    host.revive();
    expect(host.files.get('nx-mm-links')).not.toBe(host.files.get('mm-links'));
    expect(await store.readBest('mm-links')).toEqual({ value: { rev: 2, links: [] }, from: 'primary', unreadable: false });
  });

  it('reports unreadable when both copies are corrupt, and never calls that missing', async () => {
    const { host, store } = setup();
    await store.write('mm-meta', { rev: 1 });
    host.corrupt('mm-meta');
    host.corrupt('nx-mm-meta', 'empty');
    expect(await store.readBest('mm-meta')).toEqual({ value: null, from: null, unreadable: true });
    host.files.delete('nx-mm-meta');
    expect((await store.readBest('mm-meta')).unreadable).toBe(true);
  });

  it('treats a parseable copy without a rev as invalid', async () => {
    const { host, store } = setup();
    host.files.set('mm-meta', '{"schema":1}');
    host.files.set('nx-mm-meta', '{"schema":1,"rev":2}');
    expect((await store.readBest('mm-meta')).from).toBe('twin');
    expect((await store.readBest('mm-meta', { valid: () => true })).from).toBe('primary');
  });

  it('ignores a torn twin whose primary never committed (first write of a key crashed)', async () => {
    const { host, store } = setup();
    host.crashAfterWrites(0);
    await expect(store.write('mm-items-2026-12', { rev: 1, items: [] })).rejects.toMatchObject({ code: 'io' });
    host.revive();
    expect(host.files.has('mm-items-2026-12')).toBe(false);
    expect(await store.readBest('mm-items-2026-12')).toEqual({ value: null, from: null, unreadable: false });
    // A complete twin of an uncommitted first write is newer data: take it.
    host.files.set('nx-mm-items-2026-12', '{"rev":1,"items":[]}');
    expect((await store.readBest('mm-items-2026-12')).from).toBe('twin');
  });

  it('reads only the primary in atomic mode unless it does not parse', async () => {
    const { host, store } = setup({ atomic: true });
    host.files.set('nx-mm-meta', '{"rev":9}');
    expect(await store.readBest('mm-meta')).toEqual({ value: null, from: null, unreadable: false });
    host.files.set('mm-meta', '{"rev":2}');
    host.calls.length = 0;
    expect((await store.readBest('mm-meta')).value).toEqual({ rev: 2 });
    expect(host.calls.map((c) => c.args.key)).toEqual(['mm-meta']);
    host.corrupt('mm-meta');
    expect(await store.readBest('mm-meta')).toEqual({ value: { rev: 9 }, from: 'twin', unreadable: false });
    host.corrupt('nx-mm-meta');
    expect((await store.readBest('mm-meta')).unreadable).toBe(true);
  });

  it('propagates I/O errors from readBest', async () => {
    const { store } = setup({ handlers: {} });
    store.invoke = async () => { throw new Error('disk unavailable'); };
    await expect(store.readBest('mm-meta')).rejects.toMatchObject({ code: 'io' });
  });

  it('remove deletes the twin first, then the primary', async () => {
    const { host, store } = setup();
    await store.write('mm-journal', { rev: 1, ops: [] });
    host.calls.length = 0;
    await store.remove('mm-journal');
    expect(host.calls.map((c) => [c.command, c.args.key])).toEqual([
      ['delete_extension_data', 'nx-mm-journal'], ['delete_extension_data', 'mm-journal'],
    ]);
    expect([...host.files.keys()]).toEqual([]);
  });

  it('read-only mode refuses data writes and deletes unless forced', async () => {
    const { host, store } = setup();
    store.readOnly = true;
    await expect(store.write('mm-meta', { rev: 1 })).rejects.toMatchObject({ code: 'readonly' });
    await expect(store.remove('mm-meta')).rejects.toMatchObject({ code: 'readonly' });
    expect(saves(host)).toEqual([]);
    await store.write('mm-meta', { rev: 1 }, { force: true });
    expect(saves(host)).toEqual(['nx-mm-meta', 'mm-meta']);
  });

  it('readRaw returns the stored string untouched', async () => {
    const { host, store } = setup();
    host.files.set('mm-meta', '{"rev":1,"tor');
    expect(await store.readRaw('mm-meta')).toBe('{"rev":1,"tor');
    expect(await store.readRaw('mm-links')).toBeNull();
  });
});

describe('throttle and rate-limit retry', () => {
  it('never exceeds 70 invokes in any rolling second, even with the clock pinned', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXTURE_NOW);
    const times = [];
    const { store } = setup({ latency: () => { times.push(performance.now()); return 0; } });
    await Promise.all(Array.from({ length: 160 }, (_, i) => store.readJson(`k${i}`)));
    expect(times).toHaveLength(160);
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((t) => t >= times[i] && t < times[i] + 1000).length;
      expect(inWindow).toBeLessThanOrEqual(70);
    }
  }, 10_000);

  it('retries the host rate-limit error twice, then fails with io', async () => {
    const { store } = setup({ sleep: async () => {} });
    let failures = 2;
    store.invoke = async () => {
      if (failures-- > 0) throw new Error("Extension 'mindmap': invoke rate limit exceeded (max 100/s)");
      return '{"rev":1}';
    };
    expect(await store.readJson('mm-meta')).toEqual({ rev: 1 });
    expect(store.stats).toMatchObject({ invokes: 3, retries: 2 });

    failures = 3;
    await expect(store.readJson('mm-meta')).rejects.toMatchObject({ code: 'io' });
  });

  it('does not retry other errors', async () => {
    const { store } = setup({ sleep: async () => {} });
    let calls = 0;
    store.invoke = async () => { calls++; throw new Error('Failed to save extension data'); };
    await expect(store.write('mm-meta', { rev: 1 })).rejects.toMatchObject({ code: 'io' });
    expect(calls).toBe(1);
  });

  it('recovers from the real host limit when a burst overshoots it', async () => {
    const { host, store } = setup({ maxPerSecond: 1000 });
    const results = await Promise.all(Array.from({ length: 130 }, (_, i) => store.readJson(`k${i}`)));
    expect(results.every((r) => r === null)).toBe(true);
    expect(store.stats.retries).toBe(30);
    expect(host.calls).toHaveLength(160);
  }, 10_000);
});

describe('withLock', () => {
  const jitter = () => Math.random() * 4;

  it('keeps two windows mutually exclusive under interleaved latency (50 increments → 50)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXTURE_NOW);
    const host = createMemoryHost({ latency: jitter });
    const a = new Store({ invoke: host.invoke, owner: 'window-a' });
    const b = new Store({ invoke: host.connect().invoke, owner: 'window-b' });
    let writing = 0;
    let overlaps = 0;
    // A host stall longer than the settle delay can still let a late lock
    // write through; lease.check() then reports the takeover ('busy') before
    // the loser writes, and the caller retries, as mind.js does.
    const increment = async (store) => {
      for (;;) {
        try {
          return await store.withLock(async (lease) => {
            const counter = (await store.readBest('ctr')).value ?? { rev: 0, n: 0 };
            await lease.check();
            writing++;
            if (writing > 1) overlaps++;
            try { await store.write('ctr', { rev: counter.rev + 1, n: counter.n + 1 }); }
            finally { writing--; }
          }, { waitMs: 10_000 });
        } catch (error) {
          if (error?.code !== 'busy') throw error;
        }
      }
    };
    await Promise.all([
      ...Array.from({ length: 25 }, () => increment(a)),
      ...Array.from({ length: 25 }, () => increment(b)),
    ]);
    expect(overlaps).toBe(0);
    expect(JSON.parse(host.files.get('ctr'))).toEqual({ rev: 50, n: 50 });
    expect(new Set(host.calls.map((c) => c.window))).toEqual(new Set([0, 1]));
    expect(JSON.parse(host.files.get('mm-lock')).expiresAt).toBe(0);
  }, 30_000);

  it('runs calls from one window one after another', async () => {
    const { store } = setup();
    const order = [];
    await Promise.all([1, 2, 3].map((n) => store.withLock(async () => {
      order.push(`start ${n}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${n}`);
    })));
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  it('returns the work result and releases the lock when the work throws', async () => {
    const { host, store } = setup();
    expect(await store.withLock(async () => 42)).toBe(42);
    await expect(store.withLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(JSON.parse(host.files.get('mm-lock')).expiresAt).toBe(0);
    expect(await store.withLock(async () => 'again')).toBe('again');
  });

  it('writes {owner, nonce, expiresAt: now + ttl} and no twin for the lock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXTURE_NOW);
    const { host, store } = setup({ owner: 'w1' });
    let seen;
    await store.withLock(async () => { seen = JSON.parse(host.files.get('mm-lock')); });
    expect(seen).toMatchObject({ owner: 'w1', expiresAt: FIXTURE_NOW + 4000 });
    expect(typeof seen.nonce).toBe('string');
    expect(host.files.has('nx-mm-lock')).toBe(false);
  });

  it('waits for a live lock held by another window, then fails busy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXTURE_NOW);
    const { host, store } = setup();
    host.files.set('mm-lock', JSON.stringify({ owner: 'other', nonce: 'other:1', expiresAt: FIXTURE_NOW + 4000 }));
    const work = vi.fn();
    const started = performance.now();
    const error = await store.withLock(work, { waitMs: 150 }).catch((e) => e);
    expect(error).toMatchObject({ code: 'busy', detail: FIXTURE_NOW + 4000 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    expect(work).not.toHaveBeenCalled();
    expect(JSON.parse(host.files.get('mm-lock')).nonce).toBe('other:1');
  });

  it('takes over a stale lock past its expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXTURE_NOW);
    const { host, store } = setup({ owner: 'w1' });
    host.files.set('mm-lock', JSON.stringify({ owner: 'crashed', nonce: 'crashed:1', expiresAt: FIXTURE_NOW - 1 }));
    expect(await store.withLock(async () => JSON.parse(host.files.get('mm-lock')).owner, { waitMs: 50 })).toBe('w1');
  });

  it('treats a torn lock as free', async () => {
    const { host, store } = setup();
    host.files.set('mm-lock', '{"owner":"x","non');
    expect(await store.withLock(async () => 'ok', { waitMs: 50 })).toBe('ok');
  });

  it('fails lease.check() after a takeover, and never releases the new holder\'s lock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXTURE_NOW);
    const host = createMemoryHost();
    const a = new Store({ invoke: host.invoke, owner: 'a' });
    const b = new Store({ invoke: host.connect().invoke, owner: 'b' });
    const result = a.withLock(async (lease) => {
      await lease.check();
      vi.setSystemTime(FIXTURE_NOW + 5000); // a stalled past its 4 s lease
      await b.withLock(async () => {
        await expect(lease.check()).rejects.toMatchObject({ code: 'busy' });
        expect(lease.lost).toBe(true);
      });
      throw new Error('a gives up');
    });
    await expect(result).rejects.toThrow('a gives up');
    expect(JSON.parse(host.files.get('mm-lock')).owner).toBe('b');

    // b's lease survives a's release attempt even while b still holds it.
    let bLease;
    const holding = b.withLock(async (lease) => {
      bLease = lease;
      await a.release({ nonce: 'stale-nonce' });
      await lease.check();
    });
    await holding;
    expect(bLease.lost).toBe(false);
  });

  it('renews the lease on demand and after 1.5 s of work', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXTURE_NOW);
    const { host, store } = setup();
    await store.withLock(async (lease) => {
      vi.setSystemTime(FIXTURE_NOW + 1000);
      await lease.renew();
      expect(JSON.parse(host.files.get('mm-lock')).expiresAt).toBe(FIXTURE_NOW + 5000);
      vi.setSystemTime(FIXTURE_NOW + 2000);
      await lease.check(); // under 1.5 s since the renewal: no write
      expect(JSON.parse(host.files.get('mm-lock')).expiresAt).toBe(FIXTURE_NOW + 5000);
      lease.renewedAt -= 1600;
      await lease.check();
      expect(JSON.parse(host.files.get('mm-lock')).expiresAt).toBe(FIXTURE_NOW + 6000);
    });
  });

  it('lets a waiting window in between two locked operations of another', async () => {
    const host = createMemoryHost({ latency: () => 1 });
    const a = new Store({ invoke: host.invoke, owner: 'a' });
    const b = new Store({ invoke: host.connect().invoke, owner: 'b' });
    const order = [];
    const op = (store, name) => store.withLock(async () => {
      order.push(name);
      await new Promise((r) => setTimeout(r, 30));
    });
    const aOps = Promise.all([op(a, 'a1'), op(a, 'a2'), op(a, 'a3')]);
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all([aOps, op(b, 'b1')]);
    expect(order.indexOf('b1')).toBeLessThan(3);
  });
});

describe('helpers', () => {
  it('detects the atomic-write host feature', () => {
    expect(hasAtomicWrites(['settings.copy_action', 'storage.atomic_write'])).toBe(true);
    expect(hasAtomicWrites(['settings.copy_action'])).toBe(false);
    expect(hasAtomicWrites(undefined)).toBe(false);
  });

  it('StoreError carries a code and an English message without user text', () => {
    const error = new StoreError('busy', 123);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'StoreError', code: 'busy', detail: 123, message: 'mindmap store: busy' });
  });

  it('counts invokes for logging', async () => {
    const { store } = setup();
    await store.write('mm-meta', { rev: 1 });
    await store.readBest('mm-meta');
    expect(store.stats).toEqual({ invokes: 4, retries: 0, reads: 2, writes: 1 });
  });
});
