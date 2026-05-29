export default class PasswordSettingsProvider {
    initialize(context) { this.config = context.config || {}; }
    onConfigUpdate(config) { this.config = config || {}; }

    getSettings() {
        return {
            description:
                'Generates passwords using <code>crypto.getRandomValues</code> — same entropy source ' +
                'browsers use for TLS keys. Hit Enter to copy. The "Generate another" row rolls a fresh one.',
            sections: [
                {
                    label: 'Defaults',
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: 'Enable', default: true },
                        { type: 'text', id: 'trigger', label: 'Trigger', default: 'pw', maxWidth: 80 },
                        {
                            type: 'number', id: 'default_length', label: 'Default password length',
                            default: 20, min: 4, max: 128,
                        },
                    ],
                },
                {
                    label: 'Character classes',
                    controls: [
                        { type: 'checkbox', id: 'include_lowercase', label: 'Lowercase (a-z)', default: true },
                        { type: 'checkbox', id: 'include_uppercase', label: 'Uppercase (A-Z)', default: true },
                        { type: 'checkbox', id: 'include_numbers', label: 'Numbers (0-9)', default: true },
                        { type: 'checkbox', id: 'include_symbols', label: 'Symbols (!@#…)', default: true },
                        {
                            type: 'checkbox', id: 'exclude_ambiguous',
                            label: 'Exclude ambiguous (Il1O0|\'`")',
                            default: true,
                            description: 'Drops characters that are easy to misread.',
                        },
                    ],
                },
            ],
        };
    }
}
