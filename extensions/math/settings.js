/**
 * Math settings provider (sandboxed).
 *
 * Runs inside the extension sandbox iframe. Returns a declarative schema;
 * the host renders and wires everything up. No DOM access from here.
 */
import { DEFAULTS } from './defaults.js';

export default class MathSettingsProvider {
    initialize(context) {
        this.config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    getSettings() {
        const t = this.t;
        return {
            description: t('settings.description'),
            sections: [
                {
                    controls: [
                        {
                            type: 'number',
                            id: 'precision',
                            label: t('settings.precision.label'),
                            description: t('settings.precision.description'),
                            default: DEFAULTS.precision,
                            min: -1,
                            max: 15,
                            maxWidth: 80,
                        },
                        {
                            type: 'checkbox',
                            id: 'auto_copy',
                            label: t('settings.auto_copy.label'),
                            description: t('settings.auto_copy.description'),
                            default: DEFAULTS.auto_copy,
                        },
                        {
                            type: 'checkbox',
                            id: 'thousands_separator',
                            label: t('settings.thousands.label'),
                            description: t('settings.thousands.description'),
                            default: DEFAULTS.thousands_separator,
                        },
                    ],
                },
            ],
        };
    }

    validate(values) {
        const p = Number(values.precision);
        if (!Number.isFinite(p) || p < -1 || p > 15) {
            return { valid: false, error: this.t('settings.precision.error') };
        }
        return { valid: true };
    }
}
