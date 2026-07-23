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

// The token endpoint gets a much longer leash than regular API calls.
// Aborting a token-refresh POST that Spotify has already processed is
// UNRECOVERABLE under refresh-token rotation: the rotation happened
// server-side (our stored token is now dead) but the new token died
// with the aborted response. A slow /me/player poll, by contrast, can
// simply be retried next cycle. 15s trades a rare slow beat for never
// self-destructing the session.
const TOKEN_FETCH_TIMEOUT_MS = 15000;

/**
 * `fetch` with a hard timeout. Aborts via `AbortSignal.timeout`, so a
 * hung connect can't outlive the deadline. Composes with any
 * caller-supplied `signal` so existing abort semantics still work.
 */
async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
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
    // New context may mean a different backing store (fresh sandbox,
    // tests) — in-memory state derived from the OLD store no longer
    // describes it. Reset the token cache, any in-flight refresh, and
    // the revoked-marker write-dedup to read-through.
    _cachedToken = null;
    _refreshing = null;
    _revokedWritten = null;
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
    // No creds → nothing to be revoked; a stale marker would make the
    // settings panel say "session expired" instead of "not signed in".
    await clearAuthRevoked();
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
    // Same as clearAll: without creds the revoked marker is meaningless.
    await clearAuthRevoked();
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

// ---- Revoked-session marker ------------------------------------------
//
// `isConnected` only proves a credential blob exists on disk — Spotify may
// have revoked it long ago. The now-playing widget discovers revocation
// organically (its polls start failing with auth errors), but the settings
// page lives in a different window with its own sandbox instance, so an
// in-memory flag can't reach it. The marker below lives in extension-data
// (host-side storage shared by every window), letting the widget's
// diagnosis flow to the settings panel: creds present + marker set renders
// as "session expired — reconnect" instead of a false "Signed in".
//
// Set by: the widget when its auth-failure streak crosses threshold.
// Cleared by: a successful token refresh (the strongest "auth is alive"
// signal, shared by every contribution), a successful sign-in, and any
// creds wipe (clearCreds/clearAll — no creds, nothing to be revoked).
//
// `_revokedWritten` dedupes WRITE RPCs within one sandbox instance —
// the widget polls every ~15s and shouldn't re-write the marker (or
// re-delete a marker that isn't there) on every cycle. Reads are NOT
// cached: `isAuthRevoked` is only called from settings renders (rare),
// and each window has its own sandbox instance, so a read cache here
// would go stale the moment another window flips the marker.

let _revokedWritten = null; // null = unknown, true/false = last write

export async function markAuthRevoked() {
    if (_revokedWritten === true) return;
    _revokedWritten = true;
    await _ctx.invoke('save_extension_data', {
        key: 'status',
        data: JSON.stringify({ auth_revoked: true, at: Date.now() }),
    });
}

export async function clearAuthRevoked() {
    if (_revokedWritten === false) return;
    _revokedWritten = false;
    await _ctx.invoke('delete_extension_data', { key: 'status' });
}

export async function isAuthRevoked() {
    const raw = await _ctx.invoke('load_extension_data', { key: 'status' });
    if (!raw) return false;
    try {
        return !!JSON.parse(raw).auth_revoked;
    } catch {
        return false;
    }
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
        // Coded so callers can surface a contextual, localised message
        // (settings says "paste one in above"; the launcher points at
        // settings). This message is the log-facing fallback only —
        // client_id is fine in a log, not in UI copy.
        const err = new Error('No Spotify client_id configured.');
        err.code = 'no_client_id';
        throw err;
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
    // Fresh sign-in supersedes any recorded revocation.
    await clearAuthRevoked();
    return true;
}

// ---- Token refresh + access ----
//
// MULTI-INSTANCE WARNING (see CONTRIBUTING.md "multiple concurrent
// instances"): every Kage window runs its own copy of this module, all
// sharing one creds.json. Spotify ROTATES the refresh token on every
// PKCE refresh and applies reuse detection — if two windows refresh
// concurrently with the same token, the loser presents an
// already-rotated token, which Spotify may answer by revoking the
// entire grant ("keeps getting logged out"). Three defences, layered:
//
//   1. A cross-window refresh mutex in extension-data (TTL'd — a dead
//      holder can't wedge everyone). The in-memory `_refreshing`
//      promise still dedupes within a window; the lock serialises
//      across windows.
//   2. Lost-race healing: on a 4xx refresh failure, re-read creds from
//      disk. If the stored refresh token differs from the one we
//      presented, a sibling won the race and rotated it — use the
//      sibling's result instead of failing.
//   3. A generous token-endpoint timeout (TOKEN_FETCH_TIMEOUT_MS): an
//      aborted-but-server-processed rotation loses the new token
//      irrecoverably, so this call gets patience the data-plane calls
//      don't.

// Lock TTL. Longer than TOKEN_FETCH_TIMEOUT_MS so the lock outlives the
// slowest legitimate refresh; short enough that a crashed holder only
// stalls siblings briefly (they fail one poll cycle and retry).
const REFRESH_LOCK_TTL_MS = 20000;
// How long a non-holding instance waits for the holder to finish before
// reading through (holder likely completed) or grabbing the lock itself
// (holder likely died).
const REFRESH_LOCK_POLL_MS = 500;

// Instance tag for lock ownership. Random per module instance — two
// windows can't collide, and rechecking ownership after the write
// catches near-simultaneous grabs (extension-data writes are
// last-writer-wins, no compare-and-swap).
const _instanceId = base64Url(randomBytes(8));

async function _readRefreshLock() {
    const raw = await _ctx.invoke('load_extension_data', { key: 'refresh_lock' });
    if (!raw) return null;
    try {
        const lock = JSON.parse(raw);
        if (!lock.holder || !lock.expires_at || lock.expires_at < Date.now()) return null;
        return lock;
    } catch {
        return null;
    }
}

async function _acquireRefreshLock() {
    const existing = await _readRefreshLock();
    if (existing && existing.holder !== _instanceId) return false;
    await _ctx.invoke('save_extension_data', {
        key: 'refresh_lock',
        data: JSON.stringify({ holder: _instanceId, expires_at: Date.now() + REFRESH_LOCK_TTL_MS }),
    });
    // Re-read: with last-writer-wins storage two instances can both pass
    // the check above; the second write clobbers the first, so whoever
    // reads their own id back owns the lock. (The two storage RPCs are
    // serialized through the host, so this read observes any write that
    // landed before ours.)
    const check = await _readRefreshLock();
    return check?.holder === _instanceId;
}

async function _releaseRefreshLock() {
    const lock = await _readRefreshLock();
    if (lock && lock.holder !== _instanceId) return; // not ours to release
    await _ctx.invoke('delete_extension_data', { key: 'refresh_lock' });
}

/** The actual token-endpoint round trip. Throws on non-OK. */
async function _refreshRoundTrip(refreshToken, clientId) {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
    });
    const resp = await fetchWithTimeout(
        `${SPOTIFY_AUTH_BASE}/api/token`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        },
        TOKEN_FETCH_TIMEOUT_MS
    );
    if (!resp.ok) {
        const text = await resp.text();
        const err = new Error(`Token refresh failed: ${resp.status} ${text.slice(0, 200)}`);
        err.status = resp.status;
        throw err;
    }
    return resp.json();
}

async function refreshAccessToken() {
    const creds = await readCreds();
    if (!creds || !creds.refresh_token) {
        throw new Error('Not signed in to Spotify.');
    }
    const clientId = await getClientId();
    if (!clientId) {
        const err = new Error('No Spotify client_id configured.');
        err.code = 'no_client_id';
        throw err;
    }

    // Serialise across windows. If a sibling holds the lock, wait it out
    // and use whatever it wrote instead of racing it.
    if (!(await _acquireRefreshLock())) {
        const deadline = Date.now() + REFRESH_LOCK_TTL_MS;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, REFRESH_LOCK_POLL_MS));
            const lock = await _readRefreshLock();
            if (!lock) break; // holder finished (or died and TTL'd out)
        }
        const refreshed = await readCreds();
        if (refreshed?.access_token && refreshed.expires_at > Date.now() + 5000) {
            _cachedToken = {
                accessToken: refreshed.access_token,
                expiresAt: refreshed.expires_at,
            };
            return refreshed.access_token;
        }
        // Holder vanished without writing a fresh token — fall through and
        // refresh ourselves (best effort; the lock is gone or expired).
    }

    try {
        let tok;
        try {
            tok = await _refreshRoundTrip(creds.refresh_token, clientId);
        } catch (e) {
            // Lost-race healing: a 4xx here usually means the token we
            // presented was already rotated by a sibling window. If the
            // creds on disk changed while we were trying, trust the
            // sibling's rotation — retry once with the stored token.
            const isAuthShaped = e?.status >= 400 && e?.status < 500;
            if (!isAuthShaped) throw e;
            const latest = await readCreds();
            if (!latest?.refresh_token || latest.refresh_token === creds.refresh_token) {
                throw e; // nothing changed — genuinely dead
            }
            if (latest.access_token && latest.expires_at > Date.now() + 5000) {
                // Sibling already wrote a live access token; no round trip needed.
                _cachedToken = {
                    accessToken: latest.access_token,
                    expiresAt: latest.expires_at,
                };
                return latest.access_token;
            }
            tok = await _refreshRoundTrip(latest.refresh_token, clientId);
            creds.refresh_token = latest.refresh_token;
            creds.scopes = latest.scopes || creds.scopes;
        }

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
        // A refresh Spotify just accepted is the strongest proof the session
        // is alive — retract any revoked marker another surface recorded.
        await clearAuthRevoked();
        return tok.access_token;
    } finally {
        await _releaseRefreshLock();
    }
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
