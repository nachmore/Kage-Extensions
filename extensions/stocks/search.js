import { DEFAULTS } from './defaults.js';
import { getClient } from './client.js';
import { chartUrl, parseQuery, parseSymbols } from './symbols.js';
import { copyText, direction, errorText, escapeHtml, priceText, quoteDescription, signedText, sparkline } from './format.js';

export default class StocksSearchProvider {
  initialize(context) {
    this.client = getClient(context);
    this.invoke = context.invoke;
    this.config = context.config || {};
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
  }

  onConfigUpdate(config) { this.config = config || {}; }

  // Hybrid content matcher: getKeywords would suppress "$AAPL".
  match(query) {
    if (this.config.enabled === false) return [];
    const parsed = parseQuery(query);
    if (!parsed) return [];
    if (parsed.error) return [this.errorRow('', parsed.error)];
    return [{
      id: 'stocks:loading', type: 'stocks', icon: '📈', score: 90,
      label: this.t('result.loading'),
      description: this.t('result.help'),
      data: { setup: true },
    }];
  }

  async matchAsync(query) {
    if (this.config.enabled === false) return [];
    const parsed = parseQuery(query);
    if (!parsed) return [];
    if (parsed.error) return [this.errorRow('', parsed.error)];
    let symbols = parsed.symbols;
    if (!symbols.length) {
      try { symbols = parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist); }
      catch (error) { return [this.errorRow('', error.code)]; }
    }
    const quotes = await this.client.getQuotes(symbols, this.config);
    const results = [];
    for (const quote of quotes) {
      if (quote.error) {
        results.push(this.errorRow(quote.symbol, quote.error));
        continue;
      }
      const history = await this.client.getHistory(quote.symbol, '1d');
      const label = `${quote.symbol}${quote.name ? ` · ${quote.name}` : ''}  ${priceText(quote.price)}  ${signedText(quote.change)} (${signedText(quote.percent, { percent: true })})`;
      const row = {
        id: `stocks:${quote.symbol}`, type: 'stocks', icon: '📈', score: 95,
        label, description: quoteDescription(quote, this.t),
        data: { quote, samples: history.samples, copy: parsed.copy },
      };
      results.push(row);
      // The host ignores return actions from onResultAction. A separate
      // selectable copy action uses its supported execute()->copy path.
      if (!parsed.copy) results.push({
        id: `stocks:copy:${quote.symbol}`, type: 'stocks', icon: '📋', score: 80,
        label: this.t('result.copy', { text: copyText(quote) }),
        description: quoteDescription(quote, this.t),
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
      data: { setup: true },
    };
  }

  async execute(result) {
    if (result?.data?.setup) return { type: 'open_extension_settings' };
    const quote = result?.data?.quote;
    if (!quote) return null;
    if (result.data.copy) return { type: 'copy', value: copyText(quote) };
    await this.invoke('open_url', { url: chartUrl(quote.symbol) });
    return { type: 'custom', data: {} };
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
