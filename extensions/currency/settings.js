// Currency converter settings.

export default class CurrencySettingsProvider {
    initialize(context) { this.config = context.config || {}; }
    onConfigUpdate(config) { this.config = config || {}; }

    getSettings() {
        return {
            description:
                'Live exchange rates from <a href="https://frankfurter.dev">Frankfurter</a> ' +
                '(European Central Bank reference rates, no API key, ~150 currencies). Updated once per business day.',
            sections: [
                {
                    label: 'Defaults',
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: 'Enable', default: true },
                        {
                            type: 'text', id: 'default_source', label: 'Default source currency',
                            default: 'USD', maxWidth: 80,
                            description: '3-letter code used when none specified in the query.',
                        },
                        {
                            type: 'text', id: 'default_target', label: 'Default target currency',
                            default: 'EUR', maxWidth: 80,
                            description: 'Used when the query is just "<amount> <ccy>" with no destination.',
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
                default_source: (values.default_source || 'USD').trim().toUpperCase(),
                default_target: (values.default_target || 'EUR').trim().toUpperCase(),
            },
        };
    }
}
