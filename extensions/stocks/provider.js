import { StockError, normalizeSymbol, symbolName } from './symbols.js';

export const API_ORIGIN = 'https://finnhub.io';
export const FREE_KEY_URL = 'https://finnhub.io/register';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseFinnhubQuote(body, symbol) {
  const price = finite(body?.c);
  const timestamp = finite(body?.t);
  if (price === null || price <= 0 || timestamp === null || timestamp <= 0
      || timestamp > Date.now() / 1000 + 86_400) {
    throw new StockError('unknown');
  }
  const previousClose = finite(body.pc);
  // Calculate from previous close when d/dp are absent. Never invent zero.
  const change = finite(body.d) ?? (previousClose > 0 ? price - previousClose : null);
  const percent = finite(body.dp) ?? (previousClose > 0 && change !== null ? change / previousClose * 100 : null);
  return {
    symbol: normalizeSymbol(symbol),
    name: symbolName(normalizeSymbol(symbol)),
    price,
    change,
    percent,
    previousClose,
    timestamp,
    currency: 'USD',
    source: 'Finnhub',
  };
}

export function validKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value.trim());
}

export function retryAfterMs(value, now) {
  if (value !== null && value !== undefined && value !== '') {
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    if (Number.isFinite(delay)) return Math.max(60_000, Math.min(delay, 86_400_000));
  }
  return 60_000;
}

export async function fetchQuote(symbol, key, { signal } = {}) {
  if (!validKey(key)) throw new StockError('setup');
  const url = new URL('/api/v1/quote', API_ORIGIN);
  url.searchParams.set('symbol', normalizeSymbol(symbol));
  // Finnhub's live OPTIONS response omits Access-Control-Allow-Headers:
  // X-Finnhub-Token therefore fails browser preflight. Use its documented
  // token parameter for a simple CORS request. Never expose this URL in logs
  // or results; reject redirects so credentials cannot reach another host.
  url.searchParams.set('token', key.trim());
  // The only fetch destination; charts, config and returned data have no key.
  if (url.origin !== API_ORIGIN) throw new StockError('unavailable');
  let response;
  try {
    response = await fetch(url.href, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal,
    });
  } catch {
    throw new StockError('offline');
  }
  if (response.status === 429) {
    throw new StockError('rate_limit', Date.now() + retryAfterMs(response.headers.get('Retry-After'), Date.now()));
  }
  if (response.status === 401 || response.status === 403) throw new StockError('auth');
  if (!response.ok) throw new StockError('unavailable');
  let body;
  try { body = await response.json(); } catch { throw new StockError('unavailable'); }
  // Do not propagate provider error text: it could contain credentials.
  if (body?.error) throw new StockError('unavailable');
  return parseFinnhubQuote(body, symbol);
}
