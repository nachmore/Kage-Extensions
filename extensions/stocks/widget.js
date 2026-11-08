// i18n-keys: quote.source
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
    const startedAt = Date.now();
    if (this.config.enabled === false || !(this.config.show_watchlist ?? DEFAULTS.show_watchlist)) return null;
    // Current hosts skip hidden floating-window ticks themselves. Also pause
    // when the webview reports visibility, for hosts without that behavior.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return null;
    // A guest watchlist would spend 25 calls/day without an explicit search.
    // Require a key even when an old config has show_watchlist: true.
    let connection;
    try { connection = await this.client.connection(this.config); } catch { return null; }
    if (!connection.key) return null;
    try {
      this.symbols = parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist, { allowEmpty: true });
    } catch (error) {
      return { className: 'stocks-widget', html: `<span>${escapeHtml(errorText(error.code, this.t))}</span>` };
    }
    if (!this.symbols.length) return null;
    const quotes = await this.client.getQuotes(this.symbols, this.config, { startedAt, connection });
    // Not set up yet (no key): no watchlist and no nagging. Typing `stock` or
    // `$AAPL` is what leads to setup, when the user actually wants quotes.
    if (quotes.some((quote) => (quote.error || quote.reason) === 'setup')) return null;
    const connectionIssue = quotes.find((quote) => ['auth', 'storage'].includes(quote.error || quote.reason));
    const hint = this.t('widget.connection');
    if (quotes.every((quote) => ['auth', 'storage'].includes(quote.error))) {
      return { className: 'stocks-widget', html: `<span>${escapeHtml(hint)}</span>` };
    }
    const html = await Promise.all(quotes.map(async (quote) => {
      if (quote.error) {
        if (connectionIssue && ['auth', 'storage'].includes(quote.error)) return '';
        return `<span class="stocks-tile"><strong>${escapeHtml(quote.symbol)}</strong><small>${escapeHtml(errorText(quote.error, this.t, { retryAt: quote.retryAt, locale: this.locale }))}</small></span>`;
      }
      let history = { samples: [] };
      try { history = await this.client.getHistory(quote.symbol, '1m', quote, this.config); } catch { /* Quotes remain useful without history. */ }
      const description = quoteDescription(connectionIssue ? { ...quote, reason: null } : quote, this.t, this.locale);
      return `<button class="stocks-tile stocks-${direction(quote)}" data-ext-action="chart:${escapeHtml(quote.symbol)}" title="${escapeHtml(description)}"><strong>${escapeHtml(quote.symbol)} ${priceText(quote.price, { locale: this.locale, currency: quote.currency })}</strong><span>${signedText(quote.change, { price: quote.price, locale: this.locale })} (${signedText(quote.percent, { percent: true, locale: this.locale })})</span>${sparkline(history.samples, this.t(quote.source === 'Stocklake' ? 'quote.history' : 'quote.sampled'))}<small>${escapeHtml(description)}</small></button>`;
    }));
    return {
      className: 'extension-bar stocks-widget',
      html: `<span class="stocks-source">📈 <a href="${connection.provider === 'stocklake' ? 'https://stocklake.dev/' : 'https://finnhub.io/'}">${escapeHtml(this.t(connection.provider === 'stocklake' ? 'quote.stocklake' : 'quote.source'))}</a>${connectionIssue ? ` · ${escapeHtml(hint)}` : ''}</span><span class="stocks-tiles">${html.join('')}</span>`,
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
