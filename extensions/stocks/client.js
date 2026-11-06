import { DEFAULTS, refreshSeconds } from './defaults.js';
import { StockError, normalizeSymbol, parseSymbols } from './symbols.js';
import { fetchQuote, validKey } from './provider.js';

export const CREDENTIALS_KEY = 'credentials';
const BUDGET_KEY = 'request_budget';
const LOCK_KEY = 'request_lock';
const MAX_PER_MINUTE = 40; // Headroom below Finnhub's free 60/min.
const MAX_PER_SECOND = 20; // Headroom below Finnhub's global 30/sec.
const MAX_SAMPLES = 512;
const RETENTION_MS = 31 * 86_400_000;
const RANGES = Object.freeze({ '1d': 86_400_000, '1w': 7 * 86_400_000, '1m': RETENTION_MS });
const clients = new WeakMap();

export function getClient(context) {
  let client = clients.get(context.invoke);
  if (!client) {
    client = new StocksClient(context);
    clients.set(context.invoke, client);
  }
  return client;
}

export class StocksClient {
  constructor(context) {
    this.invoke = context.invoke;
    this.pending = new Map();
    this.tail = Promise.resolve();
    this.owner = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    this.localBackoff = 0;
  }

  async read(key) {
    try {
      const raw = await this.invoke('load_extension_data', { key });
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  async write(key, value) {
    await this.invoke('save_extension_data', { key, data: JSON.stringify(value) });
  }

  async key() {
    // Read through: Settings and the floating/chat windows are separate instances.
    const value = await this.read(CREDENTIALS_KEY);
    return validKey(value?.api_key) ? value.api_key.trim() : null;
  }

  async saveKey(key) {
    if (!validKey(key)) throw new StockError('invalid_key');
    await this.write(CREDENTIALS_KEY, { api_key: key.trim() });
  }

  async removeKey() {
    await this.invoke('delete_extension_data', { key: CREDENTIALS_KEY });
  }

  async cached(symbol) {
    const entry = await this.read(`quote_${normalizeSymbol(symbol)}`);
    if (!entry?.quote || entry.quote.symbol !== symbol
        || !Number.isFinite(entry.quote.price) || entry.quote.price <= 0
        || !Number.isFinite(entry.quote.timestamp) || entry.quote.timestamp <= 0
        || entry.quote.timestamp > Date.now() / 1000 + 86_400
        || !Number.isFinite(entry.fetchedAt)) return null;
    return entry;
  }

  // Serializes budget/cache mutations inside this sandbox. Shared storage
  // coordinates other windows; no reliance on a module-wide singleton.
  serial(work) {
    const promise = this.tail.then(work, work);
    this.tail = promise.catch(() => {});
    return promise;
  }

  async reserve() {
    return this.serial(async () => {
      const now = Date.now();
      const lock = await this.read(LOCK_KEY);
      if (lock?.expiresAt > now && lock.owner !== this.owner) throw new StockError('busy');
      await this.write(LOCK_KEY, { owner: this.owner, expiresAt: now + 2000 });
      try {
        // As in Spotify, storage is last-writer-wins, not atomic CAS.
        if ((await this.read(LOCK_KEY))?.owner !== this.owner) throw new StockError('busy');
        const budget = await this.read(BUDGET_KEY) || {};
        const until = Math.max(Number(budget.backoffUntil) || 0, this.localBackoff);
        if (until > now) throw new StockError(budget.backoffReason || 'rate_limit', until);
        const attempts = (Array.isArray(budget.attempts) ? budget.attempts : [])
          .filter((time) => Number.isFinite(time) && time > now - 60_000);
        if (attempts.length >= MAX_PER_MINUTE) throw new StockError('rate_limit', attempts[0] + 60_000);
        const burst = attempts.filter((time) => time > now - 1000);
        if (burst.length >= MAX_PER_SECOND) throw new StockError('rate_limit', burst[0] + 1000);
        attempts.push(now);
        await this.write(BUDGET_KEY, { ...budget, attempts, backoffUntil: 0 });
      } finally {
        if ((await this.read(LOCK_KEY))?.owner === this.owner) {
          // Avoid deleting a new owner's lock across a read/delete race.
          await this.write(LOCK_KEY, { owner: this.owner, expiresAt: 0 });
        }
      }
    });
  }

  async backoff(error) {
    await this.serial(async () => {
      const now = Date.now();
      const previous = await this.read(BUDGET_KEY) || {};
      const streak = Math.min((Number(previous.streak) || 0) + 1, 6);
      const base = error.code === 'rate_limit' ? 60_000 : 30_000;
      const until = Math.max(error.retryAt || 0, now + base * 2 ** (streak - 1), this.localBackoff);
      this.localBackoff = until;
      // Merge on every write. Credentials and symbols are never in this record.
      try {
        await this.write(BUDGET_KEY, {
          ...previous, backoffUntil: Math.max(until, Number(previous.backoffUntil) || 0),
          backoffReason: error.code, streak,
        });
      } catch { /* The local backoff still protects this sandbox. */ }
    });
  }

  async request(symbol, key) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new StockError('offline');
    try {
      await this.reserve();
    } catch (error) {
      if (error instanceof StockError) throw error;
      // Failing closed avoids unbudgeted requests if storage is unavailable.
      throw new StockError('storage');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    try {
      const quote = await fetchQuote(symbol, key, { signal: controller.signal });
      await this.serial(async () => {
        const budget = await this.read(BUDGET_KEY);
        // An overlapping failed request can have set a new backoff. Keep it.
        if (budget?.streak && !(budget.backoffUntil > Date.now())) {
          try { await this.write(BUDGET_KEY, { ...budget, streak: 0 }); } catch {}
        }
        if (this.localBackoff <= Date.now()) this.localBackoff = 0;
      });
      return quote;
    } catch (error) {
      if (['rate_limit', 'offline', 'unavailable', 'auth'].includes(error.code)) await this.backoff(error);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async testKey(key) {
    if (!validKey(key)) throw new StockError('invalid_key');
    return this.request('AAPL', key);
  }

  async getQuote(input, config = {}) {
    const symbol = normalizeSymbol(input);
    const cache = await this.cached(symbol);
    const now = Date.now();
    const provider = config.provider ?? DEFAULTS.provider;
    if (provider === 'cache') return this.fallback(cache, 'cache_only');
    if (provider !== 'finnhub') throw new StockError('unsupported');
    const key = await this.key();
    if (!key) return this.fallback(cache, 'setup');
    if (cache && cache.fetchedAt > now - refreshSeconds(config) * 1000) {
      return { ...cache.quote, fetchedAt: cache.fetchedAt, cached: true, stale: false };
    }
    if (this.pending.has(symbol)) return this.pending.get(symbol);
    const promise = this.refresh(symbol, key, cache);
    this.pending.set(symbol, promise);
    try { return await promise; } finally { this.pending.delete(symbol); }
  }

  fallback(cache, reason, retryAt = null) {
    if (!cache) throw new StockError(reason, retryAt);
    return { ...cache.quote, fetchedAt: cache.fetchedAt, cached: true, stale: true, reason, retryAt };
  }

  async refresh(symbol, key, cache) {
    try {
      const quote = await this.request(symbol, key);
      const fetchedAt = Date.now();
      await this.serial(async () => {
        const previous = await this.cached(symbol);
        const samples = (Array.isArray(previous?.samples) ? previous.samples : [])
          .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.price)
            && p.timestamp > fetchedAt / 1000 - RETENTION_MS / 1000);
        if (!samples.some((p) => p.timestamp === quote.timestamp)) {
          samples.push({ timestamp: quote.timestamp, price: quote.price });
        }
        samples.sort((a, b) => a.timestamp - b.timestamp);
        try {
          await this.write(`quote_${symbol}`, { quote, fetchedAt, samples: samples.slice(-MAX_SAMPLES) });
        } catch { /* Fresh data remains usable even if the cache cannot be saved. */ }
      });
      return { ...quote, fetchedAt, cached: false, stale: false };
    } catch (error) {
      // A sibling may have completed this quote while we were backing off.
      const latest = await this.cached(symbol) || cache;
      return this.fallback(latest, error.code || 'unavailable', error.retryAt || this.localBackoff || null);
    }
  }

  async getQuotes(input, config = {}) {
    const symbols = parseSymbols(input);
    return Promise.all(symbols.map(async (symbol) => {
      try { return await this.getQuote(symbol, config); }
      catch (error) { return { symbol, error: error.code || 'unavailable', retryAt: error.retryAt || null }; }
    }));
  }

  async getHistory(input, range = '1d') {
    const symbol = normalizeSymbol(input);
    if (!Object.hasOwn(RANGES, range)) throw new StockError('invalid_range');
    const cache = await this.cached(symbol);
    const start = (Date.now() - RANGES[range]) / 1000;
    const samples = (Array.isArray(cache?.samples) ? cache.samples : [])
      .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.price) && p.timestamp >= start)
      .map((p) => ({ timestamp: p.timestamp, price: p.price }));
    return {
      symbol, range, source: 'Finnhub', kind: 'locally_sampled_quotes',
      complete: false, samples, fetchedAt: cache?.fetchedAt || null,
      note: 'Only quotes observed on this device; gaps and closed-market periods are not filled. Not historical candles.',
    };
  }
}
