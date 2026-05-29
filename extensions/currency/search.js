// Currency converter — live FX rates from frankfurter.dev (ECB data,
// no API key, ~150 currencies). Cached for an hour because rates only
// update once per business day; we still poll on demand for the first
// query of a session.

const CACHE_KEY = 'rate_cache';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const COMMON_CCYS = new Set([
    'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'HKD', 'NZD',
    'SEK', 'KRW', 'SGD', 'NOK', 'MXN', 'INR', 'RUB', 'ZAR', 'TRY', 'BRL',
    'TWD', 'DKK', 'PLN', 'THB', 'MYR', 'HUF', 'CZK', 'ILS', 'CLP', 'PHP',
    'AED', 'SAR', 'IDR', 'IQD', 'EGP', 'KWD', 'COP', 'PKR', 'BGN', 'RON',
    'ISK', 'HRK',
]);

// Loose pattern: <amount> <ccy> [to|in|->] <ccy>
const RE = /^\s*([\d,]*\.?\d+)\s*([a-z]{3})\s*(?:to|in|->)?\s*([a-z]{3})?\s*$/i;

export default class CurrencySearchProvider {
    initialize(context) {
        this.invoke = context.invoke;
        this.config = context.config || {};
        this.log = context.log;
        this._memCache = null;
    }
    onConfigUpdate(config) { this.config = config || {}; this._memCache = null; }

    match(query) {
        const m = query.match(RE);
        if (!m) return [];
        const amount = parseFloat(m[1].replace(/,/g, ''));
        if (!Number.isFinite(amount)) return [];
        const from = m[2].toUpperCase();
        const to = (m[3] || (this.config.default_target || 'EUR')).toUpperCase();
        if (!COMMON_CCYS.has(from)) return [];
        if (!COMMON_CCYS.has(to)) return [];
        if (from === to) {
            return [this._row(`${amount.toLocaleString()} ${from}`, `Same currency`, amount, from, to)];
        }
        // Synchronous "loading" placeholder; matchAsync fills in real rate.
        return [this._row(`${amount.toLocaleString()} ${from} → ${to}`, 'Looking up rate…', null, from, to, amount)];
    }

    async matchAsync(query) {
        const m = query.match(RE);
        if (!m) return [];
        const amount = parseFloat(m[1].replace(/,/g, ''));
        if (!Number.isFinite(amount)) return [];
        const from = m[2].toUpperCase();
        const to = (m[3] || (this.config.default_target || 'EUR')).toUpperCase();
        if (!COMMON_CCYS.has(from) || !COMMON_CCYS.has(to)) return [];
        if (from === to) return [];
        try {
            const rate = await this._getRate(from, to);
            const converted = amount * rate;
            const formatted = converted.toLocaleString(undefined, {
                maximumFractionDigits: converted >= 100 ? 2 : 4,
            });
            const desc = `Rate: 1 ${from} = ${rate.toFixed(4)} ${to}`;
            return [this._row(`${amount.toLocaleString()} ${from} = ${formatted} ${to}`, desc, converted, from, to, amount)];
        } catch (e) {
            this.log?.warn?.('Currency lookup failed: ' + (e?.message || e));
            return [];
        }
    }

    _row(label, description, value, from, to, amount) {
        return {
            id: `cur:${from}:${to}:${amount}`,
            type: 'currency',
            label,
            description,
            icon: '💱',
            score: 95,
            data: { value, from, to, amount, label },
        };
    }

    execute(result) {
        const text = result?.data?.label || '';
        return { type: 'copy', value: text };
    }

    async _getRate(from, to) {
        // In-memory first, then localStorage-equivalent (extension-data),
        // then network.
        if (this._memCache) {
            const m = this._memCache;
            if (m.ts > Date.now() - CACHE_TTL_MS && m.from === from && m.rates[to]) {
                return m.rates[to];
            }
        }
        const cached = await this._readDiskCache();
        if (cached && cached.ts > Date.now() - CACHE_TTL_MS && cached.from === from && cached.rates[to]) {
            this._memCache = cached;
            return cached.rates[to];
        }

        const url = `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(from)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const body = await resp.json();
        const rates = body.rates || {};
        const fresh = { ts: Date.now(), from, rates };
        this._memCache = fresh;
        await this._writeDiskCache(fresh);
        const r = rates[to];
        if (r == null) throw new Error(`No rate for ${to}`);
        return r;
    }

    async _readDiskCache() {
        try {
            const raw = await this.invoke('load_extension_data', { key: CACHE_KEY });
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }
    async _writeDiskCache(data) {
        try {
            await this.invoke('save_extension_data', { key: CACHE_KEY, data: JSON.stringify(data) });
        } catch {}
    }
}
