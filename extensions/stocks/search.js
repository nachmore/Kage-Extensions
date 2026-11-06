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
  }

  onConfigUpdate(config) { this.config = config || {}; this.configRevision++; }

  // Hybrid content matcher: getKeywords would suppress "$AAPL".
  match(query) {
    this.generation++;
    this.query = query;
    if (this.config.enabled === false) return [];
    const parsed = parseQuery(query);
    if (!parsed) return [];
    if (parsed.error) return [this.errorRow('', parsed.error)];
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
    if (parsed.error) return [this.errorRow('', parsed.error)];
    let symbols = parsed.symbols;
    if (!symbols.length) {
      try { symbols = parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist); }
      catch (error) { return [this.errorRow('', error.code)]; }
    }
    const cacheRevision = this.configRevision;
    let quotes = await this.client.exactCache(symbols, this.config);
    if (generation !== this.generation) return [];
    if (cacheRevision !== this.configRevision) {
      return this.config.enabled === false ? [this.disabledRow()] : this.matchAsync(query);
    }
    if (!quotes) {
      if (!/[\s,]$/.test(query)) await new Promise((resolve) => setTimeout(resolve, 600));
      if (generation !== this.generation) return [];
      if (this.config.enabled === false) return [this.disabledRow()];
      // Config broadcasts do not supersede the query. Complete its loading
      // row using the latest settings instead of leaving the placeholder.
      if (!parsed.symbols.length) {
        try { symbols = parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist); }
        catch (error) { return [this.errorRow('', error.code)]; }
      }
      const revision = this.configRevision;
      quotes = await this.client.getQuotes(symbols, this.config);
      if (revision !== this.configRevision && generation === this.generation) {
        return this.config.enabled === false ? [this.disabledRow()] : this.matchAsync(query);
      }
    }
    if (generation !== this.generation) return [];
    const results = [];
    for (const quote of quotes) {
      if (quote.error) {
        results.push(this.errorRow(quote.symbol, quote.error));
        continue;
      }
      const history = await this.client.getHistory(quote.symbol, '1d', quote);
      const label = `${quote.symbol}${quote.name ? ` · ${quote.name}` : ''}  ${priceText(quote.price, { locale: this.locale })}  ${signedText(quote.change, { price: quote.price, locale: this.locale })} (${signedText(quote.percent, { percent: true, locale: this.locale })})`;
      const row = {
        id: `stocks:${quote.symbol}`, type: 'stocks', icon: '📈', score: 95,
        label, description: quoteDescription(quote, this.t, this.locale),
        data: { quote, samples: history.samples, copy: parsed.copy },
      };
      results.push(row);
      // The host ignores return actions from onResultAction. A separate
      // selectable copy action uses its supported execute()->copy path.
      if (!parsed.copy) results.push({
        id: `stocks:copy:${quote.symbol}`, type: 'stocks', icon: '📋', score: 80,
        label: this.t('result.copy', { text: copyText(quote) }),
        description: quoteDescription(quote, this.t, this.locale),
        data: { quote, copy: true },
      });
    }
    return results;
  }

  errorRow(symbol, code) {
    return {
      id: `stocks:error:${symbol || code}`, type: 'stocks', icon: '📈', score: 90,
      label: symbol || this.t('manifest.name'),
      description: errorText(code, this.t),
      data: { setup: ['setup', 'auth'].includes(code), code, symbol, query: this.query },
    };
  }

  async execute(result) {
    this.generation++;
    if (this.config.enabled === false) return this.keepInput(result);
    if (result?.data?.setup) return { type: 'open_extension_settings' };
    if (result?.data?.pending) {
      let symbols = result.data.symbols || [];
      if (!symbols.length) {
        try {
          if (!(await this.client.key())) return { type: 'open_extension_settings' };
          symbols = parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist, { allowEmpty: true });
        } catch { return this.keepInput(result); }
      }
      symbols = symbols.filter((symbol) => {
        try { normalizeSymbol(symbol); return true; } catch { return false; }
      });
      if (!symbols.length) return this.keepInput(result);
      if (result.data.copy) {
        const [quote] = await this.client.getQuotes([symbols[0]], this.config);
        return quote?.error ? this.execute(this.errorRow(quote.symbol, quote.error))
          : { type: 'copy', value: copyText(quote) };
      }
      try { await this.invoke('open_url', { url: chartUrl(symbols[0]) }); }
      catch { return null; }
      return { type: 'custom', data: {} };
    }
    const quote = result?.data?.quote;
    if (!quote) {
      try {
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
      html: `<span class="app-icon">📈</span><span class="app-info"><span class="app-name stocks-${direction(quote)}">${escapeHtml(result.label)}</span><span class="app-description">${escapeHtml(result.description)}</span></span><span class="stocks-${direction(quote)}">${sparkline(result.data.samples || [], this.t('quote.sampled'))}</span>`,
    };
  }
}
