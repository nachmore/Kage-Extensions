/**
 * Tests for the Link Preview settings provider: the cache actions, and the
 * note older hosts get while a `false` saved by the removed "Enable Link
 * Previews" checkbox keeps previews off.
 */

import { describe, it, expect } from 'vitest';
import LinkPreviewSettingsProvider from './settings.js';
import { makeContext } from '../../test-helpers/mock-context.mjs';

// `context.hostFeatures` of a current Kage host. Leaving it out (the
// default here) is a host from before 'config.manifest_defaults'.
const CURRENT_HOST = ['settings.copy_action', 'invoke.error_kind', 'config.manifest_defaults', 'windows.minimized'];

const NOTE_KEY = 'settings.legacy_disabled.info_html';

function setup({ config = {}, hostFeatures } = {}) {
    const { context } = makeContext({ config, hostFeatures });
    const provider = new LinkPreviewSettingsProvider();
    provider.initialize(context);
    return provider;
}

const controls = (provider) => provider.getSettings().sections.flatMap((s) => s.controls);
const hasNote = (provider) => controls(provider).some((c) => c.type === 'info' && c.html === NOTE_KEY);

describe('LinkPreviewSettingsProvider — the old Enable checkbox', () => {
    it('explains on an older host that a saved enabled: false keeps previews off', () => {
        const provider = setup({ config: { enabled: false, show_images: true, max_previews: 5 } });
        expect(hasNote(provider)).toBe(true);
        // A note, not a control: Save then stores only show_images and
        // max_previews, which drops `enabled`.
        expect(controls(provider).filter((c) => c.id === 'enabled')).toEqual([]);
    });

    it('drops the note once the saved value is gone', () => {
        const provider = setup({ config: { enabled: false } });
        provider.onConfigUpdate({ show_images: true, max_previews: 5 });
        expect(hasNote(provider)).toBe(false);
    });

    it('shows no note for a config without `enabled`, or on a current host', () => {
        expect(hasNote(setup())).toBe(false);
        expect(hasNote(setup({ config: { enabled: true } }))).toBe(false);
        // There `enabled: false` is the header switch, which says so itself.
        expect(hasNote(setup({ config: { enabled: false }, hostFeatures: CURRENT_HOST }))).toBe(false);
    });
});

describe('LinkPreviewSettingsProvider — cache actions', () => {
    it('maps each button to its link_metadata host effect', () => {
        const provider = setup();
        expect(provider.runSettingsAction({ action: 'cache_clear' })).toEqual({
            host: { type: 'link_metadata', op: 'clear' },
        });
        expect(provider.runSettingsAction({ action: 'cache_stats' })).toEqual({
            host: { type: 'link_metadata', op: 'stats' },
        });
        expect(provider.runSettingsAction({ action: 'nope' })).toEqual({ error: 'Unknown action: nope' });
    });
});
