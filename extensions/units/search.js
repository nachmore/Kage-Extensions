// Unit converter — pure compute, no network.
//
// Each unit is expressed as a (factor, offset) pair relative to a base
// unit per category, so the conversion is always:
//   base = (value + from_offset) * from_factor    -- normalize to base
//   result = base / to_factor - to_offset          -- denormalize
// `offset` is only non-zero for temperatures (Celsius / Fahrenheit /
// Kelvin); everything else is purely multiplicative.

const UNITS = {
    length: {
        base: 'm',
        units: {
            mm: { factor: 0.001 },
            cm: { factor: 0.01 },
            m: { factor: 1 },
            km: { factor: 1000 },
            in: { factor: 0.0254, aliases: ['inch', 'inches'] },
            ft: { factor: 0.3048, aliases: ['foot', 'feet'] },
            yd: { factor: 0.9144, aliases: ['yard', 'yards'] },
            mi: { factor: 1609.344, aliases: ['mile', 'miles'] },
            nmi: { factor: 1852, aliases: ['nautical-mile'] },
        },
    },
    weight: {
        base: 'g',
        units: {
            mg: { factor: 0.001 },
            g: { factor: 1, aliases: ['gram', 'grams'] },
            kg: { factor: 1000, aliases: ['kilo', 'kilos', 'kilogram', 'kilograms'] },
            t: { factor: 1_000_000, aliases: ['tonne', 'tonnes', 'metric-ton'] },
            oz: { factor: 28.3495, aliases: ['ounce', 'ounces'] },
            lb: { factor: 453.592, aliases: ['lbs', 'pound', 'pounds'] },
            st: { factor: 6350.29, aliases: ['stone', 'stones'] },
        },
    },
    temperature: {
        base: 'k',
        units: {
            c: { factor: 1, offset: 273.15, aliases: ['°c', 'celsius'] },
            f: { factor: 5 / 9, offset: 459.67, aliases: ['°f', 'fahrenheit'] },
            k: { factor: 1, offset: 0, aliases: ['kelvin'] },
        },
    },
    volume: {
        base: 'l',
        units: {
            ml: { factor: 0.001 },
            l: { factor: 1, aliases: ['liter', 'liters', 'litre', 'litres'] },
            dl: { factor: 0.1 },
            cl: { factor: 0.01 },
            'cu-m': { factor: 1000, aliases: ['m3', 'cubic-meter'] },
            tsp: { factor: 0.00492892, aliases: ['teaspoon', 'teaspoons'] },
            tbsp: { factor: 0.0147868, aliases: ['tablespoon', 'tablespoons'] },
            'fl-oz': { factor: 0.0295735, aliases: ['floz', 'fluid-ounce'] },
            cup: { factor: 0.24, aliases: ['cups'] },
            pt: { factor: 0.473176, aliases: ['pint', 'pints'] },
            qt: { factor: 0.946353, aliases: ['quart', 'quarts'] },
            gal: { factor: 3.78541, aliases: ['gallon', 'gallons'] },
        },
    },
    time: {
        base: 's',
        units: {
            ms: { factor: 0.001 },
            s: { factor: 1, aliases: ['sec', 'secs', 'second', 'seconds'] },
            min: { factor: 60, aliases: ['mins', 'minute', 'minutes'] },
            h: { factor: 3600, aliases: ['hr', 'hrs', 'hour', 'hours'] },
            d: { factor: 86400, aliases: ['day', 'days'] },
            wk: { factor: 604800, aliases: ['week', 'weeks'] },
            yr: { factor: 31557600, aliases: ['year', 'years'] }, // Julian year
        },
    },
    data: {
        base: 'b',
        units: {
            b: { factor: 1, aliases: ['byte', 'bytes'] },
            kb: { factor: 1000 },
            mb: { factor: 1_000_000 },
            gb: { factor: 1_000_000_000 },
            tb: { factor: 1_000_000_000_000 },
            kib: { factor: 1024 },
            mib: { factor: 1024 ** 2 },
            gib: { factor: 1024 ** 3 },
            tib: { factor: 1024 ** 4 },
            bit: { factor: 0.125 },
            kbit: { factor: 125 },
            mbit: { factor: 125000 },
            gbit: { factor: 125_000_000 },
        },
    },
};

// Build a flat name → (category, unit, offset, factor) lookup
const LOOKUP = (() => {
    const out = new Map();
    for (const [cat, group] of Object.entries(UNITS)) {
        for (const [name, def] of Object.entries(group.units)) {
            const entry = { cat, unit: name, ...def };
            out.set(name, entry);
            for (const a of def.aliases || []) out.set(a, entry);
        }
    }
    return out;
})();

const RE = /^\s*(-?[\d,]*\.?\d+)\s*°?\s*([A-Za-z][A-Za-z0-9-°]*)\s*(?:to|in|->)\s*°?\s*([A-Za-z][A-Za-z0-9-°]*)\s*$/i;

function normalize(unit) {
    return unit.toLowerCase().replace(/°/g, '');
}

function convert(value, fromUnit, toUnit) {
    const f = LOOKUP.get(normalize(fromUnit));
    const t = LOOKUP.get(normalize(toUnit));
    if (!f || !t || f.cat !== t.cat) return null;
    const fOff = f.offset || 0;
    const tOff = t.offset || 0;
    const base = (value + fOff) * f.factor;
    return base / t.factor - tOff;
}

export default class UnitsSearchProvider {
    initialize(context) { this.config = context.config || {}; }
    onConfigUpdate(config) { this.config = config || {}; }

    match(query) {
        const m = query.match(RE);
        if (!m) return [];
        const value = parseFloat(m[1].replace(/,/g, ''));
        if (!Number.isFinite(value)) return [];
        const fromUnit = m[2];
        const toUnit = m[3];
        const result = convert(value, fromUnit, toUnit);
        if (result == null) return [];
        const formatted = formatNum(result);
        const label = `${formatNum(value)} ${fromUnit} = ${formatted} ${toUnit}`;
        return [{
            id: `units:${value}:${normalize(fromUnit)}:${normalize(toUnit)}`,
            type: 'units',
            label,
            description: `Unit conversion`,
            icon: '📏',
            score: 95,
            data: { label, value: formatted, unit: toUnit },
        }];
    }

    execute(result) {
        return { type: 'copy', value: result?.data?.label || '' };
    }
}

function formatNum(n) {
    if (n === 0) return '0';
    const abs = Math.abs(n);
    let digits;
    if (abs >= 1000) digits = 2;
    else if (abs >= 10) digits = 3;
    else if (abs >= 1) digits = 4;
    else digits = 6;
    let s = n.toFixed(digits);
    // Trim trailing zeros after decimal point.
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return Number(s).toLocaleString(undefined, { maximumFractionDigits: digits });
}
