/**
 * Math Calculator search provider.
 *
 * mathjs evaluation is delegated to a freshly-spawned Worker per call
 * via `context.runSandboxed`, with a 1s hard timeout. mathjs can be
 * tricked into running for a very long time on inputs like `2^2^2^2^2`
 * or `1000!` in bignumber mode; running it in-thread freezes the whole
 * sandbox iframe (and siblings on the same agent cluster), so we run
 * it out-of-thread where we can terminate it.
 */

import { DEFAULTS } from './defaults.js';

export default class MathSearchProvider {
    initialize(context) {
        this.config = context.config || {};
        this._runSandboxed = context.runSandboxed;
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    async match(query) {
        const mathResult = await evaluateMath(this._runSandboxed, query, this.config.precision ?? DEFAULTS.precision);
        if (!mathResult) return [];

        let display = mathResult.display;
        if (this.config.thousands_separator ?? DEFAULTS.thousands_separator) {
            const parts = display.split('.');
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            display = parts.join('.');
        }

        return [{
            id: 'math',
            type: 'math',
            label: '= ' + display,
            description: this._autoCopy() ? this.t('result.copy_hint') : this.t('result.insert_hint'),
            icon: '🧮',
            score: 93,
            // `plain` is the answer without thousands separators: what goes
            // back into the input bar, where mathjs can't read "1,000".
            data: { value: display, plain: mathResult.display, raw: mathResult.result },
        }];
    }

    /**
     * Enter (or a click) on the result. With auto_copy on, the answer goes
     * to the clipboard as shown. With it off, nothing is copied: the answer
     * replaces the input, so you can keep calculating with it.
     */
    execute(result) {
        if (this._autoCopy()) {
            return { type: 'copy', value: result.data.value };
        }
        return { type: 'replace_input', value: result.data.plain ?? result.data.value };
    }

    _autoCopy() {
        return this.config.auto_copy ?? DEFAULTS.auto_copy;
    }

    destroy() {}
}

// --- Core evaluation logic ---

/**
 * Cache the last input that failed evaluation so we can skip re-evaluating
 * when the user is just appending characters to something already invalid.
 */
let _lastFailedPrefix = '';

/**
 * Cheap regex pre-filter: reject input that clearly isn't math.
 * Intentionally generous — false positives are fine since evaluate() is
 * the real validator.
 */
function couldBeMath(input) {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length === 0) return false;
    if (!/\d/.test(trimmed)) return false;
    if (/^[a-z]{3,}(\s+[a-z]{3,})+$/i.test(trimmed)) return false;
    if (/^\d[\d.,]*\s*[a-z]+\s+(to|in)\s+[a-z]+$/i.test(trimmed)) return true;
    if (/[+\-*\/\^%()!]|[a-z]+\s*\(/i.test(trimmed)) return true;
    return true;
}

async function evaluateMath(runSandboxed, input, precision = DEFAULTS.precision) {
    const trimmed = input.trim();
    if (!couldBeMath(trimmed)) return null;
    if (typeof runSandboxed !== 'function') return null;
    if (_lastFailedPrefix && trimmed.startsWith(_lastFailedPrefix)) return null;

    let serialized;
    try {
        serialized = await runSandboxed({
            vendor: ['math'],
            data: { expression: trimmed },
            timeoutMs: 1000,
            // Runs inside a Worker. No closures over outer state — inputs
            // arrive via `data`, vendor globals via `lib`.
            run: (data, lib) => {
                const math = lib.math;
                const result = math.evaluate(data.expression);
                if (result && typeof result === 'object' && result.units) {
                    const num = result.toNumber();
                    if (!isFinite(num)) return { kind: 'invalid' };
                    const unitName = result.toString().replace(/^[\d.\-]+\s*/, '');
                    return { kind: 'unit', num, unitName };
                }
                if (typeof result === 'number') {
                    return { kind: 'number', num: result };
                }
                if (math.isBigNumber && math.isBigNumber(result)) {
                    return { kind: 'number', num: result.toNumber() };
                }
                return { kind: 'invalid' };
            },
        });
    } catch (e) {
        // Timeout, worker crash, or evaluation error. Treat the input as
        // "not math" and — if it has no operators — cache so we don't
        // re-try on every keystroke. Partial expressions like "22/" or
        // "(2" might become valid as the user keeps typing; don't cache
        // those.
        if (!/[+\-*\/\^%(,)!]/.test(trimmed)) {
            _lastFailedPrefix = trimmed;
        }
        return null;
    }

    if (!serialized || serialized.kind === 'invalid') return null;

    if (serialized.kind === 'unit') {
        _lastFailedPrefix = '';
        const display = `${parseFloat(serialized.num.toFixed(2))} ${serialized.unitName}`;
        return { result: serialized.num, display };
    }

    const num = serialized.num;
    if (!isFinite(num)) return null;
    const inputAsNum = Number(trimmed);
    if (!isNaN(inputAsNum) && num === inputAsNum) return null;

    _lastFailedPrefix = '';
    let display;
    if (precision >= 0) {
        // At most `precision` decimals: round, then drop trailing zeros
        // (1+1 → "2", 1/2 → "0.5", 29/34 → "0.85") — the same rule unit
        // results already use. toFixed switches to exponent form past
        // 1e21; leave that alone.
        display = num.toFixed(precision);
        if (display.includes('.') && !/e/i.test(display)) {
            display = display.replace(/\.?0+$/, '');
        }
        // toFixed keeps the sign of a negative value that rounds to zero
        // (-1/1000 → "-0"). Show and copy "0" instead.
        if (/^-0(\.0+)?$/.test(display)) display = display.slice(1);
    } else {
        display = String(parseFloat(num.toPrecision(15)));
    }
    return { result: num, display };
}
