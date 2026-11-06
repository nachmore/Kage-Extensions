import { MAX_SYMBOLS } from './defaults.js';

const FOREIGN_SUFFIX = /\.(?:L|TO|V|DE|PA|AS|SW|HK|JP|AU|AX|PL|UK|NS|BO|KS|TW)$/;
const NAMES = Object.freeze({
  AAPL: 'Apple Inc.',
  MSFT: 'Microsoft Corporation',
  NVDA: 'NVIDIA Corporation',
});

export class StockError extends Error {
  constructor(code, retryAt = null) {
    super(code);
    this.code = code;
    this.retryAt = retryAt;
  }
}

export function normalizeSymbol(value) {
  if (typeof value !== 'string') throw new StockError('invalid_symbols');
  const symbol = value.trim().replace(/^\$/, '').toUpperCase().replace(/\.US$/, '');
  if (FOREIGN_SUFFIX.test(symbol)) throw new StockError('unsupported');
  if (!/^[A-Z][A-Z0-9]{0,11}(?:[.-][A-Z0-9]{1,4})?$/.test(symbol)) {
    throw new StockError('invalid_symbols');
  }
  return symbol;
}

export function parseSymbols(input, { allowEmpty = false } = {}) {
  const parts = Array.isArray(input)
    ? input
    : typeof input === 'string' ? input.trim().split(/[\s,]+/).filter(Boolean) : [];
  if (!parts.length && !allowEmpty) throw new StockError('invalid_symbols');
  if (parts.length > MAX_SYMBOLS) throw new StockError('too_many');
  return [...new Set(parts.map(normalizeSymbol))];
}

export function parseQuery(query) {
  if (typeof query !== 'string') return null;
  const text = query.trim();
  const match = /^stock(?:\s+(copy)\b)?(?:\s+(.*))?$/i.exec(text);
  if (!match && !text.startsWith('$')) return null;
  try {
    const input = match ? match[2] || '' : text;
    return { symbols: parseSymbols(input, { allowEmpty: true }), copy: !!match?.[1] };
  } catch (error) {
    return { symbols: [], error: error.code };
  }
}

export function symbolName(symbol) { return NAMES[symbol] || null; }

export function chartUrl(symbol) {
  // Public chart search also handles share classes without guessing an exchange.
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(normalizeSymbol(symbol))}`;
}
