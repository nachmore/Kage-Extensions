export default class WeatherSettingsProvider {
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
                        { type: 'checkbox', id: 'enabled', label: t('settings.enabled.label'), default: true },
                        {
                            type: 'text', id: 'trigger', label: t('settings.trigger.label'),
                            default: 'weather', maxWidth: 140,
                            description: t('settings.trigger.description'),
                        },
                        {
                            type: 'text', id: 'home_location', label: t('settings.home_location.label'),
                            default: '', placeholder: t('settings.home_location.placeholder'),
                            description: t('settings.home_location.description'),
                        },
                        {
                            type: 'select', id: 'units', label: t('settings.units.label'), default: 'metric',
                            options: [
                                { value: 'metric', label: t('settings.units.option_metric') },
                                { value: 'imperial', label: t('settings.units.option_imperial') },
                            ],
                        },
                    ],
                },
            ],
        };
    }
    normalize(values) {
        return {
            values: {
                ...values,
                trigger: (values.trigger || 'weather').trim().toLowerCase(),
                home_location: (values.home_location || '').trim(),
            },
        };
    }
}
