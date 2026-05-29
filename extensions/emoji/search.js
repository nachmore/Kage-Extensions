// Emoji search — pure compute, embedded dataset.
//
// Two trigger styles:
//   "emoji <q>" or "e <q>"   — explicit, returns up to 8 matches
//   ":fire" / ":fire:"       — shortcode style, returns the exact match
//                              (only when shortcode_trigger is enabled)

import { EMOJIS } from './data.js';

// Build a flat searchable index once.
const INDEX = EMOJIS.map(([emoji, ...names]) => ({
    emoji,
    shortcode: names[0],
    keywords: names,
    haystack: names.join(' ').toLowerCase(),
}));

function search(query, limit) {
    const q = query.toLowerCase();
    const exact = [];
    const startsWith = [];
    const contains = [];
    for (const e of INDEX) {
        if (e.shortcode === q) {
            exact.push(e);
        } else if (e.haystack.split(' ').some((w) => w === q)) {
            exact.push(e);
        } else if (e.haystack.split(' ').some((w) => w.startsWith(q))) {
            startsWith.push(e);
        } else if (e.haystack.includes(q)) {
            contains.push(e);
        }
        if (exact.length + startsWith.length + contains.length >= limit * 2) break;
    }
    return [...exact, ...startsWith, ...contains].slice(0, limit);
}

export default class EmojiSearchProvider {
    initialize(context) { this.config = context.config || {}; }
    onConfigUpdate(config) { this.config = config || {}; }

    match(query) {
        const trigger = (this.config.trigger || 'emoji').toLowerCase();
        const trimmed = query.trim();
        const lower = trimmed.toLowerCase();

        // Shortcode form: ":fire" / ":fire:" / ":+1:"
        if (this.config.shortcode_trigger !== false && lower.startsWith(':') && lower.length >= 3) {
            const inner = lower.replace(/^:|:$/g, '');
            if (inner.length >= 2 && /^[a-z0-9_+-]+$/i.test(inner)) {
                const hits = search(inner, 5);
                return hits.map((h, i) => this._row(h, 95 - i));
            }
        }

        // Trigger word form: "emoji <q>" or "e <q>"
        const aliases = [trigger, 'e'];
        for (const a of aliases) {
            if (lower === a) {
                return [{
                    id: 'emoji:hint',
                    type: 'emoji',
                    label: `Emoji · type to search`,
                    description: `Try "${trigger} fire" or ":fire"`,
                    icon: '😀',
                    score: 70,
                    data: { hint: true },
                }];
            }
            if (lower.startsWith(a + ' ')) {
                const rest = trimmed.slice(a.length).trim();
                if (rest) {
                    const hits = search(rest, 8);
                    return hits.map((h, i) => this._row(h, 90 - i));
                }
            }
        }
        return [];
    }

    _row(e, score) {
        return {
            id: `emoji:${e.shortcode}`,
            type: 'emoji',
            label: `${e.emoji}  :${e.shortcode}:`,
            description: e.keywords.slice(1).join(', '),
            icon: e.emoji,
            score,
            data: { emoji: e.emoji, shortcode: e.shortcode },
        };
    }

    execute(result) {
        if (result?.data?.hint) return { type: 'custom', data: { hint: true } };
        return { type: 'copy', value: result?.data?.emoji || '' };
    }
}
