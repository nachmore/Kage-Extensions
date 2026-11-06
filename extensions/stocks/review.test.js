import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { StocksClient, getClient } from './client.js';
import { normalizeSymbol, parseQuery } from './symbols.js';
import { copyText, priceText, signedText, timestampText } from './format.js';
import Search from './search.js';
import Settings from './settings.js';
import Tools from './tools.js';
import Widget from './widget.js';

const NOW = Date.parse('2026-11-06T16:20:40.969Z');
const GOOD = 'good-personal-key';
const BAD = 'wrong-personal-key';
const TEN = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOG', 'META', 'TSLA', 'AMD', 'IBM', 'ORCL'];
const catalog = JSON.parse(readFileSync(new URL('./_locales/en/messages.json', import.meta.url)));
const t = (key, vars = {}) => (catalog[key]?.message || key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? `{${name}}`);
const response = (status = 200) => ({
  status, ok: status === 200, headers: { get: () => null },
  json: async () => ({ c: 189.12, d: 0.43, dp: 0.2, pc: 188.69, o: 188, h: 190, l: 187, t: Math.floor(Date.now() / 1000) }),
});

function host({ key = GOOD, config = {}, seed = {}, store, latency = 0, cap = 100, reject } = {}) {
  store ||= new Map(Object.entries(seed).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]));
  if (key && !store.has('credentials')) store.set('credentials', JSON.stringify({ api_key: key }));
  const times = [];
  const stats = { calls: 0, rejected: 0, peak: 0, writes: [] };
  const invoke = vi.fn(async (command, args) => {
    stats.calls++;
    const now = Date.now();
    while (times.length && times[0] <= now - 1000) times.shift();
    if (times.length >= cap || reject?.(command, args)) {
      stats.rejected++;
      throw new Error('invoke rate limit exceeded (max 100/s)');
    }
    times.push(now);
    stats.peak = Math.max(stats.peak, times.length);
    if (latency) await new Promise((resolve) => setTimeout(resolve, latency));
    if (command === 'load_extension_data') return store.get(args.key) ?? null;
    if (command === 'save_extension_data') {
      stats.writes.push(args.key);
      store.set(args.key, args.data);
    } else if (command === 'delete_extension_data') store.delete(args.key);
    else if (command !== 'open_url') throw new Error(`Unexpected command: ${command}`);
    return null;
  });
  const context = { invoke, config, i18n: { t } };
  return { context, store, stats, invoke, times, client: getClient(context) };
}

function init(Class, h) {
  const instance = new Class();
  instance.initialize(h.context);
  return instance;
}

async function drive(promise, milliseconds = 1000) {
  const outcome = promise.then((value) => ({ value }), (error) => ({ error }));
  await vi.advanceTimersByTimeAsync(milliseconds);
  const result = await outcome;
  if (result.error) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async () => response()));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('review regressions: launcher and UI', () => {
  it.each([
    '$500 budget laptop recommendations', 'Stock split explained?', '$PATH is not set on my mac',
    '$NVDA why is it up', '$AAPL vs $MSFT which is better', '$', '$100', 'stock market news today',
    'stock invalid! invalid! invalid! invalid!',
  ])('leaves the agent prompt %s alone', async (query) => {
    expect(parseQuery(query)).toBeNull();
    const search = init(Search, host());
    expect(search.match(query)).toEqual([]);
    expect(await search.matchAsync(query)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['$AAPL', 'stock aapl msft nvda googl amzn meta tsla'])('settles prefix typing into one batch: %s', async (text) => {
    const h = host();
    const search = init(Search, h);
    const promises = [];
    for (let i = 1; i <= text.length; i++) {
      search.match(text.slice(0, i));
      promises.push(search.matchAsync(text.slice(0, i)));
      await vi.advanceTimersByTimeAsync(180);
    }
    const rows = await drive(Promise.all(promises), 1500);
    expect(rows.slice(0, -1).every((row) => row.length === 0)).toBe(true);
    const symbols = fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('symbol'));
    expect(symbols).toEqual(text === '$AAPL' ? ['AAPL'] : ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA']);
    expect(JSON.parse(h.store.get('request_budget')).attempts).toHaveLength(symbols.length);
  });

  it('supersedes an in-flight lookup when the next query belongs to the agent', async () => {
    fetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return response();
    });
    const search = init(Search, host());
    const old = search.matchAsync('$AAPL');
    await vi.advanceTimersByTimeAsync(400);
    search.match('$AAPL why is it up');
    expect(await drive(old)).toEqual([]);
  });

  it('opens the chart on pending Enter and fetches before copying a pending quote', async () => {
    const h = host();
    const search = init(Search, h);
    const placeholder = search.match('$AAPL')[0];
    expect(placeholder.data).toEqual({ pending: true, symbols: ['AAPL'], copy: false });
    expect(await search.execute(placeholder)).toMatchObject({ type: 'custom' });
    expect(h.invoke).toHaveBeenCalledWith('open_url', { url: 'https://www.tradingview.com/chart/?symbol=AAPL' });
    const copy = await drive(search.execute(search.match('stock copy AAPL')[0]));
    expect(copy).toEqual({ type: 'copy', value: 'AAPL 189.12 +0.2%' });
    expect(await search.execute(search.match('stock')[0])).toEqual({ type: 'open_extension_settings' });
  });

  it.each(['unknown', 'invalid_symbols', 'too_many', 'rate_limit', 'offline', 'busy', 'unsupported', 'timeout'])('does not route %s errors to settings', async (code) => {
    const search = init(Search, host());
    expect(await search.execute(search.errorRow('AAPL', code))).toBeNull();
  });
  it.each(['setup', 'auth', 'cache_only', 'storage'])('routes actionable %s errors to settings', async (code) => {
    const search = init(Search, host());
    expect(await search.execute(search.errorRow('AAPL', code))).toEqual({ type: 'open_extension_settings' });
  });

  it('uses a compact first-run widget hint and validates stable symbol actions against current config', async () => {
    const h = host({ key: null });
    const widget = init(Widget, h);
    const output = await drive(widget.render());
    expect(output.html).toContain('Type stock and press Enter');
    expect(output.html.match(/Type stock/g)).toHaveLength(1);
    expect(output.html).not.toContain('AAPL');
    expect(fetch).not.toHaveBeenCalled();
    await h.client.saveKey(GOOD);
    const connected = await drive(widget.render());
    expect(connected.actions[0]).toEqual({ id: 'chart:AAPL', rpc: 'chart:AAPL' });
    widget.onConfigUpdate({ watchlist: 'MSFT' });
    const before = h.invoke.mock.calls.length;
    await widget.onAction('chart:AAPL');
    await widget.onAction('chart:MSFT?token=bad');
    expect(h.invoke).toHaveBeenCalledTimes(before);
    await widget.onAction('chart:MSFT');
    expect(h.invoke).toHaveBeenLastCalledWith('open_url', { url: 'https://www.tradingview.com/chart/?symbol=MSFT' });
  });

  it('refreshes on every exact interval tick with fractional clocks and picks up interval changes', async () => {
    const h = host({ config: { watchlist: 'AAPL', refresh_seconds: 300 } });
    fetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return response();
    });
    const widget = init(Widget, h);
    expect(widget.getRefreshInterval()).toBe(60_000);
    await drive(widget.render(), 150);
    expect(JSON.parse(h.store.get('quote_AAPL')).fetchedAt).toBe(NOW);
    for (let tick = 1; tick <= 3; tick++) {
      vi.setSystemTime(NOW + tick * 300_000);
      await drive(widget.render(), 150);
      expect(fetch).toHaveBeenCalledTimes(tick + 1);
    }
    widget.onConfigUpdate({ watchlist: 'AAPL', refresh_seconds: 60 });
    vi.setSystemTime(NOW + 960_000);
    await drive(widget.render(), 150);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

describe('review regressions: storage, budgets and keys', () => {
  it('reads the key once, reserves all ten requests once, and stays under the host cap', async () => {
    const h = host({ config: { watchlist: TEN.join(' ') }, latency: 2 });
    const widget = init(Widget, h);
    const output = await drive(widget.render());
    expect(output.actions).toHaveLength(10);
    expect(h.stats.rejected).toBe(0);
    expect(h.stats.calls).toBeLessThanOrEqual(40);
    expect(h.invoke.mock.calls.filter(([cmd, args]) => cmd === 'load_extension_data' && args.key === 'credentials')).toHaveLength(1);
    expect(h.stats.writes.filter((key) => key === 'request_budget')).toHaveLength(1);
    expect(JSON.parse(h.store.get('request_budget')).attempts).toHaveLength(10);
    expect(TEN.every((symbol) => JSON.parse(h.store.get(`quote_${symbol}`)).samples.length === 1)).toBe(true);
    const cached = await drive(widget.render());
    expect(cached.actions).toHaveLength(10);
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it('retries invoke cap rejections without misreading credentials as missing', async () => {
    const h = host();
    h.times.push(...Array(100).fill(Date.now()));
    expect(await drive(h.client.key(), 1200)).toBe(GOOD);
    expect(h.stats.rejected).toBe(1);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['', '{torn', 'null', '{"attempts":"broken"}'])('does not overwrite an unreadable budget %j', async (record) => {
    const h = host({ seed: { request_budget: record } });
    const quotes = await drive(h.client.getQuotes(['AAPL']));
    expect(quotes[0].error).toBe('storage');
    expect(h.store.get('request_budget')).toBe(record);
    expect(h.stats.writes).not.toContain('request_budget');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed during backoff and keeps its local pause when the shared read fails', async () => {
    const h = host({ seed: { request_budget: '{torn' } });
    await expect(h.client.backoff({ code: 'offline' })).rejects.toMatchObject({ code: 'storage' });
    expect(h.store.get('request_budget')).toBe('{torn');
    expect(h.client.localBackoff).toBeGreaterThan(NOW);
  });

  it('keeps an existing cache intact when its previous-entry read fails', async () => {
    const prior = '{"quote":{"symbol":"AAPL","price":99},"fetchedAt":0,"samples":[{"price":99,"timestamp":1}]}';
    const h = host({ seed: { quote_AAPL: prior } });
    const original = h.invoke.getMockImplementation();
    let failed = false;
    h.invoke.mockImplementation(async (command, args) => {
      if (!failed && command === 'load_extension_data' && args.key === 'quote_AAPL') {
        failed = true;
        throw new Error('torn read');
      }
      return original(command, args);
    });
    // Prevent maintenance from deleting this intentionally ancient fixture.
    h.store.set('quote_index', JSON.stringify({ symbols: { AAPL: true }, prunedAt: NOW }));
    expect((await drive(h.client.getQuotes(['AAPL'])))[0].price).toBe(189.12);
    expect(h.store.get('quote_AAPL')).toBe(prior);
    expect(h.stats.writes).not.toContain('quote_AAPL');
  });

  it('coordinates concurrent windows with retries and records both batches', async () => {
    const a = host({ latency: 2 });
    const b = host({ store: a.store, latency: 2 });
    const first = a.client.getQuotes(TEN.slice(0, 5));
    await vi.advanceTimersByTimeAsync(10);
    const second = b.client.getQuotes(TEN.slice(5));
    const results = await drive(Promise.all([first, second]), 1500);
    expect(results.flat().every((quote) => !quote.error)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(JSON.parse(a.store.get('request_budget')).attempts).toHaveLength(10);
    expect(a.stats.rejected + b.stats.rejected).toBe(0);
  });

  it('retries contention three times and reports the lease expiry if still busy', async () => {
    const h = host({ seed: { request_lock: { owner: 'other', expiresAt: NOW + 10_000 } } });
    const output = await drive(h.client.getQuotes(['AAPL']), 1500);
    expect(output[0]).toMatchObject({ error: 'busy', retryAt: NOW + 10_000 });
    expect(h.invoke.mock.calls.filter(([cmd, args]) => cmd === 'load_extension_data' && args.key === 'request_lock')).toHaveLength(4);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('increments backoff once per batch episode and decays after twice its maximum', async () => {
    const h = host();
    fetch.mockResolvedValue(response(429));
    expect((await drive(h.client.getQuotes(TEN))).every((q) => q.error === 'rate_limit')).toBe(true);
    const first = JSON.parse(h.store.get('request_budget'));
    expect(first).toMatchObject({ streak: 1, backoffUntil: NOW + 60_000, lastFailureAt: NOW });
    vi.setSystemTime(first.backoffUntil);
    await drive(h.client.getQuotes(TEN));
    const second = JSON.parse(h.store.get('request_budget'));
    expect(second.streak).toBe(2);
    expect(second.backoffUntil).toBe(first.backoffUntil + 120_000);
    vi.setSystemTime(second.lastFailureAt + 30 * 60_000);
    await drive(h.client.getQuotes(['AAPL']));
    expect(JSON.parse(h.store.get('request_budget')).streak).toBe(1);
  });

  it('tests typo then correction immediately, bypasses stale auth, and rotates scratch IDs after each save', async () => {
    const h = host({ key: null });
    fetch.mockImplementation(async (url) => response(new URL(url).searchParams.get('token') === GOOD ? 200 : 401));
    const settings = init(Settings, h);
    const controls = async () => (await settings.getSettings()).sections.flatMap((section) => section.controls);
    expect((await settings.runAction('test_key', { __api_key: BAD })).status).toContain('rejected');
    expect(JSON.parse(h.store.get('request_budget')).backoffReason).toBeUndefined();
    await h.client.backoff({ code: 'auth' });
    expect((await settings.runAction('test_key', { __api_key: GOOD })).status).toContain('key saved');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await h.client.key()).toBe(GOOD);
    expect(h.client.localBackoff).toBe(0);
    expect(JSON.parse(h.store.get('request_budget')).backoffUntil).toBe(0);
    const replacement = (await controls()).find((control) => control.id?.startsWith('__replacement_key'));
    expect(replacement.default).toBe('');
    expect(replacement.id).not.toBe('__api_key');
    expect((await settings.runAction('test_key', { [replacement.id]: GOOD })).status).toContain('key saved');
    expect((await controls()).find((control) => control.id?.startsWith('__replacement_key')).id).not.toBe(replacement.id);
    expect(JSON.stringify(await settings.getSettings())).not.toContain(GOOD);
  });

  it('testing a bad replacement leaves the saved key usable in a different window', async () => {
    const h = host();
    const other = host({ store: h.store });
    fetch.mockImplementation(async (url) => response(new URL(url).searchParams.get('token') === GOOD ? 200 : 401));
    const settings = init(Settings, h);
    await settings.getSettings();
    expect((await settings.runAction('test_key', { [settings.scratchId]: BAD })).status).toContain('rejected');
    const quotes = await drive(other.client.getQuotes(['MSFT']));
    expect(quotes[0]).toMatchObject({ price: 189.12, cached: false });
    expect(await h.client.key()).toBe(GOOD);
    expect(JSON.parse(h.store.get('request_budget')).backoffReason).toBeUndefined();
  });

  it('clears stale local auth in another window after saving a new key', async () => {
    const h = host({ key: BAD });
    const settingsWindow = host({ store: h.store });
    fetch.mockImplementation(async (url) => response(new URL(url).searchParams.get('token') === GOOD ? 200 : 401));
    await drive(h.client.getQuotes(['AAPL']));
    expect(h.client.localBackoffReason).toBe('auth');
    await drive(settingsWindow.client.saveKey(GOOD));
    expect((await drive(h.client.getQuotes(['MSFT'])))[0]).toMatchObject({ price: 189.12 });
    expect(h.client.localBackoff).toBe(0);
    await h.client.backoff({ code: 'auth' });
    await h.client.removeKey();
    expect(h.client.localBackoff).toBe(0);
    expect(JSON.parse(h.store.get('request_budget')).backoffUntil).toBe(0);
  });

  it('uses a short local timeout pause and never attaches a past retry time to unknown symbols', async () => {
    const h = host();
    fetch.mockImplementation(async (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const result = await drive(h.client.getQuotes(['AAPL']), 2300);
    expect(result[0]).toMatchObject({ error: 'timeout', retryAt: NOW + 5200 });
    expect(JSON.parse(h.store.get('request_budget')).streak).toBeUndefined();
    vi.setSystemTime(NOW + 6000);
    fetch.mockResolvedValue({ ...response(), json: async () => ({ c: 0, t: 0 }) });
    expect((await drive(h.client.getQuotes(['ZZZZ'])))[0]).toMatchObject({ error: 'unknown', retryAt: null });
  });

  it('prunes unused quotes periodically and deletes all tracked quotes while keeping credentials', async () => {
    const recent = { quote: { symbol: 'AAPL', price: 100, timestamp: Math.floor(NOW / 1000) }, fetchedAt: NOW,
      samples: [{ timestamp: NOW / 1000 - 32 * 86_400, price: 1 }, { timestamp: NOW / 1000, price: 100 }] };
    const old = { ...recent, quote: { ...recent.quote, symbol: 'OLD' }, fetchedAt: NOW - 32 * 86_400_000 };
    const h = host({ seed: { quote_AAPL: recent, quote_OLD: old, quote_index: { symbols: { AAPL: true, OLD: true }, prunedAt: NOW - 86_400_000 } } });
    await drive(h.client.getQuotes(['MSFT']));
    expect(h.store.has('quote_OLD')).toBe(false);
    expect(JSON.parse(h.store.get('quote_AAPL')).samples).toHaveLength(1);
    const settings = init(Settings, h);
    expect((await settings.runAction('delete_quotes')).status).toContain('deleted');
    expect([...h.store.keys()].filter((key) => /^quote_(?!index)/.test(key))).toEqual([]);
    expect(await h.client.key()).toBe(GOOD);
  });
});

describe('review regressions: symbols, formatting and tools', () => {
  it.each(['ENI.MI', 'SAN.MC', 'EQNR.OL', 'BMW.F', 'PETR4.SA', 'D05.SI', '7203.T', 'NOVO-B.CO', 'VOD.L'])('rejects foreign %s with the correct code', (symbol) => {
    expect(() => normalizeSymbol(symbol)).toThrow('unsupported');
  });

  it('keeps US share classes, isolates bad symbols, and deduplicates before the cap', async () => {
    expect(normalizeSymbol('BRK.B')).toBe('BRK.B');
    expect(normalizeSymbol('BF.B')).toBe('BF.B');
    const h = host();
    const quotes = await drive(h.client.getQuotes(['AAPL', 'SAP.DE', 'bad/symbol', ...Array(11).fill('AAPL.US')]));
    expect(quotes).toHaveLength(3);
    expect(quotes[0].price).toBe(189.12);
    expect(quotes[1]).toMatchObject({ symbol: 'SAP.DE', error: 'unsupported' });
    expect(quotes[2]).toMatchObject({ error: 'invalid_symbols' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const search = init(Search, h);
    const rows = await drive(search.matchAsync('$AAPL $VOD.L'));
    expect(rows.some((row) => row.data.quote?.symbol === 'AAPL')).toBe(true);
    expect(rows.some((row) => row.data.code === 'unsupported')).toBe(true);
  });

  it('treats 403 as a per-symbol plan failure with no shared backoff', async () => {
    const h = host();
    fetch.mockImplementation(async (url) => response(new URL(url).searchParams.get('symbol') === 'IBM' ? 403 : 200));
    const quotes = await drive(h.client.getQuotes(['IBM', 'AAPL']));
    expect(quotes[0]).toMatchObject({ error: 'unsupported', retryAt: null });
    expect(quotes[1]).toMatchObject({ price: 189.12 });
    expect(JSON.parse(h.store.get('request_budget')).backoffReason).toBeUndefined();
    expect((await drive(h.client.getQuotes(['MSFT'])))[0].price).toBe(189.12);
  });

  it('formats whole-second times, price-precision changes and rounded zero without changing clipboard locale', () => {
    expect(timestampText(NOW / 1000)).toBe('2026-11-06 16:20:40 UTC');
    expect(signedText(0.43, { price: 189.12 })).toBe('+0.43');
    expect(signedText(-0.001, { percent: true })).toBe('0%');
    expect(signedText(0.001, { percent: true })).toBe('0%');
    expect(signedText(-0.001, { price: 100 })).toBe('0.00');
    expect(priceText(1234.56, { locale: 'de-DE' })).toBe('1.234,56');
    expect(copyText({ symbol: 'AAPL', price: 1234.56, percent: -0.001 })).toBe('AAPL 1234.56 0%');
  });

  it('makes agent sharing opt-in and returns actionable setup errors with ISO times and OHLC', async () => {
    const h = host({ key: null });
    const tools = init(Tools, h);
    expect(tools.getTools()).toEqual([]);
    expect((await tools.execute('get_quote', { symbols: ['AAPL'] })).error).toContain('Enable');
    expect(h.stats.calls).toBe(0);
    tools.onConfigUpdate({ agent_tools: true });
    const setup = await drive(tools.execute('get_quote', { symbols: ['AAPL', 'MSFT'] }));
    expect(setup.error).toContain('free Finnhub key');
    expect(setup.result.every((quote) => quote.message.includes('free Finnhub key'))).toBe(true);
    await h.client.saveKey(GOOD);
    const mixed = await drive(tools.execute('get_quote', { symbols: ['AAPL', 'SAP.DE'] }));
    expect(mixed.error).toBeUndefined();
    expect(mixed.result[0]).toMatchObject({ open: 188, high: 190, low: 187 });
    expect(mixed.result[0].tradeTime).toMatch(/Z$/);
    expect(mixed.result[0].fetchedAt).toMatch(/Z$/);
    expect(mixed.result[0].timestamp).toBeUndefined();
    expect(mixed.result[1].message).toContain('US tickers');
    const history = (await tools.execute('get_history', { symbol: 'AAPL' })).result;
    expect(history.samples[0].timestamp).toMatch(/Z$/);
    expect(history.fetchedAt).toMatch(/Z$/);
    expect(JSON.stringify(mixed)).not.toContain(GOOD);
  });
});
