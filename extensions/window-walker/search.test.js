/**
 * Functional tests for the Window Walker provider.
 * All work is async (IPC to list windows + fetch icons); we mock those
 * invokes and assert trigger gating, filtering, icon caching/eviction,
 * and the focus action.
 */

import { describe, it, expect, vi } from 'vitest';
import WindowWalkerSearchProvider from './search.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

const WINDOWS = [
    { handle: 1, title: 'README.md - VS Code', process_name: 'Code.exe' },
    { handle: 2, title: 'Inbox - Outlook', process_name: 'Outlook.exe' },
    { handle: 3, title: 'Chrome', process_name: 'Chrome' }, // title === process
];

function setup({ config = {}, windows = WINDOWS, icons = {} } = {}) {
    const invokes = {
        list_open_windows: () => windows,
        get_window_icons: () => icons,
        focus_open_window: vi.fn(),
    };
    const { context, invoke } = makeContext({ config, invokes });
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

describe('WindowWalkerSearchProvider — execute', () => {
    it('focuses the selected window', async () => {
        const { provider, invoke } = setup();
        const row = (await provider.matchAsync('w outlook'))[0];
        provider.execute(row);
        expect(invoke).toHaveBeenCalledWith('focus_open_window', { handle: 2 });
    });
});
