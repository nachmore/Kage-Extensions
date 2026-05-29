export default class SnippetsSettingsProvider {
    initialize(context) {
        this.invoke = context.invoke;
        this.config = context.config || {};
    }
    onConfigUpdate(config) { this.config = config || {}; }

    async getSettings() {
        const raw = await this.invoke('load_extension_data', { key: 'snippets' });
        const all = raw ? JSON.parse(raw) : {};
        const count = Object.keys(all).length;
        const list = Object.entries(all)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, v]) => {
                const body = typeof v === 'string' ? v : v.body || '';
                const preview = body.length > 80 ? body.slice(0, 80) + '…' : body;
                return `<li><strong>${escapeHtml(name)}</strong> &mdash; <code>${escapeHtml(preview)}</code></li>`;
            })
            .join('');
        return {
            description: 'Save bits of text — canned replies, addresses, commands, code blocks — and copy them with one keystroke.',
            sections: [
                {
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: 'Enable', default: true },
                        { type: 'text', id: 'trigger', label: 'Trigger word', default: 'snip', maxWidth: 120 },
                        {
                            type: 'info',
                            html: `<p><strong>${count} snippet${count === 1 ? '' : 's'} saved.</strong></p>` +
                                (count > 0 ? `<ul>${list}</ul>` : '<p>None yet.</p>') +
                                '<p><em>Usage:</em> <code>snip name</code> to copy, <code>snip+ name body</code> to save, <code>snip- name</code> to delete.</p>',
                        },
                    ],
                },
            ],
        };
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
