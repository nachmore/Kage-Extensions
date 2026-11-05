/**
 * Window Walker settings provider (sandboxed).
 *
 * Stored config uses `trigger` with a trailing space (that's the
 * activation delimiter). The UI shows it trimmed to avoid exposing
 * that implementation detail to the user.
 */

import { DEFAULTS } from './defaults.js';

export default class WindowWalkerSettingsProvider {
    initialize(context) {
        this.config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    getSettings() {
        const t = this.t;
        const storedTrigger = (this.config.trigger ?? DEFAULTS.trigger).replace(/\s+$/, '');
        return {
            description: t('settings.description'),
            sections: [
                {
                    controls: [
                        {
                            type: 'text',
                            id: 'trigger',
                            label: t('settings.trigger.label'),
                            description: t('settings.trigger.description'),
                            default: storedTrigger,
                            placeholder: DEFAULTS.trigger.trim(),
                            maxWidth: 120,
                        },
                        {
                            type: 'checkbox',
                            id: 'show_icons',
                            label: t('settings.show_icons.label'),
                            description: t('settings.show_icons.description'),
                            default: DEFAULTS.show_icons,
                        },
                        {
                            type: 'checkbox',
                            id: 'hide_minimized',
                            label: t('settings.hide_minimized.label'),
                            description: t('settings.hide_minimized.description'),
                            default: DEFAULTS.hide_minimized,
                        },
                    ],
                },
            ],
        };
    }

    validate(values) {
        const trigger = String(values.trigger || '').trim();
        if (!trigger) {
            return { valid: false, error: this.t('settings.trigger.error_empty') };
        }
        return { valid: true };
    }

    /**
     * Re-apply the trailing-space invariant. The search provider uses
     * a startsWith check against `config.trigger`, so the trigger needs
     * to include the activation delimiter. We hide that from the user
     * in the settings UI and re-add it here at save time.
     */
    normalize(values) {
        const trigger = String(values.trigger || '').trim() + ' ';
        return { values: { ...values, trigger } };
    }
}
