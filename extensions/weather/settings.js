import { DEFAULTS } from './defaults.js';

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
                        {
                            type: 'text', id: 'trigger', label: t('settings.trigger.label'),
                            default: DEFAULTS.trigger, maxWidth: 140,
                            description: t('settings.trigger.description'),
                        },
                        {
                            type: 'text', id: 'home_location', label: t('settings.home_location.label'),
                            default: DEFAULTS.home_location, placeholder: t('settings.home_location.placeholder'),
                            description: t('settings.home_location.description'),
                        },
                        {
                            type: 'select', id: 'units', label: t('settings.units.label'), default: DEFAULTS.units,
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
                trigger: (values.trigger || DEFAULTS.trigger).trim().toLowerCase(),
                home_location: (values.home_location || DEFAULTS.home_location).trim(),
            },
        };
    }
}
