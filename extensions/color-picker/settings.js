/**
 * Color Picker settings provider (sandboxed).
 */
export default class ColorPickerSettingsProvider {
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
                    controls: [
                        {
                            type: 'select',
                            id: 'copy_format',
                            label: t('settings.copy_format.label'),
                            description: t('settings.copy_format.description'),
                            default: 'all',
                            maxWidth: 200,
                            options: [
                                { value: 'all', label: t('settings.copy_format.option_all') },
                                { value: 'hex', label: t('settings.copy_format.option_hex') },
                                { value: 'rgb', label: t('settings.copy_format.option_rgb') },
                                { value: 'hsl', label: t('settings.copy_format.option_hsl') },
                            ],
                        },
                    ],
                },
            ],
        };
    }
}
