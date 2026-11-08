# Settings-only backup audit

Audited all 20 extension manifests and their `settings.js` controls against
Kage `3aedcc9`: `docs/EXTENSIONS.md`, `src/extensions.rs::config_field_decls`,
`src/config_export/allowlist.rs`, and `src/config_export/sensitive.rs`.
Every one of the 64 config fields already had an explicit `boolean`, `number`,
or `string` type; no type changes were needed. Defaults remain the same.

## Decisions

| Decision | Fields |
| --- | ---: |
| Include by boolean type | 33 |
| Include by number type | 8 |
| Include only declared enum choices | 5 |
| Include harmless free text with `backup: "plain"` | 13 |
| Exclude personal text or device paths (no opt-in) | 4 |
| Exclude credentials (`sensitive: true`, credential name) | 1 |
| Total | 64 |

"Include" means eligible, not guaranteed: the host requires installed
extension manifests for the id to agree, rejects sensitive declarations from
any installed item sharing the id, and checks actual saved values.
Extension data files never enter a settings-only backup.

## Host and validator contract

The host reads the exact `type`, `enum`, `backup`, and `sensitive` properties
directly from each manifest `config` entry. Types are `boolean`, `number`, or
`string`; a default's shape does not substitute for a declared type.
`sensitive` counts only when it is the boolean `true`. `backup` counts only
when it is exactly `"plain"`.

An enum must contain 1–64 primitive values. String choices have a limit of
128 UTF-8 bytes. The host tests enum membership before its boolean/number or
plain-string rule: an enum restricts eligibility even if `backup: "plain"` is
also present. The catalog validator additionally requires every enum choice
to match the explicitly declared type and numeric choices to be finite.
Objects, arrays, null choices, unsupported types, and malformed enum lists fail.
All five enums below match the choices offered by their settings providers.

The validator permits `backup` only as `"plain"` on an explicitly typed string
field. It rejects that opt-in when the field is credential-named, marked
`sensitive: true`, or covered by `sensitiveData`. For this backup check,
`sensitiveData` exact keys and prefixes match ASCII case-insensitively, like
the host; existing security checks still require case-sensitive declarations.
Credential names use the host's full safety net:

```js
/(token|secret|credential|creds|password|passwd|passphrase|passcode|api[-_\s]?key|license[-_]?key|account[-_]?key|private[-_]?key|access[-_]?key|auth|oauth|session|cookie|totp|otp[-_]?(secret|seed)|mnemonic|(^|[-_.])(pin|pass|pwd)$)/i
```

The host rejects credential-named fields whatever their declared type or enum,
host-owned `enabled` and `__…` scratch settings, undeclared fields, and nested
values. Accepted strings, including enum choices, still undergo the host's
secret scanner and 512-byte limit. Unsafe actual values are omitted and
reported to the user. These declarations describe intended preferences;
they cannot make arbitrary user-entered text safe.

## Every manifest config field

Each row names a field in `extensions/<extension>/manifest.json`; its UI was
reviewed in that extension's `settings.js`. Scalar decisions retain existing
types. Enum and plain-string decisions add metadata; each changed extension
receives a patch version bump.

| Extension | Field | Type | Decision | Reason |
| --- | --- | --- | --- | --- |
| bookmarks | `trigger` | string | Include: plain | Launcher trigger keyword; saved bookmark names and URLs are separate data. |
| calendar | `show_overlay` | boolean | Include: boolean | Meeting-banner visibility preference; no event contents. |
| calendar | `lookahead_hours` | number | Include: number | Number of hours to look ahead; no calendar identity or URL. |
| color-picker | `copy_format` | string | Include: enum | UI choices are `all`, `hex`, `rgb`, `hsl`; no saved color data. |
| currency | `default_source` | string | Include: plain | Free-text currency code used as the conversion default. |
| currency | `default_target` | string | Include: plain | Free-text destination currency code; no financial account information. |
| dev-tools | `uuid` | boolean | Include: boolean | Enable UUID generation; generated values are not this setting. |
| dev-tools | `base64` | boolean | Include: boolean | Enable Base64 conversion; no converted content. |
| dev-tools | `hash` | boolean | Include: boolean | Enable hashing; no input or hash history. |
| dev-tools | `epoch` | boolean | Include: boolean | Enable epoch conversion; no entered timestamps. |
| dev-tools | `json_format` | boolean | Include: boolean | Enable JSON formatting; no entered JSON. |
| dictionary | `trigger` | string | Include: plain | Launcher trigger keyword; not a saved search term. |
| dictionary | `language` | string | Include: enum | The UI's 31 language choices, including `auto`; no translation contents. |
| dictionary | `show_pronunciation` | boolean | Include: boolean | Display pronunciation preference. |
| dictionary | `show_examples` | boolean | Include: boolean | Display examples preference. |
| dictionary | `show_synonyms` | boolean | Include: boolean | Display synonyms preference. |
| emoji | `trigger` | string | Include: plain | Launcher trigger keyword. |
| emoji | `shortcode_trigger` | boolean | Include: boolean | Enable shortcode matching; no emoji usage history. |
| focus-tracker | `trigger` | string | Include: plain | Launcher trigger keyword; no activity names or history. |
| focus-tracker | `poll_interval` | number | Include: number | Polling interval preference; no tracked activity. |
| focus-tracker | `track_screen_time` | boolean | Include: boolean | Tracking toggle; recorded screen time remains in extension data. |
| focus-tracker | `track_switches` | boolean | Include: boolean | Tracking toggle; recorded window switches remain in extension data. |
| focus-tracker | `track_streaks` | boolean | Include: boolean | Tracking toggle; recorded streaks remain in extension data. |
| github | `trigger` | string | Include: plain | Launcher trigger keyword; no repository names or credentials. |
| github | `personal_token` | string | Exclude: credential | Existing `sensitive: true` and credential name; no plain opt-in or enum. |
| hello-world | `greeting` | string | Exclude: personal text | Arbitrary greeting can contain the user's name or a private message. |
| hello-world | `show_timestamp` | boolean | Include: boolean | Display timestamp preference; no saved message. |
| link-preview | `max_previews` | number | Include: number | Preview count limit; no visited URLs. |
| link-preview | `show_images` | boolean | Include: boolean | Image display preference; no cached images. |
| math | `precision` | number | Include: number | Rounding precision preference; no expressions or results. |
| math | `auto_copy` | boolean | Include: boolean | Clipboard behavior preference; no clipboard contents. |
| math | `thousands_separator` | boolean | Include: boolean | Number formatting preference. |
| password | `trigger` | string | Include: plain | Generator activation keyword; no generated password. |
| password | `default_length` | number | Include: number | Generated-password length preference; not a numeric credential. |
| password | `include_symbols` | boolean | Include: boolean | Generator character-class toggle. |
| password | `include_numbers` | boolean | Include: boolean | Generator character-class toggle. |
| password | `include_lowercase` | boolean | Include: boolean | Generator character-class toggle. |
| password | `include_uppercase` | boolean | Include: boolean | Generator character-class toggle. |
| password | `exclude_ambiguous` | boolean | Include: boolean | Generator readability preference. |
| snippets | `trigger` | string | Include: plain | Launcher trigger keyword; snippet names and bodies are separate data. |
| spotify | `show_now_playing_bar` | boolean | Include: boolean | Player-bar visibility preference; no listening history. |
| spotify | `refresh_seconds` | number | Include: number | Player refresh interval; no credentials. |
| spotify | `trigger` | string | Include: plain | Launcher trigger keyword; client identifiers and tokens are separate data. |
| stocks | `watchlist` | string | Exclude: personal text | User-selected tickers can disclose financial interests or holdings. |
| stocks | `refresh_seconds` | number | Include: number | Quote refresh interval; no credentials or symbols. |
| stocks | `show_watchlist` | boolean | Include: boolean | Widget visibility preference; not the watchlist itself. |
| stocks | `agent_tools` | boolean | Include: boolean | Extension feature toggle; host capability grants remain separately governed. |
| timer | `notify_on_complete` | boolean | Include: boolean | Completion notification preference; no timer labels or history. |
| timer | `sound_on_complete` | boolean | Include: boolean | Completion sound toggle. |
| timer | `sound_id` | string | Include: enum | UI choices: `two-tone`, `chime`, `alert`, `gentle`, `bell`, `success`, `custom`. |
| timer | `custom_sound_path` | string | Exclude: device path | Local filename can contain a username or personal folder; not portable. |
| timer | `sound_repeats` | number | Include: number | Sound repeat count preference. |
| timer | `show_window_on_complete` | boolean | Include: boolean | Completion window behavior preference. |
| todos | `default_category` | string | Include: plain | Default organizational category label, explicitly in this audit's safe-preference scope; no task text. |
| todos | `show_completed` | boolean | Include: boolean | Task display preference; no completed tasks. |
| todos | `confirm_delete` | boolean | Include: boolean | Deletion confirmation preference; no task contents. |
| todos | `sort_by` | string | Include: enum | UI choices: `created`, `due`, `priority`, `status`. |
| todos | `show_due_banner` | boolean | Include: boolean | Due-banner visibility preference; no reminders. |
| weather | `trigger` | string | Include: plain | Launcher trigger keyword. |
| weather | `home_location` | string | Exclude: personal text | User's home city or address; location is personal data even if public weather is fetched. |
| weather | `units` | string | Include: enum | UI choices: `metric`, `imperial`. |
| window-walker | `trigger` | string | Include: plain | Window-switching trigger, including its trailing activation delimiter. |
| window-walker | `show_icons` | boolean | Include: boolean | Window icon display preference; no application identities. |
| window-walker | `hide_minimized` | boolean | Include: boolean | Window filtering preference; no window titles. |

## Borderline decisions and non-config inputs

- `todos.default_category` is opted in as the requested default-category
  preference. A category could be personalized, so this is an intentional
  boundary: use generic category labels in settings-only backups. Task names,
  category assignments on tasks, and the task database never enter them.
- Stock symbols are public, but a user's chosen watchlist is personal
  financial data. It stays excluded. `stocks.__provider` is a scratch selector,
  not a manifest config field; provider selection and API keys live in
  `credentials` data and are excluded.
- `timer.sound_id: "custom"` is a harmless closed choice. The corresponding
  path is excluded, so restoring that choice cannot transfer the custom sound
  file or its path.
- The Hello World greeting is deliberately excluded rather than treated as a
  display preference: its unrestricted contents may be a name or private text.
- Triggers and currency codes are opted in for their intended keyword/code
  use, not arbitrary documents. Secret-looking actual values still fail the
  host's scanner.
- GitHub token inputs and Spotify client-ID/OAuth setup inputs use `__…`
  scratch controls and/or sensitive stored data, not new config declarations.
  No token, key, password, private URL, webhook URL, or ICS URL received
  `backup: "plain"`.
