/**
 * Functional tests for the Spotify provider.
 *
 * The OAuth flow and Web API calls are genuinely network/IPC glue and stay in
 * manual QA. But match() is a pure verb-dispatch parser — the part a refactor
 * most easily breaks — so we test that directly with just config + i18n.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import SpotifySearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

// Real EN catalog so cheat-sheet assertions match the shipped message text.
const EN_CATALOG = JSON.parse(
    readFileSync(fileURLToPath(new URL('./_locales/en/messages.json', import.meta.url)), 'utf8')
);

function setup(config = {}) {
    const { context } = makeContext({ config });
    const provider = new SpotifySearchProvider();
    provider.initialize(context);
    return provider;
}

// In-memory extension-data store so execute() paths that read creds/devices
// via auth.js resolve. Mirrors the store used in settings.test / widget.test.
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
    expires_at: Date.now() + 3_600_000,
    scopes: 'user-modify-playback-state user-library-modify',
});

// setup() variant with a live catalog + extension-data store, for execute().
function setupExec(storeSeed = { client: CLIENT, creds: CREDS }, config = {}) {
    const { store, invokes } = makeStore(storeSeed);
    const { context } = makeContext({ invokes, catalog: EN_CATALOG, config });
    const provider = new SpotifySearchProvider();
    provider.initialize(context);
    return { provider, store };
}

// A row shaped the way match() emits them — execute() reads data.id.
const row = (id) => ({ data: { id } });

const ids = (rows) => rows.map((r) => r.data.id);

describe('SpotifySearchProvider — trigger gating', () => {
    it('ignores input without the trigger', () => {
        expect(setup().match('hello')).toEqual([]);
        expect(setup().match('')).toEqual([]);
    });

    it('ignores words that merely begin with the trigger', () => {
        // "spotify" starts with the default "sp" trigger but is not a
        // whole-word match — it must not strip to "otify" and surface a
        // bogus play row. See the word-boundary gate in match().
        expect(setup().match('spotify')).toEqual([]);
        expect(setup().match('special')).toEqual([]);
    });

    it('honours a custom trigger', () => {
        const p = setup({ trigger: 'spot' });
        expect(p.match('sp now')).toEqual([]);
        expect(ids(p.match('spot'))).toContain('now');
        // "spotify" begins with "spot" but is still not a whole word.
        expect(p.match('spotify')).toEqual([]);
    });
});

describe('SpotifySearchProvider — getKeywords', () => {
    it('registers the default trigger as a keyword', () => {
        const [kw] = setup().getKeywords();
        expect(kw.keyword).toBe('sp');
        expect(kw.acceptsArgs).toBe(true);
        expect(kw.labelKey).toMatch(/^keyword\./);
        // i18n keys only — no raw text the author could forget to localise.
        expect(kw.label).toBeUndefined();
    });

    it('reflects a user-configured trigger (config-aware)', () => {
        const [kw] = setup({ trigger: 'spot' }).getKeywords();
        expect(kw.keyword).toBe('spot');
    });
});

describe('SpotifySearchProvider — verb dispatch', () => {
    let p;
    beforeEach(() => {
        p = setup();
    });

    it('bare trigger shows now-playing + help', () => {
        expect(ids(p.match('sp'))).toEqual(['now', 'help']);
    });

    it('play with a query vs. bare play (resume)', () => {
        expect(ids(p.match('sp play daft punk'))).toEqual(['play:daft punk']);
        expect(ids(p.match('sp play'))).toEqual(['play']);
    });

    it('pause / next / prev', () => {
        expect(ids(p.match('sp pause'))).toEqual(['pause']);
        expect(ids(p.match('sp next'))).toEqual(['next']);
        expect(ids(p.match('sp prev'))).toEqual(['prev']);
        expect(ids(p.match('sp previous'))).toEqual(['prev']);
    });

    it('queue requires an argument', () => {
        expect(ids(p.match('sp queue some song'))).toEqual(['queue:some song']);
        expect(p.match('sp queue')).toEqual([]);
    });

    it('like / unlike', () => {
        expect(ids(p.match('sp like'))).toEqual(['like']);
        expect(ids(p.match('sp unlike'))).toEqual(['unlike']);
    });

    it('volume accepts 0..100 and rejects out-of-range / non-numeric', () => {
        expect(ids(p.match('sp vol 50'))).toEqual(['vol:50']);
        expect(ids(p.match('sp volume 0'))).toEqual(['vol:0']);
        expect(ids(p.match('sp vol 100'))).toEqual(['vol:100']);
        expect(p.match('sp vol 150')).toEqual([]);
        expect(p.match('sp vol loud')).toEqual([]);
    });
});

describe('SpotifySearchProvider — Commands cheat-sheet', () => {
    it('the help row prints the command list as markdown', async () => {
        const { provider } = setupExec();
        const out = await provider.execute(row('help'));
        expect(out.type).toBe('display');
        // Markdown, not HTML — it renders in the chat/response area.
        expect(out.value).toContain('Spotify commands');
        expect(out.value).toContain('`sp play <song>`');
        expect(out.value).toContain('`sp like`');
    });

    it('uses the configured trigger in the printed list', async () => {
        const { provider } = setupExec({ client: CLIENT, creds: CREDS }, { trigger: 'spot' });
        const out = await provider.execute(row('help'));
        expect(out.value).toContain('`spot play <song>`');
        expect(out.value).not.toContain('`sp play <song>`');
    });
});

describe('SpotifySearchProvider — widget refresh after state change', () => {
    beforeEach(() => {
        // A minimal fetch stub so player/library calls in _dispatch succeed.
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({ item: { id: 't1' } }),
            json: async () => ({ item: { id: 't1' } }),
        }));
    });
    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.fetch;
    });

    it('like returns refresh_widgets so the host repaints the bar', async () => {
        const { provider } = setupExec();
        const out = await provider.execute(row('like'));
        expect(out).toEqual({ type: 'refresh_widgets' });
    });

    it('pause / next also request a widget refresh', async () => {
        const { provider } = setupExec();
        expect(await provider.execute(row('pause'))).toEqual({ type: 'refresh_widgets' });
        expect(await provider.execute(row('next'))).toEqual({ type: 'refresh_widgets' });
    });

    it('read-only "now" does not request a refresh', async () => {
        const { provider } = setupExec();
        const out = await provider.execute(row('now'));
        expect(out).toEqual({ type: 'custom', data: { ok: true } });
    });

    it('_isStateChanging classifies mutating vs read-only ids', () => {
        const p = setup();
        for (const id of ['like', 'unlike', 'play', 'pause', 'next', 'prev', 'vol:50', 'play:x', 'queue:x', 'playlist:x', 'device:kitchen', 'device-id:abc']) {
            expect(p._isStateChanging(id)).toBe(true);
        }
        for (const id of ['now', 'help', 'connect', 'disconnect']) {
            expect(p._isStateChanging(id)).toBe(false);
        }
    });
});

describe('SpotifySearchProvider — no Client ID saved', () => {
    it('`sp connect` deep-links into the extension settings page', async () => {
        // Empty store: no client.json saved. Instead of an error telling
        // the user where to navigate, take them there — the settings page's
        // status line explains the next step.
        const { provider } = setupExec({});
        const out = await provider.execute(row('connect'));
        expect(out).toEqual({ type: 'open_extension_settings' });
    });

    it('other commands keep a plain-language error, no client_id jargon', async () => {
        // A playback command mid-flow shouldn't yank a settings window
        // open — it errors with a pointer instead. The copy must use the
        // visible "Client ID" label, never the raw client_id identifier.
        // Expired token + no client id forces the refresh path, which is
        // where no_client_id surfaces for non-connect commands.
        const expired = JSON.stringify({ ...JSON.parse(CREDS), expires_at: 0 });
        const { provider } = setupExec({ creds: expired });
        const out = await provider.execute(row('pause'));
        expect(out.type).toBe('custom');
        expect(out.data.error).toMatch(/Settings → Extensions → Spotify/);
        expect(out.data.error).toMatch(/Client ID/);
        expect(out.data.error).not.toMatch(/client_id/);
    });
});
