/**
 * Tests for the Spotify settings provider's "Check connection" action.
 *
 * The OAuth/browser flow stays in manual QA, but the connection-check
 * classification is pure logic layered over the `invoke` boundary
 * (load/save/delete extension-data + fetch), and it's exactly the part that
 * decides whether the UI tells the truth about being connected. We drive it
 * through the real provider with a mocked host context + a stubbed global
 * fetch so each Spotify outcome (valid / revoked / network / signed-out)
 * maps to the right status and side effect.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import SpotifySettingsProvider from './settings.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

// Real EN catalog so status assertions match the shipped message text
// rather than key echoes.
const EN_CATALOG = JSON.parse(
    readFileSync(fileURLToPath(new URL('./_locales/en/messages.json', import.meta.url)), 'utf8')
);

// In-memory extension-data store backing load/save/delete_extension_data.
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

const CLIENT = JSON.stringify({ client_id: 'abcdef0123456789abcd' });
const CREDS = JSON.stringify({
    refresh_token: 'rt-123',
    access_token: 'at-123',
    // Expired so the check forces a refresh path (mirrors a real re-validate).
    expires_at: 0,
    scopes: 'user-read-playback-state',
});

function setup(storeSeed = {}) {
    const { store, invokes } = makeStore(storeSeed);
    const { context, invoke } = makeContext({ invokes, catalog: EN_CATALOG });
    const provider = new SpotifySettingsProvider();
    provider.initialize(context);
    return { provider, store, invoke };
}

// Minimal fetch stub: a queue of {status, body} responses consumed in order.
function stubFetch(responses) {
    const queue = [...responses];
    globalThis.fetch = vi.fn(async () => {
        const r = queue.shift() || { status: 500, body: '' };
        const bodyText = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '');
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            statusText: `HTTP ${r.status}`,
            text: async () => bodyText,
            json: async () => (bodyText ? JSON.parse(bodyText) : null),
        };
    });
}

describe('Spotify settings — check_connection action', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        delete globalThis.fetch;
    });

    it('reports connected (with name) when Spotify accepts the token', async () => {
        const { provider } = setup({ client: CLIENT, creds: CREDS });
        // 1st fetch: token refresh (expired). 2nd fetch: GET /me.
        stubFetch([
            { status: 200, body: { access_token: 'fresh', expires_in: 3600, scope: 's' } },
            { status: 200, body: { display_name: 'Ada', id: 'ada99' } },
        ]);

        const res = await provider.runAction('check_connection', {});
        expect(res.status).toMatch(/Connected as Ada/);
    });

    it('detects a revoked token and clears the stored creds', async () => {
        const { provider, store } = setup({ client: CLIENT, creds: CREDS });
        // Token refresh rejects with invalid_grant — the revoked case.
        stubFetch([{ status: 400, body: { error: 'invalid_grant' } }]);

        const res = await provider.runAction('check_connection', {});

        expect(res.status).toMatch(/expired or was revoked/i);
        // Dead creds must be wiped so the panel stops claiming "Signed in".
        expect(store.creds).toBeUndefined();
        // Client ID is a separate concern — leave it so reconnect is one click.
        expect(store.client).toBe(CLIENT);
        // Request a panel re-render so the status text + button states update.
        expect(res.host).toEqual({ type: 'refresh' });
    });

    it('does NOT clear creds on a transient network failure', async () => {
        const { provider, store } = setup({ client: CLIENT, creds: CREDS });
        globalThis.fetch = vi.fn(async () => {
            const e = new Error('The operation timed out');
            e.name = 'TimeoutError';
            throw e;
        });

        const res = await provider.runAction('check_connection', {});

        expect(res.status).toMatch(/Couldn't reach Spotify/i);
        // The token might be perfectly fine — must survive a network blip.
        expect(store.creds).toBe(CREDS);
    });

    it('reports not-signed-in when there are no stored creds', async () => {
        const { provider } = setup({ client: CLIENT });
        const res = await provider.runAction('check_connection', {});
        expect(res.status).toMatch(/Not signed in/i);
    });

    it('reports missing client id when none is saved', async () => {
        const { provider } = setup({});
        const res = await provider.runAction('check_connection', {});
        expect(res.status).toMatch(/No Client ID/i);
    });

    it('disconnect clears everything and requests a refresh', async () => {
        const { provider, store } = setup({ client: CLIENT, creds: CREDS });
        const res = await provider.runAction('disconnect', {});
        expect(store.creds).toBeUndefined();
        expect(store.client).toBeUndefined();
        expect(res.host).toEqual({ type: 'refresh' });
    });
});

describe('Spotify settings — getSettings reflects connection state', () => {
    it('when connected: Reconnect label + Sign Out enabled', async () => {
        const { provider } = setup({ client: CLIENT, creds: CREDS });
        const schema = await provider.getSettings();
        const connSection = schema.sections.find((s) =>
            s.controls.some((c) => c.id === 'connect')
        );
        const connect = connSection.controls.find((c) => c.id === 'connect');
        const disconnect = connSection.controls.find((c) => c.id === 'disconnect');
        expect(connect.label).toBe('Reconnect');
        expect(disconnect.disabled).toBe(false);
    });

    it('when disconnected: Connect label + Sign Out disabled', async () => {
        const { provider } = setup({ client: CLIENT }); // client only, no creds
        const schema = await provider.getSettings();
        const connSection = schema.sections.find((s) =>
            s.controls.some((c) => c.id === 'connect')
        );
        const connect = connSection.controls.find((c) => c.id === 'connect');
        const disconnect = connSection.controls.find((c) => c.id === 'disconnect');
        expect(connect.label).toBe('Connect');
        expect(disconnect.disabled).toBe(true);
    });

    it('when the widget marked the session revoked: status says expired, not signed-in', async () => {
        // Creds exist on disk (so isConnected() is true) but the widget's
        // polls already diagnosed them as revoked and persisted the marker.
        // The panel must NOT claim "Signed in" — that lie is the bug this
        // pins: the floating bar showed disconnected while settings said
        // signed in until the user manually hit "Check connection".
        const { provider } = setup({
            client: CLIENT,
            creds: CREDS,
            status: JSON.stringify({ auth_revoked: true, at: 999_999 }),
        });
        const schema = await provider.getSettings();
        const connSection = schema.sections.find((s) =>
            s.controls.some((c) => c.id === 'connect')
        );
        const info = connSection.controls.find((c) => c.type === 'info');
        expect(info.html).toMatch(/Session expired/i);
        expect(info.html).not.toMatch(/Signed in/i);
        // Reconnect stays one click; the button label reflects that creds
        // exist (Reconnect), and Sign Out remains available to wipe them.
        const connect = connSection.controls.find((c) => c.id === 'connect');
        expect(connect.label).toBe('Reconnect');
    });

    it('marker without creds is ignored (shows plain not-signed-in)', async () => {
        // A stale marker after sign-out must not produce "Session expired"
        // over a clean signed-out state.
        const { provider } = setup({
            client: CLIENT,
            status: JSON.stringify({ auth_revoked: true, at: 999_999 }),
        });
        const schema = await provider.getSettings();
        const connSection = schema.sections.find((s) =>
            s.controls.some((c) => c.id === 'connect')
        );
        const info = connSection.controls.find((c) => c.type === 'info');
        expect(info.html).toMatch(/Not signed in/i);
    });
});

describe('Spotify settings — connect action without a Client ID', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('points at the field above, in plain language', async () => {
        // The user is LOOKING at the settings panel — the old message told
        // them to "open the extension settings", and said "client_id"
        // (log jargon) instead of the field's visible "Client ID" label.
        const { provider } = setup({});
        const res = await provider.runAction('connect', {});
        expect(res.status).toMatch(/paste one above/i);
        expect(res.status).toMatch(/Client ID/);
        expect(res.status).not.toMatch(/client_id/);
        expect(res.status).not.toMatch(/open the extension settings/i);
    });
});
