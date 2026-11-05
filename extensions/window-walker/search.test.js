/**
 * Functional tests for the Window Walker provider.
 * All work is async (IPC to list windows + fetch icons); we mock those
 * invokes and assert trigger gating, filtering, icon caching/eviction,
 * and the focus action.
 */

import { describe, it, expect, vi } from 'vitest';
import WindowWalkerSearchProvider from './search.js';
import WindowWalkerSettingsProvider from './settings.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

const WINDOWS = [
    { handle: 1, title: 'README.md - VS Code', process_name: 'Code.exe' },
    { handle: 2, title: 'Inbox - Outlook', process_name: 'Outlook.exe' },
    { handle: 3, title: 'Chrome', process_name: 'Chrome' }, // title === process
];

function setup({ config = {}, windows = WINDOWS, icons = {}, hostFeatures } = {}) {
    const invokes = {
        list_open_windows: () => windows,
        get_window_icons: () => icons,
        focus_open_window: vi.fn(),
    };
    const { context, invoke } = makeContext({ config, invokes, hostFeatures });
    const provider = new WindowWalkerSearchProvider();
    provider.initialize(context);
    return { provider, invoke };
}

describe('WindowWalkerSearchProvider — trigger & listing', () => {
    it('match() is synchronous-empty (all work is async)', () => {
        const { provider } = setup();
        expect(provider.match('w hello')).toEqual([]);
    });

    it('requires the trigger prefix', async () => {
        const { provider } = setup();
        expect(await provider.matchAsync('hello')).toEqual([]);
    });

    it('lists all windows for the bare trigger', async () => {
        const { provider } = setup();
        const rows = await provider.matchAsync('w ');
        expect(rows.map((r) => r.label)).toEqual([
            'README.md - VS Code',
            'Inbox - Outlook',
            'Chrome',
        ]);
    });

    it('filters by title or process name', async () => {
        const { provider } = setup();
        const rows = await provider.matchAsync('w outlook');
        expect(rows).toHaveLength(1);
        expect(rows[0].data.handle).toBe(2);
    });

    it('hides the description when it equals the title', async () => {
        const { provider } = setup();
        const chrome = (await provider.matchAsync('w chrome')).find((r) => r.data.handle === 3);
        expect(chrome.description).toBe('');
    });
});

describe('WindowWalkerSearchProvider — icons', () => {
    it('uses fetched icons when show_icons is on', async () => {
        const { provider } = setup({
            icons: { 1: 'data:image/png;base64,AAA' },
        });
        const rows = await provider.matchAsync('w code');
        expect(rows[0].icon).toBe('data:image/png;base64,AAA');
    });

    it('prefixes a bare base64 icon with the data URI scheme', async () => {
        const { provider } = setup({ icons: { 1: 'BBB' } });
        const rows = await provider.matchAsync('w code');
        expect(rows[0].icon).toBe('data:image/png;base64,BBB');
    });

    it('falls back to the window glyph when show_icons is false', async () => {
        const { provider } = setup({
            config: { show_icons: false },
            icons: { 1: 'data:image/png;base64,AAA' },
        });
        const rows = await provider.matchAsync('w code');
        expect(rows[0].icon).toBe('🪟');
    });
});

describe('WindowWalkerSearchProvider — caching', () => {
    it('caches the window list for ~500ms (one IPC for rapid calls)', async () => {
        const { provider, invoke } = setup();
        await provider.matchAsync('w ');
        await provider.matchAsync('w out');
        const listCalls = invoke.mock.calls.filter((c) => c[0] === 'list_open_windows');
        expect(listCalls).toHaveLength(1);
    });
});

describe('WindowWalkerSearchProvider — hide_minimized', () => {
    // What a host with 'windows.minimized' lists: every window flagged.
    const FLAGGED = [
        { handle: 1, title: 'README.md - VS Code', process_name: 'Code.exe', minimized: false },
        { handle: 2, title: 'Inbox - Outlook', process_name: 'Outlook.exe', minimized: true },
        { handle: 3, title: 'Chrome', process_name: 'Chrome', minimized: false },
        { handle: 4, title: 'Notes - Outlook', process_name: 'Outlook.exe', minimized: true },
    ];
    const CURRENT_HOST = ['config.manifest_defaults', 'windows.minimized'];
    const handles = (rows) => rows.map((r) => r.data.handle);

    it('current host, on: minimized windows are left out', async () => {
        const { provider } = setup({
            config: { hide_minimized: true },
            windows: FLAGGED,
            hostFeatures: CURRENT_HOST,
        });
        expect(handles(await provider.matchAsync('w '))).toEqual([1, 3]);
    });

    it('current host, on: the text filter applies to what is left', async () => {
        const { provider } = setup({
            config: { hide_minimized: true },
            windows: FLAGGED,
            hostFeatures: CURRENT_HOST,
        });
        expect(await provider.matchAsync('w outlook')).toEqual([]);
        expect(handles(await provider.matchAsync('w code'))).toEqual([1]);
    });

    it('current host, on: scores stay in list order without gaps', async () => {
        const { provider } = setup({
            config: { hide_minimized: true },
            windows: FLAGGED,
            hostFeatures: CURRENT_HOST,
        });
        expect((await provider.matchAsync('w ')).map((r) => r.score)).toEqual([95, 94]);
    });

    it('current host, off (the default): minimized windows are listed', async () => {
        const { provider } = setup({ windows: FLAGGED, hostFeatures: CURRENT_HOST });
        expect(handles(await provider.matchAsync('w '))).toEqual([1, 2, 3, 4]);
    });

    it('current host, on: every window minimized → no rows', async () => {
        const { provider } = setup({
            config: { hide_minimized: true },
            windows: FLAGGED.map((w) => ({ ...w, minimized: true })),
            hostFeatures: CURRENT_HOST,
        });
        expect(await provider.matchAsync('w ')).toEqual([]);
    });

    it('current host, on: no icons are fetched for hidden windows', async () => {
        const { provider, invoke } = setup({
            config: { hide_minimized: true },
            windows: FLAGGED,
            hostFeatures: CURRENT_HOST,
        });
        await provider.matchAsync('w ');
        expect(invoke).toHaveBeenCalledWith('get_window_icons', { pids: [1, 3] });
    });

    it('a settings change applies to the cached list', async () => {
        const { provider } = setup({ windows: FLAGGED, hostFeatures: CURRENT_HOST });
        expect(handles(await provider.matchAsync('w '))).toEqual([1, 2, 3, 4]);
        provider.onConfigUpdate({ hide_minimized: true });
        expect(handles(await provider.matchAsync('w '))).toEqual([1, 3]);
    });

    it('older host (no hostFeatures), on: every listed window is shown, as before', async () => {
        // Older hosts send no `minimized` at all.
        const { provider } = setup({ config: { hide_minimized: true } });
        expect(handles(await provider.matchAsync('w '))).toEqual([1, 2, 3]);
    });

    it('host without windows.minimized, on: a stray `minimized` is not trusted', async () => {
        const { provider } = setup({
            config: { hide_minimized: true },
            windows: FLAGGED,
            hostFeatures: ['config.manifest_defaults'],
        });
        expect(handles(await provider.matchAsync('w '))).toEqual([1, 2, 3, 4]);
    });
});

describe('WindowWalkerSettingsProvider — hide_minimized description', () => {
    const CATALOG = {
        'settings.hide_minimized.description': 'Exclude minimized windows from the list. On macOS…',
        'settings.hide_minimized.description_needs_update': 'Exclude minimized windows… Needs a more recent version of Kage…',
    };

    function hideMinimizedControl(hostFeatures) {
        const { context } = makeContext({ catalog: CATALOG, hostFeatures });
        const settings = new WindowWalkerSettingsProvider();
        settings.initialize(context);
        return settings.getSettings().sections
            .flatMap((s) => s.controls)
            .find((c) => c.id === 'hide_minimized');
    }

    it('a host that flags minimized windows gets the plain description', () => {
        const c = hideMinimizedControl(['config.manifest_defaults', 'windows.minimized']);
        expect(c.description).toBe(CATALOG['settings.hide_minimized.description']);
    });

    it('an older host is told the setting needs a more recent Kage', () => {
        expect(hideMinimizedControl(undefined).description)
            .toBe(CATALOG['settings.hide_minimized.description_needs_update']);
        expect(hideMinimizedControl(['config.manifest_defaults']).description)
            .toBe(CATALOG['settings.hide_minimized.description_needs_update']);
    });
});

describe('WindowWalkerSearchProvider — execute', () => {
    it('focuses the selected window', async () => {
        const { provider, invoke } = setup();
        const row = (await provider.matchAsync('w outlook'))[0];
        provider.execute(row);
        expect(invoke).toHaveBeenCalledWith('focus_open_window', { handle: 2 });
    });
});

describe('WindowWalkerSearchProvider — getKeywords', () => {
    const kw = (cfg) => setup({ config: cfg }).provider.getKeywords();

    it('registers the trimmed trigger word', () => {
        expect(kw().map((k) => k.keyword)).toEqual(['w']);
    });

    it('trims a trailing-space trigger and tracks a custom one', () => {
        expect(kw({ trigger: 'win ' }).map((k) => k.keyword)).toEqual(['win']);
    });

    it('returns an i18n KEY for the label', () => {
        expect(kw()[0].labelKey).toMatch(/^keyword\./);
        expect(kw()[0].label).toBeUndefined();
    });
});
