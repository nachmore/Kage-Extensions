import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeContext } from '../../test-helpers/mock-context.mjs';
import { getClient } from './client.js';
import { parseQuery } from './symbols.js';
import { copyText } from './format.js';
import { refreshSeconds } from './defaults.js';
import Search from './search.js';
import Settings from './settings.js';
import Tools from './tools.js';
import Widget from './widget.js';

const NOW = Date.parse('2026-11-06T16:20:40.417Z');
const KEY = 'final-fixture-key';
const catalog = JSON.parse(readFileSync(new URL('./_locales/en/messages.json', import.meta.url)));
const quote = (symbol = 'AAPL', fetchedAt = NOW) => ({
  quote: { symbol, price: 123.45, change: 1, percent: 0.82, timestamp: Math.floor(NOW / 1000) },
  fetchedAt, samples: [],
});
function host({ key = KEY, seed = {}, config = {}, hook, hostFeatures } = {}) {
  const store = new Map(Object.entries(seed).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]));
  if (key) store.set('credentials', JSON.stringify({ api_key: key }));
  if (!key && !store.has('credentials')) store.set('credentials', JSON.stringify({ provider: 'finnhub' }));
  const { context } = makeContext({ catalog, config, hostFeatures });
  context.invoke = vi.fn(async (command, args) => {
    const override = await hook?.(command, args, store);
    if (override !== undefined) return override;
    if (command === 'load_extension_data') return store.get(args.key) ?? null;
    if (command === 'save_extension_data') store.set(args.key, args.data);
    if (command === 'delete_extension_data') store.delete(args.key);
    return null;
  });
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
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 200, ok: true,
    json: async () => ({ c: 123.45, d: 1, dp: 0.82, t: Math.floor(Date.now() / 1000) }),
  })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SF1: raw typing never skips settling on a cache miss', () => {
  it.each([120, 180, 250, 400])('avoids requests and negative files at %i ms/key', async (perKey) => {
    for (const text of ['stock price of nvda', 'stock picks for 2026', 'stock up or down', '$PATH is not set']) {
      const h = host();
      const search = init(Search, h);
      const pending = [];
      for (let i = 1; i <= text.length; i++) {
        const query = text.slice(0, i);
        search.match(query);
        pending.push(search.matchAsync(query));
        await vi.advanceTimersByTimeAsync(perKey);
      }
      await drive(Promise.all(pending));
      expect(fetch).not.toHaveBeenCalled();
      expect([...h.store.keys()].filter((name) => name.startsWith('quote_'))).toEqual([]);
    }
  });
});

describe('SF2: prose and ambiguous tickers', () => {
  it.each(['stock photos', 'stock trading app reviews', ...'price prices news tips ideas picks market today now help'.split(' ').map((word) => `stock ${word}`)])('leaves %s to the agent', async (query) => {
    const search = init(Search, host());
    expect(parseQuery(query)).toBeNull();
    expect(search.match(query)).toEqual([]);
    expect(await search.matchAsync(query)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['stock a', ['A']], ['stock f', ['F']], ['stock on', ['ON']], ['stock up', ['UP']],
    ['$NOW', ['NOW']], ['stock copy NOW', ['NOW']], ['$aapl,$msft', ['AAPL', 'MSFT']],
    ['Stock AAPL', ['AAPL']], ['stock BRK.B', ['BRK.B']],
  ])('preserves legitimate input %s', (query, symbols) => {
    expect(parseQuery(query)?.symbols).toEqual(symbols);
  });
});

describe('SF3: copy failures retain the command', () => {
  it.each(['429', '500', 'offline', 'budget'])('keeps pending and loaded copy errors on %s', async (failure) => {
    fetch.mockImplementation(async () => {
      if (failure === 'offline') throw new Error('offline');
      const status = Number(failure) || 200;
      return { status, ok: status === 200, json: async () => ({ c: 123, t: Date.now() / 1000 }) };
    });
    const h = host({ seed: failure === 'budget' ? { request_budget: { attempts: Array(40).fill(NOW) } } : {} });
    const search = init(Search, h);
    const query = 'stock copy AAPL';
    expect(await drive(search.execute(search.match(query)[0]))).toEqual({ type: 'replace_input', value: query });
    const rows = await drive(search.matchAsync(query));
    expect(rows[0].data.copy).toBe(true);
    expect(await search.execute(rows[0])).toEqual({ type: 'replace_input', value: query });
    expect(h.context.invoke.mock.calls.filter(([cmd]) => cmd === 'open_url')).toEqual([]);
  });
  it.each(['setup', 'auth'])('still opens settings for a copy %s failure', async (code) => {
    const search = init(Search, host());
    expect(await search.execute(search.errorRow('AAPL', code, true))).toEqual({ type: 'open_extension_settings' });
  });
});

describe('SF4: honest deletion and ICU counts', () => {
  it('reports two failures out of 13 and retries only the remaining records', async () => {
    const symbols = Array.from({ length: 13 }, (_, i) => `T${i}`);
    let fail = true;
    const h = host({ config: { watchlist: '' }, seed: {
      qidx: { symbols: Object.fromEntries(symbols.map((symbol) => [symbol, true])), prunedAt: NOW },
      ...Object.fromEntries(symbols.map((symbol) => [`quote_${symbol}`, quote(symbol)])),
    }, hook(cmd, args) {
      if (fail && ((cmd === 'load_extension_data' && args.key === 'quote_T5')
        || (cmd === 'delete_extension_data' && args.key === 'quote_T3'))) throw new Error('I/O');
    } });
    h.context.i18n.t = vi.fn(() => 'translated deletion status');
    const settings = init(Settings, h);
    expect((await drive(settings.runAction('delete_quotes'))).status).toBe('translated deletion status');
    expect(h.context.i18n.t).toHaveBeenCalledWith('settings.quotes_deleted', { deleted: 11, failed: 2 });
    expect([...h.store.keys()].filter((name) => name.startsWith('quote_')).sort()).toEqual(['quote_T3', 'quote_T5']);
    expect(JSON.parse(h.store.get('qidx')).symbols).toEqual({ T3: true, T5: true });
    fail = false;
    expect(await drive(h.client.deleteQuotes())).toEqual({ deleted: 2, failed: 0 });
    expect([...h.store.keys()].filter((name) => name.startsWith('quote_'))).toEqual([]);
  });
  it('provides ICU plurals for both counts in every catalog', () => {
    for (const locale of ['ar', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'uk', 'ur', 'vi', 'zh-CN', 'zh-TW']) {
      const message = JSON.parse(readFileSync(new URL(`./_locales/${locale}/messages.json`, import.meta.url)))['settings.quotes_deleted'].message;
      expect(message).toContain('{deleted, plural,');
      expect(message).toContain('{failed, plural, =0 {} one {');
      expect(message).not.toContain('{count}');
      expect(message).not.toContain('undefined');
    }
  });
});

describe('SF5: widget connection hints open settings', () => {
  it.each(['setup', 'auth', 'storage'])('routes a cached bare stock row with %s to settings', async (reason) => {
    const h = host({ key: reason === 'setup' ? null : KEY, seed: {
      quote_AAPL: quote(),
      ...(reason === 'auth' || reason === 'storage' ? { request_budget: { attempts: [], backoffUntil: NOW + 60_000, backoffReason: reason } } : {}),
    }, config: { watchlist: 'AAPL' } });
    if (reason === 'auth' || reason === 'storage') {
      // A stale cache forces the shared auth/storage pause to surface.
      h.store.set('quote_AAPL', JSON.stringify(quote('AAPL', NOW - 600_000)));
    }
    const search = init(Search, h);
    const rows = await drive(search.matchAsync('stock'));
    expect(rows[0].data.quote.reason).toBe(reason);
    expect(await search.execute(rows[0])).toEqual({ type: 'open_extension_settings' });
    expect(h.context.invoke.mock.calls.filter(([cmd]) => cmd === 'open_url')).toEqual([]);
    // Explicit symbols still open charts for saved quotes.
    const explicit = await drive(search.matchAsync('$AAPL'));
    expect(await search.execute(explicit[0])).toEqual({ type: 'custom', data: {} });
  });
  it('opens settings on pending bare stock without a saved key', async () => {
    const search = init(Search, host({ key: null }));
    expect(await search.execute(search.match('stock')[0])).toEqual({ type: 'open_extension_settings' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('SF6: refresh cadence under tick jitter', () => {
  it('refreshes every minute through 100 variable ticks, also at exactCache boundaries', async () => {
    const h = host({ config: { watchlist: 'AAPL', refresh_seconds: 60 } });
    const widget = init(Widget, h);
    for (let tick = 0; tick < 100; tick++) {
      // Deterministic 0–16 ms lateness includes earlier ticks after later ones.
      vi.setSystemTime(NOW + tick * 60_000 + (tick * 13) % 17);
      if (tick) expect(await h.client.exactCache(['AAPL'], h.context.config)).toBeNull();
      await drive(widget.render(), 1500);
      expect(fetch).toHaveBeenCalledTimes(tick + 1);
      expect((await h.client.exactCache(['AAPL'], h.context.config))[0].cached).toBe(true);
      await vi.advanceTimersByTimeAsync(20);
    }
  });
  it.each([[61, 60], [89, 60], [90, 120], [119, 120], [3500, 3480]])('rounds %i seconds to the nearest minute (%i)', (seconds, expected) => {
    expect(refreshSeconds({ refresh_seconds: seconds })).toBe(expected);
    expect(init(Settings, host()).normalize({ refresh_seconds: seconds }).values.refresh_seconds).toBe(expected);
  });
});

describe('final nits: storage and tool output', () => {
  it('keeps per-symbol messages in the host-visible no-key error and never echoes $$$ as $$', async () => {
    const tools = init(Tools, host({ key: null, config: { agent_tools: true } }));
    const result = await tools.execute('get_quote', { symbols: ['AAPL', 'VOD.L', '$$$'] });
    expect(result.error).toContain('AAPL:');
    expect(result.error).toContain('VOD.L:');
    expect(result.error).toContain(catalog['error.invalid_symbols'].message);
    expect(JSON.stringify(result)).not.toContain('$$');
  });
  it('translates the locally sampled history note and omits missing copy percentages', async () => {
    const h = host({ config: { agent_tools: true } });
    const translate = vi.fn(() => 'translated sampled-quote warning');
    h.client.t = translate;
    h.context.i18n.t = translate;
    const result = await init(Tools, h).execute('get_history', { symbol: 'AAPL' });
    expect(result.result.note).toBe('translated sampled-quote warning');
    expect(h.context.i18n.t).toHaveBeenCalledWith('quote.sampled');
    expect(copyText({ ...quote().quote, percent: null })).toBe('AAPL 123.45');
  });
  it('surfaces INDEX migration I/O as a row instead of rejecting the search', async () => {
    const h = host({ hook(cmd, args) {
      if (cmd === 'load_extension_data' && args.key === 'qidx') throw new Error('I/O');
    } });
    const search = init(Search, h);
    const rows = await drive(search.matchAsync('stock INDEX'));
    expect(rows[0].data.code).toBe('storage');
    expect(fetch).not.toHaveBeenCalled();
    expect(h.store.has('quote_INDEX')).toBe(false);
  });
  it('continues tracking after a sample-trim write failure and removes the migrated index', async () => {
    const entry = quote();
    entry.samples = [{ timestamp: NOW / 1000 - 32 * 86_400, price: 123 }];
    const h = host({ seed: {
      quote_AAPL: entry, quote_MSFT: quote('MSFT'),
      quote_index: { symbols: { AAPL: true }, prunedAt: 0 },
    }, hook(cmd, args) {
      if (cmd === 'save_extension_data' && args.key === 'quote_AAPL') throw new Error('I/O');
    } });
    await h.client.maintainQuotes(['MSFT']);
    expect(JSON.parse(h.store.get('qidx')).symbols).toEqual({ AAPL: true, MSFT: true });
    expect(h.store.has('quote_index')).toBe(false);
    expect(JSON.parse(h.store.get('quote_AAPL')).samples).toHaveLength(1);
  });
  it('renews the index lease throughout a long Delete', async () => {
    const symbols = Array.from({ length: 20 }, (_, i) => `T${i}`);
    let renewals = 0;
    const h = host({ seed: {
      qidx: { symbols: Object.fromEntries(symbols.map((symbol) => [symbol, true])), prunedAt: NOW },
      ...Object.fromEntries(symbols.map((symbol) => [`quote_${symbol}`, quote(symbol)])),
    }, async hook(cmd, args, store) {
      if (cmd === 'delete_extension_data' && args.key.startsWith('quote_')) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(JSON.parse(store.get('qidx_lock')).expiresAt).toBeGreaterThan(Date.now());
      }
      if (cmd === 'save_extension_data' && args.key === 'qidx_lock' && JSON.parse(args.data).expiresAt > 0) renewals++;
    } });
    expect(await drive(h.client.deleteQuotes(), 12_000)).toEqual({ deleted: 20, failed: 0 });
    expect(renewals).toBeGreaterThan(5);
    expect(JSON.parse(h.store.get('qidx_lock')).expiresAt).toBe(0);
  });
});

describe('SF7: generic Save on old hosts', () => {
  it.each([undefined, []])('removes typed keys with hostFeatures %j', (hostFeatures) => {
    const settings = init(Settings, host({ hostFeatures }));
    const values = { watchlist: 'aapl', __api_key: KEY, __replacement_key_2: KEY, __future_secret: KEY };
    const clean = settings.normalize(values).values;
    expect(clean).toEqual({ watchlist: 'AAPL', ...(!hostFeatures ? {
      __api_key: '', __replacement_key_2: '', __future_secret: '',
    } : {}) });
    const persisted = hostFeatures ? clean : { ...values, ...clean };
    expect(JSON.stringify(persisted)).not.toContain(KEY);
  });
});
