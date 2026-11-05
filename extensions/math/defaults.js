/**
 * Defaults for the Math settings: the control defaults in settings.js, and
 * the fallbacks in search.js for a setting the config may lack. They must
 * equal the manifest's `config` defaults (scripts/check-defaults.mjs fails
 * CI if they drift). When they disagreed, Settings showed precision 2 while
 * 29/34 rendered "= 1" (precision 0).
 *
 * Only older Kage hosts need these copies: they show a control's own
 * default, and give the extension its saved config without the manifest
 * defaults merged in. Hosts that list 'config.manifest_defaults' in
 * context.hostFeatures take every default from the manifest. Once the
 * minimum supported Kage includes it, the control defaults, the
 * fallbacks and this file can go.
 */
export const DEFAULTS = Object.freeze({
    precision: 2,
    auto_copy: true,
    thousands_separator: false,
});
