import { DEFAULTS, refreshSeconds } from './defaults.js';
import { getClient } from './client.js';
import { chartUrl, parseSymbols } from './symbols.js';
import { direction, errorText, escapeHtml, priceText, quoteDescription, signedText, sparkline } from './format.js';

export default class StocksWatchlistWidget {
  initialize(context) {
    this.client = getClient(context);
    this.invoke = context.invoke;
    this.config = context.config || {};
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
    this.symbols = [];
  }

  onConfigUpdate(config) { this.config = config || {}; }

  getRefreshInterval() { return refreshSeconds(this.config) * 1000; }

  async render() {
    if (this.config.enabled === false || !(this.config.show_watchlist ?? DEFAULTS.show_watchlist)) return null;
    // Current hosts skip hidden floating-window ticks themselves. Also pause
    // when the webview reports visibility, for hosts without that behavior.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return null;
    try {
      this.symbols = parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist, { allowEmpty: true });
    } catch (error) {
      return { className: 'stocks-widget', html: `<span>${escapeHtml(errorText(error.code, this.t))}</span>` };
    }
    if (!this.symbols.length) return null;
    const quotes = await this.client.getQuotes(this.symbols, this.config);
    const html = await Promise.all(quotes.map(async (quote, index) => {
      if (quote.error) {
        return `<span class="stocks-tile"><strong>${escapeHtml(quote.symbol)}</strong><small>${escapeHtml(errorText(quote.error, this.t))}</small></span>`;
      }
      const history = await this.client.getHistory(quote.symbol, '1d');
      return `<button class="stocks-tile stocks-${direction(quote)}" data-ext-action="chart:${index}" title="${escapeHtml(quoteDescription(quote, this.t))}"><strong>${escapeHtml(quote.symbol)} ${priceText(quote.price)}</strong><span>${signedText(quote.change)} (${signedText(quote.percent, { percent: true })})</span>${sparkline(history.samples, this.t('quote.sampled'))}<small>${escapeHtml(quoteDescription(quote, this.t))}</small></button>`;
    }));
    return {
      className: 'extension-bar stocks-widget',
      html: `<span class="stocks-source">📈 <a href="https://finnhub.io/">${escapeHtml(this.t('quote.source'))}</a></span><span class="stocks-tiles">${html.join('')}</span>`,
      actions: this.symbols.map((symbol, index) => ({ id: `chart:${index}`, rpc: `chart:${index}` })),
    };
  }

  async onAction(action) {
    const match = /^chart:(\d+)$/.exec(action || '');
    const symbol = match ? this.symbols[Number(match[1])] : null;
    if (symbol) await this.invoke('open_url', { url: chartUrl(symbol) });
    return { rerender: false };
  }
}
