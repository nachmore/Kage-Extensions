/**
 * Tests for auth.js's cross-window refresh-race defences.
 *
 * The scenario these pin (see CONTRIBUTING.md "multiple concurrent
 * instances"): every Kage window runs its own copy of auth.js against
 * one shared creds store. Spotify rotates the refresh token on every
 * refresh, so a window that refreshes with a token a sibling already
 * rotated gets a 4xx — and pre-fix, surfaced it as "signed out" (or
 * worse, tripped Spotify's reuse detection and killed the grant).
 *
 * Defences under test:
 *   1. Lost-race healing — on a 4xx refresh, re-read creds; if a
 *      sibling rotated them, use the sibling's result (live access
 *      token directly, or one retry with the sibling's refresh token).
 *   2. Genuinely-dead detection — 4xx with UNCHANGED stored creds still
 *      fails (that's a real revocation, not a race).
 *   3. Refresh lock — while a sibling holds the lock, we wait and adopt
 *      the token it wrote instead of racing it.
 *
 * We drive the real module through its public api() with a mocked host
 * context (shared store = the cross-window surface) and stubbed fetch.
 * auth.js is a module singleton, so tests re-init() it per case; the
 * random per-module _instanceId just needs to differ from the fake
 * sibling's lock holder id, which is guaranteed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as auth from './auth.js';

const CLIENT = JSON.stringify({ client_id: 'abcdef0123456789abcd' });

// Creds with an EXPIRED access token so api() must refresh first.
const staleCreds = (rt) =>
    JSON.stringify({
        refresh_token: rt,
        access_token: 'expired-at',
        expires_at: 0,
        scopes: 's',
    });

// Creds as a sibling window would write them after winning the race:
// rotated refresh token + live access token.
const siblingCreds = () =>
    JSON.stringify({
        refresh_token: 'rt-2-rotated',
        access_token: 'at-2-live',
        expires_at: Date.now() + 3_600_000,
        scopes: 's',
    });

function makeStore(initial = {}) {
    const store = { ...initial };
    const invokes = {
        load_extension_data: ({ key }) => store[key] ?? null,
        save_extension_data: ({ key, data }) => {
            store[key] = data;
            return null;
        },
        delete_extension_data: ({ key }) => {
            delete store[key];
            return null;
        },
    };
    return { store, invoke: async (cmd, args) => invokes[cmd](args) };
}

function setup(storeSeed) {
    const { store, invoke } = makeStore(storeSeed);
    auth.init({ invoke, log: { warn: () => {} } });
    return { store };
}

// fetch stub keyed by URL: token-endpoint calls consume `tokenResponses`
// in order; API calls consume `apiResponses`.
function stubFetch({ tokenResponses = [], apiResponses = [] }) {
    const tokens = [...tokenResponses];
    const apis = [...apiResponses];
    const calls = { token: [], api: [] };
    globalThis.fetch = vi.fn(async (url, init) => {
        const isToken = String(url).includes('/api/token');
        if (isToken) calls.token.push(new URLSearchParams(init.body).get('refresh_token'));
        else calls.api.push(String(url));
        const r = (isToken ? tokens : apis).shift() || { status: 500, body: '' };
        const bodyText = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '');
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            statusText: `HTTP ${r.status}`,
            text: async () => bodyText,
            json: async () => (bodyText ? JSON.parse(bodyText) : null),
        };
    });
    return calls;
}

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
});

describe('Spotify auth — cross-window refresh race', () => {
    it('heals a lost race by adopting the sibling\'s live token (no second round trip)', async () => {
        const { store } = setup({ client: CLIENT, creds: staleCreds('rt-1') });
        const calls = stubFetch({
            // Our refresh with rt-1 rejects — sibling already rotated it.
            tokenResponses: [{ status: 400, body: { error: 'invalid_grant' } }],
            apiResponses: [{ status: 200, body: { ok: true } }],
        });
        // Sibling wins the race between our readCreds and our round trip:
        // simulate by swapping the store when the token endpoint is hit.
        const origFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async (url, init) => {
            if (String(url).includes('/api/token')) {
                store.creds = siblingCreds();
            }
            return origFetch(url, init);
        });

        const out = await auth.api('GET', '/me');
        expect(out).toEqual({ ok: true });
        // Exactly one token round trip (ours, which lost) — the sibling's
        // live access token made a retry unnecessary.
        expect(calls.token).toEqual(['rt-1']);
        // The API call went out with the sibling's token.
        expect(calls.api).toHaveLength(1);
    });

    it('heals a lost race by retrying with the sibling\'s rotated refresh token', async () => {
        const { store } = setup({ client: CLIENT, creds: staleCreds('rt-1') });
        // Sibling rotated the refresh token but its access token has since
        // expired too — we must do our own round trip with rt-2.
        const calls = stubFetch({
            tokenResponses: [
                { status: 400, body: { error: 'invalid_grant' } },
                { status: 200, body: { access_token: 'at-3', expires_in: 3600, refresh_token: 'rt-3', scope: 's' } },
            ],
            apiResponses: [{ status: 200, body: { ok: true } }],
        });
        const origFetch = globalThis.fetch;
        let swapped = false;
        globalThis.fetch = vi.fn(async (url, init) => {
            if (!swapped && String(url).includes('/api/token')) {
                swapped = true;
                store.creds = JSON.stringify({
                    refresh_token: 'rt-2-rotated',
                    access_token: 'expired-too',
                    expires_at: 0,
                    scopes: 's',
                });
            }
            return origFetch(url, init);
        });

        const out = await auth.api('GET', '/me');
        expect(out).toEqual({ ok: true });
        // First attempt with our stale rt-1, healed retry with rt-2.
        expect(calls.token).toEqual(['rt-1', 'rt-2-rotated']);
        // The healed rotation was persisted (rt-3 from the retry).
        expect(JSON.parse(store.creds).refresh_token).toBe('rt-3');
    });

    it('still fails when the stored token is unchanged (genuine revocation)', async () => {
        setup({ client: CLIENT, creds: staleCreds('rt-1') });
        const calls = stubFetch({
            tokenResponses: [{ status: 400, body: { error: 'invalid_grant' } }],
        });

        await expect(auth.api('GET', '/me')).rejects.toThrow(/Token refresh failed: 400/);
        // No healed retry — the creds on disk never changed, so this is a
        // real revocation, not a race.
        expect(calls.token).toEqual(['rt-1']);
    });

    it('waits out a sibling\'s refresh lock and adopts its result', async () => {
        const { store } = setup({ client: CLIENT, creds: staleCreds('rt-1') });
        // A sibling holds the lock. Shortly after we start waiting, it
        // finishes: writes fresh creds and releases the lock.
        store.refresh_lock = JSON.stringify({
            holder: 'sibling-instance',
            expires_at: Date.now() + 10_000,
        });
        const calls = stubFetch({ apiResponses: [{ status: 200, body: { ok: true } }] });
        setTimeout(() => {
            store.creds = siblingCreds();
            delete store.refresh_lock;
        }, 600);

        const out = await auth.api('GET', '/me');
        expect(out).toEqual({ ok: true });
        // We never hit the token endpoint — the sibling's token was adopted.
        expect(calls.token).toEqual([]);
    }, 10_000);
});
