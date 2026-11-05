/**
 * Hello World settings provider (sandboxed).
 * Demonstrates the schema API with a text input and a checkbox.
 *
 * Strings come from `_locales/<lang>/messages.json` via the host's i18n
 * proxy. See docs/I18N.md for the contract.
 *
 * Control defaults must equal the manifest's `config` defaults: the Settings
 * page shows the control default for a never-saved value, but the extension
 * runs with the manifest default (scripts/check-defaults.mjs enforces this).
 * A translated default can't live in the manifest, so the greeting defaults
 * to '' ("use the localised greeting"). The placeholder shows the greeting
 * in the user's language and search.js falls back to the same string.
 */
export default class HelloWorldSettingsProvider {
    initialize(context) {
        this.config = context.config || {};
        this.t = context.i18n?.t || ((k) => k);
    }
    onConfigUpdate(config) { this.config = config || {}; }

    getSettings() {
        const t = this.t;
        return {
            description: t('settings.description'),
            sections: [
                {
                    controls: [
                        {
                            type: 'text',
                            id: 'greeting',
                            label: t('settings.greeting.label'),
                            description: t('settings.greeting.description'),
                            default: '',
                            placeholder: t('settings.greeting.default'),
                            maxWidth: 300,
                        },
                        {
                            type: 'checkbox',
                            id: 'show_timestamp',
                            label: t('settings.show_timestamp.label'),
                            description: t('settings.show_timestamp.description'),
                            default: false,
                        },
                    ],
                },
            ],
        };
    }
}
