/**
 * Functional tests for the GitHub provider.
 * match() is pure (home/me/loading rows + trigger gating). matchAsync() hits
 * api.github.com via fetch for repo/user/issue lookups; we stub fetch and
 * route by path. The token read is mocked through invoke(load_extension_data).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import GitHubSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

function setup({ config = {}, token = '' } = {}) {
    const invokes = {
        load_extension_data: token ? JSON.stringify({ token }) : null,
        save_extension_data: undefined,
    };
    const { context } = makeContext({ config, invokes });
    const provider = new GitHubSearchProvider();
    provider.initialize(context);
    return { provider };
}

/** Stub the GitHub API: map of path-substring → json body. */
function stubGitHub(routes) {
    global.fetch = vi.fn(async (url) => {
        const path = url.replace('https://api.github.com', '');
        for (const [needle, body] of Object.entries(routes)) {
            if (path.includes(needle)) return { ok: true, json: async () => body };
        }
        return { ok: false, status: 404 };
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
});

describe('GitHubSearchProvider — match', () => {
    it('requires the trigger', () => {
        expect(setup().provider.match('hello')).toEqual([]);
    });

    it('offers the GitHub home for the bare trigger', () => {
        const row = setup().provider.match('gh')[0];
        expect(row.data.url).toBe('https://github.com');
    });

    it('recognises "gh me"', () => {
        expect(setup().provider.match('gh me')[0].data.meHome).toBe(true);
    });

    it('returns a pending row for a query', () => {
        expect(setup().provider.match('gh react')[0].data.pending).toBe(true);
    });
});

describe('GitHubSearchProvider — matchAsync', () => {
    it('looks up a user with @username', async () => {
        stubGitHub({
            '/users/torvalds': {
                login: 'torvalds',
                name: 'Linus Torvalds',
                public_repos: 7,
                followers: 200000,
                bio: 'I make kernels',
                html_url: 'https://github.com/torvalds',
            },
        });
        const rows = await setup().provider.matchAsync('gh @torvalds');
        expect(rows[0].label).toContain('torvalds');
        expect(rows[0].data.url).toBe('https://github.com/torvalds');
    });

    it('searches issues with #query', async () => {
        stubGitHub({
            '/search/issues': {
                items: [
                    {
                        id: 1,
                        title: 'Fix the bug',
                        repository_url: 'https://api.github.com/repos/foo/bar',
                        state: 'open',
                        user: { login: 'alice' },
                        updated_at: new Date().toISOString(),
                        html_url: 'https://github.com/foo/bar/issues/1',
                    },
                ],
            },
        });
        const rows = await setup().provider.matchAsync('gh #bug');
        expect(rows[0].label).toBe('Fix the bug');
        expect(rows[0].data.url).toContain('/issues/1');
    });

    it('returns nothing async for bare trigger and "me"', async () => {
        expect(await setup().provider.matchAsync('gh')).toEqual([]);
        expect(await setup().provider.matchAsync('gh me')).toEqual([]);
    });
});
