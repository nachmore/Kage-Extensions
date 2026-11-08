import { DEFAULTS, MIN_REFRESH_SECONDS } from './defaults.js';
import { getClient } from './client.js';
import { chartUrl, parseSymbols } from './symbols.js';
import { direction, errorText, escapeHtml, priceText, quoteDescription, signedText, sparkline } from './format.js';

export default class StocksWatchlistWidget {
  initialize(context) {
    this.client = getClient(context);
    this.invoke = context.invoke;
    this.config = context.config || {};
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
    this.locale = context.i18n?.language?.();
    this.symbols = [];
  }

  onConfigUpdate(config) { this.config = config || {}; }

  getRefreshInterval() { return MIN_REFRESH_SECONDS * 1000; }

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
    // Not set up yet (no key): no watchlist and no nagging. Typing `stock` or
    // `$AAPL` is what leads to setup, when the user actually wants quotes.
    if (quotes.some((quote) => (quote.error || quote.reason) === 'setup')) return null;
    const connection = quotes.find((quote) => ['auth', 'storage'].includes(quote.error || quote.reason));
    const hint = this.t('widget.connection');
    if (quotes.every((quote) => ['auth', 'storage'].includes(quote.error))) {
      return { className: 'stocks-widget', html: `<span>${escapeHtml(hint)}</span>` };
    }
    const html = await Promise.all(quotes.map(async (quote) => {
      if (quote.error) {
        if (connection && ['auth', 'storage'].includes(quote.error)) return '';
        return `<span class="stocks-tile"><strong>${escapeHtml(quote.symbol)}</strong><small>${escapeHtml(errorText(quote.error, this.t))}</small></span>`;
      }
      const history = await this.client.getHistory(quote.symbol, '1d', quote);
      const description = quoteDescription(connection ? { ...quote, reason: null } : quote, this.t, this.locale);
      return `<button class="stocks-tile stocks-${direction(quote)}" data-ext-action="chart:${escapeHtml(quote.symbol)}" title="${escapeHtml(description)}"><strong>${escapeHtml(quote.symbol)} ${priceText(quote.price, { locale: this.locale })}</strong><span>${signedText(quote.change, { price: quote.price, locale: this.locale })} (${signedText(quote.percent, { percent: true, locale: this.locale })})</span>${sparkline(history.samples, this.t('quote.sampled'))}<small>${escapeHtml(description)}</small></button>`;
    }));
    return {
      className: 'extension-bar stocks-widget',
      html: `<span class="stocks-source">📈 <a href="https://finnhub.io/">${escapeHtml(this.t('quote.source'))}</a>${connection ? ` · ${escapeHtml(hint)}` : ''}</span><span class="stocks-tiles">${html.join('')}</span>`,
      actions: quotes.filter((quote) => !quote.error).map(({ symbol }) => ({ id: `chart:${symbol}`, rpc: `chart:${symbol}` })),
    };
  }

  async onAction(action) {
    const match = /^chart:([A-Z0-9.-]+)$/.exec(action || '');
    try {
      const symbols = parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist, { allowEmpty: true });
      if (match && symbols.includes(match[1])) await this.invoke('open_url', { url: chartUrl(match[1]) });
    } catch { /* Ignore stale/invalid tile actions after a config change. */ }
    return { rerender: false };
  }
}
