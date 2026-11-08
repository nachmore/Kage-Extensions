import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeContext } from '../../test-helpers/mock-context.mjs';
import { StocksClient, getClient } from './client.js';
import { MAX_SYMBOLS, parseQuery, parseSymbols } from './symbols.js';
import { copyText, direction, signedText, timestampText } from './format.js';
import Search from './search.js';
import Settings from './settings.js';
import Tools from './tools.js';
import Widget from './widget.js';

const NOW = Date.parse('2026-11-06T16:20:40.417Z');
const KEY = 'round3-fixture-key';
const DAY = 86_400_000;
const catalog = JSON.parse(readFileSync(new URL('./_locales/en/messages.json', import.meta.url)));
const quote = (symbol = 'AAPL', age = 0) => ({
  quote: { symbol, price: 1234.56, change: -0.001, percent: -0.001, timestamp: Math.floor((NOW - age) / 1000), source: 'Finnhub', currency: 'USD' },
  fetchedAt: NOW - age, samples: [],
});
const response = (status = 200) => ({
  status, ok: status === 200,
  json: async () => ({ c: 1234.56, d: -0.001, dp: -0.001, pc: 1234.56, t: Math.floor(Date.now() / 1000) }),
});
function host({ seed = {}, key = KEY, latency = 0, language = 'en', config = {}, hook, store } = {}) {
  store ||= new Map(Object.entries(seed).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]));
  if (key && !store.has('credentials')) store.set('credentials', JSON.stringify({ api_key: key }));
  const handler = async (command, args) => {
    if (latency) await new Promise((resolve) => setTimeout(resolve, latency));
    const override = await hook?.(command, args, store);
    if (override !== undefined) return override;
    if (command === 'load_extension_data') return store.get(args.key) ?? null;
    if (command === 'save_extension_data') { store.set(args.key, args.data); return null; }
    if (command === 'delete_extension_data') { store.delete(args.key); return null; }
    return null;
  };
  const context = makeContext({ catalog, config, language }).context;
  context.invoke = vi.fn(handler);
  return { context, store, client: getClient(context) };
}
function init(Provider, h) {
  const provider = new Provider();
  provider.initialize(h.context);
  return provider;
}
async function drive(promise, ms = 2000) {
  const outcome = promise.then((value) => ({ value }), (error) => ({ error }));
  await vi.advanceTimersByTimeAsync(ms);
  const result = await outcome;
  if (result.error) throw result.error;
  return result.value;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async () => response()));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('round 3: prompt intent and settling', () => {
  it.each([
    'stock price of nvda', 'stock comp: RSU vs ISO', 'stock up on water before the storm',
    'stock picks for 2026', 'stock rom for pixel 8', 'stock aapl!', 'stock nvda: earnings',
    'stock aapl bad/symbol', 'stock aapl vs msft', 'stock in my account',
  ])('leaves real prose alone: %s', async (query) => {
    const search = init(Search, host());
    expect(parseQuery(query)).toBeNull();
    expect(search.match(query)).toEqual([]);
    expect(await search.matchAsync(query)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([180, 390, 700])('settles typing at %i ms/key with a documented 600 ms pause', async (perKey) => {
    const search = init(Search, host());
    const pending = [];
    const text = '$AAPL';
    for (let i = 1; i <= text.length; i++) {
      search.match(text.slice(0, i));
      pending.push(search.matchAsync(text.slice(0, i)));
      await vi.advanceTimersByTimeAsync(perKey);
    }
    await drive(Promise.all(pending));
    const requested = fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('symbol'));
    expect(requested).toEqual(perKey < 600 ? ['AAPL'] : ['A', 'AA', 'AAP', 'AAPL']);
  });

  it.each(['stock aapl ', 'stock aapl,', 'stock '])('settles a cold lookup even after a delimiter: %s', async (query) => {
    const search = init(Search, host());
    const pending = search.matchAsync(query);
    await vi.advanceTimersByTimeAsync(599);
    expect(fetch).not.toHaveBeenCalled();
    const rows = await drive(pending, 1);
    expect(rows[0].data.quote.symbol).toBe('AAPL');
    expect(Date.now()).toBe(NOW + 600);
  });

  it('serves an exact cache hit before any settle timer', async () => {
    const search = init(Search, host({ seed: { quote_AAPL: quote() } }));
    const rows = await search.matchAsync('$AAPL');
    expect(rows[0].data.quote.cached).toBe(true);
    expect(Date.now()).toBe(NOW);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([100, 650])('finishes the loading row after a config broadcast at %i ms', async (at) => {
    fetch.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return response(); });
    const search = init(Search, host());
    const pending = search.matchAsync('$AAPL');
    await vi.advanceTimersByTimeAsync(at);
    search.onConfigUpdate({ refresh_seconds: 60 });
    const rows = await drive(pending);
    expect(rows[0].data.quote.symbol).toBe('AAPL');
    expect(rows.some((row) => row.data.pending)).toBe(false);
  });

  it.each([100, 650])('replaces the loading row when disabled during lookup at %i ms', async (at) => {
    fetch.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return response(); });
    const search = init(Search, host());
    const pending = search.matchAsync('$AAPL');
    await vi.advanceTimersByTimeAsync(at);
    search.onConfigUpdate({ enabled: false });
    const rows = await drive(pending);
    expect(rows[0].description).toBe('Stocks is disabled.');
    expect(rows[0].data.pending).toBeUndefined();
    expect(await search.execute(rows[0])).toEqual({ type: 'replace_input', value: '$AAPL' });
  });

  it.each(['stock', 'stock copy'])('pending Enter with %s uses the watchlist when a key exists', async (query) => {
    const search = init(Search, host());
    const rows = search.match(query);
    const generation = search.generation;
    const action = await search.execute(rows[0]);
    expect(action.type).toBe(query.includes('copy') ? 'copy' : 'custom');
    expect(search.generation).toBeGreaterThan(generation);
  });

  it('pending Enter skips foreign tickers and preserves input if none are usable', async () => {
    const h = host();
    const search = init(Search, h);
    expect(await search.execute(search.match('$VOD.L $AAPL')[0])).toMatchObject({ type: 'custom' });
    expect(h.context.invoke).toHaveBeenCalledWith('open_url', { url: 'https://www.tradingview.com/chart/?symbol=AAPL' });
    expect(await search.execute(search.match('$VOD.L')[0])).toEqual({ type: 'replace_input', value: '$VOD.L' });
    expect(await search.execute(search.errorRow('', 'too_many'))).toEqual({ type: 'replace_input', value: '$VOD.L' });
  });

  it('pending bare Enter opens settings only without a key', async () => {
    const search = init(Search, host({ key: null }));
    expect(await search.execute(search.match('stock')[0])).toEqual({ type: 'open_extension_settings' });
  });
});

describe('round 3: self healing storage and safe key changes', () => {
  it.each(['', '{torn', 'null'])('settings survive unreadable credentials %j with Remove enabled', async (credentials) => {
    const h = host({ seed: { credentials } });
    const settings = init(Settings, h);
    const controls = (await settings.getSettings()).sections.flatMap((section) => section.controls);
    expect(controls.find((control) => control.id === 'remove_key').disabled).toBe(false);
    expect((await settings.runAction('remove_key')).status).toContain('Key removed');
    expect(h.store.has('credentials')).toBe(false);
  });

  it('replaces an unreadable lock and confirms ownership by nonce', async () => {
    const h = host({ seed: { request_lock: '' } });
    expect((await h.client.getQuotes(['AAPL']))[0].price).toBe(1234.56);
    const lock = JSON.parse(h.store.get('request_lock'));
    expect(lock.nonce).toBeTruthy();
    const calls = h.context.invoke.mock.calls;
    const written = calls.findIndex(([cmd, args]) => cmd === 'save_extension_data' && args.key === 'request_lock');
    expect(calls[written + 1]).toEqual(['load_extension_data', { key: 'request_lock' }]);
  });

  it('retries a lost nonce against the winner budget without losing its attempts', async () => {
    let steal = true;
    const h = host({ hook(command, args, store) {
      if (steal && command === 'save_extension_data' && args.key === 'request_lock') {
        steal = false;
        store.set('request_lock', JSON.stringify({ owner: 'winner', nonce: 'winner', expiresAt: NOW + 40 }));
        store.set('request_budget', JSON.stringify({ attempts: [NOW - 100] }));
        return null;
      }
    } });
    expect((await drive(h.client.getQuotes(['AAPL'])))[0].price).toBe(1234.56);
    expect(JSON.parse(h.store.get('request_budget')).attempts).toHaveLength(2);
  });

  it.each(['', '{torn', 'null', '{"attempts":"broken"}'])('repairs a twice-unreadable budget %j and resumes after 60 seconds', async (request_budget) => {
    const h = host({ seed: { request_budget } });
    expect((await h.client.getQuotes(['AAPL']))[0].error).toBe('storage');
    const budget = JSON.parse(h.store.get('request_budget'));
    expect(budget).toMatchObject({ attempts: [], backoffReason: 'storage', backoffUntil: NOW + 60_000 });
    expect(fetch).not.toHaveBeenCalled();
    const reads = h.context.invoke.mock.calls.filter(([cmd, args]) => cmd === 'load_extension_data' && args.key === 'request_budget');
    expect(reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await h.client.getQuotes(['AAPL']))[0].price).toBe(1234.56);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not replace a budget after an I/O failure', async () => {
    const original = JSON.stringify({ attempts: [NOW] });
    const h = host({ seed: { request_budget: original }, hook(cmd, args) {
      if (cmd === 'load_extension_data' && args.key === 'request_budget') throw new Error('disk inaccessible');
    } });
    expect((await h.client.getQuotes(['AAPL']))[0].error).toBe('storage');
    expect(h.store.get('request_budget')).toBe(original);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('overwrites a torn quote and avoids refetching on the next tick', async () => {
    const h = host({ seed: { quote_AAPL: '' } });
    await h.client.getQuotes(['AAPL']);
    expect(JSON.parse(h.store.get('quote_AAPL')).quote.price).toBe(1234.56);
    await vi.advanceTimersByTimeAsync(60_000);
    await h.client.getQuotes(['AAPL']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.store.get('qidx')).symbols.AAPL).toBe(true);
  });

  it.each(['removeKey', 'saveKey'])('%s persists credentials before any failing cleanup', async (action) => {
    const h = host({ hook(cmd, args) {
      if (cmd === 'load_extension_data' && args.key === 'request_lock') throw new Error('budget unavailable');
    } });
    await h.client[action]('replacement-fixture-key');
    if (action === 'removeKey') expect(h.store.has('credentials')).toBe(false);
    else expect(await h.client.key()).toBe('replacement-fixture-key');
    const calls = h.context.invoke.mock.calls;
    expect(calls[0][0]).toBe(action === 'removeKey' ? 'delete_extension_data' : 'save_extension_data');
    expect(calls[0][1].key).toBe('credentials');
  });

  it('removes the key despite a busy lease', async () => {
    const h = host({ seed: { request_lock: { owner: 'other', expiresAt: NOW + 10_000 } } });
    await drive(h.client.removeKey());
    expect(h.store.has('credentials')).toBe(false);
  });

  it.each(['rate_limit', 'offline'])('key testing respects a non-auth %s pause', async (reason) => {
    const h = host({ seed: { request_budget: { attempts: [], backoffReason: reason, backoffUntil: NOW + 60_000 } } });
    await expect(h.client.testKey(KEY)).rejects.toMatchObject({ code: reason });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([200, 403])('negative-caches unknown or 403 symbols for ten minutes (HTTP %i)', async (status) => {
    fetch.mockResolvedValue(status === 403 ? response(403) : { ...response(), json: async () => ({ c: 0, t: 0 }) });
    const h = host();
    const expected = status === 403 ? 'unsupported' : 'unknown';
    expect((await h.client.getQuotes(['TYPO']))[0].error).toBe(expected);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await h.client.getQuotes(['TYPO']))[0].error).toBe(expected);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(540_000);
    await h.client.getQuotes(['TYPO']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('round 3: index, pruning and deletion', () => {
  it('prunes torn entries without aborting, writes prunedAt, and tracks new symbols', async () => {
    const h = host({ seed: {
      quote_BAD: '', quote_OLD: quote('OLD', 32 * DAY),
      quote_index: { symbols: { BAD: true, OLD: true }, prunedAt: NOW - 2 * DAY },
    } });
    await h.client.getQuotes(['AAPL']);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.store.has('quote_BAD')).toBe(false);
    expect(h.store.has('quote_OLD')).toBe(false);
    expect(JSON.parse(h.store.get('qidx'))).toMatchObject({ symbols: { AAPL: true }, prunedAt: NOW });
    expect(await h.client.deleteQuotes([])).toEqual({ deleted: 1, failed: 0 });
    expect(h.store.has('quote_AAPL')).toBe(false);
  });

  it('rebuilds a torn index with newly queried records on a host without enumeration', async () => {
    const h = host({ seed: { quote_index: '', qidx: '' } });
    await h.client.getQuotes(['MSFT']);
    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.parse(h.store.get('qidx')).symbols.MSFT).toBe(true);
    expect(await h.client.deleteQuotes([])).toEqual({ deleted: 1, failed: 0 });
  });

  it('returns results before pruning and caps a pass at 20 records', async () => {
    const symbols = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`S${i}`, true]));
    const h = host({ seed: { quote_AAPL: quote(), qidx: { symbols, prunedAt: 0 } } });
    const quotes = await h.client.getQuotes(['AAPL']);
    expect(quotes[0].price).toBe(1234.56);
    expect(h.context.invoke.mock.calls.some(([cmd, args]) => cmd === 'load_extension_data' && args.key === 'quote_S0')).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    const reads = h.context.invoke.mock.calls.filter(([cmd, args]) => cmd === 'load_extension_data' && /^quote_S/.test(args.key));
    expect(reads).toHaveLength(20);
    expect(JSON.parse(h.store.get('qidx')).prunedAt).toBeGreaterThanOrEqual(NOW);
  });

  it('merges symbols another window adds during the prune', async () => {
    const h = host({ seed: { quote_AAPL: quote(), quote_OLD: quote('OLD', 32 * DAY), qidx: { symbols: { OLD: true }, prunedAt: 0 } },
      hook(cmd, args, store) {
        if (cmd === 'load_extension_data' && args.key === 'quote_OLD') {
          store.set('qidx', JSON.stringify({ symbols: { OLD: true, NVDA: true }, prunedAt: 0 }));
        }
      },
    });
    await h.client.maintainQuotes(['AAPL']);
    expect(JSON.parse(h.store.get('qidx')).symbols).toEqual({ NVDA: true, AAPL: true });
  });

  it('Delete uses the index, skips invalid keys, and counts only records it deleted', async () => {
    const h = host({ seed: {
      quote_MSFT: quote('MSFT'), quote_TORN: '', quote_ORPHAN: quote('ORPHAN'),
      qidx: { symbols: { 'bad/path': true, MSFT: true, TORN: true, MISSING: true }, prunedAt: NOW },
    }, config: { watchlist: '' } });
    const settings = init(Settings, h);
    settings.t = vi.fn(settings.t);
    const result = await settings.runAction('delete_quotes');
    expect(settings.t).toHaveBeenCalledWith('settings.quotes_deleted', { deleted: 2, failed: 0 });
    expect(result.status).toContain('Other windows or active refreshes');
    expect(h.store.has('quote_MSFT')).toBe(false);
    expect(h.store.has('quote_TORN')).toBe(false);
    expect(h.store.has('quote_ORPHAN')).toBe(true);
    expect(await h.client.key()).toBe(KEY);
  });

  it('migrates before writing INDEX on a case-insensitive filesystem', async () => {
    const store = new Map();
    const insensitive = new Map();
    const h = host({ store, hook(cmd, args) {
      const name = args.key?.toLowerCase();
      if (cmd === 'load_extension_data') return insensitive.get(name) ?? null;
      if (cmd === 'save_extension_data') { insensitive.set(name, args.data); return null; }
      if (cmd === 'delete_extension_data') { insensitive.delete(name); return null; }
    } });
    insensitive.set('credentials', JSON.stringify({ api_key: KEY }));
    insensitive.set('quote_index', JSON.stringify({ symbols: { MSFT: true }, prunedAt: NOW }));
    insensitive.set('quote_msft', JSON.stringify(quote('MSFT')));
    await h.client.getQuotes(['INDEX']);
    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.parse(insensitive.get('qidx')).symbols).toMatchObject({ MSFT: true, INDEX: true });
    expect(JSON.parse(insensitive.get('quote_index')).quote.symbol).toBe('INDEX');
    expect(await h.client.deleteQuotes([])).toEqual({ deleted: 2, failed: 0 });
  });

  it('cached() excludes data beyond retention when no key is saved', async () => {
    const h = host({ key: null, seed: { quote_AAPL: quote('AAPL', 32 * DAY) } });
    expect(await h.client.cached('AAPL')).toBeNull();
    expect((await h.client.getQuotes(['AAPL']))[0].error).toBe('setup');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('round 3: cadence, locale, tools, and mutation guards', () => {
  it.each([60, 300])('refresh %i gives exact gaps with 7 ms IPC and 180 ms network latency', async (seconds) => {
    const started = [];
    fetch.mockImplementation(async () => {
      started.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 180));
      return response();
    });
    const h = host({ latency: 7, config: { watchlist: 'AAPL', refresh_seconds: seconds } });
    const widget = init(Widget, h);
    for (let tick = 0; tick < 4; tick++) {
      const target = NOW + tick * seconds * 1000;
      await vi.advanceTimersByTimeAsync(target - Date.now());
      await drive(widget.render(), 1500);
      expect(JSON.parse(h.store.get('quote_AAPL')).fetchedAt).toBe(target);
    }
    expect(started).toHaveLength(4);
    expect(started.slice(1).map((time, i) => time - started[i])).toEqual(Array(3).fill(seconds * 1000));
  });

  it('shows no watchlist at all after key removal, even with cached quotes', async () => {
    const h = host({ key: null, seed: { quote_AAPL: quote(), quote_MSFT: quote('MSFT') },
      config: { watchlist: 'AAPL MSFT NVDA' } });
    expect(await init(Widget, h).render()).toBeNull();
  });

  it('passes the host locale to prices, percentages, and timezone display while keeping copy invariant', async () => {
    const h = host({ language: 'de-DE', seed: { quote_AAPL: quote() }, config: { watchlist: 'AAPL' } });
    const rows = await init(Search, h).matchAsync('$AAPL');
    expect(rows[0].label).toContain('1.234,56');
    expect(rows[0].label).toContain('0\u00a0%');
    expect(rows[0].description).toContain(new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(quote().quote.timestamp * 1000)));
    expect((await init(Widget, h).render()).html).toContain('1.234,56');
    expect(copyText(quote().quote)).toBe('AAPL 1234.56 0%');
    expect(direction(quote().quote)).toBe('flat');
    expect(signedText(1.3, { percent: true, locale: 'de-DE' })).toBe('+1,3\u00a0%');
    expect(timestampText(NOW / 1000, { locale: 'ja-JP' })).toBe(new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(Math.floor(NOW / 1000) * 1000)));
  });

  it.each([['VOD.L'], ['bad/symbol'], ['AAPL', 'VOD.L', 'bad/symbol']])('get_quote without a key has a top-level setup error for %j', async (symbols) => {
    const tools = init(Tools, host({ key: null, config: { agent_tools: true } }));
    expect((await tools.execute('get_quote', { symbols })).error).toContain('free Finnhub key');
  });

  it('tool retryAt is a precise ISO millisecond conversion on a fractional clock', async () => {
    const h = host({ seed: { request_budget: { attempts: [], backoffReason: 'rate_limit', backoffUntil: NOW + 60_123 } }, config: { agent_tools: true } });
    const result = await init(Tools, h).execute('get_quote', { symbols: ['AAPL'] });
    expect(result.result[0].retryAt).toBe(new Date(NOW + 60_123).toISOString());
  });

  it('uses one ten-symbol limit and retains all translated placeholder parameters', async () => {
    expect(MAX_SYMBOLS).toBe(10);
    expect(() => parseSymbols('AA AB AC AD AE AF AG AH AI AJ AK')).toThrow('too_many');
    const h = host({ config: { agent_tools: true } });
    const controls = (await init(Settings, h).getSettings()).sections.flatMap((section) => section.controls);
    expect(controls.find((control) => control.id === 'watchlist').description).toContain('10');
    const hint = controls.find((control) => control.id === 'refresh_seconds').description;
    expect(hint).toContain('60');
    expect(hint).toContain('300');
    expect(hint).toContain('40');
    expect(init(Tools, h).getTools()[0].parameters.symbols.description).toContain('10');
    expect(init(Search, h).errorRow('', 'too_many').description).toContain('10');
    expect(controls.find((control) => control.id === 'agent_tools').description).toContain('Takes effect after you restart Kage');
  });
});
