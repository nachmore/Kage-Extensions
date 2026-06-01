// Spotify settings page — declarative schema; the host renders it.
//
// Two side-effects beyond plain key/value config:
//   - "Connect / Sign in" runs the PKCE + loopback flow and surfaces
//     status text on the button.
//   - "Sign out" wipes the credential blob from extension-data.

import * as auth from './auth.js';

export default class SpotifySettingsProvider {
    initialize(context) {
        auth.init(context);
        this.invoke = context.invoke;
        this.config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    async getSettings() {
        const t = this.t;
        const connected = await auth.isConnected();
        const clientId = await auth.getClientId();
        const haveClient = !!clientId;

        return {
            description: t('settings.description'),
            sections: [
                {
                    label: t('settings.section.display'),
                    controls: [
                        {
                            type: 'checkbox',
                            id: 'enabled',
                            label: t('settings.enabled.label'),
                            default: true,
                        },
                        {
                            type: 'checkbox',
                            id: 'show_now_playing_bar',
                            label: t('settings.show_now_playing_bar.label'),
                            default: true,
                        },
                        {
                            type: 'number',
                            id: 'refresh_seconds',
                            label: t('settings.refresh_seconds.label'),
                            default: 15,
                            min: 2,
                            max: 60,
                            description: t('settings.refresh_seconds.description'),
                        },
                        {
                            type: 'text',
                            id: 'trigger',
                            label: t('settings.trigger.label'),
                            default: 'sp',
                            placeholder: 'sp',
                            maxWidth: 100,
                            description: t('settings.trigger.description'),
                        },
                    ],
                },
                {
                    label: t('settings.section.app'),
                    controls: [
                        {
                            type: 'info',
                            html: t('settings.app.intro_html'),
                        },
                        {
                            type: 'text',
                            id: '__client_id_input',
                            label: t('settings.client_id.label'),
                            default: clientId || '',
                            placeholder: t('settings.client_id.placeholder'),
                            description: t('settings.client_id.description'),
                        },
                        {
                            type: 'action',
                            id: 'save_client_id',
                            label: t('settings.save_client_id.label'),
                            action: 'save_client_id',
                        },
                    ],
                },
                {
                    label: t('settings.section.connection'),
                    controls: [
                        {
                            type: 'info',
                            html: connected
                                ? t('settings.connection.connected')
                                : haveClient
                                  ? t('settings.connection.not_connected')
                                  : t('settings.connection.no_client_id'),
                        },
                        {
                            type: 'action',
                            id: 'connect',
                            label: connected ? t('settings.connect.label_reconnect') : t('settings.connect.label_connect'),
                            action: 'connect',
                            variant: 'primary',
                            showWhen: { id: '__client_id_input', oneOf: undefined },
                        },
                        {
                            type: 'action',
                            id: 'disconnect',
                            label: t('settings.disconnect.label'),
                            action: 'disconnect',
                            variant: 'danger',
                            confirm: t('settings.disconnect.confirm'),
                        },
                    ],
                },
            ],
        };
    }

    validate(values) {
        const t = this.t;
        const trig = (values.trigger || '').trim();
        if (!trig) return { valid: false, error: t('settings.validate.trigger_required') };
        if (!/^[a-z0-9-]+$/i.test(trig))
            return { valid: false, error: t('settings.validate.trigger_format') };
        return { valid: true };
    }

    normalize(values) {
        // Strip the helper field — it's not real config, just an input
        // for the "Save Client ID" action.
        const { __client_id_input, ...rest } = values;
        rest.trigger = (rest.trigger || 'sp').trim().toLowerCase();
        return { values: rest };
    }

    async runAction(action, values) {
        const t = this.t;
        if (action === 'save_client_id') {
            const id = (values.__client_id_input || '').trim();
            if (!id) return { status: t('action.save_client_id.empty') };
            if (!/^[a-z0-9]{16,}$/i.test(id))
                return { status: t('action.save_client_id.invalid') };
            await auth.setClientId(id);
            return { status: t('action.save_client_id.success') };
        }
        if (action === 'connect') {
            try {
                await auth.startSignIn();
                return { status: t('action.connect.success') };
            } catch (e) {
                return { status: t('action.connect.error', { message: e?.message || e }) };
            }
        }
        if (action === 'disconnect') {
            await auth.clearAll();
            return { status: t('action.disconnect.success') };
        }
        return {};
    }
}
