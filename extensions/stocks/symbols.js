// Keep this module a leaf for the host's single shared-module rewrite pass.
const MAX_SYMBOLS = 10;
const FOREIGN_SUFFIX = /\.(?:[A-Z]{2,}|L|F|T|V)$/;
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
  const symbols = [...new Set(parts.map(normalizeSymbol))];
  if (symbols.length > MAX_SYMBOLS) throw new StockError('too_many');
  return symbols;
}

export function symbolEntries(input) {
  const parts = Array.isArray(input) ? input
    : typeof input === 'string' ? input.trim().split(/[\s,]+/).filter(Boolean) : [];
  if (!parts.length) throw new StockError('invalid_symbols');
  const entries = new Map();
  for (const part of parts) {
    let entry;
    try { entry = { symbol: normalizeSymbol(part) }; }
    catch (error) {
      entry = { symbol: String(part ?? '').trim().replace(/^\$/, '').toUpperCase(), error: error.code };
    }
    entries.set(entry.symbol, entry);
  }
  if (entries.size > MAX_SYMBOLS) throw new StockError('too_many');
  return [...entries.values()];
}

export function parseQuery(query) {
  if (typeof query !== 'string') return null;
  const text = query.trim();
  const match = /^stock(?:\s+(copy)\b)?(?:\s+(.*))?$/i.exec(text);
  if (!match && !text.startsWith('$')) return null;
  const input = match ? match[2] || '' : text;
  const parts = input.split(/[\s,]+/).filter(Boolean);
  if (!match && (!parts.length || !parts.every((p) => /^\$[A-Za-z0-9][A-Za-z0-9.-]{0,17}$/.test(p)))) return null;
  if (match && (input.includes('?') || /^(?:market|split|options|prices)\b/i.test(input))) return null;
  if (match && parts.filter((part) => {
    try { normalizeSymbol(part); return false; }
    catch (error) { return error.code === 'invalid_symbols'; }
  }).length > 3) return null;
  if (!parts.length) return { symbols: [], copy: !!match?.[1] };
  try {
    const entries = symbolEntries(parts);
    if (!match && entries.some((entry) => entry.error === 'invalid_symbols')) return null;
    return { symbols: entries.map((entry) => entry.symbol), copy: !!match?.[1] };
  } catch (error) {
    return match ? { symbols: [], error: error.code } : null;
  }
}

export function symbolName(symbol) { return NAMES[symbol] || null; }

export function chartUrl(symbol) {
  // Public chart search also handles share classes without guessing an exchange.
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(normalizeSymbol(symbol))}`;
}
