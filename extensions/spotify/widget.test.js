/**
 * Tests for the Spotify now-playing widget's disconnected-state affordance.
 *
 * The contract these pin:
 *   - a healthy poll renders the now-playing bar and clears any failure streak;
 *   - a *critical* auth failure (revoked token) shows the "disconnected"
 *     affordance, but only AFTER it repeats (AUTH_FAIL_THRESHOLD) — a single
 *     blip never flashes it;
 *   - a transient network failure NEVER shows the affordance, however many
 *     times it repeats (true offline is the host connectivity bar's job);
 *   - a successful poll after failures resets the streak so the affordance
 *     doesn't linger.
 *
 * The OAuth/browser flow stays in manual QA; we drive render() over a mocked
 * host context + stubbed global fetch, same pattern as settings.test.js.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import SpotifyNowPlayingWidget from './widget.js';
import * as auth from './auth.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

const EN_CATALOG = JSON.parse(
    readFileSync(fileURLToPath(new URL('./_locales/en/messages.json', import.meta.url)), 'utf8')
);

const CLIENT = JSON.stringify({ client_id: 'abcdef0123456789abcd' });
const CREDS = JSON.stringify({
    refresh_token: 'rt-123',
    access_token: 'at-123',
    // Fresh so a successful poll doesn't need a refresh round-trip.
    expires_at: Date.now() + 3_600_000,
    scopes: 'user-read-playback-state',
});

function makeStore(initial = {}) {
    const store = { ...initial };
    return {
        store,
        invokes: {
            load_extension_data: ({ key }) => store[key] ?? null,
            save_extension_data: ({ key, data }) => {
                store[key] = data;
                return null;
            },
            delete_extension_data: ({ key }) => {
                delete store[key];
                return null;
            },
        },
    };
}

function setup(storeSeed = { client: CLIENT, creds: CREDS }, config = { show_now_playing_bar: true }) {
    const { store, invokes } = makeStore(storeSeed);
    const { context } = makeContext({ invokes, catalog: EN_CATALOG, config });
    const widget = new SpotifyNowPlayingWidget();
    widget.initialize(context);
    return { widget, store };
}

// fetch stub: each call throws `err` (failure case) or returns the queued
// response (success case).
function failFetch(makeError) {
    globalThis.fetch = vi.fn(async () => {
        throw makeError();
    });
}
function okPlayerFetch() {
    globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ is_playing: true, item: { id: 't1', name: 'Song', artists: [{ name: 'A' }], album: { images: [] } } }),
        json: async () => ({ is_playing: true, item: { id: 't1' } }),
    }));
}

const authError = () => Object.assign(new Error('Spotify API 401: token expired'), { status: 401 });
const networkError = () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });

describe('Spotify widget — disconnected affordance', () => {
    beforeEach(() => {
        // Widget short-circuits when navigator.onLine === false; force online
        // so we exercise the fetch path.
        vi.stubGlobal('navigator', { onLine: true });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        delete globalThis.fetch;
    });

    it('does not show the affordance on the first auth failure', async () => {
        const { widget } = setup();
        failFetch(authError);
        const out = await widget.render();
        expect(out).toBeNull();
    });

    it('shows the affordance after two consecutive auth failures', async () => {
        const { widget } = setup();
        failFetch(authError);
        await widget.render(); // strike 1 → null
        const out = await widget.render(); // strike 2 → affordance
        expect(out).not.toBeNull();
        expect(out.className).toMatch(/spotify-bar-disconnected/);
        expect(out.html).toMatch(/Spotify disconnected/);
        expect(out.actions).toEqual([{ id: 'reconnect', rpc: 'reconnect' }]);
    });

    it('never shows the affordance for repeated network failures', async () => {
        const { widget } = setup();
        failFetch(networkError);
        for (let i = 0; i < 5; i++) {
            expect(await widget.render()).toBeNull();
        }
    });

    it('resets the streak after a successful poll', async () => {
        const { widget } = setup();
        // One auth failure (below threshold)...
        failFetch(authError);
        await widget.render();
        // ...then a success clears the streak...
        okPlayerFetch();
        const ok = await widget.render();
        expect(ok?.className).toMatch(/spotify-bar/);
        expect(ok?.className).not.toMatch(/disconnected/);
        // ...so a single later failure again stays below threshold.
        failFetch(authError);
        expect(await widget.render()).toBeNull();
    });

    it('reconnect action fires sign-in without awaiting the full flow', async () => {
        const { widget } = setup();
        // startSignIn would drive a browser+loopback flow; stub the first
        // network hop so it doesn't actually run, and assert onAction returns
        // promptly without rerender.
        globalThis.fetch = vi.fn(async () => {
            throw new Error('no browser in test');
        });
        const res = await widget.onAction('reconnect');
        expect(res).toEqual({ rerender: false });
    });
});

describe('Spotify widget — dirty-flag like-cache invalidation', () => {
    beforeEach(() => {
        vi.stubGlobal('navigator', { onLine: true });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        delete globalThis.fetch;
    });

    // URL-aware stub: same track on every /me/player poll, but the like-state
    // (/me/tracks/contains) flips from [false] to [true] between polls. Lets us
    // prove the widget re-reads like-state after a state-dirty signal even
    // though the track id never changed.
    function stubWithLike(likeStates) {
        const likes = [...likeStates];
        globalThis.fetch = vi.fn(async (url) => {
            const u = String(url);
            let body;
            if (u.includes('/me/tracks/contains')) {
                body = likes.length > 1 ? likes.shift() : likes[0];
            } else {
                body = { is_playing: true, item: { id: 't1', name: 'Song', artists: [{ name: 'A' }], album: { images: [] } } };
            }
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                text: async () => JSON.stringify(body),
                json: async () => body,
            };
        });
    }

    it('re-reads like-state on the same track after markStateDirty', async () => {
        const { widget } = setup();
        stubWithLike([[false], [true]]);

        const first = await widget.render();
        expect(first.html).toContain('♡'); // not liked yet

        // Without a dirty signal, the widget trusts its per-track cache and
        // would still show ♡ — assert that baseline so the test is meaningful.
        const cached = await widget.render();
        expect(cached.html).toContain('♡');

        // A search command liked the track and flagged state dirty.
        auth.markStateDirty();
        const refreshed = await widget.render();
        expect(refreshed.html).toContain('♥'); // heart now filled
    });
});
