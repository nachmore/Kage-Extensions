export default class BookmarksSettingsProvider {
    initialize(context) {
        this.invoke = context.invoke;
        this.config = context.config || {};
    }
    onConfigUpdate(config) { this.config = config || {}; }

    async getSettings() {
        const raw = await this.invoke('load_extension_data', { key: 'bookmarks' });
        const all = raw ? JSON.parse(raw) : {};
        const count = Object.keys(all).length;
        const list = Object.entries(all)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, v]) => `<li><strong>${escapeHtml(name)}</strong> &mdash; <a href="${escapeHtml(v.url)}">${escapeHtml(v.url)}</a></li>`)
            .join('');
        return {
            description: 'Save URLs and open them with one keystroke from the floating window.',
            sections: [
                {
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: 'Enable', default: true },
                        {
                            type: 'text', id: 'trigger', label: 'Trigger word',
                            default: 'bm', maxWidth: 100,
                            description: 'Type this in the floating window to search bookmarks.',
                        },
                        {
                            type: 'info',
                            html: `<p><strong>${count} bookmarks saved.</strong></p>` +
                                (count > 0 ? `<ul>${list}</ul>` : '<p>None yet. Add one with <code>bm+ name https://example.com</code>.</p>') +
                                '<p><em>Usage:</em> <code>bm name</code> to open, <code>bm+ name url</code> to save, <code>bm- name</code> to delete.</p>',
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
