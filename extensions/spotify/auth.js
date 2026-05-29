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

export function init(context) {
    _ctx = context;
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
    _cachedToken = null;
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
    const tokenResp = await fetch(`${SPOTIFY_AUTH_BASE}/api/token`, {
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
    const resp = await fetch(`${SPOTIFY_AUTH_BASE}/api/token`, {
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
    const resp = await fetch(url, init);
    if (resp.status === 401) {
        // Access token expired between getAccessToken and the actual
        // request — refresh once and try again.
        _cachedToken = null;
        const fresh = await refreshAccessToken();
        headers.Authorization = `Bearer ${fresh}`;
        const retry = await fetch(url, init);
        return await parseSpotifyResponse(retry);
    }
    return await parseSpotifyResponse(resp);
}

async function parseSpotifyResponse(resp) {
    if (resp.status === 204) return null;
    const text = await resp.text();
    if (!resp.ok) {
        const err = new Error(
            `Spotify API ${resp.status}: ${text.slice(0, 200) || resp.statusText}`
        );
        err.status = resp.status;
        throw err;
    }
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
