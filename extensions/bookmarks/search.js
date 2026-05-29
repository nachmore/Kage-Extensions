// Quick-bookmark launcher.
//
// Storage: { [name: string]: { url, addedAt } } in extension-data/bookmarks.json.
// Names are unique and case-insensitive; we keep the original casing
// for display but match lower-cased.

const KEY = 'bookmarks';

function fuzzyScore(name, query) {
    const n = name.toLowerCase();
    const q = query.toLowerCase();
    if (n === q) return 100;
    if (n.startsWith(q)) return 95;
    if (n.includes(q)) return 85;
    // Letter-by-letter subsequence
    let i = 0;
    for (const ch of q) {
        const ni = n.indexOf(ch, i);
        if (ni < 0) return 0;
        i = ni + 1;
    }
    return 70;
}

export default class BookmarksSearchProvider {
    initialize(context) {
        this.invoke = context.invoke;
        this.config = context.config || {};
        this._cache = null;
    }
    onConfigUpdate(config) { this.config = config || {}; }

    async _load() {
        if (this._cache) return this._cache;
        try {
            const raw = await this.invoke('load_extension_data', { key: KEY });
            this._cache = raw ? JSON.parse(raw) : {};
        } catch {
            this._cache = {};
        }
        return this._cache;
    }
    async _save(data) {
        this._cache = data;
        await this.invoke('save_extension_data', { key: KEY, data: JSON.stringify(data) });
    }

    match(query) {
        const trigger = (this.config.trigger || 'bm').toLowerCase();
        const t = query.trim();
        if (!t.toLowerCase().startsWith(trigger)) return [];
        const rest = t.slice(trigger.length);
        const lower = rest.toLowerCase();

        // bm+ <name> <url>
        if (lower.startsWith('+ ')) {
            const args = rest.slice(2).trim();
            const space = args.indexOf(' ');
            if (space < 0) return [{
                id: 'bm:add-help', type: 'bookmarks',
                label: 'Save bookmark', description: 'Usage: bm+ <name> <url>',
                icon: '🔖', score: 80, data: { help: true },
            }];
            const name = args.slice(0, space).trim();
            const url = args.slice(space + 1).trim();
            if (!url || !/^https?:\/\//i.test(url)) return [{
                id: 'bm:add-bad', type: 'bookmarks',
                label: `Save "${name}"`, description: 'URL must start with http:// or https://',
                icon: '⚠️', score: 80, data: { error: true },
            }];
            return [{
                id: `bm:add:${name}`, type: 'bookmarks',
                label: `Save bookmark "${name}"`, description: url,
                icon: '➕', score: 95, data: { add: { name, url } },
            }];
        }

        // bm- <name>
        if (lower.startsWith('- ')) {
            const name = rest.slice(2).trim();
            if (!name) return [];
            return [{
                id: `bm:del:${name}`, type: 'bookmarks',
                label: `Delete bookmark "${name}"`, description: '',
                icon: '🗑️', score: 90, data: { del: name },
            }];
        }

        // bm <q>  — fuzzy-match. Async for actual disk read.
        return [{
            id: 'bm:loading', type: 'bookmarks',
            label: rest.trim() ? `Bookmarks · "${rest.trim()}"` : 'Bookmarks',
            description: 'Loading…',
            icon: '🔖', score: 50, data: { pending: true },
        }];
    }

    async matchAsync(query) {
        const trigger = (this.config.trigger || 'bm').toLowerCase();
        const t = query.trim();
        if (!t.toLowerCase().startsWith(trigger)) return [];
        const rest = t.slice(trigger.length);
        const lower = rest.toLowerCase();
        if (lower.startsWith('+') || lower.startsWith('-')) return [];

        const all = await this._load();
        const names = Object.keys(all);
        const q = rest.trim();
        const matches = q
            ? names.map((n) => ({ name: n, score: fuzzyScore(n, q) })).filter((m) => m.score > 0)
                .sort((a, b) => b.score - a.score)
            : names.map((n) => ({ name: n, score: 80 })).sort((a, b) => a.name.localeCompare(b.name));
        if (matches.length === 0 && q) {
            return [{
                id: `bm:none:${q}`, type: 'bookmarks',
                label: `No bookmark matching "${q}"`,
                description: 'Save one with `bm+ <name> <url>`',
                icon: '🤷', score: 70, data: { miss: true },
            }];
        }
        return matches.slice(0, 8).map((m) => ({
            id: `bm:open:${m.name}`,
            type: 'bookmarks',
            label: m.name,
            description: all[m.name].url,
            icon: '🔖',
            score: m.score,
            data: { open: all[m.name].url },
        }));
    }

    async execute(result) {
        const d = result?.data || {};
        if (d.add) {
            const all = await this._load();
            all[d.add.name] = { url: d.add.url, addedAt: Date.now() };
            await this._save(all);
            return { type: 'custom', data: { saved: d.add.name } };
        }
        if (d.del) {
            const all = await this._load();
            if (all[d.del]) {
                delete all[d.del];
                await this._save(all);
            }
            return { type: 'custom', data: { deleted: d.del } };
        }
        if (d.open) {
            return { type: 'open_url', value: d.open };
        }
        return { type: 'custom', data: {} };
    }
}
