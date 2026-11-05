/**
 * Defaults for the Hello World settings: the control defaults in
 * settings.js, and the fallbacks wherever code reads a setting the config
 * may lack. They must equal the manifest's `config` defaults
 * (scripts/check-defaults.mjs fails CI if they drift).
 *
 * The manifest is the source of truth. Hosts that list
 * 'config.manifest_defaults' in context.hostFeatures take every default
 * from it: Settings shows the manifest default, and context.config has
 * every declared key. Older Kage hosts show a control's own default, and
 * give the extension its saved config without the manifest defaults merged
 * in, so they need these copies. Once the minimum supported Kage includes
 * 'config.manifest_defaults', the control defaults, the fallbacks and this
 * file can go.
 *
 * A translated default can't live here or in the manifest: it has to be one
 * fixed value. So `greeting` defaults to '' ("use the localised greeting"),
 * and search.js falls back to the greeting in the user's language.
 */
export const DEFAULTS = Object.freeze({
    greeting: '',
    show_timestamp: false,
});
