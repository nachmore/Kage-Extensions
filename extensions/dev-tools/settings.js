/**
 * Developer Tools settings provider (sandboxed).
 */

import { DEFAULTS } from './defaults.js';

export default class DevToolsSettingsProvider {
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
                    label: t('settings.section.individual_tools'),
                    controls: [
                        { type: 'checkbox', id: 'uuid',        label: t('settings.uuid.label'),        description: t('settings.uuid.description'),        default: DEFAULTS.uuid },
                        { type: 'checkbox', id: 'base64',      label: t('settings.base64.label'),      description: t('settings.base64.description'),      default: DEFAULTS.base64 },
                        { type: 'checkbox', id: 'hash',        label: t('settings.hash.label'),        description: t('settings.hash.description'),        default: DEFAULTS.hash },
                        { type: 'checkbox', id: 'epoch',       label: t('settings.epoch.label'),       description: t('settings.epoch.description'),       default: DEFAULTS.epoch },
                        { type: 'checkbox', id: 'json_format', label: t('settings.json_format.label'), description: t('settings.json_format.description'), default: DEFAULTS.json_format },
                    ],
                },
            ],
        };
    }
}
