// GitHub settings — captures an optional personal access token so
// users can lift the 60 req/hr unauthenticated rate limit and search
// private repos.

import { setToken } from './search.js';

export default class GitHubSettingsProvider {
    initialize(context) {
        this.invoke = context.invoke;
        this.config = context.config || {};
        this._ctx = context;
    }
    onConfigUpdate(config) { this.config = config || {}; }

    async getSettings() {
        const raw = await this.invoke('load_extension_data', { key: 'token' });
        const stored = raw ? JSON.parse(raw) : { token: '' };
        const hasToken = !!(stored.token && stored.token.length > 10);
        return {
            description:
                'Search GitHub from the launcher. Works unauthenticated up to 60 req/hr (per IP). ' +
                'Optional: paste a fine-grained personal access token for 5,000 req/hr and access ' +
                'to private repos. The token is stored locally in Kage\'s sandboxed extension data.',
            sections: [
                {
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: 'Enable', default: true },
                        { type: 'text', id: 'trigger', label: 'Trigger', default: 'gh', maxWidth: 80 },
                    ],
                },
                {
                    label: 'GitHub access (optional)',
                    controls: [
                        {
                            type: 'info',
                            html:
                                '<p>Generate a fine-grained personal access token at ' +
                                '<a href="https://github.com/settings/personal-access-tokens/new">' +
                                'github.com/settings/personal-access-tokens/new</a>. ' +
                                '<em>Read-only</em> on the repos / issues / users you want to search ' +
                                'is enough. The token never leaves your machine except in the ' +
                                'Authorization header to <code>api.github.com</code>.</p>' +
                                (hasToken ? '<p><strong>Token saved.</strong> Paste a new one to replace, or click <em>Forget token</em> to remove.</p>' : ''),
                        },
                        {
                            type: 'text', id: '__token_input', label: 'Token',
                            default: '', placeholder: 'ghp_…  or  github_pat_…',
                        },
                        { type: 'action', id: 'save_token', label: 'Save token', action: 'save_token' },
                        {
                            type: 'action', id: 'clear_token', label: 'Forget token',
                            action: 'clear_token', variant: 'danger',
                            confirm: 'Forget the saved GitHub token? Future searches fall back to the 60 req/hr public limit.',
                        },
                    ],
                },
            ],
        };
    }

    normalize(values) {
        const { __token_input, ...rest } = values;
        return { values: { ...rest, trigger: (rest.trigger || 'gh').trim().toLowerCase() } };
    }

    async runAction(action, values) {
        if (action === 'save_token') {
            const t = (values.__token_input || '').trim();
            if (!t) return { status: '⚠️ Paste a token first.' };
            if (!/^(gh[opsu]_|github_pat_)/i.test(t)) return { status: '⚠️ Doesn\'t look like a GitHub token.' };
            await setToken(t);
            return { status: '✅ Token saved.' };
        }
        if (action === 'clear_token') {
            await setToken('');
            return { status: '✅ Token forgotten.' };
        }
        return {};
    }
}
