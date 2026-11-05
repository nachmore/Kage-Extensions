/**
 * Default values for the Math extension's settings. The settings control
 * defaults (settings.js) and the search provider's fallbacks (search.js) both
 * read from here.
 *
 * manifest.json's `config` block has to declare the same values, because the
 * host uses them for an extension whose settings were never saved, while the
 * Settings page shows the control defaults. When the two disagreed, Settings
 * showed precision 2 and 29/34 rendered "= 1" (precision 0).
 * scripts/check-defaults.mjs fails CI if they drift apart again.
 */
export const DEFAULTS = Object.freeze({
    precision: 2,
    auto_copy: true,
    thousands_separator: false,
});
