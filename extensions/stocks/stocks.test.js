import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeContext } from '../../test-helpers/mock-context.mjs';
import { DEFAULTS, refreshSeconds } from './defaults.js';
import { chartUrl, normalizeSymbol, parseQuery, parseSymbols } from './symbols.js';
import { fetchQuote, parseFinnhubQuote, validKey } from './client.js';
import { CREDENTIALS_KEY, StocksClient, getClient } from './client.js';
import { copyText, direction, escapeHtml, priceText, quoteDescription, signedText, sparkline, timestampText } from './format.js';
import Search from './search.js';
import Settings from './settings.js';
import Tools from './tools.js';
import Widget from './widget.js';

const catalog = JSON.parse(readFileSync(new URL('./_locales/en/messages.json', import.meta.url), 'utf8'));
const TEST_KEY = 'example-test-key';
const NOW = Date.parse('2026-11-06T16:00:00.417Z');
const body = (extra = {}) => ({ c: 189.12, pc: 186.69, t: NOW / 1000, ...extra });
const jsonResponse = (data = body(), status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status, headers: new Headers(headers),
  json: vi.fn(async () => data),
});

function fixture({ config = {}, key = TEST_KEY, seed = {} } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  if (key) store.set(CREDENTIALS_KEY, JSON.stringify({ api_key: key }));
  const mock = makeContext({
    catalog, config: { agent_tools: true, ...config },
    invokes: {
      load_extension_data: ({ key }) => store.get(key) || null,
      save_extension_data: ({ key, data }) => { store.set(key, data); },
      delete_extension_data: ({ key }) => { store.delete(key); },
      open_url: () => {},
    },
  });
  return { ...mock, store, client: getClient(mock.context) };
}

function init(Class, f) {
  const provider = new Class();
  provider.initialize(f.context);
  return provider;
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  // Every test gets an explicit network stub. Unexpected fetches fail.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request in test'); }));
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('symbols and launcher queries', () => {
  it.each([
    ['$aapl', ['AAPL']], ['stock msft', ['MSFT']], ['stock aapl msft nvda', ['AAPL', 'MSFT', 'NVDA']],
    ['$aapl $msft', ['AAPL', 'MSFT']], ['STOCK AAPL,MSFT,AAPL.US', ['AAPL', 'MSFT']],
    ['stock BRK.B BF-B', ['BRK.B', 'BF-B']], ['stock', []],
  ])('parses %s', (query, symbols) => {
    expect(parseQuery(query).symbols).toEqual(symbols);
  });
  it.each(['stocks aapl', 'stockholm', 'AAPL', 'the stock aapl', 'weather msft'])('ignores %s', (query) => {
    expect(parseQuery(query)).toBeNull();
  });
  it('recognizes the explicit copy query and normalizes US aliases', () => {
    expect(parseQuery('stock copy aapl')).toEqual({ symbols: ['AAPL'], copy: true });
    expect(normalizeSymbol(' $aapl.us ')).toBe('AAPL');
  });
  it.each(['VOD.L', 'SHOP.TO', '7203.JP'])('rejects international suffix %s explicitly', (symbol) => {
    expect(() => normalizeSymbol(symbol)).toThrow('unsupported');
  });
  it.each(['AAPL/../../', 'AAPL?token=bad', '<script>', '', null, 12])('rejects unsafe or invalid input %s', (symbol) => {
    expect(() => normalizeSymbol(symbol)).toThrow('invalid_symbols');
  });
  it('limits query, tools and watchlist sizes before any request', () => {
    expect(parseSymbols(Array(11).fill('AAPL'))).toEqual(['AAPL']);
    expect(() => parseSymbols(['AAPL', 'MSFT', 'NVDA', 'GOOG', 'META', 'AMD', 'IBM', 'INTC', 'TSLA', 'AMZN', 'ORCL'])).toThrow('too_many');
    expect(() => parseSymbols({})).toThrow('invalid_symbols');
    expect(parseSymbols('', { allowEmpty: true })).toEqual([]);
  });
});

describe('Finnhub parsing and transport', () => {
  it('derives absolute and percentage change from previous close', () => {
    const quote = parseFinnhubQuote(body(), 'AAPL');
    expect(quote).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD', source: 'Finnhub' });
    expect(quote.change).toBeCloseTo(2.43);
    expect(quote.percent).toBeCloseTo(1.3016);
  });
  it('preserves provider day change, zero change and nullable missing change', () => {
    expect(parseFinnhubQuote(body({ d: -3, dp: -2 }), 'MSFT')).toMatchObject({ change: -3, percent: -2 });
    expect(parseFinnhubQuote(body({ d: 0, dp: 0 }), 'MSFT')).toMatchObject({ change: 0, percent: 0 });
    expect(parseFinnhubQuote(body({ pc: 0 }), 'MSFT')).toMatchObject({ change: null, percent: null });
  });
  it.each([{}, { c: 0, t: NOW / 1000 }, { c: 'NaN', t: 1 }, { c: 1, t: 0 }, { c: null, t: 1 }, { c: 1, t: 1e99 }])('does not invent quotes from %j', (data) => {
    expect(() => parseFinnhubQuote(data, 'MSFT')).toThrow('unknown');
  });
  it('uses only the exact HTTPS API host and never forwards redirects or cookies', async () => {
    fetch.mockResolvedValue(jsonResponse());
    await fetchQuote('AAPL.US', TEST_KEY);
    const [url, options] = fetch.mock.calls[0];
    expect(new URL(url).origin).toBe('https://finnhub.io');
    expect(new URL(url).pathname).toBe('/api/v1/quote');
    expect(new URL(url).searchParams.get('symbol')).toBe('AAPL');
    expect(new URL(url).searchParams.get('token')).toBe(TEST_KEY);
    expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    expect(options.headers).toEqual({ Accept: 'application/json' });
  });
  it.each([[401, 'auth'], [403, 'unsupported'], [429, 'rate_limit'], [500, 'unavailable']])('classifies HTTP %i without leaking error bodies', async (status, code) => {
    const response = jsonResponse({ error: TEST_KEY }, status, {});
    fetch.mockResolvedValue(response);
    await expect(fetchQuote('AAPL', TEST_KEY)).rejects.toMatchObject({ code });
    expect(response.json).not.toHaveBeenCalled();
  });
  it('sanitizes transport, JSON, and provider errors', async () => {
    fetch.mockRejectedValueOnce(new Error(TEST_KEY));
    await expect(fetchQuote('AAPL', TEST_KEY)).rejects.toThrow('offline');
    fetch.mockResolvedValueOnce({ ...jsonResponse(), json: async () => { throw new Error(TEST_KEY); } });
    await expect(fetchQuote('AAPL', TEST_KEY)).rejects.toThrow('unavailable');
    fetch.mockResolvedValueOnce(jsonResponse({ error: TEST_KEY }));
    await expect(fetchQuote('AAPL', TEST_KEY)).rejects.toThrow('unavailable');
  });
  it('validates keys', () => {
    expect(validKey(TEST_KEY)).toBe(true);
    expect(validKey('https://example.com/key')).toBe(false);
    expect(validKey('')).toBe(false);

  });
});

describe('formatting and display safety', () => {
  it('formats copy output, changes, penny quotes, and missing values', () => {
    expect(copyText({ symbol: 'AAPL', price: 189.12, percent: 1.3 })).toBe('AAPL 189.12 +1.3%');
    expect(signedText(-1.25)).toBe('-1.25');
    expect(signedText(0, { percent: true })).toBe('0%');
    expect(signedText(10, { percent: true })).toBe('+10%');
    expect(priceText(0.00123)).toBe('0.0012');
    expect(priceText(null)).toBe('—');
    expect(signedText(null)).toBe('—');
    expect(timestampText(1e99)).toBe('—');
    expect(direction({ change: -1 })).toBe('down');
    expect(direction({ change: 1 })).toBe('up');
    expect(direction({ change: null })).toBe('flat');
  });
  it('shows source, last trade, delayed/closed-market freshness, cache and retry times', () => {
    const f = fixture();
    const quote = { ...parseFinnhubQuote(body({ t: NOW / 1000 - 86_400 }), 'AAPL'), cached: true, fetchedAt: NOW - 60_000, reason: 'rate_limit', retryAt: NOW + 60_000 };
    const text = quoteDescription(quote, f.context.i18n.t);
    expect(text).toContain('Finnhub');
    expect(text).toContain(timestampText(quote.timestamp));
    expect(text).toContain('Data delayed / market may be closed');
    expect(text).toContain('Cached ' + timestampText(quote.fetchedAt / 1000));
    expect(text).toContain('Retry after ' + timestampText(quote.retryAt / 1000));
  });
  it('escapes untrusted text and draws honest sparse and flat sparklines', () => {
    expect(escapeHtml('<img onerror="x">&')).toBe('&lt;img onerror=&quot;x&quot;&gt;&amp;');
    expect(sparkline([{ price: 1 }], 'sampled')).toBe('');
    const flat = sparkline([{ price: 1 }, { price: 1 }], '<sample>');
    expect(flat).toContain('0.0,11.0 72.0,11.0');
    expect(flat).toContain('&lt;sample&gt;');
    expect(flat).not.toContain('NaN');
  });
});

describe('cache, budgets, backoff and concurrent windows', () => {
  it('persists quotes and reuses them across different instances without fetching', async () => {
    const f = fixture();
    fetch.mockResolvedValue(jsonResponse());
    const first = await f.client.getQuote('AAPL');
    expect(first.cached).toBe(false);
    const sibling = new StocksClient(f.context);
    const second = await sibling.getQuote('AAPL');
    expect(second).toMatchObject({ cached: true, stale: false, timestamp: NOW / 1000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.store.has('quote_AAPL')).toBe(true);
    expect(JSON.stringify(second)).not.toContain(TEST_KEY);
  });
  it('single-flights identical simultaneous requests and shares provider clients', async () => {
    const f = fixture();
    fetch.mockResolvedValue(jsonResponse());
    const quotes = await Promise.all([f.client.getQuote('AAPL'), f.client.getQuote('AAPL')]);
    expect(quotes[0]).toEqual(quotes[1]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getClient(f.context)).toBe(getClient(f.context));
  });
  it('returns timestamped old data offline', async () => {
    const f = fixture();
    fetch.mockResolvedValueOnce(jsonResponse());
    await f.client.getQuote('AAPL');
    Date.now.mockReturnValue(NOW + 600_000);
    navigator.onLine = false;
    const old = await f.client.getQuote('AAPL');
    expect(old).toMatchObject({ cached: true, stale: true, reason: 'offline', fetchedAt: NOW });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(quoteDescription(old, f.context.i18n.t)).toContain(`As of ${timestampText(old.timestamp)}`);
    expect(quoteDescription(old, f.context.i18n.t)).toContain(`Cached ${timestampText(NOW / 1000)}`);
  });
  it.each([[500, 'unavailable'], [401, 'auth'], [403, 'unsupported']])('retains timestamped cached quotes after HTTP %i errors', async (status, reason) => {
    const f = fixture();
    fetch.mockResolvedValueOnce(jsonResponse());
    await f.client.getQuote('AAPL');
    Date.now.mockReturnValue(NOW + 600_000);
    fetch.mockResolvedValueOnce(jsonResponse({}, status));
    const saved = await f.client.getQuote('AAPL');
    expect(saved).toMatchObject({ cached: true, stale: true, reason, timestamp: NOW / 1000, fetchedAt: NOW });
    const description = quoteDescription(saved, f.context.i18n.t);
    expect(description).toContain(`As of ${timestampText(saved.timestamp)}`);
    expect(description).toContain(`Cached ${timestampText(NOW / 1000)}`);
  });
  it('backs off 429 responses across windows and shows cached values', async () => {
    const f = fixture();
    fetch.mockResolvedValueOnce(jsonResponse());
    await f.client.getQuote('AAPL');
    Date.now.mockReturnValue(NOW + 600_000);
    fetch.mockResolvedValueOnce(jsonResponse({}, 429, {}));
    const old = await f.client.getQuote('AAPL');
    expect(old).toMatchObject({ stale: true, reason: 'rate_limit', fetchedAt: NOW, retryAt: NOW + 660_000 });
    expect(quoteDescription(old, f.context.i18n.t)).toContain(`As of ${timestampText(old.timestamp)}`);
    const sibling = new StocksClient(f.context);
    Date.now.mockReturnValue(NOW + 600_251);
    await expect(sibling.getQuote('MSFT')).rejects.toMatchObject({ code: 'rate_limit', retryAt: NOW + 660_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('enforces a shared 40-request minute budget and then recovers', async () => {
    const f = fixture();
    fetch.mockResolvedValue(jsonResponse());
    for (let i = 0; i < 40; i++) {
      Date.now.mockReturnValue(NOW + (i >= 20 ? 1000 : 0));
      await f.client.testKey(TEST_KEY);
    }
    const sibling = new StocksClient(f.context);
    Date.now.mockReturnValue(NOW + 1251);
    await expect(sibling.testKey(TEST_KEY)).rejects.toMatchObject({ code: 'rate_limit', retryAt: NOW + 60_000 });
    expect(fetch).toHaveBeenCalledTimes(40);
    Date.now.mockReturnValue(NOW + 60_001);
    await sibling.testKey(TEST_KEY);
    expect(fetch).toHaveBeenCalledTimes(41);
  }, 15000);
  it('caps request bursts below the provider global 30/second ceiling', async () => {
    const f = fixture();
    fetch.mockResolvedValue(jsonResponse());
    for (let i = 0; i < 20; i++) await f.client.testKey(TEST_KEY);
    await expect(f.client.testKey(TEST_KEY)).rejects.toMatchObject({ code: 'rate_limit', retryAt: NOW + 1000 });
    expect(fetch).toHaveBeenCalledTimes(20);
    Date.now.mockReturnValue(NOW + 1000);
    await f.client.testKey(TEST_KEY);
    expect(fetch).toHaveBeenCalledTimes(21);
  });
  it('increases consecutive provider backoff and resets the streak after recovery', async () => {
    const f = fixture();
    fetch.mockResolvedValue(jsonResponse({}, 429));
    await expect(f.client.getQuote('AAPL')).rejects.toThrow('rate_limit');
    expect(JSON.parse(f.store.get('request_budget')).backoffUntil).toBe(NOW + 60_000);
    Date.now.mockReturnValue(NOW + 60_001);
    await expect(f.client.getQuote('AAPL')).rejects.toThrow('rate_limit');
    expect(JSON.parse(f.store.get('request_budget')).backoffUntil).toBe(NOW + 180_001);
    Date.now.mockReturnValue(NOW + 180_002);
    fetch.mockResolvedValue(jsonResponse());
    await f.client.getQuote('AAPL');
    expect(JSON.parse(f.store.get('request_budget')).streak).toBe(0);
  });
  it('aborts slow network requests within the widget render budget and caches the failure backoff', async () => {
    const f = fixture();
    vi.useFakeTimers();
    fetch.mockImplementation((url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    const request = f.client.getQuotes(['AAPL']);
    await vi.advanceTimersByTimeAsync(2201);
    expect((await request)[0]).toMatchObject({ error: 'timeout', retryAt: NOW + 5200 });
    expect(JSON.parse(f.store.get('request_budget')).backoffReason).toBeUndefined();
  });
  it('preserves per-symbol failures in a mixed multi-symbol request', async () => {
    const f = fixture();
    fetch.mockImplementation(async (url) => {
      const symbol = new URL(url).searchParams.get('symbol');
      return symbol === 'AAPL' ? jsonResponse() : jsonResponse({ error: 'busy' }, 500);
    });
    const result = await f.client.getQuotes(['AAPL', 'MSFT']);
    expect(result[0]).toMatchObject({ symbol: 'AAPL', price: 189.12 });
    expect(result[1]).toMatchObject({ symbol: 'MSFT', error: 'unavailable' });
  });
  it('retains bounded samples and prunes data older than 31 days when saving', async () => {
    const samples = [
      { timestamp: NOW / 1000 - 32 * 86_400, price: 100 },
      ...Array.from({ length: 600 }, (_, index) => ({ timestamp: NOW / 1000 - 1000 + index, price: 100 + index })),
    ];
    const f = fixture({ seed: { quote_AAPL: { quote: parseFinnhubQuote(body(), 'AAPL'), fetchedAt: NOW - 600_000, samples } } });
    fetch.mockResolvedValue(jsonResponse());
    await f.client.getQuote('AAPL');
    const stored = JSON.parse(f.store.get('quote_AAPL'));
    expect(stored.samples).toHaveLength(512);
    expect(stored.samples[0].timestamp).toBeGreaterThan(NOW / 1000 - 31 * 86_400);
    expect(stored.samples.at(-1)).toEqual({ timestamp: NOW / 1000, price: 189.12 });
  });
  it('does not request without keys and reads changed credentials through shared storage', async () => {
    const f = fixture({ key: null });
    await expect(f.client.getQuote('AAPL')).rejects.toThrow('setup');
    expect(fetch).not.toHaveBeenCalled();
    await f.client.saveKey(TEST_KEY);
    fetch.mockResolvedValue(jsonResponse());
    expect((await f.client.getQuote('AAPL')).price).toBe(189.12);
    await f.client.removeKey();
    expect((await f.client.getQuote('AAPL')).reason).toBe('setup');
    expect(await f.client.key()).toBeNull();
  });
  it('does not use a corrupt cache, and fails closed on budget write errors', async () => {
    const f = fixture({ seed: { quote_AAPL: { quote: { symbol: 'AAPL', price: 0 }, fetchedAt: NOW } } });
    f.invoke.mockImplementation(async (command, args) => {
      if (command === 'load_extension_data') return f.store.get(args.key) || null;
      throw new Error('Disk unavailable');
    });
    await expect(f.client.getQuote('AAPL')).rejects.toThrow('storage');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('respects another window lock and recovers its expired lease', async () => {
    const f = fixture({ seed: { request_lock: { owner: 'another-window', expiresAt: NOW + 1000 } } });
    await expect(f.client.testKey(TEST_KEY)).rejects.toThrow('busy');
    expect(fetch).not.toHaveBeenCalled();
    Date.now.mockReturnValue(NOW + 1001);
    fetch.mockResolvedValue(jsonResponse());
    await expect(f.client.testKey(TEST_KEY)).resolves.toMatchObject({ symbol: 'AAPL' });
  });
  it('stores only real timestamps and returns scoped local history without network calls', async () => {
    const f = fixture();
    fetch.mockResolvedValueOnce(jsonResponse(body({ t: NOW / 1000 - 100 })));
    await f.client.getQuote('AAPL');
    Date.now.mockReturnValue(NOW + 600_000);
    fetch.mockResolvedValueOnce(jsonResponse(body({ c: 190, t: (NOW + 600_000) / 1000 })));
    await f.client.getQuote('AAPL');
    const history = await f.client.getHistory('AAPL', '1d');
    expect(history).toMatchObject({ kind: 'locally_sampled_quotes', complete: false, source: 'Finnhub' });
    expect(history.samples.map((p) => p.price)).toEqual([189.12, 190]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(f.client.getHistory('AAPL', '5y')).rejects.toThrow('invalid_range');
    expect((await f.client.getHistory('MSFT')).samples).toEqual([]);
  });
  it('does not append duplicate closed-market timestamps', async () => {
    const f = fixture();
    fetch.mockResolvedValue(jsonResponse(body({ t: NOW / 1000 - 3 * 86_400 })));
    await f.client.getQuote('AAPL');
    Date.now.mockReturnValue(NOW + 600_000);
    await f.client.getQuote('AAPL');
    expect((await f.client.getHistory('AAPL', '1w')).samples).toHaveLength(1);
  });
});

describe('launcher, settings, tools and widget workflows', () => {
  it('serves all three launcher syntaxes, opens a chart and provides working copy actions', async () => {
    const f = fixture();
    const search = init(Search, f);
    fetch.mockResolvedValue(jsonResponse());
    expect(search.match('$AAPL')[0].label).toBe('Looking up stocks…');
    const single = await search.matchAsync('$AAPL');
    expect(single[0].label).toContain('AAPL · Apple Inc.');
    expect(single[0].label).toContain('+2.43 (+1.3%)');
    await search.execute(single[0]);
    expect(f.invoke).toHaveBeenCalledWith('open_url', { url: chartUrl('AAPL') });
    expect(await search.execute(single[1])).toEqual({ type: 'copy', value: 'AAPL 189.12 +1.3%' });
    const msft = await search.matchAsync('stock msft');
    expect(msft[0].data.quote.symbol).toBe('MSFT');
    const multi = await search.matchAsync('stock aapl msft nvda');
    expect(multi.filter((r) => !r.data.copy).map((r) => r.data.quote.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA']);
    const copy = await search.matchAsync('stock copy AAPL');
    expect(copy).toHaveLength(1);
    expect((await search.execute(copy[0])).type).toBe('copy');
    expect(search.renderCustom(single[0]).html).toContain('stocks-up');
  });
  it('surfaces unknown symbols, setup, and invalid queries without hiding rows', async () => {
    const f = fixture({ key: null });
    const search = init(Search, f);
    const rows = await search.matchAsync('stock msft');
    expect(rows[0].description).toContain('free Finnhub key');
    expect(await search.execute(rows[0])).toEqual({ type: 'open_extension_settings' });
    expect((await search.matchAsync('stock VOD.L'))[0].description).toContain('US tickers only');
    expect(search.match('stockholm')).toEqual([]);
    await f.client.saveKey(TEST_KEY);
    fetch.mockResolvedValue(jsonResponse({ c: 0, t: 0 }));
    expect((await search.matchAsync('$ZZZZZZ'))[0].description).toContain('No quote');
  });
  it('escapes result strings and never includes the API key in returned HTML or tool output', async () => {
    const f = fixture();
    const search = init(Search, f);
    const result = { label: '<img onerror=x>', description: '<script>', data: { quote: { change: 1 }, samples: [] } };
    const html = search.renderCustom(result).html;
    expect(html).toContain('&lt;img onerror=x&gt;');
    expect(html).not.toContain('<img');
    fetch.mockResolvedValue(jsonResponse());
    const toolResult = await init(Tools, f).execute('get_quote', { symbols: ['AAPL'] });
    expect(JSON.stringify(toolResult)).not.toContain(TEST_KEY);
  });
  it('shows canonical defaults on both old and current hosts and excludes secrets on Save', async () => {
    const f = fixture({ key: null });
    const settings = init(Settings, f);
    const schema = await settings.getSettings();
    const controls = schema.sections.flatMap((s) => s.controls);
    for (const [key, value] of Object.entries(DEFAULTS)) {
      expect(controls.find((c) => c.id === key).default).toEqual(value);
    }
    expect(settings.normalize({ ...DEFAULTS, __api_key: TEST_KEY, unknown: 1 })).toEqual({ values: { ...DEFAULTS, __api_key: '' } });
    expect(settings.validate(DEFAULTS)).toEqual({ valid: true });
    expect(settings.validate({ watchlist: 'VOD.L' }).valid).toBe(false);
    expect(settings.validate({ refresh_seconds: 5 }).valid).toBe(false);
    expect(settings.validate({ refresh_seconds: 4000 }).valid).toBe(false);
    expect(settings.normalize({ watchlist: '$aapl.us, msft', refresh_seconds: '60' }).values).toEqual({ watchlist: 'AAPL MSFT', refresh_seconds: 60 });
  });
  it('guides free-key setup, tests before saving, hides stored keys, and supports removal', async () => {
    const f = fixture({ key: null });
    const settings = init(Settings, f);
    await settings.runAction('free_key');
    expect(f.invoke).toHaveBeenCalledWith('open_url', { url: 'https://finnhub.io/register' });
    fetch.mockResolvedValueOnce(jsonResponse());
    expect((await settings.runAction('test_key', { __api_key: TEST_KEY })).status).toContain('key saved');
    expect(await f.client.key()).toBe(TEST_KEY);
    expect(JSON.stringify(await settings.getSettings())).not.toContain(TEST_KEY);
    await settings.runAction('remove_key');
    expect(await f.client.key()).toBeNull();
  });
  it('never saves a rejected key or echoes credentials in failure status', async () => {
    const f = fixture({ key: null });
    const settings = init(Settings, f);
    fetch.mockResolvedValue(jsonResponse({ error: TEST_KEY }, 401));
    const output = await settings.runAction('test_key', { __api_key: TEST_KEY });
    expect(output.status).toContain('rejected the key');
    expect(JSON.stringify(output)).not.toContain(TEST_KEY);
    expect(await f.client.key()).toBeNull();
    expect((await settings.runAction('test_key', { __api_key: 'https://invalid' })).status).toContain('Paste a Finnhub API key');
  });
  it('exposes the requested tools with per-symbol errors and accurately labeled sparse history', async () => {
    const f = fixture();
    const tools = init(Tools, f);
    expect(tools.getTools().map((tool) => tool.name)).toEqual(['get_quote', 'get_history']);
    fetch.mockImplementation(async (url) => jsonResponse(new URL(url).searchParams.get('symbol') === 'AAPL' ? body() : { c: 0, t: 0 }));
    const quotes = (await tools.execute('get_quote', { symbols: ['AAPL', 'ZZZZZZ'] })).result;
    expect(quotes[0]).toMatchObject({ symbol: 'AAPL', source: 'Finnhub', stale: false });
    expect(quotes[1]).toMatchObject({ symbol: 'ZZZZZZ', error: 'unknown' });
    const calls = fetch.mock.calls.length;
    expect((await tools.execute('get_history', { symbol: 'AAPL', range: '1d' })).result).toMatchObject({ complete: false, kind: 'locally_sampled_quotes' });
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect((await tools.execute('get_history', { symbol: 'AAPL', range: '5y' })).error).toContain('1d');
    expect((await tools.execute('get_quote', {})).error).toContain('Enter stock symbols');
    expect((await tools.execute('other', {})).error).toBe('Unknown Stocks tool.');
  });
  it('clamps widget intervals, handles hidden/off states and opens only current watchlist charts', async () => {
    const f = fixture({ config: { watchlist: 'AAPL', refresh_seconds: 1 } });
    const widget = init(Widget, f);
    expect(widget.getRefreshInterval()).toBe(60_000);
    expect(refreshSeconds({ refresh_seconds: Infinity })).toBe(DEFAULTS.refresh_seconds);
    fetch.mockResolvedValue(jsonResponse());
    const output = await widget.render();
    expect(output.html).toContain('Source: Finnhub');
    expect(output.html).toContain('AAPL 189.12');
    expect(output.html).toContain(timestampText(NOW / 1000));
    expect(output.actions).toEqual([{ id: 'chart:AAPL', rpc: 'chart:AAPL' }]);
    await widget.onAction('chart:AAPL');
    expect(f.invoke).toHaveBeenCalledWith('open_url', { url: chartUrl('AAPL') });
    const calls = f.invoke.mock.calls.length;
    await widget.onAction('chart:999');
    expect(f.invoke).toHaveBeenCalledTimes(calls);
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    expect(await widget.render()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.stubGlobal('document', { visibilityState: 'visible' });
    widget.onConfigUpdate({ show_watchlist: false });
    expect(await widget.render()).toBeNull();
    widget.onConfigUpdate({ watchlist: '' });
    expect(await widget.render()).toBeNull();
  });
  it('honors the host disabled flag for all contributions', async () => {
    const f = fixture({ config: { enabled: false } });
    expect(init(Search, f).match('$AAPL')).toEqual([]);
    expect(await init(Search, f).matchAsync('$AAPL')).toEqual([]);
    expect(await init(Widget, f).render()).toBeNull();
    expect((await init(Tools, f).execute('get_quote', { symbols: ['AAPL'] })).error).toBe('Stocks is disabled.');
    expect(fetch).not.toHaveBeenCalled();
  });
});
