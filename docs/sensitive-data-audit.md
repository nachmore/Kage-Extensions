# Sensitive data audit

This inventory covers every extension and theme in the catalog. “Sensitive”
means a value grants access when leaked; personal content alone does not.
Storage names below are the API keys, without the host-added `.json` suffix.
“None” means the extension does not save extension data, even if it uses an
in-memory cache or a host-owned API.

| Item | Saved storage keys | Manifest config fields | Sensitive? | Reason |
| --- | --- | --- | --- | --- |
| bookmarks | `bookmarks` | `trigger` | No | User bookmarks and a search keyword; no credentials are requested. |
| calendar | None | `show_overlay`, `lookahead_hours` | No | Uses the host's native calendar commands and an in-memory event cache. No extension OAuth tokens, ICS/subscription URLs, or subscription settings exist. |
| color-picker | None | `copy_format` | No | Color formatting preference. |
| currency | `rate_cache` | `default_source`, `default_target` | No | Public exchange rates and currency choices; no API key. |
| dev-tools | None | `uuid`, `base64`, `hash`, `epoch`, `json_format` | No | Feature preferences; input/output is not saved as extension data. |
| dictionary | None | `trigger`, `language`, `show_pronunciation`, `show_examples`, `show_synonyms` | No | Search/display preferences and public dictionary lookup. |
| emoji | None | `trigger`, `shortcode_trigger` | No | Search keyword preferences. |
| focus-tracker | None | `trigger`, `poll_interval`, `track_screen_time`, `track_switches`, `track_streaks` | No | Host-owned activity reports and in-memory caches; preferences do not grant access. |
| github | `token` | `trigger`, **`personal_token`** | **Yes:** `token`, `personal_token`. No: `trigger`. | Personal access token grants repository/API access. `personal_token` is a retained manifest field even though the current provider stores tokens through a transient input into `token`. |
| hello-world | None | `greeting`, `show_timestamp` | No | Greeting and display preference. |
| link-preview | None | `max_previews`, `show_images` | No | Display preferences and in-memory metadata cache; disk caching belongs to the host's `fetch_link_metadata` implementation. No webhook or private URL setting. |
| math | None | `precision`, `auto_copy`, `thousands_separator` | No | Calculation/display preferences. |
| password | None | `trigger`, `default_length`, `include_symbols`, `include_numbers`, `include_lowercase`, `include_uppercase`, `exclude_ambiguous` | No extension-data secrets | Generates passwords for display/copy. Before 1.0.2, result IDs embedded generated passwords/passphrases and the host persisted them in search frecency after selection. Version 1.0.2 uses fixed `pw:password` / `pw:passphrase` IDs. Previously recorded secrets remain host-owned data and need host-side cleanup. Settings only describe generation preferences. |
| snippets | `snippets` | `trigger` | No | General user-authored text; the extension does not solicit credentials. |
| spotify | **`creds`**, **`client`**, `device`, `setup`, `status`, `refresh_lock` | `show_now_playing_bar`, `refresh_seconds`, `trigger` | **Yes:** `creds`, `client` (required). No: other keys/config. | `creds` contains access/refresh tokens. `client` holds pasted authentication input: a client SECRET can satisfy the 16–64 alphanumeric format and be saved when verification is offline/unverified. Versions 0.1.0–0.3.15 saved the input unchecked. Its sensitive declaration is required even though a genuine public PKCE client ID does not grant access. `device` is an ID/name, `setup` is wizard progress, `status` is a revocation flag/timestamp, and `refresh_lock` is an instance lease. |
| stocks | **`credentials`**, `request_budget`, `request_lock`, `quote_index`, `quote_*` | `provider`, `watchlist`, `refresh_seconds`, `show_watchlist`, `agent_tools` | **Yes:** `credentials`. No: other keys/config. | `credentials.api_key` holds the Finnhub API key and the manifest declares `sensitiveData: ["credentials"]`. Other records are quotes/history, indexes, rate-limit/backoff state, and a short coordination lease. |
| timer | None | `notify_on_complete`, `sound_on_complete`, `sound_id`, `custom_sound_path`, `sound_repeats`, `show_window_on_complete` | No | Notification/sound preferences and a local sound-file path. |
| todos | `kage-todos` | `default_category`, `show_completed`, `confirm_delete`, `sort_by`, `show_due_banner` | No | User tasks and presentation preferences. |
| weather | `geocode_cache`, `forecast_cache` | `trigger`, `home_location`, `units` | No | Locations and public forecast data; no API key. Locations are personal data, not credentials. |
| window-walker | None | `trigger`, `show_icons`, `hide_minimized` | No | Window-search preferences; no saved session credential. |
| theme: kiro-ish | None | None | No | Color JSON only. |
| theme: nord | None | None | No | Color JSON only. |
| theme: sunset | None | None | No | Color JSON only. |

## Declarations and review boundaries

- GitHub declares `sensitiveData: ["token"]` and
  `config.personal_token.sensitive: true`.
- Spotify declares `sensitiveData: ["creds", "client"]`.
- Stocks declares `sensitiveData: ["credentials"]`.
- Other manifests need no sensitive declarations.

Spotify's genuine public client ID does not itself grant access, but
`parseClientId()` accepts any 16–64 alphanumerics, including a pasted client
secret. `verifyClientId()` returns `unverified` while offline, and settings
still saves that input; versions 0.1.0–0.3.15 saved it without verification.
Existing stores can therefore contain client secrets. `client` must remain
declared sensitive.

GitHub retains the unused legacy `config.personal_token` definition and its
sensitive flag so users' existing config values remain covered by backups.
Current settings use a transient input and the `token` storage key. Search
and settings each initialize their own storage context; search reads persisted
tokens on each request so changes from another module instance are visible.

Users can paste a secret into arbitrary snippets, bookmarks, or todos. Their
ordinary content cannot be classified statically, and this contract explicitly
does not label general personal content as sensitive. Calendar meeting URLs
and link-preview URLs can also be capability links, but these extensions do
not persist them through extension-data storage or config. Host-owned caches
and other host data need the host's separate backup audit.
