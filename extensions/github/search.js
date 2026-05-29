// GitHub search — unauthenticated by default (60 req/hr per IP).
//
// If the user pastes a personal access token in settings, requests use
// it (5000 req/hr) and lookups for private repos / issues work too.
// Tokens never leave the user's machine outside the request to GitHub.
//
// "gh <q>"      -> search repos
// "gh @<user>"  -> look up a user
// "gh #<q>"     -> search issues
// "gh me"       -> open the GitHub home page

const TOKEN_KEY = 'token';

let _ctx = null;
let _cachedToken = null;

async function getToken() {
    if (_cachedToken !== null) return _cachedToken;
    try {
        const raw = await _ctx.invoke('load_extension_data', { key: TOKEN_KEY });
        _cachedToken = raw ? (JSON.parse(raw).token || '') : '';
    } catch {
        _cachedToken = '';
    }
    return _cachedToken;
}

export async function setToken(token) {
    _cachedToken = token || '';
    await _ctx.invoke('save_extension_data', {
        key: TOKEN_KEY,
        data: JSON.stringify({ token: token || '' }),
    });
}

async function ghFetch(path) {
    const token = await getToken();
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetch(`https://api.github.com${path}`, { headers });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
    return await resp.json();
}

export default class GitHubSearchProvider {
    initialize(context) {
        _ctx = context;
        this.invoke = context.invoke;
        this.config = context.config || {};
        this.log = context.log;
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }
    onConfigUpdate(config) { this.config = config || {}; }

    match(query) {
        const trigger = (this.config.trigger || 'gh').toLowerCase();
        const t = query.trim();
        const lower = t.toLowerCase();
        if (lower !== trigger && !lower.startsWith(trigger + ' ')) return [];
        const rest = t.slice(trigger.length).trim();
        if (!rest) {
            return [{
                id: 'gh:home', type: 'github',
                label: this.t('result.home.label'),
                description: this.t('result.home.description'),
                icon: '🐙', score: 80,
                data: { url: 'https://github.com' },
            }];
        }
        if (rest === 'me') {
            return [{
                id: 'gh:me', type: 'github',
                label: this.t('result.me.label'),
                description: this.t('result.me.description'),
                icon: '🐙', score: 90,
                data: { meHome: true },
            }];
        }
        return [{
            id: `gh:loading:${rest}`, type: 'github',
            label: this.t('result.searching.label', { query: rest }),
            description: '',
            icon: '🐙', score: 50,
            data: { pending: true },
        }];
    }

    async matchAsync(query) {
        const trigger = (this.config.trigger || 'gh').toLowerCase();
        const t = query.trim();
        const lower = t.toLowerCase();
        if (lower !== trigger && !lower.startsWith(trigger + ' ')) return [];
        const rest = t.slice(trigger.length).trim();
        if (!rest || rest === 'me') return [];

        try {
            // User lookup: @username
            if (rest.startsWith('@')) {
                const user = rest.slice(1).trim();
                if (!user) return [];
                const u = await ghFetch(`/users/${encodeURIComponent(user)}`);
                return [{
                    id: `gh:user:${u.login}`,
                    type: 'github',
                    label: `${u.login} · ${u.name || ''}`,
                    description: `${u.public_repos} repos · ${u.followers} followers · ${u.bio || ''}`.slice(0, 140),
                    icon: '👤', score: 95,
                    data: { url: u.html_url },
                }];
            }
            // Issues: #query
            if (rest.startsWith('#')) {
                const q = rest.slice(1).trim();
                if (!q) return [];
                const data = await ghFetch(`/search/issues?q=${encodeURIComponent(q)}&per_page=5`);
                return (data.items || []).slice(0, 5).map((i, idx) => ({
                    id: `gh:issue:${i.id}`,
                    type: 'github',
                    label: `${i.title}`,
                    description: `${repoFromUrl(i.repository_url)} · ${i.state} · ${i.user?.login} · ${formatRel(i.updated_at)}`,
                    icon: i.pull_request ? '🔀' : i.state === 'closed' ? '✅' : '🐛',
                    score: 95 - idx,
                    data: { url: i.html_url },
                }));
            }
            // Repos
            const data = await ghFetch(`/search/repositories?q=${encodeURIComponent(rest)}&sort=stars&per_page=5`);
            return (data.items || []).slice(0, 5).map((r, idx) => ({
                id: `gh:repo:${r.id}`,
                type: 'github',
                label: r.full_name,
                description: `★ ${r.stargazers_count.toLocaleString()} · ${r.language || ''} · ${r.description || ''}`.slice(0, 140),
                icon: '📦',
                score: 95 - idx,
                data: { url: r.html_url },
            }));
        } catch (e) {
            this.log?.warn?.('GitHub fetch failed: ' + (e?.message || e));
            return [{
                id: 'gh:err', type: 'github',
                label: this.t('result.error.label'),
                description: e?.message || String(e),
                icon: '⚠️', score: 60,
                data: { error: true },
            }];
        }
    }

    async execute(result) {
        const d = result?.data || {};
        if (d.meHome) {
            const token = await getToken();
            if (token) {
                try {
                    const u = await ghFetch('/user');
                    return { type: 'open_url', value: u.html_url };
                } catch {}
            }
            return { type: 'open_url', value: 'https://github.com' };
        }
        if (d.url) return { type: 'open_url', value: d.url };
        return { type: 'custom', data: {} };
    }
}

function repoFromUrl(u) {
    if (!u) return '';
    const m = u.match(/repos\/([^/]+\/[^/]+)/);
    return m ? m[1] : '';
}

function formatRel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const days = Math.floor(diff / 86400000);
    if (days < 1) return 'today';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
}
