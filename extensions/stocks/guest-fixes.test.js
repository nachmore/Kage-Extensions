import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeContext } from '../../test-helpers/mock-context.mjs';
import { getClient, parseStocklakeQuote, stocklakeCall } from './client.js';
import { stocklakeSymbol } from './symbols.js';
import { copyText, quoteDescription, timestampText } from './format.js';
import Search from './search.js';
import Settings from './settings.js';
import Tools from './tools.js';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url)));
const catalog = read('./_locales/en/messages.json');
const captured = read('./get_stocks.fixture.json');
const sample = JSON.parse(captured.result.content[0].text);
const aapl = JSON.parse(read('./get_stock.fixture.json').result.content[0].text);
const history = JSON.parse(read('./get_stock_history.fixture.json').result.content[0].text);
const NOW = Date.parse('2026-11-08T16:00:00Z');
const DAY = 86_400_000;
const BUDGET = 'request_budget_stocklake_guest';
const KEY = 'guest-fixes-fixture-key';
const envelope = (body) => ({ result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });
const response = (body, status = 200, headers = {}) => ({
  status, ok: status === 200, headers: new Headers(headers), json: async () => envelope(body),
});
function host(seed = {}, config = {}, hook) {
  const store = new Map(Object.entries(seed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const mock = makeContext({ catalog, config, hostFeatures: ['config.manifest_defaults'], invokes: {
    load_extension_data: async ({ key }) => {
      await hook?.('load', key, store);
      return store.get(key) ?? null;
    },
    save_extension_data: async ({ key, data }) => {
      store.set(key, data);
      await hook?.('save', key, store);
    },
    delete_extension_data: ({ key }) => store.delete(key),
    open_url: () => {},
  } });
  return { ...mock, store, client: getClient(mock.context) };
}
function init(Provider, h) { const p = new Provider(); p.initialize(h.context); return p; }
function mockWire({ delay = 0 } = {}) {
  fetch.mockImplementation(async (_, options) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const { name, arguments: args } = JSON.parse(options.body).params;
    if (name === 'get_stock_history') return response({ ...history, symbol: args.symbol });
    expect(name).toBe('get_stocks');
    const symbols = {};
    for (const symbol of args.symbols) {
      if (symbol === 'ZZZZQX') continue;
      symbols[symbol] = sample.symbols[symbol] || { ...aapl, symbol };
    }
    return response({ symbols, missing: args.symbols.filter((s) => !symbols[s]), requested: args.symbols.length });
  });
}
const spent = (h) => 25 - JSON.parse(h.store.get(BUDGET) || '{"remaining":25}').remaining;
const params = () => fetch.mock.calls.map(([, opts]) => JSON.parse(opts.body).params);
async function settle(work, ms = 2000) { await vi.advanceTimersByTimeAsync(ms); return work; }
async function driveUntil(work) {
  let done = false;
  const observed = work.finally(() => { done = true; });
  for (let i = 0; i < 100 && !done; i++) await vi.advanceTimersByTimeAsync(100);
  expect(done, 'work completes within the host timeout').toBe(true);
  return observed;
}
async function type(search, text, ms) {
  const pending = [];
  // The host debounces typing for 100 ms before invoking its match phases.
  for (let i = 1; i <= text.length; i++) {
    await vi.advanceTimersByTimeAsync(100);
    search.match(text.slice(0, i));
    pending.push(search.matchAsync(text.slice(0, i)));
    await vi.advanceTimersByTimeAsync(ms - 100);
  }
  return (await settle(Promise.all(pending), 2500)).at(-1);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn());
  mockWire();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('measured fresh-install guest cost', () => {
  it.each([
    ['$AAPL', 250, 1], ['stock msft nvda', 250, 2], ['$SAP.DE', 250, 1], ['stock', 250, 0],
    ['$AAPL', 700, 1], ['stock msft nvda', 700, 2],
  ])('%s at %i ms/char charges %i symbols', async (query, cadence, charged) => {
    mockWire({ delay: 250 });
    const h = host();
    const rows = await type(init(Search, h), query, cadence);
    expect(spent(h)).toBe(charged);
    expect(fetch).toHaveBeenCalledTimes(charged ? 1 : 0);
    expect(params().every((p) => p.name === 'get_stocks')).toBe(true);
    expect(rows[0].data.help || rows[0].data.quote).toBeTruthy();
    console.log(`GUEST_COST ${JSON.stringify({ query, msPerChar: cadence, charged, httpRequests: fetch.mock.calls.length })}`);
  });
});

describe('guest quote and transport regressions', () => {
  it('uses the captured batch reply, preserving share-class spelling and negatively caching the typo', async () => {
    fetch.mockResolvedValue({ ...response(null), json: async () => captured });
    const h = host();
    const quotes = await h.client.getQuotes(['BRK.B', 'SAP.DE', 'ZZZZQX']);
    expect(params()).toEqual([{ name: 'get_stocks', arguments: { symbols: ['BRK-B', 'SAP.DE', 'ZZZZQX'] } }]);
    expect(quotes[0]).toMatchObject({ symbol: 'BRK.B', price: 570.89, currency: 'USD' });
    expect(quotes[1]).toMatchObject({ symbol: 'SAP.DE', price: 210.75, currency: 'EUR' });
    expect(quotes[2]).toMatchObject({ error: 'unknown' });
    expect(JSON.parse(h.store.get('quote_ZZZZQX')).expiresAt).toBe(NOW + 600_000);
    await h.client.getQuotes(['ZZZZQX']);
    mockWire();
    await h.client.getQuotes(['AAPL']);
    expect(params()).toHaveLength(2);
    expect(spent(h)).toBe(4);
    expect(JSON.parse(h.store.get(BUDGET)).backoffUntil).toBeUndefined();
  });

  it('maps isError ticker-not-found to unknown and caches it without a pause', async () => {
    fetch.mockResolvedValue({ ...response(null), json: async () => ({
      result: { isError: true, content: [{ text: 'Ticker not found' }] },
    }) });
    await expect(stocklakeCall('get_stocks', { symbols: ['ZZZZQX'] })).rejects.toMatchObject({ code: 'unknown' });
    const h = host();
    expect((await h.client.getQuotes(['ZZZZQX']))[0].error).toBe('unknown');
    mockWire();
    await h.client.getQuotes(['AAPL']);
    await h.client.getQuotes(['ZZZZQX']);
    expect(fetch).toHaveBeenCalledTimes(3); // one raw parser check, then two client requests
    expect(spent(h)).toBe(2);
  });

  it.each(['L', 'F', 'T', 'V', 'DE', 'CO', 'TO'])('leaves the .%s exchange suffix unchanged', (suffix) => {
    expect(stocklakeSymbol(`ABC.${suffix}`)).toBe(`ABC.${suffix}`);
  });

  it.each(['quotes', 'history', 'keyTest'])('known offline %s never reserves or fetches', async (kind) => {
    navigator.onLine = false;
    const h = host();
    if (kind === 'quotes') expect((await h.client.getQuotes(['AAPL']))[0].error).toBe('offline');
    else if (kind === 'history') await expect(h.client.getHistory('AAPL')).rejects.toThrow('offline');
    else await expect(h.client.testKey(KEY, 'stocklake')).rejects.toThrow('offline');
    expect(spent(h)).toBe(0);
    expect(h.store.has(BUDGET)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refunds a failed unsent network request', async () => {
    fetch.mockRejectedValue(new TypeError('Network unavailable'));
    const h = host();
    expect((await h.client.getQuotes(['AAPL', 'MSFT']))[0].error).toBe('offline');
    expect(spent(h)).toBe(0);
  });

  it.each(['load', 'save'])('superseding a query during budget %s skips the network and spends nothing', async (phase) => {
    let search;
    const h = host({}, {}, (action, key) => {
      if (action === phase && key === BUDGET) search.match('ordinary new prompt');
    });
    search = init(Search, h);
    const rows = await settle(search.matchAsync('$AAPL'));
    expect(rows).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(spent(h)).toBe(0);
  });

  it('keeps and caches a charged success when header sync cannot persist', async () => {
    const h = host();
    h.client.syncDaily = vi.fn(async () => { throw new Error('Disk unavailable'); });
    expect((await h.client.getQuote('AAPL')).price).toBe(aapl.price);
    expect((await h.client.getQuote('AAPL')).cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(spent(h)).toBe(1);
  });

  it('clamps a far-future provider reset to 24 hours', async () => {
    const headers = readFileSync(new URL('./get_stocks.headers.fixture.txt', import.meta.url), 'utf8');
    const capturedHeaders = Object.fromEntries([...headers.matchAll(/^(x-ratelimit-[\w-]+): (.+)$/gm)].map((m) => [m[1], m[2].trim()]));
    const h = host();
    await h.client.syncDaily(new Headers({ ...capturedHeaders, 'x-ratelimit-reset': String((NOW + 4 * DAY) / 1000) }), 200);
    expect(JSON.parse(h.store.get(BUDGET)).resetAt).toBe(NOW + DAY);
  });

  it('a guest 401 at UTC rollover does not exhaust the new day', async () => {
    vi.setSystemTime(Date.parse('2026-11-09T00:00:02Z'));
    fetch.mockResolvedValue(response(null, 401));
    const h = host();
    const quote = (await h.client.getQuotes(['AAPL']))[0];
    expect(quote.error).toBe('daily_limit');
    expect(quote.retryAt).toBe(Date.now() + 30_000);
    expect(spent(h)).toBe(1);
    mockWire();
    await vi.advanceTimersByTimeAsync(30_000);
    await h.client.getQuote('MSFT');
    expect(spent(h)).toBe(2);
  });

  it('unreadable credentials report storage without selecting Finnhub or fetching', async () => {
    const h = host({ credentials: '{torn' });
    expect((await h.client.getQuotes(['SAP.DE']))[0]).toMatchObject({ symbol: 'SAP.DE', error: 'storage' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('history scheduling, settings and units', () => {
  it('guest sparklines read even stale history without a network history request', async () => {
    const h = host({ history_AAPL: { source: 'Stocklake', fetchedAt: NOW - 2 * DAY,
      samples: [{ timestamp: NOW / 1000 - DAY, price: 100 }, { timestamp: NOW / 1000, price: 105 }] } });
    const search = init(Search, h);
    const rows = await settle(search.matchAsync('$AAPL'));
    expect(rows[0].data.samples).toHaveLength(2);
    expect(search.renderCustom(rows[0]).html).toContain('<svg');
    expect(search.renderCustom(rows[0]).html).not.toContain('<a ');
    expect(spent(h)).toBe(1);
  });

  it('returns ten keyed quote rows before parallel history, then stops new work on a newer query', async () => {
    const symbols = ['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ'];
    const h = host({ credentials: { provider: 'stocklake', stocklake_key: KEY } });
    const search = init(Search, h);
    let requestsWhenRowsReturned;
    let active = 0, peak = 0;
    fetch.mockImplementation(async (_, options) => {
      const { name, arguments: args } = JSON.parse(options.body).params;
      if (name === 'get_stocks') return response({ symbols: Object.fromEntries(args.symbols.map((s) => [s, { ...aapl, symbol: s }])) });
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 2000));
      active--;
      return response({ ...history, symbol: args.symbol });
    });
    const rows = await driveUntil(search.matchAsync(`stock ${symbols.join(' ')}`).then((rows) => {
      requestsWhenRowsReturned = params().length;
      return rows;
    }));
    expect(rows.filter((r) => !r.data.copy)).toHaveLength(10);
    expect(requestsWhenRowsReturned).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(peak).toBeGreaterThan(1);
    search.match('a newer prompt');
    await driveUntil(search.historyWork);
    expect(search.historySamples.size).toBe(0);
  });

  it('skips keyed history entirely if a newer query arrives before it starts', async () => {
    const h = host({ credentials: { provider: 'stocklake', stocklake_key: KEY } });
    const search = init(Search, h);
    await settle(search.matchAsync('$AAPL'), 600);
    search.match('$MSFT');
    await vi.advanceTimersByTimeAsync(50);
    expect(params()).toHaveLength(1);
  });

  it('guest Test and use selects the provider without a quote test', async () => {
    const h = host({ credentials: { provider: 'finnhub', api_key: KEY } });
    const settings = init(Settings, h);
    await settings.getSettings();
    expect((await settings.runAction('test_key', { __provider: 'stocklake' })).status).toContain('Provider selected');
    expect((await h.client.connection()).provider).toBe('stocklake');
    expect(fetch).not.toHaveBeenCalled();
    expect(spent(h)).toBe(0);
  });

  it.each(['stocklake', 'finnhub'])('Remove acts only on %s regardless of selection and preserves the active provider', async (remove) => {
    const active = remove === 'stocklake' ? 'finnhub' : 'stocklake';
    const h = host({ credentials: { provider: active, api_key: KEY, stocklake_key: KEY } });
    const settings = init(Settings, h);
    const controls = (await settings.getSettings()).sections[0].controls;
    expect(controls.find((c) => c.id === `remove_${remove}_key`).disabled).toBe(false);
    await settings.runAction(`remove_${remove}_key`, { __provider: active });
    expect((await h.client.connection()).provider).toBe(active);
    expect(await h.client.providerKey(remove)).toBeNull();
    expect(await h.client.providerKey(active)).toBe(KEY);
  });

  it('removing the active Finnhub key falls back to Stocklake with an explicit message', async () => {
    const h = host({ credentials: { provider: 'finnhub', api_key: KEY } });
    const settings = init(Settings, h);
    await settings.getSettings();
    const result = await settings.runAction('remove_finnhub_key', { __provider: 'stocklake' });
    expect(result.status).toContain('Stocklake guest is now active');
    expect((await h.client.connection()).provider).toBe('stocklake');
  });

  it('Save explains provider switches and validates the watchlist against the active provider', async () => {
    const h = host({ credentials: { provider: 'finnhub', api_key: KEY } });
    const settings = init(Settings, h);
    await settings.getSettings();
    expect(settings.validate({ __provider: 'stocklake', watchlist: 'SAP.DE' })).toMatchObject({
      valid: false, error: expect.stringContaining('Use Test and use'),
    });
    expect(settings.validate({ watchlist: 'SAP.DE' }).valid).toBe(false);
    expect((await h.client.connection()).provider).toBe('finnhub');
  });

  it.each(['GBp', 'GBX', 'ZAc'])('retains and displays the %s subunit', async (currency) => {
    fetch.mockResolvedValue(response({ symbols: { 'VOD.L': { ...aapl, symbol: 'VOD.L', price: 123.4, currency } } }));
    const h = host();
    const search = init(Search, h);
    const rows = await settle(search.matchAsync('$VOD.L'));
    const quote = rows[0].data.quote;
    const suffix = currency === 'ZAc' ? 'c' : 'p';
    expect(quote.currency).toBe(currency);
    expect(rows[0].label).toContain(`123.40${suffix}`);
    expect(copyText(quote)).toContain(`123.40${suffix}`);
  });

  it('shows one delay note, short update/reset labels and asOf rather than tradeTime', async () => {
    const h = host({}, { agent_tools: true });
    const result = (await init(Tools, h).execute('get_quote', { symbols: ['SAP.DE'] })).result[0];
    expect(result.asOf).toBe(sample.symbols['SAP.DE'].updated_at.replace('34.057000+00:00', '34.057Z'));
    expect(result).not.toHaveProperty('tradeTime');
    expect(result.change).toBe(-5);
    const quote = parseStocklakeQuote(sample.symbols['SAP.DE'], 'SAP.DE');
    expect(quoteDescription(quote, h.context.i18n.t)).toBe(`Delayed ~15 min · Stocklake · EUR · Updated ${timestampText(quote.timestamp)}`);
    expect(timestampText(NOW / 1000)).not.toMatch(/2026|GMT|UTC|:00:/);
  });

  it('Enter on an exhausted quote or error row opens settings', async () => {
    const h = host({ [BUDGET]: { limit: 25, remaining: 0, resetAt: NOW + 1000 } });
    const search = init(Search, h);
    expect(await search.execute(search.errorRow('AAPL', 'daily_limit'))).toEqual({ type: 'open_extension_settings' });
    expect(await search.execute({ data: { quote: { symbol: 'AAPL', reason: 'daily_limit' } } })).toEqual({ type: 'open_extension_settings' });
  });

  it('get_history defaults to 1m and converts retryAt to ISO', async () => {
    const h = host({ [BUDGET]: { limit: 25, remaining: 0, resetAt: NOW + 1000 },
      history_AAPL: { source: 'Stocklake', fetchedAt: NOW - 2 * DAY, samples: [{ price: 100, timestamp: NOW / 1000 }] } },
    { agent_tools: true });
    const result = (await init(Tools, h).execute('get_history', { symbol: 'AAPL' })).result;
    expect(result.range).toBe('1m');
    expect(result.retryAt).toBe(new Date(NOW + 1000).toISOString());
    expect(init(Tools, h).getTools()[1].description).toContain('guest allowance');
  });

  it('storage lockout text includes its end time', async () => {
    const h = host({ [BUDGET]: '{torn' });
    const search = init(Search, h);
    const rows = await settle(search.matchAsync('$AAPL'));
    expect(rows[0].description).toContain(`paused until ${timestampText(Date.parse('2026-11-09T00:00:00Z') / 1000)}`);
  });
});
