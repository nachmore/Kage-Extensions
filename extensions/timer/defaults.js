/**
 * Defaults for the Timer settings: the control defaults in settings.js,
 * and the fallbacks of its Preview button. They must equal the manifest's
 * `config` defaults (scripts/check-defaults.mjs fails CI if they drift).
 * Kage itself reads these settings when a timer finishes.
 *
 * Only older Kage hosts need these copies: they show a control's own
 * default, and give the extension its saved config without the manifest
 * defaults merged in. Hosts that list 'config.manifest_defaults' in
 * context.hostFeatures take every default from the manifest. Once the
 * minimum supported Kage includes it, the control defaults, the
 * fallbacks and this file can go.
 */
export const DEFAULTS = Object.freeze({
    notify_on_complete: true,
    sound_on_complete: true,
    sound_id: 'two-tone',
    custom_sound_path: '',
    sound_repeats: 3,
    show_window_on_complete: true,
});
