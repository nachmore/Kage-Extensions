// Spotify settings page — declarative schema; the host renders it.
//
// The page has two faces, chosen on every render (see setup.resolveSetupView):
//
//   - Guided setup, while the extension can't do anything yet (no Client ID,
//     or no Spotify sign-in). Instead of raw settings that are useless until
//     then, the page walks through it one step per screen:
//     (1) open the Spotify Developer Dashboard, (2) create an app with
//     Kage's Redirect URI, (3) paste and verify the Client ID,
//     (4) connect, then a one-time "all set" screen. Progress is stored in
//     extension-data (`setup`), so closing the window mid-way resumes on
//     the same step.
//   - The regular settings once connected, with "Run setup again" and
//     "Sign out".
//
// Every step change saves the new state and returns the host `refresh`
// effect, which re-runs getSettings() and re-renders the page in place. So
// all state lives in extension-data, never on this instance.

import * as auth from './auth.js';
import {
    DASHBOARD_URL,
    REDIRECT_URI,
    SETUP_STEPS,
    classifySignInError,
    escapeHtml,
    normalizeSetupState,
    parseClientId,
    resolveSetupView,
} from './setup.js';

const SETUP_KEY = 'setup';
const REFRESH = Object.freeze({ type: 'refresh' });

// Wizard navigation buttons → the step they go to. Explicit targets (rather
// than "next"/"back") keep a stale page from skipping a step.
const STEP_ACTIONS = Object.freeze({
    setup_step_dashboard: 'dashboard',
    setup_step_create_app: 'create_app',
    setup_step_client_id: 'client_id',
    setup_step_connect: 'connect',
});

// The display controls are on every setup step too, but always hidden: an
// empty `oneOf` never matches. They have to be there because the host saves
// exactly the value controls of the schema on screen (and carries their
// values through an in-place refresh). Without them, a Save during setup
// would drop the user's trigger word and refresh interval, and validate()
// would reject the "missing" trigger.
const NEVER_SHOWN = Object.freeze({ id: 'enabled', oneOf: [] });

export default class SpotifySettingsProvider {
    initialize(context) {
        auth.init(context);
        this.invoke = context.invoke;
        this.log = context.log;
        this.config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
        /** AbortController of the sign-in this page is waiting on, if any. */
        this._signIn = null;
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    // --- Schema ------------------------------------------------------------

    async getSettings() {
        const { clientId, connected, view } = await this._loadView();
        if (view.clearState) await this._clearSetupState();
        if (view.view === 'settings') return this._settingsSchema(clientId);
        return this._setupSchema(view, { clientId, connected });
    }

    _displayControls() {
        const t = this.t;
        return [
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
        ];
    }

    _trigger() {
        return (this.config.trigger || 'sp').toLowerCase();
    }

    /** The regular settings. Only shown while connected. */
    async _settingsSchema(clientId) {
        const t = this.t;
        // The widget's polls may have already diagnosed the stored session
        // as revoked (persisted marker — see auth.js). Trust it: showing
        // "Signed in" off a dead creds blob is the lie this panel used to
        // tell until the user manually hit "Check connection".
        const revoked = await auth.isAuthRevoked();
        return {
            description: t('settings.description'),
            sections: [
                {
                    label: t('settings.section.display'),
                    controls: [
                        ...this._displayControls(),
                        {
                            type: 'info',
                            label: t('settings.commands.label'),
                            // Built with the live trigger so a renamed trigger
                            // stays accurate in the reference list.
                            html: t('settings.commands.html', { trigger: escapeHtml(this._trigger()) }),
                        },
                    ],
                },
                {
                    label: t('settings.section.connection'),
                    controls: [
                        {
                            type: 'info',
                            html: revoked
                                ? t('settings.connection.revoked')
                                : t('settings.connection.connected'),
                        },
                        {
                            type: 'action',
                            id: 'connect',
                            label: t('settings.connect.label_reconnect'),
                            action: 'connect',
                            variant: 'primary',
                        },
                        {
                            type: 'action',
                            id: 'check_connection',
                            label: t('settings.check_connection.label'),
                            action: 'check_connection',
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
                {
                    label: t('settings.section.app'),
                    controls: [
                        {
                            type: 'info',
                            html: t('settings.app.client_id_html', {
                                client_id: escapeHtml(clientId || ''),
                            }),
                        },
                        {
                            type: 'action',
                            id: 'setup_restart',
                            label: t('settings.rerun_setup.label'),
                            description: t('settings.rerun_setup.description'),
                            action: 'setup_restart',
                        },
                    ],
                },
            ],
        };
    }

    /** The guided setup: one numbered step per screen, then "all set". */
    _setupSchema(view, { clientId, connected }) {
        const t = this.t;
        const sections = [];
        if (view.view === 'done') {
            sections.push({ label: t('setup.done.title'), controls: this._doneControls(view) });
        } else {
            sections.push({
                label: t('setup.step_label', {
                    number: SETUP_STEPS.indexOf(view.step) + 1,
                    total: SETUP_STEPS.length,
                    title: this._stepTitle(view.step),
                }),
                controls: this._stepControls(view, { clientId, connected }),
            });
            // A way out that leaves things as they were — only meaningful
            // when there's a working connection to go back to.
            if (view.rerun && connected) {
                sections.push({
                    controls: [
                        {
                            type: 'action',
                            id: 'setup_cancel',
                            label: t('setup.cancel.label'),
                            action: 'setup_cancel',
                        },
                    ],
                });
            }
        }
        sections.push({
            controls: this._displayControls().map((c) => ({ ...c, showWhen: NEVER_SHOWN })),
        });
        return {
            description:
                view.view === 'done'
                    ? t('settings.description')
                    : view.rerun
                      ? t('setup.description_rerun')
                      : t('setup.description'),
            sections,
        };
    }

    _stepTitle(step) {
        const t = this.t;
        switch (step) {
            case 'dashboard':
                return t('setup.dashboard.title');
            case 'create_app':
                return t('setup.create_app.title');
            case 'client_id':
                return t('setup.client_id.title');
            default:
                return t('setup.connect.title');
        }
    }

    _stepControls(view, { clientId, connected }) {
        const t = this.t;
        const openAgain = {
            type: 'action',
            id: 'setup_open_dashboard',
            label: t('setup.open_dashboard_again.label'),
            action: 'setup_open_dashboard',
        };
        const back = (target) => ({
            type: 'action',
            id: 'setup_back',
            label: t('setup.back.label'),
            action: `setup_step_${target}`,
        });

        switch (view.step) {
            case 'dashboard':
                return [
                    { type: 'info', html: t('setup.dashboard.body_html') },
                    {
                        type: 'action',
                        id: 'setup_open_dashboard',
                        label: t('setup.dashboard.open.label'),
                        action: 'setup_open_dashboard',
                        variant: 'primary',
                    },
                    {
                        type: 'action',
                        id: 'setup_next',
                        label: t('setup.next.label'),
                        action: 'setup_step_create_app',
                    },
                    { type: 'info', html: t('setup.dashboard.premium_html') },
                    ...(view.rerun ? [] : [{ type: 'info', html: t('setup.not_using_html') }]),
                ];
            case 'create_app':
                return [
                    { type: 'info', html: t('setup.create_app.body_html') },
                    {
                        type: 'info',
                        label: t('setup.create_app.redirect_label'),
                        // Its own block so a triple-click selects just the URI.
                        // No copy button: the host's settings schema has no
                        // clipboard-write control or effect, and the sandbox
                        // can't write the clipboard itself.
                        html: `<div><code>${escapeHtml(REDIRECT_URI)}</code></div><p>${t('setup.create_app.redirect_hint_html')}</p>`,
                    },
                    {
                        type: 'action',
                        id: 'setup_next',
                        label: t('setup.next.label'),
                        action: 'setup_step_client_id',
                        variant: 'primary',
                    },
                    openAgain,
                    back('dashboard'),
                ];
            case 'client_id':
                return [
                    { type: 'info', html: t('setup.client_id.body_html') },
                    {
                        type: 'text',
                        id: '__setup_client_id',
                        label: t('setup.client_id.label'),
                        default: clientId || '',
                        placeholder: t('setup.client_id.placeholder'),
                        description:
                            connected && clientId
                                ? t('setup.client_id.description_connected')
                                : t('setup.client_id.description'),
                    },
                    {
                        type: 'action',
                        id: 'setup_save_client_id',
                        label: t('setup.client_id.save.label'),
                        action: 'setup_save_client_id',
                        variant: 'primary',
                    },
                    openAgain,
                    back('create_app'),
                ];
            default:
                return [
                    ...(view.notice === 'revoked'
                        ? [{ type: 'info', html: t('setup.connect.notice_revoked_html') }]
                        : []),
                    { type: 'info', html: t('setup.connect.body_html') },
                    {
                        type: 'action',
                        id: 'setup_connect',
                        label: t('setup.connect.button'),
                        action: 'setup_connect',
                        variant: 'primary',
                    },
                    {
                        type: 'info',
                        label: t('setup.connect.trouble_label'),
                        html: t('setup.connect.trouble_html', { uri: escapeHtml(REDIRECT_URI) }),
                    },
                    back('client_id'),
                ];
        }
    }

    _doneControls(view) {
        const t = this.t;
        const headline = view.name
            ? t('setup.done.connected_named_html', { name: escapeHtml(view.name) })
            : t('setup.done.connected_html');
        return [
            {
                type: 'info',
                html: headline + t('setup.done.tips_html', { trigger: escapeHtml(this._trigger()) }),
            },
            {
                type: 'action',
                id: 'setup_finish',
                label: t('setup.done.finish.label'),
                action: 'setup_finish',
                variant: 'primary',
            },
        ];
    }

    // --- Validation --------------------------------------------------------

    validate(values) {
        const t = this.t;
        const trig = (values.trigger || '').trim();
        if (!trig) return { valid: false, error: t('settings.validate.trigger_required') };
        if (!/^[a-z0-9-]+$/i.test(trig))
            return { valid: false, error: t('settings.validate.trigger_format') };
        return { valid: true };
    }

    normalize(values) {
        // Strip helper fields (`__…`): inputs for actions, not real config.
        const rest = {};
        for (const [k, v] of Object.entries(values || {})) {
            if (!k.startsWith('__')) rest[k] = v;
        }
        rest.trigger = (rest.trigger || 'sp').trim().toLowerCase();
        return { values: rest };
    }

    // --- Actions -----------------------------------------------------------

    async runAction(action, values) {
        const target = STEP_ACTIONS[action];
        if (target) {
            // A pending sign-in keeps running across Back/Next. Its consent
            // tab is still open, and if the user clicks Agree there, Kage's
            // loopback page says "Spotify is now connected", so Kage must
            // finish connecting (landing on "All set"). It is abandoned only
            // once it can't be valid any more: a different Client ID
            // (_saveClientId), Cancel setup, Sign out, or a new Connect.
            await this._setStep(target);
            return { host: REFRESH };
        }
        switch (action) {
            case 'setup_open_dashboard':
                return this._openDashboard();
            case 'setup_save_client_id':
                return this._saveClientId(values || {});
            case 'setup_connect':
                return this._setupConnect();
            case 'setup_cancel':
                this._abortSignIn();
                await this._clearSetupState();
                return { host: REFRESH };
            case 'setup_finish':
                await this._clearSetupState();
                return { host: REFRESH };
            case 'setup_restart':
                await this._saveSetupState({ step: 'dashboard', rerun: true });
                return { host: REFRESH };
            case 'connect':
                return this._reconnect();
            case 'check_connection':
                return this._checkConnection();
            case 'disconnect':
                this._abortSignIn();
                await auth.clearAll();
                // Refresh: with the Client ID gone, the page turns back into
                // the guided setup.
                return { status: this.t('action.disconnect.success'), host: REFRESH };
            default:
                return {};
        }
    }

    async _openDashboard() {
        const t = this.t;
        try {
            // Through the host (`urls` capability) so it opens in the
            // system browser — never a navigation of the settings window.
            await this.invoke('open_url', { url: DASHBOARD_URL });
        } catch (e) {
            this.log?.warn?.('Spotify setup: open_url failed: ' + (e?.message || e));
            return { status: t('setup.dashboard.open_failed', { url: DASHBOARD_URL }) };
        }
        const status = t('setup.dashboard.opened');
        const { view } = await this._loadView();
        if (view.view === 'wizard' && view.step === 'dashboard') {
            // Opening the dashboard is step 1; move on so the instructions
            // for step 2 are waiting when the user comes back. The status
            // lands on step 2's "Open dashboard again" button (same id).
            await this._setStep('create_app');
            return { status, host: REFRESH };
        }
        return { status };
    }

    async _saveClientId(values) {
        const t = this.t;
        const parsed = parseClientId(values.__setup_client_id);
        if (!parsed.ok) {
            switch (parsed.reason) {
                case 'empty':
                    return { status: t('setup.client_id.error.empty') };
                case 'url':
                    return { status: t('setup.client_id.error.url') };
                default:
                    return { status: t('setup.client_id.error.format') };
            }
        }
        if ((await auth.verifyClientId(parsed.id)) === 'unknown_client') {
            return { status: t('setup.client_id.error.unknown_client') };
        }
        const previous = await auth.getClientId();
        if (previous !== parsed.id) {
            this._abortSignIn();
            // A sign-in belongs to the app it was made with; it can't be
            // refreshed under a different Client ID.
            if (previous) await auth.clearCreds();
            await auth.setClientId(parsed.id);
        }
        await this._setStep('connect');
        return { host: REFRESH };
    }

    async _setupConnect() {
        const controller = this._beginSignIn();
        const { signal } = controller;
        try {
            try {
                await auth.startSignIn({ signal });
            } catch (e) {
                // Abandoned (a different Client ID, Cancel setup, Sign out,
                // or a newer Connect): the page already shows something
                // else, so there's nothing to report.
                if (signal.aborted || e?.code === 'cancelled') return {};
                this.log?.warn?.('Spotify setup: sign-in failed: ' + (e?.message || e));
                return { status: this._signInErrorStatus(e, { inSetup: true }) };
            }
            // Signed in. Ask who as: that's the name on the "done" screen,
            // and the first call that shows whether Spotify will actually
            // serve this account.
            let name = '';
            let notRegistered = false;
            try {
                const me = await auth.api('GET', '/me');
                name = me?.display_name || me?.id || '';
            } catch (e) {
                // 403 right after a successful sign-in: the app is in
                // Spotify's development mode and the account that signed in
                // isn't its owner or on its User Management list (Spotify:
                // "the user may not be registered"). Every call would fail
                // the same way, so this is not "connected".
                if (e?.status === 403) notRegistered = true;
                // Anything else (offline, rate-limited) is left for later:
                // the name is a nicety, and the sign-in itself succeeded.
            }
            if (signal.aborted) return {};
            if (notRegistered) {
                this.log?.warn?.('Spotify setup: signed in, but GET /me answered 403');
                // Drop the unusable session so nothing claims "Signed in"
                // (the regular settings, the widget), and stay on (or come
                // back to) the connect step so the message is next to the
                // button that retries.
                await auth.clearCreds();
                await this._saveSetupState({ step: 'connect' });
                return { status: this.t('setup.connect.error.not_registered'), host: REFRESH };
            }
            await this._saveSetupState({ step: 'done', name });
            return { host: REFRESH };
        } finally {
            if (this._signIn === controller) this._signIn = null;
        }
    }

    async _reconnect() {
        const t = this.t;
        const controller = this._beginSignIn();
        try {
            await auth.startSignIn({ signal: controller.signal });
            // Refresh so the status line (e.g. a "Session expired" notice)
            // reflects the new session.
            return { status: t('action.connect.success'), host: REFRESH };
        } catch (e) {
            if (controller.signal.aborted || e?.code === 'cancelled') return {};
            if (e?.code === 'no_client_id') {
                // Signed out from elsewhere meanwhile: show the setup.
                return { status: t('action.check_connection.no_client_id'), host: REFRESH };
            }
            this.log?.warn?.('Spotify reconnect failed: ' + (e?.message || e));
            return { status: this._signInErrorStatus(e, { inSetup: false }) };
        } finally {
            if (this._signIn === controller) this._signIn = null;
        }
    }

    async _checkConnection() {
        const t = this.t;
        const res = await auth.checkConnection();
        switch (res.reason) {
            case 'ok':
                return {
                    status: res.display
                        ? t('action.check_connection.ok_named', { name: res.display })
                        : t('action.check_connection.ok'),
                };
            case 'no_client_id':
                return { status: t('action.check_connection.no_client_id'), host: REFRESH };
            case 'not_signed_in':
                return { status: t('action.check_connection.not_signed_in'), host: REFRESH };
            case 'revoked':
                // The stored refresh token is dead (Spotify revoked it —
                // password change, app removed, etc.). Wipe it so nothing
                // keeps claiming "Signed in". Keep the Client ID (clearCreds,
                // not clearAll): the app registration is still valid, so the
                // refreshed page is the setup's connect step — one click —
                // with a note saying why it's there.
                await auth.clearCreds();
                await this._saveSetupState({ step: 'connect', notice: 'revoked' });
                return { status: t('action.check_connection.revoked'), host: REFRESH };
            case 'network':
                return { status: t('action.check_connection.network') };
            default:
                return {
                    status: t('action.check_connection.unknown', { message: res.display || '' }),
                };
        }
    }

    _signInErrorStatus(e, { inSetup }) {
        const t = this.t;
        const c = classifySignInError(e);
        switch (c.reason) {
            case 'no_client_id':
                return t('action.check_connection.no_client_id');
            case 'denied':
                return t('signin.error.denied');
            case 'state':
                return t('signin.error.state');
            case 'network':
                return t('signin.error.network');
            case 'oauth':
                return t('signin.error.oauth', { error: c.error });
            case 'timeout':
                return inSetup ? t('setup.connect.error.timeout') : t('settings.connect.error.timeout');
            case 'bad_client':
                return inSetup
                    ? t('setup.connect.error.bad_client')
                    : t('settings.connect.error.app');
            case 'redirect':
                return inSetup
                    ? t('setup.connect.error.redirect', { uri: REDIRECT_URI })
                    : t('settings.connect.error.app');
            default:
                return t('signin.error.unknown', { message: c.message || '' });
        }
    }

    // --- Sign-in bookkeeping -----------------------------------------------

    /** Start tracking a new sign-in, abandoning any earlier one. */
    _beginSignIn() {
        this._abortSignIn();
        this._signIn = new AbortController();
        return this._signIn;
    }

    _abortSignIn() {
        if (this._signIn) {
            this._signIn.abort();
            this._signIn = null;
        }
    }

    // --- Setup state (extension-data `setup`) -------------------------------

    async _loadView() {
        const clientId = await auth.getClientId();
        const connected = await auth.isConnected();
        const state = await this.invoke('load_extension_data', { key: SETUP_KEY });
        return { clientId, connected, view: resolveSetupView({ clientId, connected, state }) };
    }

    /** Move to `step`, keeping the "re-running setup" flag. */
    async _setStep(step) {
        const raw = await this.invoke('load_extension_data', { key: SETUP_KEY });
        const current = normalizeSetupState(raw);
        await this._saveSetupState(current.rerun ? { step, rerun: true } : { step });
    }

    async _saveSetupState(state) {
        await this.invoke('save_extension_data', { key: SETUP_KEY, data: JSON.stringify(state) });
    }

    async _clearSetupState() {
        await this.invoke('delete_extension_data', { key: SETUP_KEY });
    }
}
