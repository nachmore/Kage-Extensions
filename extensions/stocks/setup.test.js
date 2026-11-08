import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeContext } from '../../test-helpers/mock-context.mjs';
import { getClient } from './client.js';
import { DEFAULTS } from './defaults.js';
import { timestampText } from './format.js';
import Search from './search.js';
import Settings from './settings.js';
import Tools from './tools.js';
import Widget from './widget.js';

const NOW = Date.parse('2026-11-08T16:00:00Z');
const KEY = 'setup-fixture-key';
const SETUP = 'Get a free Finnhub key (about a minute)';
const catalog = JSON.parse(readFileSync(new URL('./_locales/en/messages.json', import.meta.url)));
const saved = {
  quote: { symbol: 'AAPL', price: 123.45, change: 1, percent: 0.82, timestamp: NOW / 1000 - 60, source: 'Finnhub', currency: 'USD' },
  fetchedAt: NOW - 600_000,
  samples: [{ timestamp: NOW / 1000 - 60, price: 123.45 }],
};

function host({ config = {}, seed = {}, key = null, hostFeatures, keyReadError = false } = {}) {
  const store = new Map(Object.entries(seed).map(([name, value]) => [name, JSON.stringify(value)]));
  if (key) store.set('credentials', JSON.stringify({ api_key: key }));
  if (!key && !store.has('credentials')) store.set('credentials', JSON.stringify({ provider: 'finnhub' }));
  const { context } = makeContext({
    catalog, config, hostFeatures,
    invokes: {
      load_extension_data: ({ key }) => {
        if (keyReadError && key === 'credentials') throw new Error('Credential storage unavailable');
        return store.get(key) ?? null;
      },
      save_extension_data: ({ key, data }) => { store.set(key, data); },
      delete_extension_data: ({ key }) => { store.delete(key); },
      open_url: () => {},
    },
  });
  return { context, store, client: getClient(context) };
}

function init(Provider, h) {
  const provider = new Provider();
  provider.initialize(h.context);
  return provider;
}

async function settle(promise) {
  await vi.advanceTimersByTimeAsync(1400);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async (_, options) => ({
    status: 200, ok: true, headers: new Headers(),
    json: async () => {
      if (!options.body) return { c: 124, d: 1, dp: 0.82, t: NOW / 1000 };
      const { name, arguments: args } = JSON.parse(options.body).params;
      const file = name === 'get_stock_history' ? './get_stock_history.fixture.json' : './get_stock.fixture.json';
      const body = JSON.parse(JSON.parse(readFileSync(new URL(file, import.meta.url))).result.content[0].text);
      const data = name === 'get_stock_history' ? body : { symbols: Object.fromEntries(args.symbols.map((s) => [s, { ...body, symbol: s }])) };
      return { result: { content: [{ text: JSON.stringify(data) }] } };
    },
  })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Finnhub setup and migration', () => {
  it.each([undefined, ['config.manifest_defaults']])('normalizes retired config and exposes the provider selector on host features %j', async (hostFeatures) => {
    const settings = init(Settings, host({ hostFeatures, config: { provider: 'cache' } }));
    expect(settings.validate({ provider: 'cache', watchlist: 'aapl' })).toEqual({ valid: true });
    await settings.getSettings();
    expect(settings.normalize({ provider: 'cache', watchlist: 'aapl' })).toEqual({
      values: { provider: 'stocklake', watchlist: 'AAPL' },
    });
    const controls = (await settings.getSettings()).sections.flatMap((section) => section.controls);
    expect(controls.find((control) => control.id === '__provider').options.map((option) => option.value)).toEqual(['stocklake', 'finnhub']);
    expect(controls.find((control) => control.id === 'free_key').label).toBe(SETUP);
    expect(DEFAULTS).not.toHaveProperty('provider');
    const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url)));
    expect(manifest.config).not.toHaveProperty('provider');
  });

  it.each([{}, { quote_AAPL: saved }])('falls back from keyless Finnhub to Stocklake for retired config and saved cache %j', async (seed) => {
    const legacy = host({ config: { provider: 'cache' }, seed });
    const fresh = host({ seed });
    const expected = await fresh.client.getQuotes(['AAPL']);
    expect(await legacy.client.getQuotes(['AAPL'], legacy.context.config)).toEqual(expected);
    expect(await legacy.client.exactCache(['AAPL'], legacy.context.config)).toEqual(await fresh.client.exactCache(['AAPL']));
    expect(expected[0]).toMatchObject({ source: 'Stocklake', cached: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses a saved Finnhub key even before the retired provider field is normalized', async () => {
    const h = host({ config: { provider: 'cache' }, key: KEY });
    expect((await h.client.getQuotes(['AAPL'], h.context.config))[0]).toMatchObject({ cached: false, price: 124 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['stock aapl', '$AAPL', 'stock aapl msft', 'stock copy AAPL'])('routes pending and loaded %s to guest quotes without a setup nag', async (query) => {
    const h = host({ config: { provider: 'cache' } });
    const search = init(Search, h);
    expect((await search.execute(search.match(query)[0])).type).toBe(query.includes('copy') ? 'copy' : 'custom');
    const rows = await settle(search.matchAsync(query));
    expect(rows.some((row) => row.data.setup)).toBe(false);
    expect(rows[0].data.quote.source).toBe('Stocklake');
    expect((await search.execute(rows[0])).type).toBe(query.includes('copy') ? 'copy' : 'custom');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['stock aapl', '$AAPL'])('replaces old Finnhub caches with usable guest quotes for %s', async (query) => {
    const h = host({ config: { provider: 'cache' }, seed: { quote_AAPL: saved } });
    const search = init(Search, h);
    const rows = await settle(search.matchAsync(query));
    expect(rows.filter((row) => row.data.setup)).toHaveLength(0);
    const quote = rows.find((row) => row.data.quote && !row.data.copy);
    expect(quote.data.quote).toMatchObject({ cached: false, source: 'Stocklake' });
    expect(quote.description).toContain('Updated ');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { quote_AAPL: saved }])('shows no widget before setup, cached quotes or not, for %j', async (seed) => {
    const h = host({ config: { provider: 'cache', watchlist: 'AAPL MSFT' }, seed });
    expect(await init(Widget, h).render()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{}, { quote_AAPL: saved }])('gives opted-in agents guest quotes and on-demand history for %j', async (seed) => {
    const h = host({ config: { provider: 'cache', agent_tools: true }, seed });
    const tools = init(Tools, h);
    const quotes = await tools.execute('get_quote', { symbols: ['AAPL'] });
    expect(quotes.error).toBeUndefined();
    expect(quotes.result[0]).toMatchObject({ source: 'Stocklake', price: 342.37 });
    expect(quotes.result[0].asOf).toMatch(/Z$/);
    const history = await tools.execute('get_history', { symbol: 'AAPL' });
    expect(history.result).toMatchObject({ kind: 'daily_history', complete: true, range: '1m' });
    expect(history.result.samples).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps local history available when credential storage fails', async () => {
    const h = host({ config: { agent_tools: true }, seed: { quote_AAPL: saved }, keyReadError: true });
    const history = await init(Tools, h).execute('get_history', { symbol: 'AAPL' });
    expect(history.error).toBeUndefined();
    expect(history.result.samples).toHaveLength(1);
    expect(history.result.note).toContain('Locally sampled');
    expect(fetch).not.toHaveBeenCalled();
  });
});
