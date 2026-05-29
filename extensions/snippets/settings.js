export default class SnippetsSettingsProvider {
    initialize(context) {
        this.invoke = context.invoke;
        this.config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }
    onConfigUpdate(config) { this.config = config || {}; }

    async getSettings() {
        const t = this.t;
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
        const countHtml = t('settings.info.saved_count', { count, plural: count === 1 ? '' : 's' });
        const bodyHtml = count > 0 ? `<ul>${list}</ul>` : t('settings.info.none_yet');
        return {
            description: t('settings.description'),
            sections: [
                {
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: t('settings.enabled.label'), default: true },
                        { type: 'text', id: 'trigger', label: t('settings.trigger.label'), default: 'snip', maxWidth: 120 },
                        {
                            type: 'info',
                            html: countHtml + bodyHtml + t('settings.info.usage_html'),
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
