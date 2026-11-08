import { DEFAULTS } from './defaults.js';
import { getClient } from './client.js';
import { chartUrl, normalizeSymbol, parseQuery, parseSymbols } from './symbols.js';
import { copyText, direction, errorText, escapeHtml, priceText, quoteDescription, signedText, sparkline } from './format.js';

export default class StocksSearchProvider {
  initialize(context) {
    this.client = getClient(context);
    this.invoke = context.invoke;
    this.config = context.config || {};
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
    this.locale = context.i18n?.language?.();
    this.generation = 0;
    this.configRevision = 0;
    this.historySamples = new Map();
  }

  onConfigUpdate(config) { this.config = config || {}; this.configRevision++; }

  // Hybrid content matcher: getKeywords would suppress "$AAPL".
  match(query) {
    this.generation++;
    this.query = query;
    if (this.config.enabled === false) return [];
    const parsed = parseQuery(query);
    if (!parsed) return [];
    if (parsed.error) return [this.errorRow('', parsed.error, parsed.copy)];
    const symbols = parsed.symbols;
    return [{
      id: 'stocks:loading', type: 'stocks', icon: '📈', score: 90,
      label: this.t('result.loading'),
      description: this.t('result.help'),
      data: { pending: true, symbols, copy: parsed.copy, query },
    }];
  }

  async matchAsync(query) {
    const generation = ++this.generation;
    this.query = query;
    if (this.config.enabled === false) return [];
    const parsed = parseQuery(query);
    if (!parsed) return [];
    if (parsed.error) return [this.errorRow('', parsed.error, parsed.copy)];
    const current = () => generation === this.generation && this.config.enabled !== false;
    let connection;
    try { connection = await this.client.connection(this.config); } catch { /* Client reports storage below. */ }
    if (!current()) return this.config.enabled === false ? [this.disabledRow()] : [];
    let symbols = parsed.symbols;
    if (!symbols.length) {
      if (connection?.provider === 'stocklake' && !connection.key) return [this.helpRow(query)];
      try { symbols = parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist); }
      catch (error) { return [this.errorRow('', error.code, parsed.copy)]; }
    }
    const cacheRevision = this.configRevision;
    let quotes = await this.client.exactCache(symbols, this.config, { shouldContinue: current });
    if (generation !== this.generation) return [];
    if (cacheRevision !== this.configRevision) {
      return this.config.enabled === false ? [this.disabledRow()] : this.matchAsync(query);
    }
    if (!quotes) {
      await new Promise((resolve) => setTimeout(resolve, !connection || (connection.provider === 'stocklake' && !connection.key) ? 1300 : 600));
      if (generation !== this.generation) return [];
      if (this.config.enabled === false) return [this.disabledRow()];
      // Config broadcasts do not supersede the query. Complete its loading
      // row using the latest settings instead of leaving the placeholder.
      if (!parsed.symbols.length) {
        try { connection = await this.client.connection(this.config); } catch { /* Client reports storage. */ }
        if (!current()) return [];
        if (connection?.provider === 'stocklake' && !connection.key) return [this.helpRow(query)];
        try { symbols = parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist); }
        catch (error) { return [this.errorRow('', error.code, parsed.copy)]; }
      }
      const revision = this.configRevision;
      quotes = await this.client.getQuotes(symbols, this.config, { shouldContinue: current });
      if (revision !== this.configRevision && generation === this.generation) {
        return this.config.enabled === false ? [this.disabledRow()] : this.matchAsync(query);
      }
    }
    if (generation !== this.generation) return [];
    const histories = await Promise.all(quotes.map(async (quote) => {
      if (quote.error || !current()) return { samples: [] };
      try { return await this.client.getHistory(quote.symbol, '1m', quote, this.config, { cachedOnly: true }); }
      catch { return { samples: [] }; }
    }));
    if (!current()) return [];
    const results = [];
    for (const [index, quote] of quotes.entries()) {
      if (quote.error) {
        if (quote.error === 'setup') continue;
        results.push(this.errorRow(quote.symbol, quote.error, parsed.copy, query, quote.retryAt));
        continue;
      }
      const history = histories[index];
      const label = `${quote.symbol}${quote.name ? ` · ${quote.name}` : ''}  ${priceText(quote.price, { locale: this.locale, currency: quote.currency })}  ${signedText(quote.change, { price: quote.price, locale: this.locale })} (${signedText(quote.percent, { percent: true, locale: this.locale })})`;
      const row = {
        id: `stocks:${quote.symbol}`, type: 'stocks', icon: '📈', score: 95,
        label, description: quoteDescription(quote, this.t, this.locale),
        data: { quote, samples: history.samples, copy: parsed.copy, query, generation },
      };
      results.push(row);
      // The host ignores return actions from onResultAction. A separate
      // selectable copy action uses its supported execute()->copy path.
      if (!parsed.copy) results.push({
        id: `stocks:copy:${quote.symbol}`, type: 'stocks', icon: '📋', score: 80,
        label: this.t('result.copy', { text: copyText(quote) }),
        description: quoteDescription(quote, this.t, this.locale),
        data: { quote, copy: true, query },
      });
    }
    // One setup action for the whole query, alongside any saved quotes.
    if (quotes.some((quote) => (quote.error || quote.reason) === 'setup')) {
      results.push(this.errorRow('', 'setup', parsed.copy));
    }
    if (connection?.key && connection.provider === 'stocklake') {
      // Return rows before starting optional history. The host has no search
      // push-update API; completed samples are available on subsequent renders.
      setTimeout(() => {
        if (!current()) return;
        this.historyWork = Promise.all(quotes.filter((quote) => !quote.error).map(async (quote) => {
          if (!current()) return;
          try {
            const history = await this.client.getHistory(quote.symbol, '1m', quote, this.config, { shouldContinue: current });
            if (current()) this.historySamples.set(quote.symbol, history.samples);
          } catch { /* Optional history never hides a quote. */ }
        }));
      }, 0);
    }
    return results;
  }

  helpRow(query) {
    return { id: 'stocks:help', type: 'stocks', icon: '📈', score: 90,
      label: this.t('manifest.name'), description: this.t('result.type_symbol'), data: { help: true, query } };
  }

  errorRow(symbol, code, copy = false, query = this.query, retryAt = null) {
    return {
      id: `stocks:error:${symbol || code}`, type: 'stocks', icon: '📈', score: code === 'setup' ? 100 : 90,
      label: code === 'setup' ? this.t('setup.free_key') : symbol || this.t('manifest.name'),
      description: code === 'setup' ? this.t('error.setup') : errorText(code, this.t, { retryAt, locale: this.locale }),
      data: { setup: ['setup', 'auth', 'daily_limit', 'key_daily_limit'].includes(code), code, symbol, copy, query },
    };
  }

  async execute(result) {
    this.generation++;
    if (this.config.enabled === false) return this.keepInput(result);
    if (result?.data?.setup) return { type: 'open_extension_settings' };
    if (['daily_limit', 'key_daily_limit'].includes(result?.data?.quote?.reason)) return { type: 'open_extension_settings' };
    if (result?.data?.help) return this.keepInput(result);
    const bare = /^stock\s*$/i.test(result?.data?.query ?? this.query ?? '');
    if (bare && ['setup', 'auth', 'storage'].includes(result?.data?.code || result?.data?.quote?.reason)) {
      return { type: 'open_extension_settings' };
    }
    if (result?.data?.pending) {
      let symbols = result.data.symbols || [];
      let provider = 'stocklake';
      try {
        const connection = await this.client.connection(this.config);
        provider = connection.provider;
        if (connection.provider === 'finnhub' && !connection.key) return { type: 'open_extension_settings' };
        if (!symbols.length) {
          if (connection.provider === 'stocklake' && !connection.key) return this.keepInput(result);
          symbols = parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist, { allowEmpty: true });
          if (bare) {
            const quotes = await this.client.exactCache(symbols, this.config);
            if (quotes?.some((quote) => ['setup', 'auth', 'storage'].includes(quote.error || quote.reason))) {
              return { type: 'open_extension_settings' };
            }
          }
        }
      } catch (error) {
        return bare && error.code === 'storage' ? { type: 'open_extension_settings' } : this.keepInput(result);
      }
      symbols = symbols.filter((symbol) => {
        try { normalizeSymbol(symbol, provider); return true; } catch { return false; }
      });
      if (!symbols.length) return this.keepInput(result);
      if (result.data.copy) {
        const [quote] = await this.client.getQuotes([symbols[0]], this.config);
        if (!quote) return this.keepInput(result);
        return quote.error ? this.execute(this.errorRow(quote.symbol, quote.error, true, result.data.query))
          : { type: 'copy', value: copyText(quote) };
      }
      try { await this.invoke('open_url', { url: chartUrl(symbols[0]) }); }
      catch { return null; }
      return { type: 'custom', data: {} };
    }
    const quote = result?.data?.quote;
    if (!quote) {
      try {
        if (result?.data?.copy || ['unknown', 'invalid_symbols'].includes(result?.data?.code)) return this.keepInput(result);
        if (!result?.data?.symbol) return this.keepInput(result);
        await this.invoke('open_url', { url: chartUrl(result.data.symbol) });
        return { type: 'custom', data: {} };
      } catch { return this.keepInput(result); }
    }
    if (result.data.copy) return { type: 'copy', value: copyText(quote) };
    await this.invoke('open_url', { url: chartUrl(quote.symbol) });
    return { type: 'custom', data: {} };
  }

  keepInput(result) { return { type: 'replace_input', value: result?.data?.query ?? this.query ?? '' }; }

  disabledRow() {
    return { ...this.errorRow('', 'disabled'), description: this.t('tool.disabled') };
  }

  renderCustom(result) {
    const quote = result?.data?.quote;
    if (!quote || result.data.copy) return null;
    return {
      className: 'stocks-result',
      html: `<span class="app-icon">📈</span><span class="app-info"><span class="app-name stocks-${direction(quote)}">${escapeHtml(result.label)}</span><span class="app-description">${escapeHtml(result.description)}</span></span><span class="stocks-${direction(quote)}">${sparkline(result.data.samples?.length ? result.data.samples : this.historySamples.get(quote.symbol) || [], this.t(quote.source === 'Stocklake' ? 'quote.history' : 'quote.sampled'))}</span>`,
    };
  }
}
