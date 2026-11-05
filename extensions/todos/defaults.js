/**
 * Defaults for the Todos settings: the control defaults in settings.js,
 * and the fallbacks wherever code reads a setting the config may lack.
 * They must equal the manifest's `config` defaults (scripts/check-
 * defaults.mjs fails CI if they drift).
 *
 * Only older Kage hosts need these copies: they show a control's own
 * default, and give the extension its saved config without the manifest
 * defaults merged in. Hosts that list 'config.manifest_defaults' in
 * context.hostFeatures take every default from the manifest. Once the
 * minimum supported Kage includes it, the control defaults, the
 * fallbacks and this file can go.
 */
export const DEFAULTS = Object.freeze({
    default_category: '',
    show_completed: true,
    confirm_delete: true,
    sort_by: 'created',
    show_due_banner: true,
});
