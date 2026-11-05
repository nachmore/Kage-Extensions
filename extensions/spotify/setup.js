// Spotify first-run setup: the pure half of the guided setup wizard.
//
// The settings page (settings.js) shows a step-by-step setup instead of the
// regular settings whenever the extension can't do anything yet: no Client
// ID saved, or no Spotify sign-in. Every command, tool and the now-playing
// bar need a signed-in app, so the raw settings are useless until then.
//
// Everything in this module is side-effect free (no storage, network or
// browser access) so the step logic can be pinned by tests directly;
// settings.js does the I/O and builds the schema.
//
// Setup progress lives in extension-data under the `setup` key:
//
//   { step: 'dashboard'|'create_app'|'client_id'|'connect'|'done',
//     rerun?: true,      // user clicked "Run setup again" while connected
//     notice?: 'revoked', // why the user was sent back to the connect step
//     name?: string }    // Spotify display name, shown on the "done" screen
//
// Steps 1 and 2 leave no trace we could detect (opening a web page, creating
// an app on Spotify's site), so the step is stored explicitly. That is what
// makes setup resumable: closing the settings window mid-way and reopening
// it lands on the same step.

export const DASHBOARD_URL = 'https://developer.spotify.com/dashboard';

// The Redirect URI the user registers in their Spotify app. The path must
// match the `redirect_path` auth.js hands to `oauth_loopback_start`. The
// port is only there because Spotify's form refuses a port-less loopback
// entry: Spotify lets the runtime port differ for 127.0.0.1, and Kage binds
// a fresh ephemeral port on every sign-in.
export const REDIRECT_PATH = '/spotify/callback';
export const REDIRECT_URI = `http://127.0.0.1:8080${REDIRECT_PATH}`;

/** Ordered, numbered setup steps. `done` is the unnumbered final screen. */
export const SETUP_STEPS = Object.freeze(['dashboard', 'create_app', 'client_id', 'connect']);

const KNOWN_STEPS = new Set([...SETUP_STEPS, 'done']);

/**
 * Parse the stored `setup` blob (a JSON string from extension-data, an
 * object, or null) into a well-formed state. Unknown steps and garbage
 * collapse to "no step", so a corrupt blob can't strand the user.
 *
 * @returns {{present: boolean, step: string|null, rerun: boolean,
 *            notice: string|null, name: string}}
 */
export function normalizeSetupState(raw) {
    let obj = raw;
    if (typeof raw === 'string') {
        try {
            obj = JSON.parse(raw);
        } catch {
            obj = null;
        }
    }
    const present = raw != null && raw !== '';
    if (!obj || typeof obj !== 'object') {
        return { present, step: null, rerun: false, notice: null, name: '' };
    }
    return {
        present,
        step: KNOWN_STEPS.has(obj.step) ? obj.step : null,
        rerun: obj.rerun === true,
        notice: obj.notice === 'revoked' ? 'revoked' : null,
        name: typeof obj.name === 'string' ? obj.name.slice(0, 100) : '',
    };
}

/**
 * Decide what the settings page shows.
 *
 * - Not connected: the setup wizard, at the stored step. With no stored
 *   step it starts at step 1, or at "connect" when a Client ID is already
 *   saved (an older version's user who pasted one but never signed in, or
 *   a session Spotify revoked). "connect" needs a Client ID, so without one
 *   the wizard falls back to the Client ID step.
 * - Connected after just finishing setup: the one-time "all set" screen.
 * - Connected and re-running setup on purpose: the wizard again.
 * - Connected otherwise: the regular settings.
 *
 * `clearState` asks the caller to delete the stored blob: the "done" screen
 * shows once, and leftovers from a setup the user finished elsewhere (for
 * example `sp connect` from the launcher) must not resurface later.
 *
 * @param {{clientId: string|null, connected: boolean, state: *}} args
 * @returns {{view: 'wizard'|'done'|'settings', step?: string, rerun?: boolean,
 *            notice?: string|null, name?: string, clearState?: boolean}}
 */
export function resolveSetupView({ clientId, connected, state }) {
    const s = normalizeSetupState(state);
    if (connected) {
        if (s.step === 'done') return { view: 'done', name: s.name, clearState: true };
        if (s.rerun && s.step) {
            return { view: 'wizard', step: clampStep(s.step, clientId), rerun: true, notice: null };
        }
        return { view: 'settings', clearState: s.present };
    }
    const stored = SETUP_STEPS.includes(s.step) ? s.step : null;
    const step = clampStep(stored || (clientId ? 'connect' : 'dashboard'), clientId);
    return { view: 'wizard', step, rerun: false, notice: step === 'connect' ? s.notice : null };
}

function clampStep(step, clientId) {
    return step === 'connect' && !clientId ? 'client_id' : step;
}

/**
 * Validate a pasted Client ID before we save it or ask Spotify about it.
 * Spotify issues 32-character hex IDs; the format check is deliberately a
 * little looser (16-64 letters/digits) so a format change on Spotify's side
 * can't lock users out. The server-side check in auth.verifyClientId is
 * what catches a typo or a pasted Client secret.
 *
 * @returns {{ok: true, id: string} | {ok: false, reason: 'empty'|'url'|'format'}}
 */
export function parseClientId(raw) {
    const id = String(raw ?? '').trim();
    if (!id) return { ok: false, reason: 'empty' };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(id) || /^(www\.|[a-z0-9-]+\.spotify\.com)/i.test(id)) {
        return { ok: false, reason: 'url' };
    }
    if (!/^[a-z0-9]{16,64}$/i.test(id)) return { ok: false, reason: 'format' };
    return { ok: true, id };
}

/**
 * Optional Kage host behaviour this extension feature-detects through
 * `context.hostFeatures` (hosts that predate the list don't set it).
 */
export const HOST_FEATURE_COPY_ACTION = 'settings.copy_action';
/**
 * Among other things: saving a settings page stores only that page's keys
 * and keeps every other saved value.
 */
export const HOST_FEATURE_MANIFEST_DEFAULTS = 'config.manifest_defaults';

/** Whether the host's `context.hostFeatures` lists `feature`. */
export function hostHasFeature(hostFeatures, feature) {
    return Array.isArray(hostFeatures) && hostFeatures.includes(feature);
}

/**
 * Why Kage's loopback listener rejected `oauth_loopback_await`:
 * 'timeout', 'cancelled', or null for anything else.
 *
 * Current hosts put a stable `kind` on the error, and the kind decides.
 * Their `timeout` and `cancelled` messages are fixed English in every
 * locale ("OAuth flow timed out before a callback arrived" / "OAuth
 * listener was cancelled before a callback arrived"); their other loopback
 * errors (kind `internal`: a listener that failed or no longer exists) are
 * translated. Older hosts set no kind, always answer in English, and
 * reported a timeout with that same "...was cancelled before a callback
 * arrived" text (they couldn't cancel an await in flight, so it always
 * meant a timeout). So the text alone can't tell a timeout from a cancel,
 * and it is only matched when there's no kind.
 *
 * @returns {'timeout'|'cancelled'|null}
 */
export function loopbackFailure(e) {
    const kind = e?.kind;
    if (kind === 'timeout' || kind === 'cancelled') return kind;
    if (typeof kind === 'string' && kind) return null;
    if (/callback arrived|timed out/i.test(String(e?.message || e || ''))) return 'timeout';
    return null;
}

/**
 * Map a failed auth.startSignIn() onto a reason the settings page can
 * explain with a fix.
 *
 * The two most common setup mistakes (an unregistered Redirect URI and an
 * unknown Client ID) never reach us as an error: Spotify shows an
 * "INVALID_CLIENT" page in the browser and never redirects back, so the
 * loopback listener just times out. That's why `timeout` gets its own
 * reason, and why its message points at both fixes.
 *
 * `cancelled` covers both an abandoned sign-in (auth.js code 'cancelled')
 * and a listener Kage reports as cancelled; callers show nothing for it.
 *
 * @returns {{reason: string, error?: string, message?: string}}
 *   reason: 'cancelled' | 'no_client_id' | 'denied' | 'oauth' | 'state'
 *         | 'bad_client' | 'redirect' | 'timeout' | 'network' | 'unknown'
 */
export function classifySignInError(e) {
    const code = e?.code;
    if (code === 'cancelled') return { reason: 'cancelled' };
    if (code === 'no_client_id') return { reason: 'no_client_id' };
    if (code === 'oauth_denied') return { reason: 'denied' };
    if (code === 'oauth_error') {
        if (e.oauthError === 'invalid_client') return { reason: 'bad_client' };
        return { reason: 'oauth', error: String(e.oauthError || '').slice(0, 80) };
    }
    if (code === 'state_mismatch' || code === 'no_code') return { reason: 'state' };
    if (code === 'token_exchange') {
        if (/redirect/i.test(e.oauthDescription || '')) return { reason: 'redirect' };
        if (e.oauthError === 'invalid_client') return { reason: 'bad_client' };
        return { reason: 'oauth', error: String(e.oauthError || `HTTP ${e.status}`).slice(0, 80) };
    }
    if (code === 'loopback') {
        const failure = loopbackFailure(e);
        if (failure === 'timeout') return { reason: 'timeout' };
        if (failure === 'cancelled') return { reason: 'cancelled' };
    }
    const msg = String(e?.message || e || '');
    if (
        e?.name === 'TimeoutError' ||
        e?.name === 'AbortError' ||
        /failed to fetch|network|load failed/i.test(msg)
    ) {
        return { reason: 'network' };
    }
    return { reason: 'unknown', message: msg.slice(0, 160) };
}

/** Minimal HTML escaping for values interpolated into `info` blocks. */
export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
