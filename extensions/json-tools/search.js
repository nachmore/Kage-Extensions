// JSON tools — operate on whatever text is in the clipboard right now.
// Result lands back on the clipboard via a `copy` action; the original
// clipboard contents are replaced by the formatted output.
//
// "json fmt"  | "json pretty" -> pretty-print
// "json min"  | "json minify" -> compact form
// "json check"               -> just validate, surface errors

export default class JsonToolsSearchProvider {
    initialize(context) {
        this.invoke = context.invoke;
        this.config = context.config || {};
    }
    onConfigUpdate(config) { this.config = config || {}; }

    match(query) {
        const trigger = (this.config.trigger || 'json').toLowerCase();
        const t = query.trim();
        const lower = t.toLowerCase();
        if (lower !== trigger && !lower.startsWith(trigger + ' ')) return [];
        const op = lower.slice(trigger.length).trim();

        if (!op) {
            return [
                this._row('fmt', 'Pretty-print clipboard JSON', 95),
                this._row('min', 'Minify clipboard JSON', 90),
                this._row('check', 'Validate clipboard JSON', 85),
            ];
        }
        if (['fmt', 'format', 'pretty'].includes(op)) {
            return [this._row('fmt', 'Pretty-print clipboard JSON', 95)];
        }
        if (['min', 'minify', 'compact'].includes(op)) {
            return [this._row('min', 'Minify clipboard JSON', 95)];
        }
        if (['check', 'validate'].includes(op)) {
            return [this._row('check', 'Validate clipboard JSON', 95)];
        }
        return [];
    }

    _row(op, label, score) {
        const labels = {
            fmt: 'JSON · pretty-print clipboard',
            min: 'JSON · minify clipboard',
            check: 'JSON · validate clipboard',
        };
        const descs = {
            fmt: 'Re-formats with consistent indentation and sorts keys (preserves order otherwise)',
            min: 'Strips whitespace down to the minimum for transmission',
            check: 'Reports the first parse error with line/column',
        };
        return {
            id: `jt:${op}`,
            type: 'json-tools',
            label: labels[op] || label,
            description: descs[op] || '',
            icon: '🧰',
            score,
            data: { op },
        };
    }

    async execute(result) {
        const op = result?.data?.op;
        let text;
        try {
            text = await this.invoke('read_clipboard');
            text = (text || '').trim();
        } catch {
            return { type: 'custom', data: { error: 'clipboard-unavailable' } };
        }
        if (!text) {
            return { type: 'custom', data: { error: 'clipboard-empty' } };
        }
        try {
            const parsed = JSON.parse(text);
            if (op === 'check') {
                const summary = describe(parsed);
                return { type: 'copy', value: `Valid JSON · ${summary}\n${text}` };
            }
            const indent = op === 'min' ? 0 : (this.config.indent_spaces || 2);
            const out = JSON.stringify(parsed, null, indent);
            return { type: 'copy', value: out };
        } catch (e) {
            return { type: 'copy', value: `❌ Invalid JSON: ${e.message}` };
        }
    }
}

function describe(v) {
    if (Array.isArray(v)) return `array of ${v.length}`;
    if (v && typeof v === 'object') return `object with ${Object.keys(v).length} keys`;
    if (typeof v === 'string') return `string (${v.length} chars)`;
    return typeof v;
}
