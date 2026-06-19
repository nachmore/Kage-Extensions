// Snippets — quick canned-text storage & retrieval.
//
// "snip"          -> list all
// "snip <query>"  -> fuzzy match by name OR body
// "snip+ <name> <body>" -> save (body is everything after the first space)
// "snip- <name>"  -> delete

const KEY = 'snippets';

function fuzzy(haystack, q) {
    const h = haystack.toLowerCase();
    const ql = q.toLowerCase();
    if (h === ql) return 100;
    if (h.startsWith(ql)) return 92;
    if (h.includes(ql)) return 85;
    let i = 0;
    for (const ch of ql) {
        const ni = h.indexOf(ch, i);
        if (ni < 0) return 0;
        i = ni + 1;
    }
    return 70;
}

export default class SnippetsSearchProvider {
    initialize(context) {
        this.invoke = context.invoke;
        this.config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
        this._cache = null;
    }
    onConfigUpdate(config) { this.config = config || {}; }

    /**
     * Complete, authoritative trigger set — the host hints partial prefixes
     * and only invokes match()/matchAsync() on a committed keyword. The +/-
     * sub-commands are distinct whole-word keywords, so each is listed.
     * Labels are i18n keys, resolved host-side.
     */
    getKeywords() {
        // i18n-keys: keyword.snip.label, keyword.snip.description, keyword.add.label, keyword.add.description, keyword.del.label, keyword.del.description
        const trigger = (this.config.trigger || 'snip').toLowerCase();
        return [
            { keyword: trigger, labelKey: 'keyword.snip.label', descriptionKey: 'keyword.snip.description', icon: '📋', acceptsArgs: true },
            { keyword: trigger + '+', labelKey: 'keyword.add.label', descriptionKey: 'keyword.add.description', icon: '➕', acceptsArgs: true },
            { keyword: trigger + '-', labelKey: 'keyword.del.label', descriptionKey: 'keyword.del.description', icon: '🗑️', acceptsArgs: true },
        ];
    }

    async _load() {
        if (this._cache) return this._cache;
        try {
            const raw = await this.invoke('load_extension_data', { key: KEY });
            this._cache = raw ? JSON.parse(raw) : {};
        } catch { this._cache = {}; }
        return this._cache;
    }
    async _save(data) {
        this._cache = data;
        await this.invoke('save_extension_data', { key: KEY, data: JSON.stringify(data) });
    }

    match(query) {
        const trigger = (this.config.trigger || 'snip').toLowerCase();
        const t = query.trim();
        if (!t.toLowerCase().startsWith(trigger)) return [];
        const rest = t.slice(trigger.length);
        const lower = rest.toLowerCase();

        if (lower.startsWith('+ ')) {
            const args = rest.slice(2);
            const space = args.indexOf(' ');
            if (space < 0) return [{
                id: 'snip:add-help', type: 'snippets',
                label: this.t('result.add_help.label'), description: this.t('result.add_help.description'),
                icon: '📋', score: 80, data: { help: true },
            }];
            const name = args.slice(0, space).trim();
            const body = args.slice(space + 1);
            if (!name || !body) return [];
            const preview = body.length > 60 ? body.slice(0, 60) + '…' : body;
            return [{
                id: `snip:add:${name}`, type: 'snippets',
                label: this.t('result.add.label', { name }), description: preview,
                icon: '➕', score: 95, data: { add: { name, body } },
            }];
        }

        if (lower.startsWith('- ')) {
            const name = rest.slice(2).trim();
            if (!name) return [];
            return [{
                id: `snip:del:${name}`, type: 'snippets',
                label: this.t('result.del.label', { name }), description: '',
                icon: '🗑️', score: 90, data: { del: name },
            }];
        }

        const q = rest.trim();
        return [{
            id: 'snip:loading', type: 'snippets',
            label: q ? this.t('result.list.label_query', { query: q }) : this.t('result.list.label_all'),
            description: this.t('result.list.loading'),
            icon: '📋', score: 50, data: { pending: true },
        }];
    }

    async matchAsync(query) {
        const trigger = (this.config.trigger || 'snip').toLowerCase();
        const t = query.trim();
        if (!t.toLowerCase().startsWith(trigger)) return [];
        const rest = t.slice(trigger.length);
        const lower = rest.toLowerCase();
        if (lower.startsWith('+') || lower.startsWith('-')) return [];

        const all = await this._load();
        const entries = Object.entries(all);
        const q = rest.trim();
        const scored = entries
            .map(([name, body]) => ({
                name,
                body: typeof body === 'string' ? body : (body.body || ''),
                score: q ? Math.max(fuzzy(name, q), fuzzy(body.body || body, q)) : 80,
            }))
            .filter((e) => e.score > 0)
            .sort((a, b) => b.score - a.score);
        if (!q && scored.length === 0) {
            return [{
                id: 'snip:empty', type: 'snippets',
                label: this.t('result.empty.label'),
                description: this.t('result.empty.description'),
                icon: '📋', score: 60, data: { empty: true },
            }];
        }
        return scored.slice(0, 8).map((e) => {
            const preview = e.body.length > 60 ? e.body.slice(0, 60) + '…' : e.body;
            return {
                id: `snip:copy:${e.name}`,
                type: 'snippets',
                label: e.name,
                description: preview,
                icon: '📋',
                score: e.score,
                data: { copy: e.body },
            };
        });
    }

    async execute(result) {
        const d = result?.data || {};
        if (d.add) {
            const all = await this._load();
            all[d.add.name] = { body: d.add.body, savedAt: Date.now() };
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
        if (d.copy) return { type: 'copy', value: d.copy };
        return { type: 'custom', data: {} };
    }
}
