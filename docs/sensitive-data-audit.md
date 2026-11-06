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
| password | None | `trigger`, `default_length`, `include_symbols`, `include_numbers`, `include_lowercase`, `include_uppercase`, `exclude_ambiguous` | No saved secrets | Generates passwords for display/copy; it does not persist generated passwords. Settings only describe generation preferences. |
| snippets | `snippets` | `trigger` | No | General user-authored text; the extension does not solicit credentials. |
| spotify | **`creds`**, **`client`**, `device`, `setup`, `status`, `refresh_lock` | `show_now_playing_bar`, `refresh_seconds`, `trigger` | **Yes:** `creds`, conservatively `client`. No: other keys/config. | `creds` contains access/refresh tokens. `client` currently contains only a public PKCE client ID; conservatively declared as requested authentication metadata. `device` is an ID/name, `setup` is wizard progress, `status` is a revocation flag/timestamp, and `refresh_lock` is an instance lease. |
| stocks | **`credentials`**, `request_budget`, `request_lock`, `quote_index`, `quote_*` | `provider`, `watchlist`, `refresh_seconds`, `show_watchlist`, `agent_tools` | **Yes:** `credentials`. No: other keys/config. | `credentials.api_key` holds the Finnhub API key. Other records are quotes/history, indexes, rate-limit/backoff state, and a short coordination lease. Must declare `sensitiveData: ["credentials"]`; this extension is maintained separately and was not edited in this audit. |
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
- Stocks requires `sensitiveData: ["credentials"]` from its owning change.
- Other manifests need no sensitive declarations.

Spotify's public client ID does not itself grant access. Its conservative
declaration follows the requested treatment of the non-obvious `client` key;
this is the one classification that is stricter than the access-granting test.
No client secret is persisted there.

Users can paste a secret into arbitrary snippets, bookmarks, or todos. Their
ordinary content cannot be classified statically, and this contract explicitly
does not label general personal content as sensitive. Calendar meeting URLs
and link-preview URLs can also be capability links, but these extensions do
not persist them through extension-data storage or config. Host-owned caches
and other host data need the host's separate backup audit.
