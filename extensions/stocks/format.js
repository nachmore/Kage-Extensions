import { MAX_SYMBOLS } from './symbols.js';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function precision(value) { return Math.abs(value) < 1 ? 4 : 2; }

export function priceText(value, { locale, invariant = false } = {}) {
  if (!Number.isFinite(value)) return '—';
  const digits = precision(value);
  const rounded = Number(value.toFixed(digits)) || 0;
  return invariant ? rounded.toFixed(digits) : new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(rounded);
}

export function signedText(value, { percent = false, price = value, locale, invariant = false } = {}) {
  if (!Number.isFinite(value)) return '—';
  const digits = percent ? 2 : precision(price);
  const rounded = Number(value.toFixed(digits)) || 0;
  const fixed = rounded.toFixed(digits);
  if (invariant) return `${rounded > 0 ? '+' : ''}${percent ? fixed.replace(/\.?0+$/, '') : fixed}${percent ? '%' : ''}`;
  return new Intl.NumberFormat(locale, {
    style: percent ? 'percent' : 'decimal', signDisplay: 'exceptZero',
    minimumFractionDigits: percent ? 0 : digits, maximumFractionDigits: digits,
  }).format(percent ? rounded / 100 : rounded);
}

export function copyText(quote) {
  return `${quote.symbol} ${priceText(quote.price, { invariant: true })}${Number.isFinite(quote.percent) ? ` ${signedText(quote.percent, { percent: true, invariant: true })}` : ''}`;
}

export function direction(quote) {
  const change = Number.isFinite(quote.change) ? Number(quote.change.toFixed(precision(quote.price))) : 0;
  return change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
}

export function timestampText(value, { locale, invariant = false } = {}) {
  if (!Number.isFinite(value)) return '—';
  const date = new Date(Math.floor(value) * 1000);
  if (!Number.isFinite(date.getTime())) return '—';
  return invariant ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long' }).format(date);
}

export function quoteDescription(quote, t, locale) {
  const parts = [
    quote.source === 'Stocklake' ? `${t('quote.stocklake')}${quote.currency ? ` · ${quote.currency}` : ''}` : 'Finnhub · USD',
    t('quote.as_of', { time: timestampText(quote.timestamp, { locale }) }),
  ];
  if (quote.timestamp * 1000 < Date.now() - 15 * 60_000) parts.push(t('quote.delayed'));
  if (quote.cached) parts.push(t('quote.cached', { time: timestampText(quote.fetchedAt / 1000, { locale }) }));
  if (quote.reason) parts.push(errorText(quote.reason, t, { retryAt: quote.retryAt, locale }));
  if (quote.retryAt && !['daily_limit', 'key_daily_limit'].includes(quote.reason)) parts.push(t('quote.retry', { time: timestampText(quote.retryAt / 1000, { locale }) }));
  return parts.join(' · ');
}

// i18n-keys: error.*
export function errorText(code, t, { retryAt, locale } = {}) {
  if (code === 'setup') return `${t('setup.free_key')}. ${t('error.setup')}`;
  const known = new Set([
    'setup', 'auth', 'unknown', 'unsupported', 'invalid_symbols', 'too_many',
    'rate_limit', 'offline', 'unavailable', 'busy', 'storage',
    'invalid_key', 'invalid_range', 'timeout', 'daily_limit', 'key_daily_limit',
  ]);
  return t(`error.${known.has(code) ? code : 'unavailable'}`, {
    max: MAX_SYMBOLS, time: timestampText(retryAt / 1000, { locale }),
  });
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
