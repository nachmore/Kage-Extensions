export default class WeatherSettingsProvider {
    initialize(context) { this.config = context.config || {}; }
    onConfigUpdate(config) { this.config = config || {}; }

    getSettings() {
        return {
            description: 'Forecasts from <a href="https://open-meteo.com">Open-Meteo</a>; geocoding via OpenStreetMap Nominatim.',
            sections: [
                {
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: 'Enable', default: true },
                        {
                            type: 'text', id: 'trigger', label: 'Trigger word',
                            default: 'weather', maxWidth: 140,
                            description: 'Type this followed by a city, or alone for your home location.',
                        },
                        {
                            type: 'text', id: 'home_location', label: 'Home location',
                            default: '', placeholder: 'e.g. San Francisco, CA',
                            description: 'Used when you type just the trigger word.',
                        },
                        {
                            type: 'select', id: 'units', label: 'Units', default: 'metric',
                            options: [
                                { value: 'metric', label: 'Metric (°C, km/h)' },
                                { value: 'imperial', label: 'Imperial (°F, mph)' },
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
