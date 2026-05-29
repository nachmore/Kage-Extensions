export default class PasswordSettingsProvider {
    initialize(context) {
        this.config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }
    onConfigUpdate(config) { this.config = config || {}; }

    getSettings() {
        const t = this.t;
        return {
            description: t('settings.description'),
            sections: [
                {
                    label: t('settings.section.defaults'),
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: t('settings.enabled.label'), default: true },
                        { type: 'text', id: 'trigger', label: t('settings.trigger.label'), default: 'pw', maxWidth: 80 },
                        {
                            type: 'number', id: 'default_length', label: t('settings.default_length.label'),
                            default: 20, min: 4, max: 128,
                        },
                    ],
                },
                {
                    label: t('settings.section.character_classes'),
                    controls: [
                        { type: 'checkbox', id: 'include_lowercase', label: t('settings.include_lowercase.label'), default: true },
                        { type: 'checkbox', id: 'include_uppercase', label: t('settings.include_uppercase.label'), default: true },
                        { type: 'checkbox', id: 'include_numbers', label: t('settings.include_numbers.label'), default: true },
                        { type: 'checkbox', id: 'include_symbols', label: t('settings.include_symbols.label'), default: true },
                        {
                            type: 'checkbox', id: 'exclude_ambiguous',
                            label: t('settings.exclude_ambiguous.label'),
                            default: true,
                            description: t('settings.exclude_ambiguous.description'),
                        },
                    ],
                },
            ],
        };
    }
}
