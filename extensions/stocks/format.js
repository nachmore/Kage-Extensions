export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function priceText(value) {
  return Number.isFinite(value) ? value.toFixed(Math.abs(value) < 1 ? 4 : 2) : '—';
}

export function signedText(value, { percent = false } = {}) {
  if (!Number.isFinite(value)) return '—';
  const text = percent ? value.toFixed(2).replace(/\.?0+$/, '') : priceText(value);
  return `${value > 0 ? '+' : ''}${text}${percent ? '%' : ''}`;
}

export function copyText(quote) {
  return `${quote.symbol} ${priceText(quote.price)} ${signedText(quote.percent, { percent: true })}`;
}

export function direction(quote) {
  return quote.change > 0 ? 'up' : quote.change < 0 ? 'down' : 'flat';
}

export function timestampText(value) {
  if (!Number.isFinite(value)) return '—';
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '—';
}

export function quoteDescription(quote, t) {
  const parts = [
    'Finnhub · USD',
    t('quote.as_of', { time: timestampText(quote.timestamp) }),
  ];
  if (quote.timestamp * 1000 < Date.now() - 15 * 60_000) parts.push(t('quote.delayed'));
  if (quote.cached) parts.push(t('quote.cached', { time: timestampText(quote.fetchedAt / 1000) }));
  if (quote.reason) parts.push(errorText(quote.reason, t));
  if (quote.retryAt) parts.push(t('quote.retry', { time: timestampText(quote.retryAt / 1000) }));
  return parts.join(' · ');
}

// i18n-keys: error.*
export function errorText(code, t) {
  const known = new Set([
    'setup', 'auth', 'unknown', 'unsupported', 'invalid_symbols', 'too_many',
    'rate_limit', 'offline', 'unavailable', 'busy', 'cache_only', 'storage',
    'invalid_key', 'invalid_range',
  ]);
  return t(`error.${known.has(code) ? code : 'unavailable'}`);
}

export function sparkline(samples, label) {
  const values = samples.filter((p) => Number.isFinite(p.price)).map((p) => p.price).slice(-48);
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const spread = Math.max(...values) - min;
  const points = values.map((price, i) =>
    `${(i * 72 / (values.length - 1)).toFixed(1)},${(spread ? 20 - (price - min) * 18 / spread : 11).toFixed(1)}`
  ).join(' ');
  return `<svg class="stocks-sparkline" viewBox="0 0 74 24" width="74" height="24" role="img" aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}
