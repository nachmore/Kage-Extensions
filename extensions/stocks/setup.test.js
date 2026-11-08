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
  await vi.advanceTimersByTimeAsync(601);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 200, ok: true,
    json: async () => ({ c: 124, d: 1, dp: 0.82, t: NOW / 1000 }),
  })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Finnhub setup and migration', () => {
  it.each([undefined, ['config.manifest_defaults']])('normalizes the retired provider on host features %j without a selector', async (hostFeatures) => {
    const settings = init(Settings, host({ hostFeatures, config: { provider: 'cache' } }));
    expect(settings.validate({ provider: 'cache', watchlist: 'aapl' })).toEqual({ valid: true });
    expect(settings.normalize({ provider: 'cache', watchlist: 'aapl' })).toEqual({
      values: { provider: 'finnhub', watchlist: 'AAPL' },
    });
    const controls = (await settings.getSettings()).sections.flatMap((section) => section.controls);
    expect(controls.some((control) => control.id === 'provider' || control.type === 'select')).toBe(false);
    expect(controls.find((control) => control.id === 'free_key').label).toBe(SETUP);
    expect(DEFAULTS).not.toHaveProperty('provider');
    const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url)));
    expect(manifest.config).not.toHaveProperty('provider');
  });

  it.each([{}, { quote_AAPL: saved }])('treats an unmigrated provider exactly like default config, preserving cache %j', async (seed) => {
    const legacy = host({ config: { provider: 'cache' }, seed });
    const fresh = host({ seed });
    const expected = await fresh.client.getQuotes(['AAPL']);
    expect(await legacy.client.getQuotes(['AAPL'], legacy.context.config)).toEqual(expected);
    expect(await legacy.client.exactCache(['AAPL'], legacy.context.config)).toEqual(await fresh.client.exactCache(['AAPL']));
    expect(expected[0]).toMatchObject(seed.quote_AAPL
      ? { cached: true, stale: true, reason: 'setup', timestamp: saved.quote.timestamp }
      : { error: 'setup' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses a saved Finnhub key even before the retired provider field is normalized', async () => {
    const h = host({ config: { provider: 'cache' }, key: KEY });
    expect((await h.client.getQuotes(['AAPL'], h.context.config))[0]).toMatchObject({ cached: false, price: 124 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['stock aapl', '$AAPL', 'stock aapl msft', 'stock copy AAPL'])('routes pending and loaded %s to one setup action without a key', async (query) => {
    const h = host({ config: { provider: 'cache' } });
    const search = init(Search, h);
    expect(await search.execute(search.match(query)[0])).toEqual({ type: 'open_extension_settings' });
    const rows = await settle(search.matchAsync(query));
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe(SETUP);
    expect(await search.execute(rows[0])).toEqual({ type: 'open_extension_settings' });
    expect(h.context.invoke).not.toHaveBeenCalledWith('open_url', expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['stock aapl', '$AAPL'])('offers one setup action alongside cached quotes for %s', async (query) => {
    const h = host({ config: { provider: 'cache' }, seed: { quote_AAPL: saved } });
    const search = init(Search, h);
    const rows = await settle(search.matchAsync(query));
    const setup = rows.filter((row) => row.data.setup);
    expect(setup).toHaveLength(1);
    expect(setup[0].label).toBe(SETUP);
    const quote = rows.find((row) => row.data.quote && !row.data.copy);
    expect(quote.data.quote).toMatchObject({ cached: true, stale: true, reason: 'setup' });
    expect(quote.description).toContain(`As of ${timestampText(saved.quote.timestamp)}`);
    expect(quote.description).toContain('Cached ');
    expect(setup[0].score).toBeGreaterThan(quote.score);
    expect(await search.execute(setup[0])).toEqual({ type: 'open_extension_settings' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{}, { quote_AAPL: saved }])('shows no widget before setup, cached quotes or not, for %j', async (seed) => {
    const h = host({ config: { provider: 'cache', watchlist: 'AAPL MSFT' }, seed });
    expect(await init(Widget, h).render()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{}, { quote_AAPL: saved }])('guides both tools to setup while retaining cached quotes and history for %j', async (seed) => {
    const h = host({ config: { provider: 'cache', agent_tools: true }, seed });
    const tools = init(Tools, h);
    const quotes = await tools.execute('get_quote', { symbols: ['AAPL'] });
    expect(quotes.result[0].message).toContain(SETUP);
    if (seed.quote_AAPL) {
      expect(quotes.result[0]).toMatchObject({ cached: true, reason: 'setup', price: 123.45 });
      expect(quotes.result[0].tradeTime).toBe(new Date(saved.quote.timestamp * 1000).toISOString());
    } else {
      expect(quotes.error).toContain(SETUP);
    }
    const history = await tools.execute('get_history', { symbol: 'AAPL' });
    expect(history.result.note).toContain(SETUP);
    expect(history.result).toMatchObject({ kind: 'locally_sampled_quotes', complete: false });
    expect(history.result.samples).toHaveLength(seed.quote_AAPL ? 1 : 0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps local history available when credential storage fails', async () => {
    const h = host({ config: { agent_tools: true }, seed: { quote_AAPL: saved }, keyReadError: true });
    const history = await init(Tools, h).execute('get_history', { symbol: 'AAPL' });
    expect(history.error).toBeUndefined();
    expect(history.result.samples).toHaveLength(1);
    expect(history.result.note).toContain(catalog['error.storage'].message);
    expect(fetch).not.toHaveBeenCalled();
  });
});
