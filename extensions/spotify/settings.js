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
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    async getSettings() {
        const connected = await auth.isConnected();
        const clientId = await auth.getClientId();
        const haveClient = !!clientId;

        return {
            description:
                'Show what\'s playing, control playback, and run shortcuts like ' +
                '"sp like" or "sp play <track>". Uses Spotify\'s PKCE flow over a ' +
                'one-shot localhost listener — no client secret leaves your machine.',
            sections: [
                {
                    label: 'Display',
                    controls: [
                        {
                            type: 'checkbox',
                            id: 'enabled',
                            label: 'Enable',
                            default: true,
                        },
                        {
                            type: 'checkbox',
                            id: 'show_now_playing_bar',
                            label: 'Show now-playing bar in the floating window',
                            default: true,
                        },
                        {
                            type: 'number',
                            id: 'refresh_seconds',
                            label: 'Refresh every (seconds)',
                            default: 5,
                            min: 2,
                            max: 60,
                            description:
                                'How often the now-playing bar polls Spotify. Lower means snappier ' +
                                'updates and slightly more API calls.',
                        },
                        {
                            type: 'text',
                            id: 'trigger',
                            label: 'Trigger word',
                            default: 'sp',
                            placeholder: 'sp',
                            maxWidth: 100,
                            description:
                                'What you type to invoke Spotify shortcuts in the floating window. ' +
                                'For example, "sp like" or "sp play lofi beats".',
                        },
                    ],
                },
                {
                    label: 'Spotify app',
                    controls: [
                        {
                            type: 'info',
                            html:
                                'Create a free <strong>Spotify Developer</strong> app at ' +
                                '<a href="https://developer.spotify.com/dashboard">developer.spotify.com/dashboard</a>. ' +
                                'Add <code>http://127.0.0.1/spotify/callback</code> as a Redirect URI ' +
                                '(any port works — Kage adds the actual port at sign-in time, and Spotify ' +
                                'matches the host + path). Copy the <strong>Client ID</strong> below.',
                        },
                        {
                            type: 'text',
                            id: '__client_id_input',
                            label: 'Client ID',
                            default: clientId || '',
                            placeholder: 'Paste your Spotify client_id here',
                            description: 'Stored locally; never sent anywhere except Spotify.',
                        },
                        {
                            type: 'action',
                            id: 'save_client_id',
                            label: 'Save Client ID',
                            action: 'save_client_id',
                        },
                    ],
                },
                {
                    label: 'Connection',
                    controls: [
                        {
                            type: 'info',
                            html: connected
                                ? '<strong>Connected</strong> — playback controls are ready.'
                                : haveClient
                                  ? 'Not connected yet. Click <strong>Connect</strong> to authorize.'
                                  : 'Save a Client ID first, then connect.',
                        },
                        {
                            type: 'action',
                            id: 'connect',
                            label: connected ? 'Reconnect…' : 'Connect…',
                            action: 'connect',
                            variant: 'primary',
                            showWhen: { id: '__client_id_input', oneOf: undefined },
                        },
                        {
                            type: 'action',
                            id: 'disconnect',
                            label: 'Sign out',
                            action: 'disconnect',
                            variant: 'danger',
                            confirm: 'Sign out of Spotify? You\'ll need to re-authorize to use playback shortcuts.',
                        },
                    ],
                },
            ],
        };
    }

    validate(values) {
        const t = (values.trigger || '').trim();
        if (!t) return { valid: false, error: 'Trigger word is required.' };
        if (!/^[a-z0-9-]+$/i.test(t))
            return { valid: false, error: 'Trigger must be letters, digits, or hyphens.' };
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
        if (action === 'save_client_id') {
            const id = (values.__client_id_input || '').trim();
            if (!id) return { status: '⚠️ Paste a Client ID first.' };
            if (!/^[a-z0-9]{16,}$/i.test(id))
                return { status: '⚠️ That doesn\'t look like a valid Spotify Client ID.' };
            await auth.setClientId(id);
            return { status: '✅ Client ID saved.' };
        }
        if (action === 'connect') {
            try {
                await auth.startSignIn();
                return { status: '✅ Connected. Now-playing bar will appear when something is playing.' };
            } catch (e) {
                return { status: `⚠️ ${e?.message || e}` };
            }
        }
        if (action === 'disconnect') {
            await auth.clearAll();
            return { status: '✅ Signed out.' };
        }
        return {};
    }
}
