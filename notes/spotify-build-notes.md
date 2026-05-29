# Spotify build notes — feedback for Kage core

Things the Spotify integration surfaced that are worth tracking.

## Things that worked first try

- The `oauth` capability + loopback flow was the right shape. PKCE
  state matching, code exchange, token refresh all sit cleanly inside
  the extension.
- Sandbox `fetch()` to `accounts.spotify.com` and `api.spotify.com`
  works fine — Spotify sends proper CORS headers, no Kage capability
  needed.
- `crypto.subtle.digest` + `crypto.getRandomValues` are available in
  the sandbox (PKCE verifier hashing, state nonce generation).
- Sharing `auth.js` between providers via ES `import` already worked
  for the calendar extension — same module-level state pattern carries
  over.

## Open items

- **Settings: input field as action arg**. The "Save Client ID" action
  currently reads `__client_id_input` from the values map by relying
  on the host stripping it back out in `normalize`. Cleaner would be a
  first-class control type for "scratch input that doesn't persist
  unless an action is invoked", or an action that takes a single
  inline-input. Workaround for v0.1.

- **Settings: showWhen on action button**. We tried to hide the
  Connect button until a Client ID is saved. The current `showWhen`
  syntax (`{ id, equals }` / `{ id, oneOf }`) doesn't have a
  "non-empty" predicate, so the button is always shown. Possible
  enhancement: `{ id, present: true }` or accept a function-string.

- **Refresh-token rotation**. Spotify rotates refresh tokens on some
  account tiers. `auth.js` handles it — but extensions needing OAuth
  would benefit from a Kage helper module that abstracts the
  start/await + token storage so each new extension doesn't reimplement
  it. Candidate for a future `ui/js/shared/extension-oauth.js` that
  extensions can import via `sandboxVendor`.

- **Widget: per-tick API calls**. The now-playing widget polls
  `/me/player` every 5 seconds when active. That's well under
  Spotify's documented limits, but it's also a paper-cut for battery
  life. Ideas: pause polling when the floating window is hidden, or
  expose a `{ paused }` lifecycle hint to widgets.

- **No way to disable the widget without disabling the whole
  extension**. The extension config has `show_now_playing_bar: false`
  to hide the bar, but the search shortcuts and tools stay enabled —
  works as intended, but was non-obvious to design without explicit
  per-contribution-point toggles. Confirms the current "one extension
  config, conditional contribute" model is sufficient.
