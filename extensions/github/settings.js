// GitHub settings — captures an optional personal access token so
// users can lift the 60 req/hr unauthenticated rate limit and search
// private repos.

import { init, setToken } from './search.js';
import { DEFAULTS } from './defaults.js';

export default class GitHubSettingsProvider {
    initialize(context) {
        init(context);
        this.invoke = context.invoke;
        this.config = context.config || {};
        this.hostFeatures = context.hostFeatures;
        this._ctx = context;
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }
    onConfigUpdate(config) { this.config = config || {}; }

    async getSettings() {
        const t = this.t;
        const raw = await this.invoke('load_extension_data', { key: 'token' });
        const stored = raw ? JSON.parse(raw) : { token: '' };
        const hasToken = !!(stored.token && stored.token.length > 10);
        return {
            description: t('settings.description'),
            sections: [
                {
                    controls: [
                        { type: 'text', id: 'trigger', label: t('settings.trigger.label'), default: DEFAULTS.trigger, maxWidth: 80 },
                    ],
                },
                {
                    label: t('settings.section.access'),
                    controls: [
                        {
                            type: 'info',
                            html: t('settings.access.intro_html')
                                + (hasToken ? t('settings.access.token_saved_html') : ''),
                        },
                        {
                            type: 'text', id: '__token_input', label: t('settings.token_input.label'),
                            default: '', placeholder: 'ghp_…  or  github_pat_…',
                        },
                        { type: 'action', id: 'save_token', label: t('settings.save_token.label'), action: 'save_token' },
                        {
                            type: 'action', id: 'clear_token', label: t('settings.clear_token.label'),
                            action: 'clear_token', variant: 'danger',
                            confirm: t('settings.clear_token.confirm'),
                        },
                    ],
                },
            ],
        };
    }

    normalize(values = {}) {
        const clean = {};
        for (const [key, value] of Object.entries(values)) {
            if (!key.startsWith('__')) clean[key] = value;
            else if (!this.hostFeatures) clean[key] = '';
        }
        return { values: { ...clean, trigger: (clean.trigger || DEFAULTS.trigger).trim().toLowerCase() } };
    }

    async runAction(action, values) {
        const t = this.t;
        if (action === 'save_token') {
            const tok = (values.__token_input || '').trim();
            if (!tok) return { status: t('action.save_token.empty') };
            if (!/^(gh[opsu]_|github_pat_)/i.test(tok)) return { status: t('action.save_token.invalid') };
            await setToken(tok);
            return { status: t('action.save_token.success') };
        }
        if (action === 'clear_token') {
            await setToken('');
            return { status: t('action.clear_token.success') };
        }
        return {};
    }
}
