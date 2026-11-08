// permissions: storage — commands are routed through dataInvoke.
import { MAX_PER_MINUTE, refreshSeconds } from './defaults.js';
import { StockError, normalizeSymbol, stocklakeSymbol, symbolEntries, symbolName } from './symbols.js';

export const API_ORIGIN = 'https://finnhub.io';
export const FREE_KEY_URL = 'https://finnhub.io/register';
export const STOCKLAKE_ORIGIN = 'https://api.stocklake.dev';
export const STOCKLAKE_KEY_URL = 'https://stocklake.dev/';
const DAY_MS = 86_400_000;
const QUOTE_TTL_MS = 10 * 60_000;
const nextMidnight = (now = Date.now()) => (Math.floor(now / DAY_MS) + 1) * DAY_MS;

export function migrateProvider(config = {}, credentials = {}) {
  if (credentials.provider === 'stocklake') return 'stocklake';
  if (credentials.provider === 'finnhub') return validKey(credentials.api_key) ? 'finnhub' : 'stocklake';
  // Old provider/cache fields did not reliably describe an active connection.
  // A saved Finnhub key is the migration signal, including on hosts which
  // overlay new manifest defaults on old saved settings.
  if (validKey(credentials.api_key)) return 'finnhub';
  return 'stocklake';
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseFinnhubQuote(body, symbol) {
  const price = finite(body?.c);
  const timestamp = finite(body?.t);
  if (price === null || price <= 0 || timestamp === null || timestamp <= 0
      || timestamp > Date.now() / 1000 + 86_400) {
    throw new StockError('unknown');
  }
  const previousClose = finite(body.pc);
  // Calculate from previous close when d/dp are absent. Never invent zero.
  const change = finite(body.d) ?? (previousClose > 0 ? price - previousClose : null);
  const percent = finite(body.dp) ?? (previousClose > 0 && change !== null ? change / previousClose * 100 : null);
  return {
    symbol: normalizeSymbol(symbol, 'finnhub'),
    name: symbolName(normalizeSymbol(symbol)),
    price,
    change,
    percent,
    previousClose,
    open: finite(body.o),
    high: finite(body.h),
    low: finite(body.l),
    timestamp,
    currency: 'USD',
    source: 'Finnhub',
  };
}

export function validKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value.trim());
}

export async function fetchQuote(symbol, key, { signal } = {}) {
  if (!validKey(key)) throw new StockError('setup');
  const url = new URL('/api/v1/quote', API_ORIGIN);
  url.searchParams.set('symbol', normalizeSymbol(symbol, 'finnhub'));
  // Finnhub's live OPTIONS response omits Access-Control-Allow-Headers:
  // X-Finnhub-Token therefore fails browser preflight. Use its documented
  // token parameter for a simple CORS request. Never expose this URL in logs
  // or results; reject redirects so credentials cannot reach another host.
  url.searchParams.set('token', key.trim());
  // The only fetch destination; charts, config and returned data have no key.
  if (url.origin !== API_ORIGIN) throw new StockError('unavailable');
  let response;
  try {
    response = await fetch(url.href, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal,
    });
  } catch {
    throw new StockError(signal?.aborted ? 'timeout' : 'offline');
  }
  if (response.status === 429) {
    throw new StockError('rate_limit', Date.now() + 60_000);
  }
  if (response.status === 401) throw new StockError('auth');
  if (response.status === 403) throw new StockError('unsupported');
  if (!response.ok) throw new StockError('unavailable');
  let body;
  try { body = await response.json(); } catch { throw new StockError('unavailable'); }
  // Do not propagate provider error text: it could contain credentials.
  if (body?.error) throw new StockError('unavailable');
  return parseFinnhubQuote(body, symbol);
}

export function parseStocklakeQuote(body, symbol) {
  const price = finite(body?.price);
  const timestamp = Date.parse(body?.updated_at) / 1000;
  if (price === null || price <= 0 || !Number.isFinite(timestamp) || timestamp <= 0
      || timestamp > Date.now() / 1000 + 86_400 || body?.symbol !== stocklakeSymbol(symbol)) {
    throw new StockError('unknown');
  }
  const previousClose = finite(body.prev_close);
  const change = previousClose > 0 ? price - previousClose : null;
  return {
    symbol: normalizeSymbol(symbol), name: typeof body.name === 'string' ? body.name.slice(0, 200) : null,
    price, change, percent: finite(body.change_pct) ?? (change !== null ? change / previousClose * 100 : null),
    previousClose, open: finite(body.open), high: finite(body.high), low: finite(body.low),
    volume: finite(body.volume), exchange: typeof body.exchange === 'string' ? body.exchange.slice(0, 40) : null,
    timestamp, asOf: new Date(timestamp * 1000).toISOString(),
    currency: /^(?:[A-Z]{3}|GBp|ZAc)$/.test(body.currency) ? body.currency : null, source: 'Stocklake',
  };
}

export function parseStocklakeHistory(body, symbol) {
  if (body?.symbol !== symbol || !Array.isArray(body.history)) throw new StockError('unavailable');
  const samples = body.history.map((bar) => ({
    timestamp: typeof bar.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bar.date)
      ? Date.parse(`${bar.date}T00:00:00Z`) / 1000 : NaN,
    price: finite(bar.close), open: finite(bar.open), high: finite(bar.high),
    low: finite(bar.low), volume: finite(bar.volume),
  }));
  if (samples.some((p) => !Number.isFinite(p.timestamp) || p.timestamp <= 0
      || p.timestamp > Date.now() / 1000 + 86_400 || p.price === null || p.price <= 0)) throw new StockError('unavailable');
  return samples.sort((a, b) => a.timestamp - b.timestamp).slice(-30);
}

let rpcId = 0;
export async function stocklakeCall(name, args, key, { signal, onHeaders = async () => {} } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (key) {
    if (!validKey(key)) throw new StockError('invalid_key');
    headers.Authorization = `Bearer ${key.trim()}`;
  }
  let response;
  try {
    response = await fetch(`${STOCKLAKE_ORIGIN}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal,
    });
  } catch { throw new StockError(signal?.aborted ? 'timeout' : 'offline'); }
  // Sync even error responses; don't read/log provider error text or retry.
  try { await onHeaders(response.headers, response.status); } catch { /* Never discard a paid response over budget sync. */ }
  if (response.status === 401) throw new StockError(key ? 'auth' : 'daily_limit', nextMidnight());
  if (response.status === 429) throw new StockError('rate_limit', nextMidnight());
  if (!response.ok) throw new StockError('unavailable');
  let envelope, body;
  try {
    envelope = await response.json();
    if (envelope.result?.isError && /\bticker\b.{0,100}\bnot[ -]+found\b/i.test(envelope.result.content?.[0]?.text || '')) {
      throw new StockError('unknown');
    }
    if (envelope.error || envelope.result?.isError) throw new Error();
    body = JSON.parse(envelope.result.content[0].text);
  } catch (error) { throw new StockError(error.code === 'unknown' ? 'unknown' : 'unavailable'); }
  return body;
}

export const CREDENTIALS_KEY = 'credentials';
const BUDGET_KEY = 'request_budget';
const LOCK_KEY = 'request_lock';
const INDEX_KEY = 'qidx';
const LEGACY_INDEX_KEY = 'quote_index';
const MAX_PER_SECOND = 20;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_SAMPLES = 512;
const RETENTION_MS = 31 * 86_400_000;
const NEGATIVE_MS = 10 * 60_000;
const PRUNE_LIMIT = 20;
const RANGES = Object.freeze({ '1d': 86_400_000, '1w': 7 * 86_400_000, '1m': RETENTION_MS });
const BACKOFF_CODES = new Set(['rate_limit', 'offline', 'unavailable', 'auth', 'timeout']);
const clients = new WeakMap();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isFresh(cache, config = {}, now = Date.now()) {
  // Refresh slightly early so a late previous tick cannot skip this boundary.
  const ttl = cache?.quote?.source === 'Stocklake' ? Math.max(QUOTE_TTL_MS, refreshSeconds(config) * 1000)
    : refreshSeconds(config) * 1000 - 1500;
  return Number.isFinite(cache?.fetchedAt) && now - cache.fetchedAt < ttl;
}

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
    this.config = context.config || {};
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
    this.pending = new Map();
    this.tail = Promise.resolve();
    this.owner = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    this.localBackoff = 0;
    this.localBackoffReason = null;
    this.invokeTimes = [];
  }

  async dataInvoke(command, args) {
    // Stay below the host's per-sandbox 100/s cap, including maintenance.
    for (let attempt = 0; ; attempt++) {
      let now = performance.now();
      this.invokeTimes = this.invokeTimes.filter((time) => time > now - 1000);
      if (this.invokeTimes.length >= 70) {
        await wait(Math.max(1, this.invokeTimes[0] + 1001 - now));
        now = performance.now();
        this.invokeTimes = this.invokeTimes.filter((time) => time > now - 1000);
      }
      this.invokeTimes.push(now);
      try { return await this.invoke(command, args); }
      catch (error) {
        if (attempt < 2 && /invoke rate limit exceeded/i.test(String(error?.message || error))) {
          await wait(1050 + Math.random() * 50);
          continue;
        }
        throw new StockError('storage');
      }
    }
  }

  async read(key) {
    const raw = await this.dataInvoke('load_extension_data', { key });
    if (raw === null) return null;
    // Distinguish corrupt contents from an I/O failure so repairs never
    // overwrite a readable record just because the disk is unavailable.
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      const error = new StockError('storage');
      error.unreadable = true;
      throw error;
    }
  }

  async write(key, value) {
    await this.dataInvoke('save_extension_data', { key, data: JSON.stringify(value) });
  }

  async key() {
    return this.providerKey('finnhub');
  }

  async providerKey(provider) {
    const value = await this.read(CREDENTIALS_KEY);
    if (value?.revision && this.keyRevision !== value.revision) {
      this.keyRevision = value.revision;
      if (this.localBackoffReason === 'auth') {
        this.localBackoff = 0;
        this.localBackoffReason = null;
        this.localAuthKey = null;
      }
    }
    const key = provider === 'stocklake' ? value?.stocklake_key : value?.api_key;
    return validKey(key) ? key.trim() : null;
  }

  async connection(config = this.config) {
    const credentials = await this.read(CREDENTIALS_KEY) || {};
    const provider = migrateProvider(config, credentials);
    const value = provider === 'stocklake' ? credentials.stocklake_key : credentials.api_key;
    return { provider, key: validKey(value) ? value.trim() : null };
  }

  async clearAuthBackoff(provider = 'finnhub') {
    if (this.localBackoffReason === 'auth') {
      this.localBackoff = 0;
      this.localBackoffReason = null;
      this.localAuthKey = null;
    }
    await this.budgetTransaction((budget) => budget.backoffReason === 'auth'
      ? { ...budget, backoffUntil: 0, backoffReason: null, streak: 0, lastFailureAt: 0 }
      : budget, provider === 'stocklake' ? '_stocklake_key' : '');
  }

  async saveKey(key, provider = 'finnhub') {
    if (!validKey(key)) throw new StockError('invalid_key');
    const previous = await this.read(CREDENTIALS_KEY) || {};
    await this.write(CREDENTIALS_KEY, { ...previous, provider,
      [provider === 'stocklake' ? 'stocklake_key' : 'api_key']: key.trim(),
      revision: `${this.owner}:${Math.random()}` });
    try { await this.clearAuthBackoff(provider); } catch { /* Credentials are already saved. */ }
  }

  async useProvider(provider) {
    if (!['stocklake', 'finnhub'].includes(provider)) throw new StockError('unavailable');
    const previous = await this.read(CREDENTIALS_KEY) || {};
    await this.write(CREDENTIALS_KEY, { ...previous, provider });
  }

  async removeKey(provider = 'finnhub') {
    let previous;
    try { previous = await this.read(CREDENTIALS_KEY) || {}; }
    catch (error) {
      if (!error.unreadable) throw error;
      // Explicit Remove is the recovery path for a torn credential record.
      await this.dataInvoke('delete_extension_data', { key: CREDENTIALS_KEY });
      return;
    }
    delete previous[provider === 'stocklake' ? 'stocklake_key' : 'api_key'];
    const active = migrateProvider(this.config, previous);
    const nextProvider = active === 'finnhub' && !validKey(previous.api_key) ? 'stocklake' : active;
    await this.write(CREDENTIALS_KEY, { ...previous, provider: nextProvider, revision: `${this.owner}:${Math.random()}` });
    try { await this.clearAuthBackoff(provider); } catch { /* Credentials are already removed. */ }
  }

  async cached(symbol, provider = 'finnhub') {
    const entry = await this.read(`quote_${normalizeSymbol(symbol)}`);
    if (['unknown', 'unsupported'].includes(entry?.error) && entry.expiresAt > Date.now()
        && (entry.source || 'Finnhub') === (provider === 'stocklake' ? 'Stocklake' : 'Finnhub')) return entry;
    if (!entry?.quote || (entry.quote.source || 'Finnhub') !== (provider === 'stocklake' ? 'Stocklake' : 'Finnhub')
        || entry.quote.symbol !== symbol
        || !Number.isFinite(entry.quote.price) || entry.quote.price <= 0
        || !Number.isFinite(entry.quote.timestamp) || entry.quote.timestamp <= 0
        || entry.quote.timestamp > Date.now() / 1000 + 86_400
        || !Number.isFinite(entry.fetchedAt)
        || entry.fetchedAt <= Date.now() - RETENTION_MS) return null;
    return entry;
  }

  serial(work) {
    const promise = this.tail.then(work, work);
    this.tail = promise.catch(() => {});
    return promise;
  }

  async budgetTransaction(update, scope = '') {
    const budgetKey = scope === '_stocklake_guest' ? 'request_budget_stocklake_guest'
      : scope === '_stocklake_key' ? 'request_budget_stocklake_key' : BUDGET_KEY;
    const lockKey = scope === '_stocklake_guest' ? 'request_lock_stocklake_guest'
      : scope === '_stocklake_key' ? 'request_lock_stocklake_key' : LOCK_KEY;
    return this.serial(async () => {
      for (let attempt = 0; ; attempt++) {
        const now = Date.now();
        let lock;
        try { lock = await this.read(lockKey); }
        catch (error) { if (!error.unreadable) throw error; }
        if (lock?.expiresAt > now && lock.owner !== this.owner) {
          if (attempt >= 3) throw new StockError('busy', lock.expiresAt);
          await wait(Math.min(300, lock.expiresAt - now) + 15 + Math.random() * 25);
          continue;
        }
        const nonce = `${this.owner}:${Math.random()}`;
        await this.write(lockKey, { owner: this.owner, nonce, expiresAt: now + 250 });
        // Validate the lease both before and after writing. The host has no
        // atomic CAS; a lost nonce retries against the winner's budget.
        if ((await this.read(lockKey))?.nonce !== nonce) {
          if (attempt >= 3) throw new StockError('busy', Date.now() + 250);
          await wait(15 + Math.random() * 25);
          continue;
        }
        try {
          let budget;
          const readBudget = async () => {
            const record = await this.read(budgetKey) ?? {};
            if (record.attempts !== undefined && (!Array.isArray(record.attempts) || !record.attempts.every(Number.isFinite))) {
              const error = new StockError('storage');
              error.unreadable = true;
              throw error;
            }
            return record;
          };
          try { budget = await readBudget(); }
          catch (error) {
            if (!error.unreadable) throw error;
            try { budget = await readBudget(); }
            catch (second) {
              if (!second.unreadable) throw second;
              budget = scope.startsWith('_stocklake')
                ? { limit: scope.endsWith('_key') ? 200 : 25, remaining: 0, resetAt: nextMidnight(),
                  backoffUntil: nextMidnight(), backoffReason: 'storage' }
                : { attempts: [], backoffUntil: Date.now() + 60_000, backoffReason: 'storage', streak: 0 };
              await this.write(budgetKey, budget);
            }
          }
          const next = { ...update(budget, Date.now()), transaction: nonce };
          if ((await this.read(lockKey))?.nonce !== nonce) {
            if (attempt >= 3) throw new StockError('busy', Date.now() + 250);
            continue;
          }
          await this.write(budgetKey, next);
          const written = await this.read(budgetKey);
          if (written?.transaction === nonce && (await this.read(lockKey))?.nonce === nonce) return;
          if (attempt >= 3) throw new StockError('busy', Date.now() + 250);
        } finally {
          // Never delete a lock which another window acquired meanwhile.
          try {
            if ((await this.read(lockKey))?.nonce === nonce) {
              await this.write(lockKey, { owner: this.owner, nonce, expiresAt: 0 });
            }
          } catch { /* A lease also expires on its own. */ }
        }
      }
    });
  }

  async reserve(n = 1, { bypassAuth = false } = {}) {
    let reservedAt;
    await this.budgetTransaction((budget, now) => {
      const localActive = this.localBackoff > now;
      const pauses = [
        { until: Number(budget.backoffUntil) || 0, reason: budget.backoffReason || 'rate_limit' },
        { until: localActive ? this.localBackoff : 0, reason: this.localBackoffReason },
      ].filter((pause) => !(bypassAuth && pause.reason === 'auth')).sort((a, b) => b.until - a.until);
      if (pauses[0]?.until > now) throw new StockError(pauses[0].reason, pauses[0].until);
      if (budget.attempts !== undefined && (!Array.isArray(budget.attempts)
          || !budget.attempts.every(Number.isFinite))) throw new StockError('storage');
      const attempts = (budget.attempts || []).filter((time) => time > now - 60_000).sort((a, b) => a - b);
      if (attempts.length + n > MAX_PER_MINUTE) {
        throw new StockError('rate_limit', attempts[attempts.length + n - MAX_PER_MINUTE - 1] + 60_000);
      }
      const burst = attempts.filter((time) => time > now - 1000);
      if (burst.length + n > MAX_PER_SECOND) {
        throw new StockError('rate_limit', burst[burst.length + n - MAX_PER_SECOND - 1] + 1000);
      }
      this.recoveryNeeded = !!budget.streak;
      reservedAt = now;
      return { ...budget, attempts: [...attempts, ...Array(n).fill(now)] };
    });
    return reservedAt;
  }

  async refund(reservedAt) {
    try {
      await this.budgetTransaction((budget) => {
        const attempts = [...(budget.attempts || [])];
        const index = attempts.indexOf(reservedAt);
        if (index >= 0) attempts.splice(index, 1);
        return { ...budget, attempts };
      });
    } catch { /* Failed persistence remains conservative. */ }
  }

  dailyBudget(record, key, now = Date.now()) {
    if (record.backoffUntil > now) throw new StockError(record.backoffReason || 'storage', record.backoffUntil);
    if (record.resetAt === undefined) return { ...record, limit: key ? 200 : 25, remaining: key ? 200 : 25, resetAt: nextMidnight(now) };
    if (!Number.isInteger(record.limit) || record.limit <= 0 || !Number.isInteger(record.remaining)
        || record.remaining < 0 || record.remaining > record.limit || !Number.isFinite(record.resetAt)
        || record.resetAt <= 0) throw new StockError('storage');
    return now >= record.resetAt
      ? { ...record, remaining: record.limit, resetAt: nextMidnight(now), exhausted: false }
      : { ...record, resetAt: Math.min(record.resetAt, now + DAY_MS) };
  }

  async reserveDaily(n, key, { bypassAuth = false } = {}) {
    let reservation;
    await this.budgetTransaction((record, now) => {
      const budget = this.dailyBudget(bypassAuth && record.backoffReason === 'auth'
        ? { ...record, backoffUntil: 0 } : record, key, now);
      if (budget.remaining < n) throw new StockError(key ? 'key_daily_limit' : 'daily_limit', budget.resetAt);
      reservation = { n, resetAt: budget.resetAt };
      return { ...budget, remaining: budget.remaining - n };
    }, key ? '_stocklake_key' : '_stocklake_guest');
    return reservation;
  }

  async refundDaily(reservation, key) {
    await this.budgetTransaction((record, now) => {
      const budget = this.dailyBudget(record, key, now);
      return budget.resetAt === reservation.resetAt && !budget.exhausted
        ? { ...budget, remaining: Math.min(budget.limit, budget.remaining + reservation.n) } : budget;
    }, key ? '_stocklake_key' : '_stocklake_guest');
  }

  async syncDaily(headers, status, key, requestedAt = Date.now()) {
    await this.budgetTransaction((record, now) => {
      const budget = this.dailyBudget(record, key, now);
      const integerHeader = (name) => {
        const raw = headers?.get?.(name);
        return raw !== null && raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
      };
      const limit = integerHeader('x-ratelimit-limit');
      const remaining = integerHeader('x-ratelimit-remaining');
      const reset = integerHeader('x-ratelimit-reset');
      const valid = limit > 0 && limit <= 5000 && remaining !== null && remaining <= limit
        && reset * 1000 > now;
      // Browsers cannot read these unless the service exposes them via CORS.
      // Absent/invalid headers retain the durable, conservative reservation.
      const next = valid ? { ...budget, limit, remaining: Math.min(budget.remaining, remaining),
        resetAt: Math.min(reset * 1000, now + DAY_MS) } : budget;
      // A late previous-day response or provider rollover lag must not close
      // a whole new guest day. Briefly pause until the service catches up.
      const rollover = !key && status === 401 && !valid
        && (requestedAt < Math.floor(now / DAY_MS) * DAY_MS || now % DAY_MS < 60_000);
      if (rollover) Object.assign(next, { backoffUntil: now + 30_000, backoffReason: 'daily_limit' });
      else if (status === 429 || (!key && status === 401)) Object.assign(next, { remaining: 0, exhausted: true });
      return next;
    }, key ? '_stocklake_key' : '_stocklake_guest');
  }

  checkNetwork(shouldContinue = () => true) {
    if (!shouldContinue()) throw new StockError('superseded');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new StockError('offline');
  }

  async requestStocklake(name, args, key, { testing = false, cost = 1, shouldContinue } = {}) {
    this.checkNetwork(shouldContinue);
    if (key && !validKey(key)) throw new StockError('invalid_key');
    const reservation = await this.reserveDaily(cost, key, { bypassAuth: testing });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    let responded = false;
    const requestedAt = Date.now();
    try {
      this.checkNetwork(shouldContinue);
      return await stocklakeCall(name, args, key, {
        signal: controller.signal, onHeaders: (headers, status) => {
          responded = true;
          clearTimeout(timer);
          return this.syncDaily(headers, status, key, requestedAt);
        },
      });
    } catch (error) {
      if (!responded && ['offline', 'superseded'].includes(error.code)) {
        try { await this.refundDaily(reservation, key); } catch { /* A failed write stays conservative. */ }
      }
      if (error.code === 'daily_limit' || error.code === 'rate_limit') {
        // Use the provider's reset rather than a transport fallback.
        let budget;
        try { budget = await this.read(`${BUDGET_KEY}_stocklake_${key ? 'key' : 'guest'}`); } catch { /* Keep the provider error. */ }
        error.code = key ? 'key_daily_limit' : 'daily_limit';
        error.retryAt = budget?.backoffReason === 'daily_limit' && budget.backoffUntil > Date.now()
          ? budget.backoffUntil : budget?.resetAt || nextMidnight();
      } else if (BACKOFF_CODES.has(error.code) && !(testing && error.code === 'auth')) {
        const until = Date.now() + (error.code === 'timeout' ? 3000 : 30_000);
        try {
          await this.budgetTransaction((budget) => ({ ...budget, backoffUntil: until, backoffReason: error.code }),
            key ? '_stocklake_key' : '_stocklake_guest');
        } catch { /* Keep the transport error. */ }
        error.retryAt = until;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  async backoff(error) {
    const now = Date.now();
    if (error.code === 'timeout') {
      this.localBackoff = now + 3000;
      this.localBackoffReason = 'timeout';
      error.retryAt = this.localBackoff;
      return;
    }
    if (this.backoffPending) {
      await this.backoffPending;
      error.retryAt = this.localBackoff;
      return;
    }
    // A failed budget read must not overwrite the existing shared record.
    this.localBackoff = Math.max(this.localBackoff, now + 30_000);
    this.localBackoffReason = error.code;
    const pending = this.budgetTransaction((previous, time) => {
      const active = previous.backoffUntil > time;
      const oldStreak = time - (previous.lastFailureAt || 0) >= 2 * MAX_BACKOFF_MS ? 0 : Number(previous.streak) || 0;
      const streak = active ? oldStreak : Math.min(oldStreak + 1, 6);
      const base = error.code === 'rate_limit' ? 60_000 : 30_000;
      const until = active ? Math.max(previous.backoffUntil, error.retryAt || 0)
        : Math.max(error.retryAt || 0, time + Math.min(MAX_BACKOFF_MS, base * 2 ** (streak - 1)));
      this.localBackoff = until;
      this.localBackoffReason = active ? previous.backoffReason : error.code;
      error.retryAt = until;
      return { ...previous, backoffUntil: until, backoffReason: this.localBackoffReason, streak, lastFailureAt: time };
    });
    this.backoffPending = pending;
    try { await pending; } finally { this.backoffPending = null; }
  }

  async request(symbol, key, { testing = false, shouldContinue, reservedAt } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    try {
      this.checkNetwork(shouldContinue);
      return await fetchQuote(symbol, key, { signal: controller.signal });
    }
    catch (error) {
      if (['offline', 'superseded'].includes(error.code) && reservedAt !== undefined) await this.refund(reservedAt);
      if (!testing && error.code === 'auth') this.localAuthKey = key;
      // A rejected candidate key must never poison the saved key's backoff.
      if ((!testing || error.code !== 'auth') && BACKOFF_CODES.has(error.code)) await this.backoff(error);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async testKey(key, provider = 'finnhub') {
    if (provider === 'stocklake') {
      if (!key) return null;
      if (key && !validKey(key)) throw new StockError('invalid_key');
      const body = await this.requestStocklake('get_stocks', { symbols: ['AAPL'] }, key, { testing: true });
      return parseStocklakeQuote(body?.symbols?.AAPL, 'AAPL');
    }
    if (!validKey(key)) throw new StockError('invalid_key');
    this.checkNetwork();
    const reservedAt = await this.reserve(1, { bypassAuth: true });
    return this.request('AAPL', key, { testing: true, reservedAt });
  }

  async recovered() {
    if (!this.recoveryNeeded) return;
    await this.budgetTransaction((budget, now) => budget.backoffUntil > now ? budget
      : { ...budget, streak: 0 });
    if (this.localBackoff <= Date.now()) {
      this.localBackoff = 0;
      this.localBackoffReason = null;
    }
  }

  async getQuote(input, config = {}) {
    const [quote] = await this.getQuotes([input], config);
    if (quote.error) throw new StockError(quote.error, quote.retryAt);
    return quote;
  }

  fallback(cache, reason, retryAt = null) {
    const retry = BACKOFF_CODES.has(reason) || ['busy', 'storage', 'daily_limit', 'key_daily_limit'].includes(reason) ? retryAt : null;
    if (!cache || cache.error) throw new StockError(reason, retry);
    return { ...cache.quote, fetchedAt: cache.fetchedAt, cached: true, stale: true, reason, retryAt: retry, samples: cache.samples || [] };
  }

  async refresh(symbol, key, cache, fetchedAt = Date.now(), preserveRecord = false, options = {}) {
    try {
      const quote = await this.request(symbol, key, options);
      const samples = (Array.isArray(cache?.samples) ? cache.samples : [])
        .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.price)
          && p.timestamp > fetchedAt / 1000 - RETENTION_MS / 1000);
      if (!samples.some((p) => p.timestamp === quote.timestamp)) samples.push({ timestamp: quote.timestamp, price: quote.price });
      samples.sort((a, b) => a.timestamp - b.timestamp);
      const entry = { quote, fetchedAt, samples: samples.slice(-MAX_SAMPLES) };
      if (!preserveRecord) {
        try { await this.write(`quote_${symbol}`, entry); } catch { /* Keep the fresh result. */ }
      }
      return { ...quote, fetchedAt, cached: false, stale: false, samples: entry.samples };
    } catch (error) {
      if (!preserveRecord && ['unknown', 'unsupported'].includes(error.code)) {
        try { await this.write(`quote_${symbol}`, { error: error.code, fetchedAt, expiresAt: fetchedAt + NEGATIVE_MS }); } catch { /* Best effort negative cache. */ }
      }
      const retryAt = error.retryAt || (BACKOFF_CODES.has(error.code) && this.localBackoff > Date.now() ? this.localBackoff : null);
      return this.fallback(cache, error.code || 'unavailable', retryAt);
    }
  }

  async getQuotes(input, config = {}, options = {}) {
    const fetchedAt = options.startedAt ?? Date.now();
    let connection, connectionError;
    try { connection = options.connection || await this.connection(config); }
    catch (error) { connectionError = error.code || 'storage'; }
    if (connectionError || connection?.provider === 'stocklake') return this.getStocklakeQuotes(input, config, connection?.key, fetchedAt,
      { ...options, connectionError });
    // Start the reservation clock before IPC. Polls at 60/300 seconds must
    // not miss the boundary because key/cache/budget reads took time.
    const entries = symbolEntries(input, 'finnhub');
    // Migrate before an INDEX quote can overwrite quote_index on APFS/NTFS.
    if (entries.some((entry) => entry.symbol === 'INDEX')) {
      try { await this.maintainQuotes([]); }
      catch (error) {
        for (const entry of entries) if (entry.symbol === 'INDEX') entry.error = error.code || 'storage';
      }
    }
    const key = connection?.key;
    const keyError = connectionError;
    if (this.localBackoffReason === 'auth' && key !== this.localAuthKey) {
      this.localBackoff = 0;
      this.localBackoffReason = null;
      this.localAuthKey = null;
    }
    const ready = await Promise.all(entries.map(async (entry) => {
      if (entry.error) return entry;
      let cache, preserveRecord = false;
      try { cache = await this.cached(entry.symbol); } catch (error) { preserveRecord = !error.unreadable; }
      return { ...entry, cache, preserveRecord };
    }));
    const fresh = [];
    const output = ready.map((entry) => {
      if (entry.error) return Promise.resolve(entry);
      const { symbol, cache, preserveRecord } = entry;
      const failure = (error) => ({ symbol, error: error.code || 'unavailable', retryAt: error.retryAt || null });
      const reason = keyError || (!key ? 'setup' : null);
      if (reason) {
        try { return Promise.resolve(this.fallback(cache, reason)); } catch (error) { return Promise.resolve(failure(error)); }
      }
      if (cache?.error) return Promise.resolve({ symbol, error: cache.error, retryAt: null });
      if (cache && isFresh(cache, config, fetchedAt)) {
        return Promise.resolve({ ...cache.quote, fetchedAt: cache.fetchedAt, cached: true, stale: false, samples: cache.samples || [] });
      }
      if (this.pending.has(symbol)) return this.pending.get(symbol).catch(failure);
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      this.pending.set(symbol, promise);
      fresh.push({ symbol, cache, preserveRecord, resolve, reject });
      return promise.catch(failure);
    });
    if (fresh.length) {
      // One key read and one budget reservation for the entire batch.
      try {
        this.checkNetwork(options.shouldContinue);
        const reservedAt = await this.reserve(fresh.length);
        await Promise.all(fresh.map(async (entry) => {
          try { entry.resolve(await this.refresh(entry.symbol, key, entry.cache, fetchedAt, entry.preserveRecord,
            { shouldContinue: options.shouldContinue, reservedAt })); }
          catch (error) { entry.reject(error); }
          finally { this.pending.delete(entry.symbol); }
        }));
      } catch (error) {
        for (const entry of fresh) {
          try { entry.resolve(this.fallback(entry.cache, error.code || 'storage', error.retryAt)); }
          catch (failure) { entry.reject(failure); }
          this.pending.delete(entry.symbol);
        }
      }
    }
    const results = await Promise.all(output);
    if (fresh.length && results.some((quote) => quote.cached === false)) {
      try { await this.recovered(); } catch { /* Existing budget is preserved. */ }
    }
    this.scheduleMaintenance(ready.filter((q) => !q.error).map((q) => q.symbol));
    return results;
  }

  async getStocklakeQuotes(input, config, key, fetchedAt = Date.now(), options = {}) {
    const entries = symbolEntries(input);
    const ready = await Promise.all(entries.map(async (entry) => {
      if (entry.error) return entry;
      try { return { ...entry, cache: await this.cached(entry.symbol, 'stocklake')
        || (options.connectionError ? await this.cached(entry.symbol, 'finnhub') : null) }; }
      catch (error) { return { ...entry, preserveRecord: !error.unreadable }; }
    }));
    const fresh = [];
    const fail = (entry, error) => {
      try { return this.fallback(entry.cache, error.code || 'unavailable', error.retryAt); }
      catch (failure) { return { symbol: entry.symbol, error: failure.code, retryAt: failure.retryAt }; }
    };
    const output = ready.map((entry) => {
      if (entry.error) return Promise.resolve(entry);
      const { symbol, cache } = entry;
      if (options.connectionError) return Promise.resolve(fail(entry, new StockError(options.connectionError)));
      if (cache?.error) return Promise.resolve({ symbol, error: cache.error });
      if (cache && isFresh(cache, config, fetchedAt)) {
        return Promise.resolve({ ...cache.quote, fetchedAt: cache.fetchedAt, cached: true, stale: false });
      }
      const pendingId = `stocklake:${key ? 'key' : 'guest'}:${symbol}`;
      if (this.pending.has(pendingId)) return this.pending.get(pendingId);
      let resolve;
      const promise = new Promise((res) => { resolve = res; });
      this.pending.set(pendingId, promise);
      fresh.push({ ...entry, pendingId, resolve });
      return promise;
    });
    if (fresh.length) {
      try {
        // The API accepts 25; the extension's watchlist/query cap is 10.
        // Each requested symbol is reserved, even if the API skips it.
        const symbols = [...new Set(fresh.map((entry) => stocklakeSymbol(entry.symbol)))];
        const body = await this.requestStocklake('get_stocks', { symbols }, key,
          { cost: symbols.length, shouldContinue: options.shouldContinue });
        for (const entry of fresh) {
          try {
            const quote = parseStocklakeQuote(body?.symbols?.[stocklakeSymbol(entry.symbol)], entry.symbol);
            if (!entry.preserveRecord) {
              try { await this.write(`quote_${entry.symbol}`, { quote, fetchedAt }); } catch { /* Keep the valid fresh quote. */ }
            }
            entry.resolve({ ...quote, fetchedAt, cached: false, stale: false });
          } catch (error) {
            if (!entry.preserveRecord && error.code === 'unknown') {
              try { await this.write(`quote_${entry.symbol}`, { source: 'Stocklake', error: 'unknown', fetchedAt,
                expiresAt: fetchedAt + NEGATIVE_MS }); } catch { /* Best effort negative cache. */ }
            }
            entry.resolve(fail(entry, error));
          }
        }
      } catch (error) {
        for (const entry of fresh) {
          if (error.code === 'unknown' && !entry.preserveRecord) {
            try { await this.write(`quote_${entry.symbol}`, { source: 'Stocklake', error: 'unknown', fetchedAt,
              expiresAt: fetchedAt + NEGATIVE_MS }); } catch { /* Best effort negative cache. */ }
          }
          entry.resolve(fail(entry, error));
        }
      } finally {
        for (const entry of fresh) this.pending.delete(entry.pendingId);
      }
    }
    const results = await Promise.all(output);
    // Show exhaustion even on an otherwise fresh cache hit.
    try {
      const budget = this.dailyBudget(await this.read(`${BUDGET_KEY}_stocklake_${key ? 'key' : 'guest'}`) || {}, key);
      if (budget.remaining === 0) {
        for (const quote of results) {
          if (!quote.error) Object.assign(quote, { reason: key ? 'key_daily_limit' : 'daily_limit', retryAt: budget.resetAt });
        }
      }
    } catch { /* A failed reservation already reports storage; cache remains useful. */ }
    this.scheduleMaintenance(ready.filter((q) => !q.error).map((q) => q.symbol));
    return results;
  }

  async exactCache(symbols, config = {}, options = {}) {
    if (!symbols.length) return null;
    try {
      const { provider } = await this.connection(config);
      const caches = await Promise.all(symbols.map((symbol) => this.cached(symbol, provider)));
      if (caches.some((cache) => !cache || (!cache.error && !isFresh(cache, config)))) return null;
      // getQuotes also applies key removal and setup status to cache hits.
      return await this.getQuotes(symbols, config, options);
    } catch { return null; }
  }

  scheduleMaintenance(symbols) {
    this.maintenanceSymbols ||= new Set();
    for (const symbol of symbols) this.maintenanceSymbols.add(symbol);
    if (this.maintenanceTimer !== undefined) return;
    this.maintenanceTimer = setTimeout(() => {
      this.maintenanceTimer = undefined;
      const tracked = [...this.maintenanceSymbols];
      this.maintenanceSymbols.clear();
      this.maintenance = this.maintainQuotes(tracked).catch(() => {
        // Keep failed tracking work for the next lookup rather than orphaning
        // new records after transient contention or an inaccessible index.
        for (const symbol of tracked) this.maintenanceSymbols.add(symbol);
      });
    }, 0);
  }

  async quoteIndex() {
    let index;
    let legacy = false;
    try { index = await this.read(INDEX_KEY); }
    catch (error) { if (!error.unreadable) throw error; }
    if (!index) {
      // Today's host cannot enumerate extension data. Migrate the old index
      // if readable, otherwise start fresh and track subsequent lookups.
      try { index = await this.read(LEGACY_INDEX_KEY); legacy = !!index && !index.quote; }
      catch (error) { if (!error.unreadable) throw error; }
    }
    return index?.symbols && typeof index.symbols === 'object' && !Array.isArray(index.symbols)
      ? { ...index, legacy } : { symbols: {}, prunedAt: 0, legacy };
  }

  async indexLease(work) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let lock;
      try { lock = await this.read('qidx_lock'); }
      catch (error) { if (!error.unreadable) throw error; }
      if (lock?.expiresAt > Date.now() && lock.owner !== this.owner) {
        await wait(Math.min(250, lock.expiresAt - Date.now()) + 15 + Math.random() * 25);
        continue;
      }
      const nonce = `${this.owner}:${Math.random()}`;
      await this.write('qidx_lock', { owner: this.owner, nonce, expiresAt: Date.now() + 5000 });
      if ((await this.read('qidx_lock'))?.nonce !== nonce) continue;
      let renewedAt = Date.now();
      const renew = async (force = false) => {
        if (!force && Date.now() - renewedAt < 1000) return;
        if ((await this.read('qidx_lock'))?.nonce !== nonce) throw new StockError('busy', Date.now() + 250);
        await this.write('qidx_lock', { owner: this.owner, nonce, expiresAt: Date.now() + 5000 });
        if ((await this.read('qidx_lock'))?.nonce !== nonce) throw new StockError('busy', Date.now() + 250);
        renewedAt = Date.now();
      };
      try { return await work(renew); }
      finally {
        try {
          if ((await this.read('qidx_lock'))?.nonce === nonce) await this.write('qidx_lock', { owner: this.owner, nonce, expiresAt: 0 });
        } catch { /* Lease expiry also releases maintenance. */ }
      }
    }
    throw new StockError('busy', Date.now() + 250);
  }

  async maintainQuotes(symbols = [], { clear = false } = {}) {
    return this.serial(() => this.indexLease(async (renew) => {
      const index = await this.quoteIndex();
      const tracked = { ...index.symbols };
      for (const symbol of symbols) tracked[normalizeSymbol(symbol)] = true;
      const due = clear || !index.prunedAt || index.prunedAt <= Date.now() - 86_400_000;
      const removed = new Set();
      let deleted = 0, failed = 0;
      if (due) {
        const keys = Object.keys(tracked);
        const start = clear ? 0 : Number(index.cursor) || 0;
        for (const symbol of (clear ? keys : keys.slice(start, start + PRUNE_LIMIT))) {
          await renew();
          try { if (normalizeSymbol(symbol) !== symbol) throw new StockError('invalid_symbols'); }
          catch { delete tracked[symbol]; removed.add(symbol); continue; }
          let entry, unreadable = false;
          try { entry = await this.read(`quote_${symbol}`); }
          catch (error) {
            if (!error.unreadable) { if (clear) failed++; continue; }
            unreadable = true;
          }
          if (clear) {
            if (entry || unreadable) {
              try {
                await this.dataInvoke('delete_extension_data', { key: `quote_${symbol}` });
                deleted++;
              } catch { failed++; continue; }
            }
            try {
              const history = await this.read(`history_${symbol}`);
              if (history) {
                await this.dataInvoke('delete_extension_data', { key: `history_${symbol}` });
                deleted++;
              }
            } catch { failed++; continue; }
            delete tracked[symbol];
            removed.add(symbol);
            continue;
          }
          if (!entry && !unreadable) {
            // A history-only record must remain tracked for clear/retention.
            try {
              const history = await this.read(`history_${symbol}`);
              if (history?.fetchedAt > Date.now() - RETENTION_MS) continue;
              if (history) await this.dataInvoke('delete_extension_data', { key: `history_${symbol}` });
            } catch { continue; }
          }
          if (unreadable || !entry || !Number.isFinite(entry.fetchedAt) || entry.fetchedAt <= Date.now() - RETENTION_MS || (entry.error && entry.expiresAt <= Date.now())) {
            try { await this.dataInvoke('delete_extension_data', { key: `quote_${symbol}` }); }
            catch { continue; }
            delete tracked[symbol];
            removed.add(symbol);
          } else if (Array.isArray(entry.samples)) {
            const samples = entry.samples.filter((p) => p && Number.isFinite(p.timestamp) && Number.isFinite(p.price)
              && p.timestamp * 1000 > Date.now() - RETENTION_MS);
            if (samples.length !== entry.samples.length) {
              // Do not overwrite a fresh quote written during this pass.
              try {
                const latest = await this.read(`quote_${symbol}`);
                if (latest?.fetchedAt === entry.fetchedAt) await this.write(`quote_${symbol}`, { ...latest, samples });
              } catch { /* A failed trim must not abort tracking other records. */ }
            }
          }
        }
      }
      // Merge symbols added by other windows while pruning was in progress.
      await renew(true);
      const latest = await this.quoteIndex();
      const merged = { ...latest.symbols, ...tracked };
      for (const symbol of removed) delete merged[symbol];
      const cursor = due && !clear ? (Number(index.cursor) || 0) + PRUNE_LIMIT : 0;
      await this.write(INDEX_KEY, { symbols: merged, prunedAt: due ? Date.now() : index.prunedAt,
        cursor: cursor < Object.keys(index.symbols).length ? cursor : 0 });
      if (index.legacy) {
        // quote_INDEX may share this path on case-insensitive filesystems.
        try {
          const legacy = await this.read(LEGACY_INDEX_KEY);
          if (legacy && !legacy.quote) await this.dataInvoke('delete_extension_data', { key: LEGACY_INDEX_KEY });
        } catch { /* The new index is durable even if legacy cleanup fails. */ }
      }
      return { deleted, failed };
    }));
  }

  async deleteQuotes(symbols = []) {
    await Promise.allSettled([...this.pending.values()]);
    if (this.maintenanceTimer !== undefined) {
      clearTimeout(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }
    if (this.maintenance) await this.maintenance;
    const tracked = [...new Set([...symbols, ...(this.maintenanceSymbols || [])])];
    this.maintenanceSymbols?.clear();
    return this.maintainQuotes(tracked, { clear: true });
  }

  async getHistory(input, range = '1m', entry = undefined, config = this.config, options = {}) {
    const symbol = normalizeSymbol(input);
    if (!Object.hasOwn(RANGES, range)) throw new StockError('invalid_range');
    let connection;
    try { connection = entry && entry.source !== 'Stocklake'
      ? { provider: 'finnhub' } : await this.connection(config); }
    catch (error) {
      // Existing Finnhub local history remains readable with a broken
      // credential store; no request is made on that path.
      if (entry?.source === 'Stocklake') throw error;
      const old = entry || await this.cached(symbol);
      if (!old) throw error;
    }
    if (connection?.provider === 'stocklake') return this.stocklakeHistory(symbol, range, connection.key, options);
    const cache = entry === undefined ? await this.cached(symbol) : entry;
    if (entry === undefined) {
      this.scheduleMaintenance([symbol]);
    }
    const start = (Date.now() - RANGES[range]) / 1000;
    const samples = (Array.isArray(cache?.samples) ? cache.samples : [])
      .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.price) && p.timestamp >= start)
      .map((p) => ({ timestamp: p.timestamp, price: p.price }));
    return {
      symbol, range, source: 'Finnhub', kind: 'locally_sampled_quotes',
      complete: false, samples, fetchedAt: cache?.fetchedAt || null,
      note: this.t('quote.sampled'),
    };
  }

  async stocklakeHistory(symbol, range, key, { cachedOnly = false, shouldContinue } = {}) {
    const pendingId = `history:${key ? 'key' : 'guest'}:${symbol}`;
    const selectRange = (history) => ({ ...history, range,
      samples: history.samples.slice(-(range === '1d' ? 1 : range === '1w' ? 5 : 30)) });
    if (!cachedOnly && this.pending.has(pendingId)) return this.pending.get(pendingId).then(selectRange);
    const work = async () => {
      let cache;
      try { cache = await this.read(`history_${symbol}`); }
      catch (error) { if (!error.unreadable) throw error; }
      const valid = cache?.source === 'Stocklake' && Number.isFinite(cache.fetchedAt) && Array.isArray(cache.samples)
        && cache.samples.every((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.price) && p.price > 0);
      if (valid && Date.now() - cache.fetchedAt < DAY_MS) return { ...cache, symbol, range, cached: true };
      if (cachedOnly) return valid ? { ...cache, symbol, range, cached: true, stale: true }
        : { symbol, source: 'Stocklake', samples: [], range, cached: true };
      try {
        const fetchedAt = Date.now();
        const wireSymbol = stocklakeSymbol(symbol);
        const body = await this.requestStocklake('get_stock_history', { symbol: wireSymbol, days: 30 }, key, { shouldContinue });
        const history = { symbol, source: 'Stocklake', kind: 'daily_history', complete: true,
          days: 30, samples: parseStocklakeHistory(body, wireSymbol), fetchedAt, note: this.t('quote.history') };
        // History shares the quote index so deletion also removes its cache.
        try { await this.write(`history_${symbol}`, history); } catch { /* Keep the paid history response. */ }
        this.scheduleMaintenance([symbol]);
        return { ...history, range, cached: false };
      } catch (error) {
        if (!valid) throw error;
        return { ...cache, symbol, range, cached: true, stale: true, reason: error.code, retryAt: error.retryAt };
      }
    };
    const promise = work();
    if (!cachedOnly) this.pending.set(pendingId, promise);
    try {
      const history = await promise;
      return selectRange(history);
    } finally { if (!cachedOnly) this.pending.delete(pendingId); }
  }
}
