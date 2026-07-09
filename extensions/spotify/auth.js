// Spotify auth module — PKCE with native loopback redirect.
//
// Shared between every contribution point in the extension (search,
// widget, settings, tools). Caches the access token in-memory after
// first refresh so a busy widget poll cycle isn't pinging the refresh
// endpoint every 5 seconds.
//
// Storage keys (extension-data, sandboxed):
//   creds.json    — { refresh_token, expires_at, access_token, scopes }
//   client.json   — { client_id }   (user-pasted; never logged)
//
// We never store the client_id in the manifest because Spotify's PKCE
// flow allows public client_ids (no secret). Each user creates their own
// app at developer.spotify.com — the friction is real but it sidesteps
// every "kage's shared client got rate-limited" risk.

// ---- PKCE helpers (Web Crypto, same in browser + worker contexts) ----

const SPOTIFY_AUTH_BASE = 'https://accounts.spotify.com';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

// Hard ceiling on every Spotify network call. Without it, a bare
// `fetch()` against an unreachable host blocks on the OS DNS/TCP-connect
// timeout — observed in the field at 5–32s — which then trips the host's
// 5s slow-render guard and 10s renderWidget RPC timeout, eventually
// tripping the widget circuit breaker. 4s sits comfortably under the 5s
// slow-render threshold, so the FIRST failed poll returns before the
// host even classifies it as slow. The happy path returns in well under
// a second, so this timeout never fires when Spotify is reachable.
const FETCH_TIMEOUT_MS = 4000;

/**
 * `fetch` with a hard timeout. Aborts via `AbortSignal.timeout`, so a
 * hung connect can't outlive `FETCH_TIMEOUT_MS`. Composes with any
 * caller-supplied `signal` so existing abort semantics still work.
 */
async function fetchWithTimeout(url, init = {}) {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = init.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal;
    return fetch(url, { ...init, signal });
}

const SCOPES = [
    'user-read-playback-state',
    'user-read-currently-playing',
    'user-modify-playback-state',
    'user-library-read',
    'user-library-modify',
    'playlist-read-private',
    'playlist-read-collaborative',
    'playlist-modify-public',
    'playlist-modify-private',
];

function randomBytes(n) {
    const buf = new Uint8Array(n);
    crypto.getRandomValues(buf);
    return buf;
}

function base64Url(bytes) {
    let s = btoa(String.fromCharCode(...bytes));
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256B64Url(input) {
    const enc = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return base64Url(new Uint8Array(buf));
}

function makeVerifier() {
    return base64Url(randomBytes(64));
}

// ---- Module state ----

let _ctx = null; // { invoke, log }
let _cachedToken = null; // { accessToken, expiresAt }
let _refreshing = null; // in-flight Promise to dedupe parallel refreshes

// Cross-contribution "playback state changed" signal. The search provider
// and the now-playing widget are separate provider instances but share this
// module. When a search command mutates state the widget renders (like/unlike,
// play/pause, skip, volume, …), it calls `markStateDirty()`. The widget checks
// `consumeStateDirty()` on its next render and drops its per-track caches (most
// importantly the like state), so a host-forced refresh after `sp like` shows
// the new heart instead of the stale cached value. It's a plain boolean, not a
// queue — one pending "something changed, re-read" is all the widget needs.
let _stateDirty = false;

export function init(context) {
    _ctx = context;
}

/** Flag that playback/library state the widget renders has changed, so the
 *  next widget render re-reads it instead of trusting its per-track cache. */
export function markStateDirty() {
    _stateDirty = true;
}

/** Read-and-clear the dirty flag. Returns true if state changed since the
 *  last call. The widget uses this to decide whether to invalidate caches. */
export function consumeStateDirty() {
    const was = _stateDirty;
    _stateDirty = false;
    return was;
}

export async function getClientId() {
    const raw = await _ctx.invoke('load_extension_data', { key: 'client' });
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw);
        return obj.client_id || null;
    } catch {
        return null;
    }
}

export async function setClientId(clientId) {
    await _ctx.invoke('save_extension_data', {
        key: 'client',
        data: JSON.stringify({ client_id: clientId.trim() }),
    });
}

export async function clearAll() {
    await _ctx.invoke('delete_extension_data', { key: 'creds' });
    await _ctx.invoke('delete_extension_data', { key: 'client' });
    await _ctx.invoke('delete_extension_data', { key: 'device' });
    _cachedToken = null;
}

/**
 * Clear the session credentials (and now-meaningless device preference)
 * but KEEP the user-pasted client_id. Used when Spotify has revoked the
 * refresh token: the token is dead, but the app registration is still
 * valid, so reconnecting is a single click rather than a re-paste of the
 * Client ID. Contrast with `clearAll`, which the explicit "Sign out"
 * action uses to wipe everything.
 */
export async function clearCreds() {
    await _ctx.invoke('delete_extension_data', { key: 'creds' });
    await _ctx.invoke('delete_extension_data', { key: 'device' });
    _cachedToken = null;
}

// ---- Preferred-device storage --------------------------------------
//
// Spotify's "active device" is whatever Spotify is currently streaming
// to. If nothing is streaming, ALL `/me/player/*` calls that drive
// playback (play/pause/next/prev/queue/volume/...) reject with HTTP
// 404 + reason `NO_ACTIVE_DEVICE`. The fix is to call
// `PUT /me/player` with a `device_ids` list — that wakes the chosen
// device and the next play call succeeds.
//
// We persist the user's last-used device so subsequent commands don't
// have to ask. The id alone is enough for the API; we keep the name
// for nicer error messages and future "reset device" UX.

export async function getPreferredDevice() {
    const raw = await _ctx.invoke('load_extension_data', { key: 'device' });
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw);
        return obj && obj.id ? obj : null;
    } catch {
        return null;
    }
}

export async function setPreferredDevice(device) {
    if (!device || !device.id) return;
    await _ctx.invoke('save_extension_data', {
        key: 'device',
        data: JSON.stringify({ id: device.id, name: device.name || '' }),
    });
}

export async function clearPreferredDevice() {
    await _ctx.invoke('delete_extension_data', { key: 'device' });
}

async function readCreds() {
    const raw = await _ctx.invoke('load_extension_data', { key: 'creds' });
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function writeCreds(creds) {
    await _ctx.invoke('save_extension_data', {
        key: 'creds',
        data: JSON.stringify(creds),
    });
}

export async function isConnected() {
    const c = await readCreds();
    return !!(c && c.refresh_token);
}

/**
 * Classify a thrown Spotify error so callers can tell a *critical* auth
 * failure (the stored token is dead — only reconnecting fixes it) from a
 * *transient* one (network blip, timeout — the token is probably fine).
 * Shared by `checkConnection` and the now-playing widget so both agree on
 * what "disconnected" means.
 *
 * @returns {'auth'|'network'|'unknown'}
 *   - 'auth'    : 401/403, or a refresh that came back invalid_grant/4xx —
 *                 Spotify revoked us. api() already retried the refresh
 *                 once, so surfacing this means the token is genuinely dead.
 *   - 'network' : offline / DNS / connect timeout / abort — retryable.
 *   - 'unknown' : anything else; treated as non-critical (don't nag).
 */
export function classifyError(e) {
    const msg = String(e?.message || e);
    if (
        e?.status === 401 ||
        e?.status === 403 ||
        /invalid_grant|Token refresh failed: 4\d\d|Not signed in/i.test(msg)
    ) {
        return 'auth';
    }
    if (
        e?.name === 'TimeoutError' ||
        e?.name === 'AbortError' ||
        /fetch|network|timeout|Failed to fetch/i.test(msg)
    ) {
        return 'network';
    }
    return 'unknown';
}

/**
 * Actively validate the stored credentials against Spotify, rather than
 * just checking a blob exists on disk (`isConnected`). This is what the
 * settings "Check connection" button calls: `isConnected` can report
 * "Signed in" indefinitely after Spotify revokes the refresh token (e.g.
 * the user removed the app, or changed their password), because nothing
 * ever exercises the token until playback is attempted.
 *
 * Forces a token refresh + a cheap authenticated call (`GET /me`) and
 * classifies the outcome so the caller can show an accurate message and
 * decide whether to clear the now-dead creds.
 *
 * @returns {Promise<{ok: boolean, reason: string, display?: string}>}
 *   reason ∈ 'ok' | 'no_client_id' | 'not_signed_in' | 'revoked'
 *            | 'network' | 'unknown'. `display` is the Spotify display
 *   name on success when available.
 */
export async function checkConnection() {
    const clientId = await getClientId();
    if (!clientId) return { ok: false, reason: 'no_client_id' };

    const creds = await readCreds();
    if (!creds || !creds.refresh_token) return { ok: false, reason: 'not_signed_in' };

    // Drop any cached access token so we genuinely re-validate against
    // Spotify instead of trusting an in-memory token from a prior poll.
    _cachedToken = null;

    try {
        const me = await api('GET', '/me');
        return { ok: true, reason: 'ok', display: me?.display_name || me?.id || '' };
    } catch (e) {
        // Map the shared classification onto the settings-facing reasons.
        // 'auth' → the stored creds are dead ('revoked'); network/unknown
        // stay distinct so we don't tell the user to reconnect over a blip.
        const kind = classifyError(e);
        if (kind === 'auth') return { ok: false, reason: 'revoked' };
        if (kind === 'network') return { ok: false, reason: 'network' };
        return { ok: false, reason: 'unknown', display: String(e?.message || e).slice(0, 120) };
    }
}

// ---- Sign-in flow ----

export async function startSignIn() {
    const clientId = await getClientId();
    if (!clientId) {
        throw new Error(
            'No Spotify client_id configured. Open the extension settings to paste one in.'
        );
    }

    // 1. Reserve the loopback listener — this gives us back a fixed
    //    redirect URI like http://127.0.0.1:54321/spotify/callback
    //    that we register with Spotify on this attempt.
    const start = await _ctx.invoke('oauth_loopback_start', {
        args: {
            redirect_path: '/spotify/callback',
            timeout_secs: 300,
            success_label: 'Spotify',
        },
    });

    // 2. Build the auth URL. PKCE: hash the verifier into the challenge,
    //    keep the verifier locally so we can redeem the code later.
    const verifier = makeVerifier();
    const challenge = await sha256B64Url(verifier);
    const state = base64Url(randomBytes(16));
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: start.redirect_uri,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        scope: SCOPES.join(' '),
        state,
        show_dialog: 'false',
    });
    const authUrl = `${SPOTIFY_AUTH_BASE}/authorize?${params.toString()}`;

    // 3. Open the browser for the user to consent.
    await _ctx.invoke('open_url', { url: authUrl });

    // 4. Block until the user's browser hits our loopback. This is the
    //    same redirect_uri Spotify just got, so they'll get redirected
    //    here even from a fresh tab.
    let result;
    try {
        result = await _ctx.invoke('oauth_loopback_await', {
            args: { listener_id: start.listener_id },
        });
    } catch (e) {
        // Cancel just in case the start succeeded but the await failed —
        // makes the error surface cleanly without leaking listeners.
        try {
            await _ctx.invoke('oauth_loopback_cancel', {
                args: { listener_id: start.listener_id },
            });
        } catch {}
        throw e;
    }

    const params2 = result.params || {};
    if (params2.error) {
        throw new Error(`Spotify rejected the request: ${params2.error}`);
    }
    if (params2.state !== state) {
        throw new Error(
            'OAuth state mismatch — refusing to redeem the code. Try connecting again.'
        );
    }
    const code = params2.code;
    if (!code) {
        throw new Error('Spotify redirect arrived without a code.');
    }

    // 5. Exchange code for refresh + access token.
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: start.redirect_uri,
        client_id: clientId,
        code_verifier: verifier,
    });
    const tokenResp = await fetchWithTimeout(`${SPOTIFY_AUTH_BASE}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!tokenResp.ok) {
        const text = await tokenResp.text();
        throw new Error(`Token exchange failed: ${tokenResp.status} ${text.slice(0, 200)}`);
    }
    const tok = await tokenResp.json();
    const expiresAt = Date.now() + (tok.expires_in - 30) * 1000;
    await writeCreds({
        refresh_token: tok.refresh_token,
        access_token: tok.access_token,
        expires_at: expiresAt,
        scopes: tok.scope || SCOPES.join(' '),
    });
    _cachedToken = { accessToken: tok.access_token, expiresAt };
    return true;
}

// ---- Token refresh + access ----

async function refreshAccessToken() {
    const creds = await readCreds();
    if (!creds || !creds.refresh_token) {
        throw new Error('Not signed in to Spotify.');
    }
    const clientId = await getClientId();
    if (!clientId) {
        throw new Error('No Spotify client_id configured.');
    }
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refresh_token,
        client_id: clientId,
    });
    const resp = await fetchWithTimeout(`${SPOTIFY_AUTH_BASE}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Token refresh failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    const tok = await resp.json();
    const expiresAt = Date.now() + (tok.expires_in - 30) * 1000;
    // Spotify sometimes rotates the refresh_token (newer SDK versions do).
    const next = {
        refresh_token: tok.refresh_token || creds.refresh_token,
        access_token: tok.access_token,
        expires_at: expiresAt,
        scopes: tok.scope || creds.scopes || SCOPES.join(' '),
    };
    await writeCreds(next);
    _cachedToken = { accessToken: tok.access_token, expiresAt };
    return tok.access_token;
}

async function getAccessToken() {
    if (_cachedToken && _cachedToken.expiresAt > Date.now() + 5000) {
        return _cachedToken.accessToken;
    }
    if (_refreshing) return _refreshing;
    _refreshing = (async () => {
        const creds = await readCreds();
        if (creds && creds.access_token && creds.expires_at > Date.now() + 5000) {
            _cachedToken = {
                accessToken: creds.access_token,
                expiresAt: creds.expires_at,
            };
            return creds.access_token;
        }
        return await refreshAccessToken();
    })();
    try {
        return await _refreshing;
    } finally {
        _refreshing = null;
    }
}

// ---- Authenticated API helper ----

export async function api(method, path, opts = {}) {
    const token = await getAccessToken();
    const url = path.startsWith('http') ? path : `${SPOTIFY_API_BASE}${path}`;
    const headers = {
        Authorization: `Bearer ${token}`,
        ...(opts.headers || {}),
    };
    const init = { method, headers };
    if (opts.body !== undefined) {
        if (typeof opts.body === 'string') {
            init.body = opts.body;
        } else {
            init.body = JSON.stringify(opts.body);
            headers['Content-Type'] = 'application/json';
        }
    }
    const resp = await fetchWithTimeout(url, init);
    if (resp.status === 401) {
        // Access token expired between getAccessToken and the actual
        // request — refresh once and try again.
        _cachedToken = null;
        const fresh = await refreshAccessToken();
        headers.Authorization = `Bearer ${fresh}`;
        const retry = await fetchWithTimeout(url, init);
        return await parseSpotifyResponse(retry);
    }
    return await parseSpotifyResponse(resp);
}

async function parseSpotifyResponse(resp) {
    if (resp.status === 204) return null;
    const text = await resp.text();
    if (!resp.ok) {
        // Pull the structured error body when present so callers can
        // distinguish recovery cases (NO_ACTIVE_DEVICE, PREMIUM_REQUIRED,
        // etc.) without parsing the prose. The Web API consistently
        // returns `{ error: { status, message, reason? } }`.
        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch {
            /* not JSON — leave parsed null */
        }
        const reason = parsed?.error?.reason || null;
        const message = parsed?.error?.message || text.slice(0, 200) || resp.statusText;
        const err = new Error(`Spotify API ${resp.status}: ${message}`);
        err.status = resp.status;
        err.reason = reason;
        throw err;
    }
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

// ---- Player API helper ---------------------------------------------
//
// Player commands fail with `404 / NO_ACTIVE_DEVICE` when nothing is
// currently streaming. The standard Spotify recovery is to transfer
// playback to a chosen device first (which "wakes" it server-side),
// then retry the original command. We wrap every player call so the
// caller doesn't have to plumb device handling through every shortcut.
//
// Strategy:
//   1. Fast path: send the command. If it succeeds, we're done.
//   2. On NO_ACTIVE_DEVICE:
//      - Fetch `/me/player/devices`.
//      - Pick the user's saved preference if it's in the list.
//      - Otherwise, if there's exactly one device, use that and save
//        it as the preference.
//      - Otherwise, throw a structured `no_devices` error so callers
//        can route the user into the device-picker.
//   3. Transfer playback to the chosen device (`PUT /me/player`),
//      wait briefly for Spotify to commit, retry the command once.
//
// We don't add device_id directly to every URL because not all
// player endpoints accept it — and the transfer dance is what
// actually moves an idle Spotify Connect target into "active"
// state. Adding `?device_id=...` to a play call when the device is
// asleep still 404s.
//
// Errors thrown by this helper carry an extra `code` field so the UI
// can pick a localised message:
//   - 'no_devices'            — no Spotify devices online anywhere
//   - 'device_unavailable'    — saved device is gone; user must pick
//   - 'premium_required'      — playback API is Premium-only
//   - 'no_active_device'      — recovery attempted but still 404
// Anything else falls through with the original `.status` / `.reason`.

const NO_ACTIVE = 'NO_ACTIVE_DEVICE';
const TRANSFER_SETTLE_MS = 700; // Spotify needs a beat to wake the target

export async function listDevices() {
    const resp = await api('GET', '/me/player/devices');
    return Array.isArray(resp?.devices) ? resp.devices : [];
}

/**
 * Pick a target device when we have no saved preference. Returns
 * null when there's no clear single best — caller should surface a
 * picker.
 *
 * Heuristic in priority order:
 *
 *   1. Singleton — exactly one device, no choice to make.
 *   2. Single Computer — Spotify's own desktop client always reports
 *      `type: "Computer"` and uses the OS hostname for `name`. If
 *      there's exactly ONE Computer-typed device in the list, we're
 *      almost certainly the user's primary desktop — auto-pick. Fall
 *      back to the picker if there are multiple computers (rare; a
 *      developer machine + work machine signed into the same Spotify
 *      account, etc.) so we don't surprise.
 *
 * What we deliberately don't do: read the OS hostname. The Kage
 * sandbox doesn't expose it (and gating that on a new capability
 * just to break the tie between "phone" and "this computer" would
 * be heavy). Spotify's `type` is sufficient for the common case;
 * the picker covers the long tail.
 */
function pickBestDeviceWithoutPrompt(devices) {
    if (!Array.isArray(devices) || devices.length === 0) return null;
    if (devices.length === 1) return devices[0];
    const computers = devices.filter((d) => d.type === 'Computer');
    if (computers.length === 1) return computers[0];
    return null;
}

async function transferPlaybackTo(deviceId, play) {
    await api('PUT', '/me/player', {
        body: { device_ids: [deviceId], play: !!play },
    });
    // Give Spotify a beat to commit the transfer; immediate follow-up
    // calls have been observed returning NO_ACTIVE_DEVICE again.
    await new Promise((r) => setTimeout(r, TRANSFER_SETTLE_MS));
}

/**
 * Player API call with auto-device-recovery.
 *
 * @param {string} method  HTTP verb (PUT/POST/GET/DELETE)
 * @param {string} path    Path under SPOTIFY_API_BASE
 * @param {object} [opts]  Same shape as `api()`.
 * @param {object} [recovery]
 * @param {boolean} [recovery.willStartPlaying]
 *   True for play/queue/skip/playlist calls that ARE driving playback
 *   (so the transfer should `play: true`); false for pause/volume/etc
 *   where we want to wake the device but not start music. Defaults
 *   to true — the more common case and the safe assumption.
 */
export async function playerApi(method, path, opts = {}, recovery = {}) {
    try {
        return await api(method, path, opts);
    } catch (e) {
        // Only NO_ACTIVE_DEVICE is recoverable. Everything else (auth
        // expired, Premium required, malformed body, etc.) goes
        // straight back to the caller.
        if (e?.status !== 404 || e?.reason !== NO_ACTIVE) throw e;
    }

    // Fetch devices and pick a target.
    const devices = await listDevices();
    if (!devices.length) {
        const err = new Error('No Spotify devices found.');
        err.code = 'no_devices';
        throw err;
    }

    const pref = await getPreferredDevice();
    let target = pref ? devices.find((d) => d.id === pref.id) : null;
    if (!target) {
        if (pref) {
            // Preference is stale — clear it so the next attempt
            // re-prompts. Don't auto-pick a different device behind
            // the user's back: the saved preference reflected an
            // explicit choice, and silently switching to "phone" when
            // they expected "speaker" is the worse failure mode.
            await clearPreferredDevice();
            const err = new Error('Saved device is offline.');
            err.code = 'device_unavailable';
            err.lastDevice = pref;
            throw err;
        }
        target = pickBestDeviceWithoutPrompt(devices);
        if (target) {
            // Save the auto-pick so the next recovery doesn't re-run
            // the heuristic — and so the user can override it later
            // via the picker if it guessed wrong.
            await setPreferredDevice(target);
        } else {
            const err = new Error('Multiple devices available; pick one first.');
            err.code = 'multiple_devices';
            err.devices = devices;
            throw err;
        }
    }

    // Wake the target.
    const willPlay = recovery.willStartPlaying !== false;
    await transferPlaybackTo(target.id, willPlay);
    // Save the working device — survives an explicit picker choice
    // too, since the picker writes it before calling player commands.
    await setPreferredDevice(target);

    // Retry once. If it fails again, surface a stable code.
    try {
        return await api(method, path, opts);
    } catch (e) {
        if (e?.status === 404 && e?.reason === NO_ACTIVE) {
            e.code = 'no_active_device';
        }
        throw e;
    }
}
