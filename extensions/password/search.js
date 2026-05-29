// Password generator — pure compute, uses Web Crypto for entropy.
//
// "pw"             -> generate at default length
// "pw 32"          -> custom length (4..128)
// "pw word"        -> 4-word passphrase ("apple-bridge-coffee-eagle")
// "pw word 6"      -> N-word passphrase

import { WORDS } from './wordlist.js';

const AMBIGUOUS = new Set('Il1O0|`\'"');

function pool(config) {
    let s = '';
    if (config.include_lowercase !== false) s += 'abcdefghijklmnopqrstuvwxyz';
    if (config.include_uppercase !== false) s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (config.include_numbers !== false) s += '0123456789';
    if (config.include_symbols !== false) s += '!@#$%^&*()-_=+[]{};:,.<>?';
    if (config.exclude_ambiguous !== false) {
        s = [...s].filter((c) => !AMBIGUOUS.has(c)).join('');
    }
    return s || 'abcdefghijklmnopqrstuvwxyz';
}

function randInt(maxExclusive) {
    // Reject sample to avoid modulo bias on the 32-bit Uint32Array reads.
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    while (true) {
        crypto.getRandomValues(buf);
        if (buf[0] < limit) return buf[0] % maxExclusive;
    }
}

function genPassword(length, config) {
    const chars = pool(config);
    let out = '';
    for (let i = 0; i < length; i++) {
        out += chars[randInt(chars.length)];
    }
    return out;
}

function genPassphrase(count, separator = '-') {
    const parts = [];
    for (let i = 0; i < count; i++) {
        parts.push(WORDS[randInt(WORDS.length)]);
    }
    return parts.join(separator);
}

function entropyBits(length, poolSize) {
    return Math.round(length * Math.log2(poolSize) * 10) / 10;
}

export default class PasswordSearchProvider {
    initialize(context) {
        this.config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }
    onConfigUpdate(config) { this.config = config || {}; }

    match(query) {
        const trigger = (this.config.trigger || 'pw').toLowerCase();
        const t = query.trim();
        const lower = t.toLowerCase();
        if (lower !== trigger && !lower.startsWith(trigger + ' ')) return [];
        const rest = t.slice(trigger.length).trim();

        // Passphrase mode
        if (rest.startsWith('word')) {
            const m = rest.match(/^word\s*(\d+)?$/);
            const count = m && m[1] ? Math.max(2, Math.min(12, parseInt(m[1], 10))) : 4;
            const phrase = genPassphrase(count);
            const bits = Math.round(count * Math.log2(WORDS.length) * 10) / 10;
            return [{
                id: `pw:phrase:${phrase}`,
                type: 'password',
                label: phrase,
                description: this.t('result.passphrase.description', { count, bits }),
                icon: '🔐',
                score: 95,
                data: { value: phrase },
            }];
        }

        // Numeric password
        let length = parseInt(rest, 10);
        if (!Number.isFinite(length)) length = this.config.default_length || 20;
        length = Math.max(4, Math.min(128, length));
        const password = genPassword(length, this.config);
        const bits = entropyBits(length, pool(this.config).length);
        return [{
            id: `pw:${password}`,
            type: 'password',
            label: password,
            description: this.t('result.password.description', { length, bits }),
            icon: '🔐',
            score: 95,
            data: { value: password },
        }, {
            id: 'pw:regen',
            type: 'password',
            label: this.t('result.regen.label'),
            description: this.t('result.regen.description'),
            icon: '🔁',
            score: 80,
            data: { regen: true, rest },
        }];
    }

    execute(result) {
        if (result?.data?.regen) {
            // The host treats `replace_input` as "swap the input text and re-search".
            // Re-emitting the same trigger word kicks off a fresh `match()` with a
            // newly-rolled password.
            const rest = result.data.rest || '';
            const trigger = (this.config.trigger || 'pw');
            return { type: 'replace_input', value: rest ? `${trigger} ${rest}` : trigger };
        }
        return { type: 'copy', value: result?.data?.value || '' };
    }
}
