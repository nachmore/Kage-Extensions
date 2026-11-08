import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeContext } from '../../test-helpers/mock-context.mjs';
import { getClient, migrateProvider, parseStocklakeQuote, parseStocklakeHistory, stocklakeCall } from './client.js';
import { normalizeSymbol, parseQuery } from './symbols.js';
import { quoteDescription, timestampText } from './format.js';
import Search from './search.js';
import Settings from './settings.js';
import Tools from './tools.js';
import Widget from './widget.js';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url)));
const catalog = read('./_locales/en/messages.json');
const quoteFixture = read('./get_stock.fixture.json');
const historyFixture = read('./get_stock_history.fixture.json');
const stock = JSON.parse(quoteFixture.result.content[0].text);
const historyBody = JSON.parse(historyFixture.result.content[0].text);
const NOW = Date.parse('2026-11-08T16:00:00Z');
const RESET = Date.parse('2026-11-09T00:00:00Z');
const KEY = 'sl_mock_personal_key';
const guestBudget = 'request_budget_stocklake_guest';
const keyedBudget = 'request_budget_stocklake_key';
const envelope = (body) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });
const response = (body = stock, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => envelope(body?.price ? { count: 1, symbols: { [body.symbol]: body } } : body),
});
const budget = (remaining, extra = {}) => ({ limit: 25, remaining, resetAt: RESET, ...extra });

function host({ credentials, config = {}, seed = {}, reject } = {}) {
  const store = new Map(Object.entries(seed).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]));
  if (credentials) store.set('credentials', JSON.stringify(credentials));
  const mock = makeContext({
    catalog, config, hostFeatures: ['config.manifest_defaults'],
    invokes: {
      load_extension_data: ({ key }) => {
        if (reject?.('load_extension_data', key)) throw new Error('I/O failed');
        return store.get(key) ?? null;
      },
      save_extension_data: ({ key, data }) => {
        if (reject?.('save_extension_data', key)) throw new Error('I/O failed');
        store.set(key, data);
      },
      delete_extension_data: ({ key }) => store.delete(key),
      open_url: () => {},
    },
  });
  return { ...mock, store, client: getClient(mock.context) };
}
function init(Provider, h) { const provider = new Provider(); provider.initialize(h.context); return provider; }
const saved = (age = 0, source = 'Stocklake') => ({
  quote: { ...parseStocklakeQuote(stock, 'AAPL'), source }, fetchedAt: NOW - age,
});
async function settle(promise) { await vi.advanceTimersByTimeAsync(1350); return promise; }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network call'); }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('verified Stocklake wire format', () => {
  it('parses the trimmed live quote and uses price, not prev_close', async () => {
    fetch.mockResolvedValue({ ...response(), json: async () => quoteFixture });
    const body = await stocklakeCall('get_stock', { symbol: 'AAPL' });
    const quote = parseStocklakeQuote(body, 'AAPL');
    expect(quote).toMatchObject({ price: 342.37, previousClose: 344.17, percent: -0.52,
      source: 'Stocklake', currency: 'USD', exchange: 'NMS', volume: 43750861 });
    expect(quote.change).toBeCloseTo(-1.8);
    expect(quote.timestamp).toBe(Date.parse(stock.updated_at) / 1000);
    expect(fetch.mock.calls[0][0]).toBe('https://api.stocklake.dev/mcp');
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_stock', arguments: { symbol: 'AAPL' } },
    });
  });
  it('sends an optional key only in documented Bearer authentication', async () => {
    fetch.mockResolvedValue(response());
    await stocklakeCall('get_stock', { symbol: 'AAPL' }, KEY);
    const [url, options] = fetch.mock.calls[0];
    expect(url).not.toContain(KEY);
    expect(options.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(options.headers).not.toHaveProperty('Mcp-Session-Id');
    expect(options.body).not.toContain(KEY);
  });
  it.each([null, {}, { ...stock, price: 0 }, { ...stock, updated_at: 'invalid' },
    { ...stock, symbol: 'MSFT' }, { ...stock, updated_at: '2099-01-01' }])('rejects malformed quote %j', (body) => {
    expect(() => parseStocklakeQuote(body, 'AAPL')).toThrow('unknown');
  });
  it.each([{ error: { message: KEY } }, { result: { isError: true, content: [{ text: KEY }] } },
    { result: { content: [{ text: '{torn' }] } }])('sanitizes RPC/tool/JSON errors', async (body) => {
    fetch.mockResolvedValue({ ...response(), json: async () => body });
    await expect(stocklakeCall('get_stock', { symbol: 'AAPL' })).rejects.toThrow('unavailable');
  });
  it('parses daily OHLCV from the second live fixture', () => {
    expect(parseStocklakeHistory(historyBody, 'AAPL')).toHaveLength(3);
    expect(parseStocklakeHistory(historyBody, 'AAPL').at(-1)).toMatchObject({
      timestamp: Date.parse('2026-11-06T00:00:00Z') / 1000, price: 342.37,
      open: 338.73, high: 345.79, low: 338.3, volume: 43750861,
    });
  });
});

describe('keyless quotes, batching and provider-specific symbols', () => {
  it('makes $AAPL work with one guest lookup and plain-text attribution', async () => {
    const h = host();
    fetch.mockImplementation(async (_, options) => {
      const name = JSON.parse(options.body).params.name;
      return response(name === 'get_stock_history' ? historyBody : stock);
    });
    const search = init(Search, h);
    const rows = await settle(search.matchAsync('$AAPL'));
    expect(rows[0].data.quote).toMatchObject({ price: stock.price, source: 'Stocklake', stale: false });
    expect(rows[0].description).toContain('Delayed ~15 min · Stocklake');
    expect(rows.some((row) => row.data.setup)).toBe(false);
    expect(search.renderCustom(rows[0]).html).not.toContain('<a ');
    expect(rows[0].data.samples).toHaveLength(0);
    expect(JSON.parse(h.store.get(guestBudget)).remaining).toBe(24);
    expect(await search.execute(rows[1])).toEqual({ type: 'copy', value: 'AAPL 342.37 -0.52%' });
  });
  it('uses one get_stocks request, billing each distinct symbol and preserving skipped-symbol errors', async () => {
    const h = host();
    fetch.mockResolvedValue(response({ count: 2, symbols: {
      AAPL: stock, 'SAP.DE': { ...stock, symbol: 'SAP.DE', currency: 'EUR' },
    } }));
    const quotes = await h.client.getQuotes(['aapl', 'SAP.DE', 'AAPL', 'ZZZZZZ']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).params).toEqual({
      name: 'get_stocks', arguments: { symbols: ['AAPL', 'SAP.DE', 'ZZZZZZ'] },
    });
    expect(quotes[1]).toMatchObject({ symbol: 'SAP.DE', currency: 'EUR' });
    expect(quotes[2]).toMatchObject({ symbol: 'ZZZZZZ', error: 'unknown' });
    expect(JSON.parse(h.store.get(guestBudget)).remaining).toBe(22);
  });
  it.each(['SAP.DE', 'VOD.L', 'NOVO-B.CO', '7203.T'])('accepts %s for Stocklake and rejects it for Finnhub', async (symbol) => {
    expect(normalizeSymbol(symbol)).toBe(symbol);
    expect(parseQuery(`$${symbol}`).symbols).toEqual([symbol]);
    expect(() => normalizeSymbol(symbol, 'finnhub')).toThrow('unsupported');
    const h = host({ credentials: { api_key: KEY } });
    expect((await h.client.getQuotes([symbol]))[0].error).toBe('unsupported');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('caches for at least ten minutes even with a 60 second refresh setting', async () => {
    const h = host(); fetch.mockResolvedValue(response());
    await h.client.getQuote('AAPL', { refresh_seconds: 60 });
    vi.setSystemTime(NOW + 599_999);
    expect((await h.client.getQuote('AAPL', { refresh_seconds: 60 })).cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 600_000);
    await h.client.getQuote('AAPL', { refresh_seconds: 60 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('deduplicates concurrent quotes without another budget charge', async () => {
    const h = host(); fetch.mockResolvedValue(response());
    const quotes = await Promise.all([h.client.getQuote('AAPL'), h.client.getQuote('AAPL')]);
    expect(quotes[0]).toEqual(quotes[1]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.store.get(guestBudget)).remaining).toBe(24);
  });
  it('never polls the guest watchlist, including old enabled configs and saved quotes', async () => {
    const h = host({ config: { show_watchlist: true }, seed: { quote_AAPL: saved() } });
    expect(await init(Widget, h).render()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('opens pending international charts without sending a guest to setup', async () => {
    const h = host(); const search = init(Search, h);
    expect(await search.execute(search.match('$SAP.DE')[0])).toEqual({ type: 'custom', data: {} });
    expect(h.invoke).toHaveBeenCalledWith('open_url', { url: 'https://www.tradingview.com/chart/?symbol=SAP.DE' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('daily reservations, response headers and fail-closed storage', () => {
  it('syncs the server limit, remaining count and epoch reset', async () => {
    const h = host();
    fetch.mockResolvedValue(response(stock, 200, {
      'x-ratelimit-limit': '25', 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': String(RESET / 1000),
    }));
    await h.client.getQuote('AAPL');
    expect(JSON.parse(h.store.get(guestBudget))).toMatchObject(budget(3));
  });
  it.each([{}, { 'x-ratelimit-limit': '25', 'x-ratelimit-remaining': '-1', 'x-ratelimit-reset': 'NaN' }])(
    'retains the local count when CORS hides headers or headers are invalid', async (headers) => {
      const h = host(); fetch.mockResolvedValue(response(stock, 200, headers));
      await h.client.getQuote('AAPL');
      expect(JSON.parse(h.store.get(guestBudget)).remaining).toBe(24);
    });
  it('shows a localized reset message and as-of time for fresh and stale saved quotes without requesting', async () => {
    const h = host({ seed: { [guestBudget]: budget(0), quote_AAPL: saved(600_000) } });
    const quote = await h.client.getQuote('AAPL');
    expect(quote).toMatchObject({ price: stock.price, cached: true, reason: 'daily_limit', retryAt: RESET });
    const text = quoteDescription(quote, h.context.i18n.t);
    expect(text).toContain(`Daily free quotes used up. Resets at ${timestampText(RESET / 1000)}. Add a free Stocklake key for 200 a day.`);
    expect(text).toContain(`Updated ${timestampText(quote.timestamp)}`);
    h.store.set('quote_AAPL', JSON.stringify(saved()));
    expect((await h.client.getQuote('AAPL')).reason).toBe('daily_limit');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the same reset message for an uncached symbol in search and tool errors', async () => {
    const h = host({ config: { agent_tools: true }, seed: { [guestBudget]: budget(0) } });
    const search = init(Search, h);
    const rows = await settle(search.matchAsync('$AAPL'));
    expect(rows[0].description).toContain(timestampText(RESET / 1000));
    const result = await init(Tools, h).execute('get_quote', { symbols: ['AAPL'] });
    expect(result.result[0].message).toContain('Daily free quotes used up.');
    expect(result.result[0].retryAt).toBe(new Date(RESET).toISOString());
    expect(fetch).not.toHaveBeenCalled();
  });
  it('resets at the stored provider epoch and then reserves a new call', async () => {
    const h = host({ seed: { [guestBudget]: budget(0, { resetAt: NOW + 1000 }) } });
    vi.setSystemTime(NOW + 1000); fetch.mockResolvedValue(response());
    await h.client.getQuote('AAPL');
    expect(JSON.parse(h.store.get(guestBudget))).toMatchObject({ remaining: 24, resetAt: RESET });
  });
  it.each([401, 429])('treats guest HTTP %i as exhaustion and never retries it', async (status) => {
    const h = host(); fetch.mockResolvedValue(response(null, status));
    await expect(h.client.getQuote('AAPL')).rejects.toMatchObject({ code: 'daily_limit', retryAt: RESET });
    expect(JSON.parse(h.store.get(guestBudget)).remaining).toBe(0);
    await expect(h.client.getQuote('MSFT')).rejects.toThrow('daily_limit');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('starts a keyed budget at 200 while preserving the exhausted guest count', async () => {
    const h = host({ seed: { [guestBudget]: budget(0) } });
    await h.client.saveKey(KEY, 'stocklake'); fetch.mockResolvedValue(response());
    await h.client.getQuote('AAPL');
    expect(JSON.parse(h.store.get(keyedBudget))).toMatchObject({ limit: 200, remaining: 199 });
    await h.client.removeKey('stocklake');
    expect((await h.client.getQuote('AAPL')).reason).toBe('daily_limit');
    expect(JSON.parse(h.store.get(guestBudget)).remaining).toBe(0);
  });
  it('rejects a whole batch before requesting when it exceeds the remaining allowance', async () => {
    const h = host({ seed: { [guestBudget]: budget(1) } });
    const quotes = await h.client.getQuotes(['AAPL', 'MSFT']);
    expect(quotes.every((quote) => quote.error === 'daily_limit')).toBe(true);
    expect(JSON.parse(h.store.get(guestBudget)).remaining).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['load_extension_data', 'save_extension_data'])('never requests if %s fails for the daily budget', async (command) => {
    const h = host({ reject: (cmd, key) => cmd === command && key === guestBudget });
    await expect(h.client.getQuote('AAPL')).rejects.toThrow('storage');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed until midnight for a torn budget instead of granting another 25 calls', async () => {
    const h = host({ seed: { [guestBudget]: '{torn' } });
    await expect(h.client.getQuote('AAPL')).rejects.toThrow('storage');
    expect(JSON.parse(h.store.get(guestBudget))).toMatchObject({ remaining: 0, resetAt: RESET });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('shares durable counts across windows without increasing a low server count', async () => {
    const h = host(); fetch.mockResolvedValue(response(stock, 200, {
      'x-ratelimit-limit': '25', 'x-ratelimit-remaining': '2', 'x-ratelimit-reset': String(RESET / 1000),
    }));
    await h.client.getQuote('AAPL');
    const second = getClient({ ...h.context, invoke: async (...args) => h.invoke(...args) });
    fetch.mockResolvedValue(response({ ...stock, symbol: 'MSFT' }, 200, {
      'x-ratelimit-limit': '25', 'x-ratelimit-remaining': '24', 'x-ratelimit-reset': String(RESET / 1000),
    }));
    await second.getQuote('MSFT');
    expect(JSON.parse(h.store.get(guestBudget)).remaining).toBe(1);
  });
});

describe('migration, switching, and real history', () => {
  it.each([{}, { provider: 'cache' }, { provider: 'finnhub' }, { provider: 'stocklake' },
    { provider: null }, { watchlist: '', refresh_seconds: 60 }])('migrates keyless legacy config %j to Stocklake', async (config) => {
    const h = host({ config }); const settings = init(Settings, h);
    await settings.getSettings();
    expect((await h.client.connection(config)).provider).toBe('stocklake');
    if (Object.hasOwn(config, 'provider')) expect(settings.normalize(config).values.provider).toBe('stocklake');
  });
  it.each([{}, { provider: 'cache' }, { provider: 'stocklake' }])('keeps a legacy Finnhub key for config %j', async (config) => {
    expect(migrateProvider(config, { api_key: KEY })).toBe('finnhub');
    const h = host({ config, credentials: { api_key: KEY } });
    const settings = init(Settings, h);
    const controls = (await settings.getSettings()).sections.flatMap((section) => section.controls);
    expect(controls.find((control) => control.id === '__provider').default).toBe('finnhub');
    expect(settings.normalize({ provider: config.provider }).values.provider).toBe('finnhub');
  });
  it.each(['api_key', 'finnhub_key'])('ignores never-released %s config credential fields', async (field) => {
    const h = host({ config: { [field]: KEY } }); const settings = init(Settings, h);
    await settings.getSettings();
    expect(h.store.has('credentials')).toBe(false);
    expect((await h.client.connection()).provider).toBe('stocklake');
    expect(settings.normalize({ [field]: KEY }).values).not.toHaveProperty(field);
  });
  it('selects keyless Stocklake with Test/use, retaining the old Finnhub key and ignoring its cache', async () => {
    const h = host({ credentials: { api_key: KEY }, seed: { quote_AAPL: saved(0, 'Finnhub') } });
    const settings = init(Settings, h); await settings.getSettings();
    fetch.mockResolvedValue(response());
    expect((await settings.runAction('test_key', { __provider: 'stocklake' })).status).toContain('Provider selected');
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(h.store.get('credentials'))).toMatchObject({ provider: 'stocklake', api_key: KEY });
    expect((await h.client.getQuote('AAPL')).source).toBe('Stocklake');
    await h.client.useProvider('finnhub');
    fetch.mockResolvedValue({ ...response(), json: async () => ({ c: 123, t: NOW / 1000 }) });
    expect((await h.client.getQuote('AAPL')).price).toBe(123);
    expect(new URL(fetch.mock.calls.at(-1)[0]).origin).toBe('https://finnhub.io');
  });
  it('keeps both keys out of schemas, regular config, and tool output', async () => {
    const h = host({ credentials: { provider: 'stocklake', stocklake_key: KEY, api_key: 'other_personal_key' },
      config: { agent_tools: true } });
    const settings = init(Settings, h);
    expect(JSON.stringify(await settings.getSettings())).not.toContain(KEY);
    const clean = settings.normalize({ __api_key: KEY, stocklake_key: KEY, __provider: 'stocklake' }).values;
    expect(JSON.stringify(clean)).not.toContain(KEY);
    fetch.mockResolvedValue(response());
    expect(JSON.stringify(await init(Tools, h).execute('get_quote', { symbols: ['AAPL'] }))).not.toContain(KEY);
  });
  it('uses 30 real trading days, caches once per day across ranges, and labels it daily history', async () => {
    const h = host(); fetch.mockResolvedValue(response(historyBody));
    const first = await h.client.getHistory('AAPL', '1m');
    expect(first).toMatchObject({ kind: 'daily_history', complete: true, source: 'Stocklake' });
    expect(first.samples).toHaveLength(3);
    expect(JSON.parse(fetch.mock.calls[0][1].body).params).toEqual({
      name: 'get_stock_history', arguments: { symbol: 'AAPL', days: 30 },
    });
    expect((await h.client.getHistory('AAPL', '1d')).samples).toHaveLength(1);
    vi.setSystemTime(NOW + 86_399_999);
    expect((await h.client.getHistory('AAPL', '1m')).cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 86_400_000);
    await h.client.getHistory('AAPL', '1m');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves cached history on exhaustion without substituting local quote samples', async () => {
    const h = host(); fetch.mockResolvedValue(response(historyBody));
    await h.client.getHistory('AAPL', '1m');
    vi.setSystemTime(NOW + 86_400_000);
    h.store.set(guestBudget, JSON.stringify(budget(0, { resetAt: RESET + 86_400_000 })));
    const history = await h.client.getHistory('AAPL', '1m', { source: 'Stocklake', samples: [{ price: 999 }] });
    expect(history).toMatchObject({ kind: 'daily_history', stale: true, reason: 'daily_limit' });
    expect(history.samples.at(-1).price).toBe(342.37);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('deletes history-only caches while retaining credentials and daily limits', async () => {
    const h = host({ credentials: { provider: 'stocklake', stocklake_key: KEY } });
    fetch.mockResolvedValue(response(historyBody));
    await h.client.getHistory('AAPL', '1m');
    await vi.advanceTimersByTimeAsync(5);
    const counts = await h.client.deleteQuotes();
    expect(counts).toEqual({ deleted: 1, failed: 0 });
    expect(h.store.has('history_AAPL')).toBe(false);
    expect(h.store.has('credentials')).toBe(true);
    expect(JSON.parse(h.store.get(keyedBudget)).remaining).toBe(199);
  });
});
