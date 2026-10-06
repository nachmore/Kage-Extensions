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

function setup(
    storeSeed = { client: CLIENT, creds: CREDS },
    config = { show_now_playing_bar: true },
    ctxOpts = {}
) {
    const { store, invokes } = makeStore(storeSeed);
    const { context, mascot } = makeContext({ invokes, catalog: EN_CATALOG, config, ...ctxOpts });
    const widget = new SpotifyNowPlayingWidget();
    widget.initialize(context);
    return { widget, store, mascot };
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
// Like okPlayerFetch but with an explicit is_playing — the mascot hint turns
// on exactly this field, so the paused case needs its own stub.
function playerFetch(isPlaying) {
    const body = {
        is_playing: isPlaying,
        item: { id: 't1', name: 'Song', artists: [{ name: 'A' }], album: { images: [] } },
    };
    globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(body),
        json: async () => body,
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
        // The button is a glyph — localized "Reconnect" text overflows the
        // square bar buttons, so it lives in the tooltip instead.
        expect(out.html).toMatch(/title="Reconnect"[^>]*>↻</);
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

    it('persists the revoked marker when the affordance shows (settings reads it)', async () => {
        const { widget, store } = setup();
        failFetch(authError);
        await widget.render(); // strike 1
        await widget.render(); // strike 2 → affordance + marker
        // markAuthRevoked is fire-and-forget from render; let it settle.
        await Promise.resolve();
        expect(store.status).toBeDefined();
        expect(JSON.parse(store.status).auth_revoked).toBe(true);
    });

    it('clears the revoked marker on a healthy poll', async () => {
        const { widget, store } = setup();
        failFetch(authError);
        await widget.render();
        await widget.render(); // marker set
        await Promise.resolve();
        expect(store.status).toBeDefined();
        okPlayerFetch();
        await widget.render(); // healthy → marker retracted
        await Promise.resolve();
        expect(store.status).toBeUndefined();
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

/**
 * Mascot activity hints.
 *
 * The contract: while audio is actually playing the widget holds a LEASE on
 * the generic 'music' activity — generic because the mascot deliberately
 * knows nothing about Spotify specifically. The lease expires on its own, so
 * it must be re-asserted on every poll with a TTL comfortably longer than the
 * poll interval, and released the moment playback stops. A host without the
 * API (`context.mascot === undefined`) must still work.
 */
describe('Spotify widget — mascot activity lease', () => {
    beforeEach(() => {
        vi.stubGlobal('navigator', { onLine: true });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        delete globalThis.fetch;
    });

    it("asserts the generic 'music' activity while a track is playing", async () => {
        const { widget, mascot } = setup();
        playerFetch(true);
        await widget.render();
        expect(mascot.setActivity).toHaveBeenCalledTimes(1);
        const [name, opts] = mascot.setActivity.mock.calls[0];
        expect(name).toBe('music');
        // 3x the default 15s cadence — never shorter than the poll interval,
        // or the mascot would flicker between ticks.
        expect(opts.ttlMs).toBe(45_000);
        expect(mascot.clearActivity).not.toHaveBeenCalled();
    });

    it('re-asserts the lease on every poll', async () => {
        const { widget, mascot } = setup();
        playerFetch(true);
        await widget.render();
        await widget.render();
        await widget.render();
        expect(mascot.setActivity).toHaveBeenCalledTimes(3);
    });

    it('never lets the TTL fall under the floor on a fast poll cadence', async () => {
        const { widget, mascot } = setup({ client: CLIENT, creds: CREDS }, {
            show_now_playing_bar: true,
            refresh_seconds: 2, // the configurable minimum
        });
        playerFetch(true);
        await widget.render();
        expect(mascot.setActivity.mock.calls[0][1].ttlMs).toBe(20_000);
    });

    it('releases the lease when playback is paused', async () => {
        const { widget, mascot } = setup();
        playerFetch(true);
        await widget.render();
        playerFetch(false);
        await widget.render();
        expect(mascot.setActivity).toHaveBeenCalledTimes(1);
        expect(mascot.clearActivity).toHaveBeenCalled();
    });

    it('releases the lease when the bar renders nothing at all', async () => {
        // Not signed in → render() bails before the first fetch. Still has to
        // let go, otherwise a stale hint sits there until the TTL lapses.
        const { widget, mascot } = setup({});
        const out = await widget.render();
        expect(out).toBeNull();
        expect(mascot.clearActivity).toHaveBeenCalled();
        expect(mascot.setActivity).not.toHaveBeenCalled();
    });

    it('releases the lease when a poll fails', async () => {
        const { widget, mascot } = setup();
        playerFetch(true);
        await widget.render();
        failFetch(networkError);
        await widget.render();
        expect(mascot.clearActivity).toHaveBeenCalled();
    });

    it('works on a host with no mascot API', async () => {
        // Older hosts have no context.mascot — every call site is optional, so
        // the bar must render exactly as before rather than throwing.
        const { widget } = setup({ client: CLIENT, creds: CREDS }, { show_now_playing_bar: true }, { mascot: null });
        playerFetch(true);
        const out = await widget.render();
        expect(out?.html).toContain('Song');
    });
});
