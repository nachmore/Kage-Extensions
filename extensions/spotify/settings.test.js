/**
 * Tests for the Spotify settings provider: the guided setup shown until the
 * extension is usable, the regular settings once it is, and the
 * "Check connection" classification.
 *
 * The browser half of OAuth stays in manual QA, but everything the settings
 * page decides is logic layered over the `invoke` boundary (extension-data,
 * open_url, the oauth_loopback_* commands) plus `fetch`. We drive the real
 * provider through a mocked host context and a stubbed global fetch, the
 * same way the host does: getSettings() for what's on screen, runAction()
 * for button clicks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import SpotifySettingsProvider from './settings.js';
import { DASHBOARD_URL, REDIRECT_PATH, REDIRECT_URI, hostHasFeature, loopbackFailure } from './setup.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

// Real EN catalog so status assertions match the shipped message text
// rather than key echoes.
const EN_CATALOG = JSON.parse(
    readFileSync(fileURLToPath(new URL('./_locales/en/messages.json', import.meta.url)), 'utf8')
);
const msg = (key) => EN_CATALOG[key].message;

const CLIENT_ID = 'abcdef0123456789abcdef0123456789';
const CLIENT = JSON.stringify({ client_id: CLIENT_ID });
const CREDS = JSON.stringify({
    refresh_token: 'rt-123',
    access_token: 'at-123',
    // Expired so the check forces a refresh path (mirrors a real re-validate).
    expires_at: 0,
    scopes: 'user-read-playback-state',
});
const REFRESH = { type: 'refresh' };

// `context.hostFeatures` of a current Kage host. Leaving it out (the default
// in these tests) is a host that predates feature detection.
const CURRENT_HOST = { hostFeatures: ['settings.copy_action', 'invoke.error_kind'] };

/** The Error a current host's invoke() rejects with for a backend AppError. */
const hostError = (kind, key, message) => Object.assign(new Error(message), { kind, key });

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

/**
 * Provider over a seeded store. `extraInvokes` adds host commands
 * (open_url, oauth_loopback_*). `opened` records every URL handed to
 * open_url, which is how a test reads the OAuth `state` back. `host` is
 * what the host context offers on top (e.g. CURRENT_HOST).
 */
function setup(storeSeed = {}, extraInvokes = {}, config = {}, host = {}) {
    const { store, invokes } = makeStore(storeSeed);
    const opened = [];
    const { context, invoke, log } = makeContext({
        invokes: {
            open_url: ({ url }) => {
                opened.push(url);
                return null;
            },
            ...invokes,
            ...extraInvokes,
        },
        catalog: EN_CATALOG,
        config,
        ...host,
    });
    const provider = new SpotifySettingsProvider();
    provider.initialize(context);
    return { provider, store, invoke, log, opened };
}

const setupState = (store) => (store.setup ? JSON.parse(store.setup) : undefined);

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

// Spotify replies to the Client ID probe (see auth.verifyClientId).
const PROBE_KNOWN_CLIENT = { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid authorization code' } };
const PROBE_UNKNOWN_CLIENT = { status: 400, body: { error: 'invalid_client', error_description: 'Failed to get client' } };
const TOKEN_OK = {
    status: 200,
    body: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, scope: 's' },
};

/**
 * OAuth host commands for a sign-in. `reply(state)` builds the loopback
 * callback params; return a Promise to control when the "browser" answers,
 * or throw to simulate the listener giving up.
 */
function oauthInvokes(reply, opened) {
    return {
        oauth_loopback_start: () => ({
            listener_id: 'L1',
            redirect_uri: 'http://127.0.0.1:54321/spotify/callback',
            port: 54321,
        }),
        oauth_loopback_await: () => {
            const state = new URL(opened.at(-1)).searchParams.get('state');
            return reply(state);
        },
        oauth_loopback_cancel: () => null,
    };
}

/** Provider wired for a sign-in whose browser step answers via `reply`. */
function setupSignIn(storeSeed, reply, host = {}) {
    const opened = [];
    const ctx = setup(
        storeSeed,
        {
            ...oauthInvokes(reply, opened),
            open_url: ({ url }) => {
                opened.push(url);
                return null;
            },
        },
        {},
        host
    );
    return { ...ctx, opened };
}

// --- Schema helpers --------------------------------------------------------

const controlsOf = (schema) => schema.sections.flatMap((s) => s.controls);
const byId = (schema, id) => controlsOf(schema).find((c) => c.id === id);
const infoHtml = (schema) =>
    controlsOf(schema)
        .filter((c) => c.type === 'info')
        .map((c) => c.html)
        .join('\n');

/** The host's showWhen semantics (Kage ui/js/shared/settings-schema.js isVisible). */
function isVisible(showWhen, values) {
    if (!showWhen || typeof showWhen !== 'object') return true;
    const current = values[showWhen.id];
    if ('equals' in showWhen) return current === showWhen.equals;
    if (Array.isArray(showWhen.oneOf)) return showWhen.oneOf.includes(current);
    return true;
}
function visibleControls(schema) {
    const values = {};
    for (const c of controlsOf(schema)) if (c.id && 'default' in c) values[c.id] = c.default;
    return controlsOf(schema).filter((c) => isVisible(c.showWhen, values));
}
const visibleIds = (schema) => visibleControls(schema).map((c) => c.id).filter(Boolean);

/** Which screen a schema is, read off the controls it shows. */
function screenOf(schema) {
    const ids = new Set(visibleIds(schema));
    if (ids.has('setup_finish')) return 'done';
    if (ids.has('setup_connect')) return 'connect';
    if (ids.has('setup_save_client_id')) return 'client_id';
    if (byId(schema, 'setup_next')?.action === 'setup_step_client_id') return 'create_app';
    if (byId(schema, 'setup_next')?.action === 'setup_step_create_app') return 'dashboard';
    if (ids.has('disconnect')) return 'settings';
    return 'unknown';
}

/**
 * The host rejects a schema that breaks these rules (validateSchema), on
 * current and older hosts alike.
 */
function expectHostValid(schema) {
    const types = ['checkbox', 'text', 'number', 'select', 'range', 'action', 'info'];
    const seen = new Set();
    expect(Array.isArray(schema.sections)).toBe(true);
    for (const c of controlsOf(schema)) {
        expect(types).toContain(c.type);
        if (c.type !== 'info') expect(typeof c.id).toBe('string');
        if (c.id) {
            expect(c.id).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
            expect(seen.has(c.id), `duplicate id ${c.id}`).toBe(false);
            seen.add(c.id);
        }
        // Current hosts make `action` optional on a copy action; older ones
        // ignore `copy` and still require it.
        if (c.type === 'action') expect(c.action).toMatch(/\S/);
        if (c.copy !== undefined) expectValidCopy(c, schema);
        if (c.type === 'info') expect(typeof c.html).toBe('string');
    }
}

/** A current host's rules for an action's `copy` (Kage settings-schema.js). */
function expectValidCopy(c, schema) {
    expect(c.type).toBe('action');
    const { copy } = c;
    expect(Object.hasOwn(copy, 'value') !== Object.hasOwn(copy, 'from'), 'exactly one of value/from').toBe(true);
    if (Object.hasOwn(copy, 'value')) {
        expect(typeof copy.value).toBe('string');
        expect(copy.value.length).toBeGreaterThan(0);
        expect(copy.value.length).toBeLessThanOrEqual(2048);
        // No control characters except tab/CR/LF, no bidi overrides.
        expect(copy.value).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    } else {
        expect(['text', 'number', 'select']).toContain(byId(schema, copy.from)?.type);
    }
}

const realFetch = globalThis.fetch;
beforeEach(() => {
    // No test may reach the real network: default to "offline".
    globalThis.fetch = vi.fn(async () => {
        throw new TypeError('Failed to fetch (test: network disabled)');
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = realFetch;
});

// --- Which screen shows -----------------------------------------------------

describe('Spotify settings — not set up shows the guided setup', () => {
    it('with nothing saved: step 1, and none of the raw settings', async () => {
        const { provider } = setup({});
        const schema = await provider.getSettings();
        expectHostValid(schema);
        expect(screenOf(schema)).toBe('dashboard');
        expect(schema.description).toBe(msg('setup.description'));
        expect(schema.sections[0].label).toBe(
            'Step 1 of 4: ' + msg('setup.dashboard.title')
        );
        // The regular settings and account controls are not on screen.
        const visible = visibleIds(schema);
        for (const id of ['enabled', 'trigger', 'refresh_seconds', 'connect', 'check_connection', 'disconnect']) {
            expect(visible).not.toContain(id);
        }
    });

    it('keeps the display settings in the schema, hidden, so a Save mid-setup keeps them', async () => {
        // The host saves exactly the value controls of the schema on screen.
        // Dropping them would wipe a customised trigger on Save, and
        // validate() would reject the "missing" trigger.
        const { provider } = setup({});
        const schema = await provider.getSettings();
        for (const id of ['enabled', 'show_now_playing_bar', 'refresh_seconds', 'trigger']) {
            expect(byId(schema, id), id).toBeTruthy();
        }
        const values = {};
        for (const c of controlsOf(schema)) if (c.id && 'default' in c) values[c.id] = c.default;
        expect(provider.validate(values)).toEqual({ valid: true });
    });

    it('with a Client ID but no sign-in: resumes at the connect step', async () => {
        const { provider } = setup({ client: CLIENT });
        const schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('connect');
        expect(schema.sections[0].label).toMatch(/^Step 4 of 4/);
    });

    it('a stored revoked-marker without creds never claims "Session expired"', async () => {
        // A stale marker after sign-out must not produce "Session expired"
        // over a clean signed-out state.
        const { provider } = setup({
            client: CLIENT,
            status: JSON.stringify({ auth_revoked: true, at: 999_999 }),
        });
        const schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('connect');
        expect(infoHtml(schema)).not.toMatch(/Session expired/i);
    });

    it('no step links to a web page inside the settings window', async () => {
        // Opening the dashboard goes through open_url (system browser);
        // an <a href> in an info block would navigate the settings window.
        for (const step of ['dashboard', 'create_app', 'client_id', 'connect']) {
            const { provider } = setup({ client: CLIENT, setup: JSON.stringify({ step }) });
            const schema = await provider.getSettings();
            expectHostValid(schema);
            expect(screenOf(schema)).toBe(step);
            expect(infoHtml(schema)).not.toMatch(/<a\b/i);
        }
    });
});

describe('Spotify settings — configured shows the regular settings', () => {
    it('connected: display settings, Reconnect, Sign out and Run setup again', async () => {
        const { provider } = setup({ client: CLIENT, creds: CREDS });
        const schema = await provider.getSettings();
        expectHostValid(schema);
        expect(screenOf(schema)).toBe('settings');
        const visible = visibleIds(schema);
        for (const id of ['enabled', 'trigger', 'connect', 'check_connection', 'disconnect', 'setup_restart']) {
            expect(visible).toContain(id);
        }
        expect(visible.filter((id) => id.startsWith('setup_') && id !== 'setup_restart')).toEqual([]);
        expect(byId(schema, 'connect').label).toBe('Reconnect');
        expect(byId(schema, 'disconnect').disabled).toBeFalsy();
        expect(infoHtml(schema)).toContain(CLIENT_ID);
    });

    it('when the widget marked the session revoked: status says expired, not signed-in', async () => {
        // Creds exist on disk but the widget's polls already diagnosed them
        // as revoked and persisted the marker. The panel must NOT claim
        // "Signed in" — the floating bar showed disconnected while settings
        // said signed in until the user manually hit "Check connection".
        const { provider } = setup({
            client: CLIENT,
            creds: CREDS,
            status: JSON.stringify({ auth_revoked: true, at: 999_999 }),
        });
        const schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('settings');
        expect(infoHtml(schema)).toMatch(/Session expired/i);
        expect(infoHtml(schema)).not.toMatch(/Signed in/i);
        expect(byId(schema, 'connect').label).toBe('Reconnect');
    });

    it('drops leftover setup progress once connected elsewhere (e.g. `sp connect`)', async () => {
        const { provider, store } = setup({
            client: CLIENT,
            creds: CREDS,
            setup: JSON.stringify({ step: 'connect' }),
        });
        expect(screenOf(await provider.getSettings())).toBe('settings');
        expect(store.setup).toBeUndefined();
    });
});

// --- Step progression --------------------------------------------------------

describe('Spotify settings — setup step progression', () => {
    it('step 1 opens the dashboard through the host API and moves to step 2', async () => {
        const { provider, invoke, store, opened } = setup({});
        const res = await provider.runAction('setup_open_dashboard', {});
        expect(invoke).toHaveBeenCalledWith('open_url', { url: DASHBOARD_URL });
        expect(opened).toEqual([DASHBOARD_URL]);
        expect(setupState(store)).toEqual({ step: 'create_app' });
        expect(res.host).toEqual(REFRESH);
        expect(res.status).toBe(msg('setup.dashboard.opened'));

        const schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('create_app');
        // The status lands on the same-id button of the new step.
        expect(byId(schema, 'setup_open_dashboard')).toBeTruthy();
        expect(infoHtml(schema)).toContain(REDIRECT_URI);
    });

    it('"Open dashboard again" on a later step opens it without moving', async () => {
        const { provider, invoke, store } = setup({ setup: JSON.stringify({ step: 'client_id' }) });
        const res = await provider.runAction('setup_open_dashboard', {});
        expect(invoke).toHaveBeenCalledWith('open_url', { url: DASHBOARD_URL });
        expect(setupState(store)).toEqual({ step: 'client_id' });
        expect(res.host).toBeUndefined();
    });

    it('if the browser cannot be opened, says where to go and stays on step 1', async () => {
        const { provider, store } = setup({}, {
            open_url: () => {
                throw new Error('no browser');
            },
        });
        const res = await provider.runAction('setup_open_dashboard', {});
        expect(res.status).toContain(DASHBOARD_URL);
        expect(res.host).toBeUndefined();
        expect(store.setup).toBeUndefined();
        expect(screenOf(await provider.getSettings())).toBe('dashboard');
    });

    it('walks every step to "All set", then shows the regular settings', async () => {
        const { provider, store, opened, invoke } = setupSignIn({}, (state) => ({
            params: { code: 'c0de', state },
        }));

        // 1 → 2 via Next (dashboard opened by hand), 2 → 3 via Next.
        let res = await provider.runAction(byId(await provider.getSettings(), 'setup_next').action, {});
        expect(res.host).toEqual(REFRESH);
        expect(screenOf(await provider.getSettings())).toBe('create_app');
        res = await provider.runAction(byId(await provider.getSettings(), 'setup_next').action, {});
        let schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('client_id');
        expect(byId(schema, '__setup_client_id').default).toBe('');

        // 3: an invalid paste is explained and nothing moves.
        res = await provider.runAction('setup_save_client_id', { __setup_client_id: 'nope' });
        expect(res.status).toBe(msg('setup.client_id.error.format'));
        expect(res.host).toBeUndefined();
        expect(store.client).toBeUndefined();

        // 3: a real Client ID (Spotify knows it) is saved → step 4.
        stubFetch([PROBE_KNOWN_CLIENT]);
        res = await provider.runAction('setup_save_client_id', { __setup_client_id: `  ${CLIENT_ID} ` });
        expect(res.host).toEqual(REFRESH);
        expect(JSON.parse(store.client)).toEqual({ client_id: CLIENT_ID });
        expect(screenOf(await provider.getSettings())).toBe('connect');

        // 4: connect → token exchange → display name → "All set".
        stubFetch([TOKEN_OK, { status: 200, body: { display_name: 'Ada', id: 'ada99' } }]);
        res = await provider.runAction('setup_connect', {});
        expect(res).toEqual({ host: REFRESH });
        expect(JSON.parse(store.creds).refresh_token).toBe('rt-new');
        expect(opened.at(-1)).toMatch(/^https:\/\/accounts\.spotify\.com\/authorize\?/);
        // The loopback path is the one users register in step 2.
        const start = invoke.mock.calls.find(([cmd]) => cmd === 'oauth_loopback_start');
        expect(start[1].args.redirect_path).toBe(REDIRECT_PATH);

        schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('done');
        expect(infoHtml(schema)).toMatch(/Connected to Spotify as Ada/);
        expect(infoHtml(schema)).toContain('<code>sp</code>');

        // The "All set" screen is one-shot: showing it consumed the progress,
        // so a reopen shows the regular settings...
        expect(store.setup).toBeUndefined();
        const reopened = setup({ ...store });
        expect(screenOf(await reopened.provider.getSettings())).toBe('settings');

        // ...and so does Finish.
        res = await provider.runAction('setup_finish', {});
        expect(res.host).toEqual(REFRESH);
        expect(store.setup).toBeUndefined();
        expect(screenOf(await provider.getSettings())).toBe('settings');
    });

    it('Back buttons go to the previous step', async () => {
        const cases = { create_app: 'dashboard', client_id: 'create_app', connect: 'client_id' };
        for (const [step, previous] of Object.entries(cases)) {
            const { provider, store } = setup({ client: CLIENT, setup: JSON.stringify({ step }) });
            const back = byId(await provider.getSettings(), 'setup_back');
            const res = await provider.runAction(back.action, {});
            expect(res.host).toEqual(REFRESH);
            expect(setupState(store).step).toBe(previous);
        }
    });

    it('step 1 has no Back, and offers a way to turn the extension off instead', async () => {
        const { provider } = setup({});
        const schema = await provider.getSettings();
        expect(byId(schema, 'setup_back')).toBeUndefined();
        expect(infoHtml(schema)).toContain(msg('setup.not_using_html'));
    });
});

describe('Spotify settings — setup resumes where the user left off', () => {
    it('reopening mid-setup lands on the saved step', async () => {
        const first = setup({});
        await first.provider.runAction('setup_open_dashboard', {});
        await first.provider.runAction('setup_step_client_id', {});

        // A fresh provider over the same store = the settings window reopened.
        const { provider } = setup({ ...first.store });
        expect(screenOf(await provider.getSettings())).toBe('client_id');
    });

    it('the connect step needs a Client ID; without one it falls back to step 3', async () => {
        const { provider } = setup({ setup: JSON.stringify({ step: 'connect' }) });
        expect(screenOf(await provider.getSettings())).toBe('client_id');
    });

    it('a corrupt progress blob restarts at step 1 instead of breaking the page', async () => {
        const { provider } = setup({ setup: '{not json' });
        expect(screenOf(await provider.getSettings())).toBe('dashboard');
    });

    it('step 3 prefills the saved Client ID', async () => {
        const { provider } = setup({ client: CLIENT, setup: JSON.stringify({ step: 'client_id' }) });
        expect(byId(await provider.getSettings(), '__setup_client_id').default).toBe(CLIENT_ID);
    });
});

// --- Step 2: copying the Redirect URI ---------------------------------------

describe('Spotify settings — step 2 Copy Redirect URI button', () => {
    const atStep2 = (host) => setup({ setup: JSON.stringify({ step: 'create_app' }) }, {}, {}, host);
    const copyControls = (schema) => controlsOf(schema).filter((c) => c.copy !== undefined);

    it('a host with copy actions gets a button that copies exactly the URI to register', async () => {
        const { provider } = atStep2(CURRENT_HOST);
        const schema = await provider.getSettings();
        expectHostValid(schema);
        expect(screenOf(schema)).toBe('create_app');

        const btn = byId(schema, 'setup_copy_redirect');
        expect(btn).toMatchObject({
            type: 'action',
            label: msg('setup.create_app.copy.label'),
            copy: { value: REDIRECT_URI },
        });
        expect(visibleIds(schema)).toContain('setup_copy_redirect');
        // Right under the URI, before Next.
        const controls = controlsOf(schema);
        const uriBlock = controls.findIndex((c) => c.type === 'info' && c.html.includes(REDIRECT_URI));
        expect(controls.indexOf(btn)).toBe(uriBlock + 1);
        expect(controls.indexOf(btn)).toBeLessThan(controls.indexOf(byId(schema, 'setup_next')));
        // The selectable <code> line stays.
        expect(infoHtml(schema)).toContain(`<code>${REDIRECT_URI}</code>`);
    });

    it('an older host gets step 2 as before: no button, the URI on its own selectable line', async () => {
        // Older hosts ignore `copy`, so the button would do nothing useful;
        // the page must still render (an invalid schema drops all of it).
        for (const host of [{}, { hostFeatures: ['invoke.error_kind'] }]) {
            const { provider } = atStep2(host);
            const schema = await provider.getSettings();
            expectHostValid(schema);
            expect(screenOf(schema)).toBe('create_app');
            expect(byId(schema, 'setup_copy_redirect')).toBeUndefined();
            expect(copyControls(schema)).toEqual([]);
            expect(infoHtml(schema)).toContain(`<div><code>${REDIRECT_URI}</code></div>`);
        }
    });

    it('feature detection needs a real list naming the feature', () => {
        expect(hostHasFeature(['settings.copy_action'], 'settings.copy_action')).toBe(true);
        expect(hostHasFeature(undefined, 'settings.copy_action')).toBe(false);
        expect(hostHasFeature('settings.copy_action', 'settings.copy_action')).toBe(false);
        expect(hostHasFeature(['invoke.error_kind'], 'settings.copy_action')).toBe(false);
    });

    it('no other screen has a copy button', async () => {
        for (const step of ['dashboard', 'client_id', 'connect', 'done']) {
            const { provider } = setup({ client: CLIENT, setup: JSON.stringify({ step }) }, {}, {}, CURRENT_HOST);
            expect(copyControls(await provider.getSettings()), step).toEqual([]);
        }
        const { provider } = setup({ client: CLIENT, creds: CREDS }, {}, {}, CURRENT_HOST);
        expect(copyControls(await provider.getSettings())).toEqual([]);
    });

    it("the button's `action` is only there for schema validity: it does nothing", async () => {
        // Every host that gets the button copies without calling runAction.
        // The `action` must not name a real one (e.g. a step change) anyway.
        const { provider, store } = atStep2(CURRENT_HOST);
        const res = await provider.runAction(byId(await provider.getSettings(), 'setup_copy_redirect').action, {});
        expect(res).toEqual({});
        expect(setupState(store)).toEqual({ step: 'create_app' });
    });
});

// --- Errors, each with its fix -----------------------------------------------

describe('Spotify settings — setup errors explain the fix', () => {
    const atStep3 = () => setup({ setup: JSON.stringify({ step: 'client_id' }) });

    it('empty and pasted-URL Client IDs get specific messages', async () => {
        const { provider } = atStep3();
        let res = await provider.runAction('setup_save_client_id', { __setup_client_id: '   ' });
        expect(res.status).toBe(msg('setup.client_id.error.empty'));
        res = await provider.runAction('setup_save_client_id', {
            __setup_client_id: 'https://developer.spotify.com/dashboard/abc',
        });
        expect(res.status).toBe(msg('setup.client_id.error.url'));
    });

    it('a Client ID Spotify does not know (typo, or the secret) is rejected before the browser', async () => {
        const { provider, store } = atStep3();
        stubFetch([PROBE_UNKNOWN_CLIENT]);
        const res = await provider.runAction('setup_save_client_id', { __setup_client_id: CLIENT_ID });
        expect(res.status).toBe(msg('setup.client_id.error.unknown_client'));
        expect(res.status).toMatch(/not the Client secret/);
        expect(store.client).toBeUndefined();
        expect(setupState(store).step).toBe('client_id');
    });

    it('when Spotify cannot be reached, the Client ID is accepted (setup is never blocked offline)', async () => {
        const { provider, store } = atStep3(); // default fetch stub = offline
        const res = await provider.runAction('setup_save_client_id', { __setup_client_id: CLIENT_ID });
        expect(res.host).toEqual(REFRESH);
        expect(JSON.parse(store.client).client_id).toBe(CLIENT_ID);
        expect(setupState(store).step).toBe('connect');
    });

    it('clicking Cancel on Spotify\'s page explains how to retry', async () => {
        const { provider, store } = setupSignIn(
            { client: CLIENT, setup: JSON.stringify({ step: 'connect' }) },
            (state) => ({ params: { error: 'access_denied', state } })
        );
        const res = await provider.runAction('setup_connect', {});
        expect(res.status).toBe(msg('signin.error.denied'));
        expect(res.host).toBeUndefined();
        expect(store.creds).toBeUndefined();
        expect(setupState(store).step).toBe('connect');
    });

    it('a sign-in that never comes back explains the two browser-side setup mistakes', async () => {
        // Bad redirect URI / unknown client: Spotify shows INVALID_CLIENT in
        // the browser and never redirects, so the loopback listener gives up.
        // This is how an older host reports it: no `kind`, English text.
        const { provider } = setupSignIn({ client: CLIENT, setup: JSON.stringify({ step: 'connect' }) }, () => {
            throw new Error('OAuth listener was cancelled before a callback arrived');
        });
        const res = await provider.runAction('setup_connect', {});
        expect(res.status).toBe(msg('setup.connect.error.timeout'));
        expect(res.status).toMatch(/Invalid redirect URI/);
        expect(res.status).toMatch(/Invalid client/);
    });

    it('the connect step lists the INVALID_CLIENT browser errors and their fixes up front', async () => {
        const { provider } = setup({ client: CLIENT });
        const html = infoHtml(await provider.getSettings());
        expect(html).toMatch(/INVALID_CLIENT: Invalid redirect URI/);
        expect(html).toMatch(/INVALID_CLIENT: Invalid client/);
        expect(html).toContain(REDIRECT_URI);
    });

    it('a token exchange rejected for the redirect URI or the client says which to fix', async () => {
        const reply = (state) => ({ params: { code: 'c0de', state } });
        let ctx = setupSignIn({ client: CLIENT }, reply);
        stubFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid redirect URI' } }]);
        let res = await ctx.provider.runAction('setup_connect', {});
        expect(res.status).toContain(REDIRECT_URI);
        expect(res.status).toMatch(/Back twice/);

        ctx = setupSignIn({ client: CLIENT }, reply);
        stubFetch([{ status: 400, body: { error: 'invalid_client', error_description: 'Invalid client' } }]);
        res = await ctx.provider.runAction('setup_connect', {});
        expect(res.status).toBe(msg('setup.connect.error.bad_client'));
    });

    it('a network failure during the token exchange says so', async () => {
        const { provider } = setupSignIn({ client: CLIENT }, (state) => ({ params: { code: 'c0de', state } }));
        const res = await provider.runAction('setup_connect', {}); // default fetch = offline
        expect(res.status).toBe(msg('signin.error.network'));
    });
});

describe('Spotify settings — sign-in failures from current hosts carry a kind', () => {
    const atConnect = (fail) =>
        setupSignIn({ client: CLIENT, setup: JSON.stringify({ step: 'connect' }) }, () => {
            throw fail;
        }, CURRENT_HOST);
    const reconnecting = (fail) =>
        setupSignIn({ client: CLIENT, creds: CREDS }, () => {
            throw fail;
        }, CURRENT_HOST);
    // What a current host's oauth_loopback_await rejects with (Kage
    // src/commands/oauth.rs). `timeout` and `cancelled` carry fixed English
    // text in every locale, under the passthrough key; the cancelled text is
    // the one older hosts used for a timeout. Other loopback failures are
    // `internal`, keyed, and translated.
    const TIMEOUT_TEXT = 'OAuth flow timed out before a callback arrived';
    const CANCELLED_TEXT = 'OAuth listener was cancelled before a callback arrived';
    const UNKNOWN_LISTENER_TEXT = 'Unknown listener id (timed out, cancelled, or already consumed)';
    const timedOut = () => hostError('timeout', 'errors.passthrough', TIMEOUT_TEXT);
    const cancelled = () => hostError('cancelled', 'errors.passthrough', CANCELLED_TEXT);

    it('a timeout explains the two browser-side setup mistakes', async () => {
        let res = await atConnect(timedOut()).provider.runAction('setup_connect', {});
        expect(res.status).toBe(msg('setup.connect.error.timeout'));

        res = await reconnecting(timedOut()).provider.runAction('connect', {});
        expect(res.status).toBe(msg('settings.connect.error.timeout'));
    });

    it('the kind wins over the text: a timeout is a timeout whatever its message says', async () => {
        // Current hosts keep the timeout text English, so this can't happen
        // today; the kind alone must still be enough.
        const timedOutJa = hostError(
            'timeout',
            'errors.passthrough',
            'コールバックを受け取る前に OAuth フローがタイムアウトしました'
        );
        const res = await atConnect(timedOutJa).provider.runAction('setup_connect', {});
        expect(res.status).toBe(msg('setup.connect.error.timeout'));
        expect(loopbackFailure(timedOutJa)).toBe('timeout');
    });

    it('a listener Kage reports as cancelled ends quietly, even with the old timeout wording', async () => {
        // On its own, this text used to mean a timeout. The kind says
        // otherwise.
        const setupCtx = atConnect(cancelled());
        expect(await setupCtx.provider.runAction('setup_connect', {})).toEqual({});
        expect(setupState(setupCtx.store)).toEqual({ step: 'connect' });
        expect(setupCtx.store.creds).toBeUndefined();

        const settingsCtx = reconnecting(cancelled());
        expect(await settingsCtx.provider.runAction('connect', {})).toEqual({});
        expect(settingsCtx.store.creds).toBe(CREDS);

        expect(setupCtx.log.warn).not.toHaveBeenCalled();
        expect(settingsCtx.log.warn).not.toHaveBeenCalled();
    });

    it('any other kind is reported as it is, never as a timeout', async () => {
        // The English unknown-listener text says "timed out", which the
        // old-host text match would read as a timeout. The kind says otherwise.
        const gone = hostError('internal', 'errors.oauth.unknown_listener', UNKNOWN_LISTENER_TEXT);
        const res = await atConnect(gone).provider.runAction('setup_connect', {});
        expect(res.status).toBe(msg('signin.error.unknown').replace('{message}', UNKNOWN_LISTENER_TEXT));
    });

    it('the kind decides; the English text only counts when there is none (older hosts)', () => {
        expect(loopbackFailure(timedOut())).toBe('timeout');
        expect(loopbackFailure(cancelled())).toBe('cancelled');
        expect(loopbackFailure(hostError('internal', 'errors.oauth.unknown_listener', UNKNOWN_LISTENER_TEXT))).toBeNull();
        // Older hosts: no kind, always English, and their timeout used the
        // text current hosts use for a cancel.
        expect(loopbackFailure(new Error(CANCELLED_TEXT))).toBe('timeout');
        expect(loopbackFailure(new Error(TIMEOUT_TEXT))).toBe('timeout');
        expect(loopbackFailure(new Error('Unknown listener'))).toBeNull();
        expect(loopbackFailure(undefined)).toBeNull();
    });
});

describe('Spotify settings — leaving the connect step mid-sign-in', () => {
    /**
     * Start a sign-in on the connect step whose browser step answers only
     * when the test calls `agree()` (as if the user clicked Agree in the
     * still-open consent tab), and wait until it's blocked on that.
     */
    async function pendingSignIn(storeSeed) {
        let agree;
        const ctx = setupSignIn(
            storeSeed,
            (state) =>
                new Promise((resolve) => {
                    agree = () => resolve({ params: { code: 'c0de', state } });
                })
        );
        const pending = ctx.provider.runAction('setup_connect', {});
        await vi.waitFor(() =>
            expect(ctx.invoke).toHaveBeenCalledWith('oauth_loopback_await', expect.anything())
        );
        return { ...ctx, pending, agree: () => agree() };
    }
    const cancelled = (invoke) =>
        invoke.mock.calls.some(([cmd]) => cmd === 'oauth_loopback_cancel');

    it('Back keeps the sign-in: agreeing in the browser afterwards still finishes setup', async () => {
        // Kage's loopback page tells the user "Spotify is now connected"
        // whenever the browser comes back, so a late Agree must connect.
        const { provider, store, invoke, pending, agree } = await pendingSignIn({
            client: CLIENT,
            setup: JSON.stringify({ step: 'connect' }),
        });

        const back = await provider.runAction('setup_step_client_id', {});
        expect(back.host).toEqual(REFRESH);
        expect(screenOf(await provider.getSettings())).toBe('client_id');
        expect(cancelled(invoke)).toBe(false);

        stubFetch([TOKEN_OK, { status: 200, body: { display_name: 'Ada' } }]);
        agree();
        expect(await pending).toEqual({ host: REFRESH });
        expect(JSON.parse(store.creds).refresh_token).toBe('rt-new');
        const schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('done');
        expect(infoHtml(schema)).toMatch(/Connected to Spotify as Ada/);
    });

    it('saving a different Client ID abandons it, so a late Agree redeems nothing', async () => {
        const { provider, store, invoke, pending, agree } = await pendingSignIn({
            client: CLIENT,
            setup: JSON.stringify({ step: 'connect' }),
        });
        await provider.runAction('setup_step_client_id', {});

        const other = 'ffffeeee0000111122223333aaaabbbb';
        stubFetch([PROBE_KNOWN_CLIENT]);
        const res = await provider.runAction('setup_save_client_id', { __setup_client_id: other });
        expect(res.host).toEqual(REFRESH);
        expect(await pending).toEqual({});
        expect(invoke).toHaveBeenCalledWith('oauth_loopback_cancel', { args: { listener_id: 'L1' } });

        stubFetch([TOKEN_OK]);
        agree();
        await Promise.resolve();
        expect(store.creds).toBeUndefined();
        expect(JSON.parse(store.client).client_id).toBe(other);
        expect(setupState(store).step).toBe('connect');
    });

    it('Cancel setup abandons it and leaves the existing connection as it was', async () => {
        const { provider, store, pending } = await pendingSignIn({
            client: CLIENT,
            creds: CREDS,
            setup: JSON.stringify({ step: 'connect', rerun: true }),
        });
        const res = await provider.runAction('setup_cancel', {});
        expect(res.host).toEqual(REFRESH);
        expect(await pending).toEqual({});
        expect(store.creds).toBe(CREDS);
        expect(store.setup).toBeUndefined();
    });

    it('a Client ID change while the code is being redeemed keeps the old app\'s tokens out', async () => {
        // The browser already answered; the token exchange is in flight
        // when the user saves a different Client ID.
        const { provider, store } = setupSignIn({ client: CLIENT }, (state) => ({
            params: { code: 'c0de', state },
        }));
        let finishExchange;
        const reply = (r) => ({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            text: async () => JSON.stringify(r.body),
            json: async () => r.body,
        });
        globalThis.fetch = vi.fn(async (url, init) => {
            if (String(init?.body).includes('code=c0de')) {
                return new Promise((resolve) => (finishExchange = () => resolve(reply(TOKEN_OK))));
            }
            return reply(PROBE_KNOWN_CLIENT);
        });

        const pending = provider.runAction('setup_connect', {});
        await vi.waitFor(() => expect(finishExchange).toBeTypeOf('function'));
        const other = 'ffffeeee0000111122223333aaaabbbb';
        await provider.runAction('setup_save_client_id', { __setup_client_id: other });
        finishExchange();

        expect(await pending).toEqual({});
        expect(store.creds).toBeUndefined();
        expect(JSON.parse(store.client).client_id).toBe(other);
    });
});

describe('Spotify settings — signed in, but Spotify refuses the account', () => {
    // Development-mode apps only serve their owner and the accounts on the
    // app's User Management list. Anyone else signs in fine, then gets 403
    // from every Web API call.
    const NOT_REGISTERED = {
        status: 403,
        body: 'Check settings on developer.spotify.com/dashboard, the user may not be registered.',
    };

    it('a 403 from /me after signing in keeps the wizard on the connect step and says why', async () => {
        const { provider, store } = setupSignIn(
            { client: CLIENT, setup: JSON.stringify({ step: 'connect' }) },
            (state) => ({ params: { code: 'c0de', state } })
        );
        stubFetch([TOKEN_OK, NOT_REGISTERED]);
        const res = await provider.runAction('setup_connect', {});

        expect(res.status).toBe(msg('setup.connect.error.not_registered'));
        expect(res.status).toMatch(/User Management/);
        expect(res.host).toEqual(REFRESH);
        // Not "connected": the unusable session is dropped, the Client ID kept.
        expect(store.creds).toBeUndefined();
        expect(store.client).toBe(CLIENT);
        expect(setupState(store)).toEqual({ step: 'connect' });
        // The refresh lands on the connect step, where the status shows
        // next to the Connect button (same action id).
        const schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('connect');
        expect(byId(schema, 'setup_connect')).toBeTruthy();
        // ...and so does reopening the window.
        expect(screenOf(await setup({ ...store }).provider.getSettings())).toBe('connect');
    });

    it('in a re-run, the refused session is dropped too (no Cancel back to it)', async () => {
        const { provider, store } = setupSignIn(
            { client: CLIENT, creds: CREDS, setup: JSON.stringify({ step: 'connect', rerun: true }) },
            (state) => ({ params: { code: 'c0de', state } })
        );
        stubFetch([TOKEN_OK, NOT_REGISTERED]);
        const res = await provider.runAction('setup_connect', {});
        expect(res.status).toBe(msg('setup.connect.error.not_registered'));
        expect(store.creds).toBeUndefined();
        const schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('connect');
        expect(byId(schema, 'setup_cancel')).toBeUndefined();
    });

    it('other /me failures (offline) still count as connected: the name is a nicety', async () => {
        const { provider, store } = setupSignIn(
            { client: CLIENT, setup: JSON.stringify({ step: 'connect' }) },
            (state) => ({ params: { code: 'c0de', state } })
        );
        stubFetch([TOKEN_OK, { status: 503, body: '' }]);
        const res = await provider.runAction('setup_connect', {});
        expect(res).toEqual({ host: REFRESH });
        expect(JSON.parse(store.creds).refresh_token).toBe('rt-new');
        const schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('done');
        expect(infoHtml(schema)).toContain(msg('setup.done.connected_html'));
    });
});

// --- Re-running setup, signing out ------------------------------------------

describe('Spotify settings — re-run setup and sign out', () => {
    it('Run setup again shows the wizard with a Cancel that changes nothing', async () => {
        const { provider, store } = setup({ client: CLIENT, creds: CREDS });
        let res = await provider.runAction('setup_restart', {});
        expect(res.host).toEqual(REFRESH);

        let schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('dashboard');
        expect(schema.description).toBe(msg('setup.description_rerun'));
        expect(byId(schema, 'setup_cancel')).toBeTruthy();
        expect(infoHtml(schema)).not.toContain(msg('setup.not_using_html'));

        // Navigation keeps the re-run flag (and so the Cancel button).
        await provider.runAction('setup_step_client_id', {});
        schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('client_id');
        expect(byId(schema, 'setup_cancel')).toBeTruthy();
        expect(byId(schema, '__setup_client_id').description).toBe(
            msg('setup.client_id.description_connected')
        );

        res = await provider.runAction('setup_cancel', {});
        expect(res.host).toEqual(REFRESH);
        expect(store.setup).toBeUndefined();
        expect(store.creds).toBe(CREDS);
        expect(screenOf(await provider.getSettings())).toBe('settings');
    });

    it('re-saving the same Client ID keeps the session; a different one signs out of it', async () => {
        const { provider, store } = setup({
            client: CLIENT,
            creds: CREDS,
            setup: JSON.stringify({ step: 'client_id', rerun: true }),
        });
        stubFetch([PROBE_KNOWN_CLIENT]);
        await provider.runAction('setup_save_client_id', { __setup_client_id: CLIENT_ID });
        expect(store.creds).toBe(CREDS);
        expect(setupState(store)).toEqual({ step: 'connect', rerun: true });

        const other = 'ffffeeee0000111122223333aaaabbbb';
        stubFetch([PROBE_KNOWN_CLIENT]);
        await provider.runAction('setup_save_client_id', { __setup_client_id: other });
        expect(store.creds).toBeUndefined();
        expect(JSON.parse(store.client).client_id).toBe(other);
        // No longer connected → plain setup at the connect step, no Cancel.
        const schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('connect');
        expect(byId(schema, 'setup_cancel')).toBeUndefined();
    });

    it('Sign out clears everything, including setup progress, and returns to step 1', async () => {
        const { provider, store } = setup({
            client: CLIENT,
            creds: CREDS,
            setup: JSON.stringify({ step: 'connect', rerun: true }),
        });
        const res = await provider.runAction('disconnect', {});
        expect(store.creds).toBeUndefined();
        expect(store.client).toBeUndefined();
        expect(store.setup).toBeUndefined();
        expect(res.host).toEqual(REFRESH);
        expect(screenOf(await provider.getSettings())).toBe('dashboard');
    });

    it('normalize strips helper fields so only real config is kept', () => {
        const { provider } = setup({});
        const out = provider.normalize({ trigger: ' SP ', enabled: true, __setup_client_id: 'x', __client_id_input: 'y' });
        expect(out).toEqual({ values: { trigger: 'sp', enabled: true } });
    });
});

// --- Check connection / Reconnect (regular settings) -------------------------

describe('Spotify settings — check_connection action', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
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

    it('detects a revoked token, clears the creds, and sends the page to the connect step', async () => {
        const { provider, store } = setup({ client: CLIENT, creds: CREDS });
        // Token refresh rejects with invalid_grant — the revoked case.
        stubFetch([{ status: 400, body: { error: 'invalid_grant' } }]);

        const res = await provider.runAction('check_connection', {});

        expect(res.status).toMatch(/expired or was revoked/i);
        // Dead creds must be wiped so the panel stops claiming "Signed in".
        expect(store.creds).toBeUndefined();
        // Client ID is a separate concern — leave it so reconnect is one click.
        expect(store.client).toBe(CLIENT);
        // Request a panel re-render so the page reflects it.
        expect(res.host).toEqual(REFRESH);
        // ...which is now the setup's connect step, saying why.
        const schema = await provider.getSettings();
        expect(screenOf(schema)).toBe('connect');
        expect(infoHtml(schema)).toContain(msg('setup.connect.notice_revoked_html'));
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

    it('reports not-signed-in when there are no stored creds, and refreshes into setup', async () => {
        const { provider } = setup({ client: CLIENT });
        const res = await provider.runAction('check_connection', {});
        expect(res.status).toMatch(/Not signed in/i);
        expect(res.host).toEqual(REFRESH);
    });

    it('reports missing client id when none is saved', async () => {
        const { provider } = setup({});
        const res = await provider.runAction('check_connection', {});
        expect(res.status).toMatch(/No Client ID/i);
        expect(res.host).toEqual(REFRESH);
    });
});

describe('Spotify settings — Reconnect from the regular settings', () => {
    it('without a Client ID (signed out elsewhere): plain language, then the setup', async () => {
        const { provider } = setup({});
        const res = await provider.runAction('connect', {});
        expect(res.status).toBe(msg('action.check_connection.no_client_id'));
        expect(res.status).not.toMatch(/client_id/);
        expect(res.host).toEqual(REFRESH);
    });

    it('a timeout points at Run setup again (there are no steps to go Back to here)', async () => {
        const { provider } = setupSignIn({ client: CLIENT, creds: CREDS }, () => {
            throw new Error('OAuth listener was cancelled before a callback arrived');
        });
        const res = await provider.runAction('connect', {});
        expect(res.status).toBe(msg('settings.connect.error.timeout'));
        expect(res.status).toMatch(/Run setup again/);
    });

    it('success refreshes the page', async () => {
        const { provider, store } = setupSignIn({ client: CLIENT, creds: CREDS }, (state) => ({
            params: { code: 'c0de', state },
        }));
        stubFetch([TOKEN_OK]);
        const res = await provider.runAction('connect', {});
        expect(res).toEqual({ status: msg('action.connect.success'), host: REFRESH });
        expect(JSON.parse(store.creds).refresh_token).toBe('rt-new');
    });
});
