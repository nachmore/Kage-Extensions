# Spotify

See what's playing on Spotify, control playback, and manage your library
from Kage's floating window — without leaving the keyboard.

## Features

- **Now-playing bar** in the floating window with album art, track,
  artist, prev / play-pause / next / like buttons. Refreshes every 5
  seconds (configurable).
- **Quick shortcuts** — type `sp` (configurable) plus a verb in the
  floating window:
  | Shortcut         | Effect                                       |
  |------------------|----------------------------------------------|
  | `sp`             | Show what's playing                          |
  | `sp play`        | Resume                                       |
  | `sp play <q>`    | Search + play the top track match            |
  | `sp queue <q>`   | Add the top match to your queue              |
  | `sp pause`       | Pause                                        |
  | `sp like` / `unlike` | Save / unsave the current track          |
  | `sp next` / `prev` | Skip                                       |
  | `sp vol <0-100>` | Set volume on the active device              |
  | `sp device <name>` | Transfer playback to a device by name      |
  | `sp playlist <q>` | Play one of your playlists by name match    |
  | `sp connect`     | Sign in (also available in settings)         |
  | `sp disconnect`  | Sign out                                     |
- **AI tools**. The agent can call:
  `spotify_now_playing`, `spotify_play_search`, `spotify_queue_search`,
  `spotify_like_current`, `spotify_unlike_current`, `spotify_pause`,
  `spotify_resume`, `spotify_skip_next`, `spotify_skip_prev`,
  `spotify_set_volume`, `spotify_list_playlists`, `spotify_play_playlist`.
  So in chat: "queue up some lofi beats" or "what am I listening to?"
  just works.

## First-time setup (one-time)

Spotify requires every native client to be registered, and they don't
let us ship a shared client_id with this extension because rate limits
are per-app. So you make a free developer app once. You don't have to
follow this by hand: until the extension is set up, **Kage → Settings →
Extensions → Spotify** walks you through it step by step (and remembers
where you were if you close the window):

1. **Open the Spotify Developer Dashboard** — the button opens
   <https://developer.spotify.com/dashboard> in your browser.
2. **Create an app** — click **Create app** and set:
   - **App name** / **App description**: anything (e.g. "Kage")
   - **Redirect URIs**: `http://127.0.0.1:8080/spotify/callback` — the
     port is required at registration. Per [Spotify's redirect-URI
     rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)
     the form refuses port-less loopback entries. Spotify treats
     `127.0.0.1` as the IETF-blessed loopback address and lets the
     actual runtime port differ from the registered one, so Kage's
     ephemeral listener works regardless of the number. Use `http`
     and `127.0.0.1` exactly — not `https`, not `localhost`.
   - Tick **Web API**, accept the terms, and **Save**.
3. **Copy your Client ID** from the app's **Settings** page and paste it.
   Kage checks with Spotify that the ID exists before moving on, so a typo
   or a pasted Client secret is caught right there.
4. **Connect** — your browser opens Spotify's consent screen; approve and
   the extension picks up the redirect automatically.

Once connected, the page shows the regular settings, with **Run setup
again** (e.g. to switch apps) and **Sign out**.

## How auth works

PKCE (no client secret), with the OAuth redirect captured by Kage's
built-in localhost loopback listener. The flow:

1. The extension asks Kage to bind a one-shot listener on
   `http://127.0.0.1:<port>/spotify/callback`.
2. The extension opens Spotify's authorize page in your browser, with
   that loopback URL as the `redirect_uri`.
3. You approve. Spotify redirects your browser to the loopback. Kage's
   listener captures the `code` and shuts down — the port is closed
   immediately.
4. The extension exchanges the code for an access + refresh token,
   stored in Kage's sandboxed extension data area (never in
   `localStorage`, never in plain config).

The listener:
- only binds to `127.0.0.1`, never `0.0.0.0`
- uses an OS-assigned random port (not guessable from the outside)
- accepts exactly one matching request, then drops
- has a 5-minute hard timeout

## Permissions

| Capability | Why                                                     |
|------------|---------------------------------------------------------|
| `storage`  | Saves your Spotify Client ID + refresh token locally.   |
| `urls`     | Opens the Spotify dashboard and authorize page in your browser. |
| `oauth`    | Binds the one-shot loopback listener for the redirect.  |

The extension makes its own outbound HTTPS calls to `api.spotify.com`
and `accounts.spotify.com` from within the Kage extension sandbox; that
doesn't need a Kage capability because Spotify's API sends proper CORS
headers.

## Privacy

- Your Client ID and tokens never leave your machine, except outbound
  to `accounts.spotify.com` (token refresh) and `api.spotify.com`
  (playback control).
- No telemetry from this extension. Kage's general telemetry policy
  applies separately and is opt-in.

## Troubleshooting

**"INVALID_CLIENT: Invalid redirect URI"** in the browser — your app's
Redirect URIs don't include `http://127.0.0.1:8080/spotify/callback`
(any port). Add it in the Spotify dashboard (app → Settings → Edit) and
save.

**"INVALID_CLIENT: Invalid client"** in the browser — Spotify doesn't know
the saved Client ID. Settings → Extensions → Spotify → **Run setup again**
and paste the Client ID from the app's Settings page.

**Buttons do nothing** — Spotify's API only controls an *active*
device. Make sure Spotify is open and playing on at least one device
(desktop / phone / web player). The "device" shortcut can transfer
playback if you have multiple.

**"Nothing is playing"** when liking a track — Spotify briefly returns
no current track between songs. Wait a tick and retry.

**Token never refreshes** — sign out and reconnect. The extension
stores `refresh_token` once; if you revoke access in Spotify's account
page, the next refresh fails and you'll need to reauth.
