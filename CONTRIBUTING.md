# Contributing to Kage-Extensions

Thanks for wanting to add or improve a Kage extension.

This file is the **store-side** view: how the catalog is published, what
checks CI runs, and what the manifest needs at minimum. The full
extension API (search providers, widgets, settings, tool providers,
etc.) lives in Kage's
[`docs/EXTENSIONS.md`](https://github.com/nachmore/Kage/blob/main/docs/EXTENSIONS.md) — read that
for everything an extension can actually *do*. The capability list and
sandbox model are spec'd there.

## Quick start

```bash
git clone https://github.com/nachmore/Kage-Extensions.git
cd Kage-Extensions
npm install
npm run check:all          # full CI gate (manifest schema + permissions + security + i18n + bundle + tests + defaults + versions)
npm run build              # produce dist/ (catalog.json + per-id zips)
```

### Running individual gates

| Script                     | What it checks                                                                                                                                                          |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `npm run validate`         | Manifest schema: required fields, semver, capability names, contributes paths exist, ID/folder match, length limits, no unknown top-level fields, ID-collision sweep.   |
| `npm run check:permissions`| Static analysis of `invoke('cmd', ...)` call sites cross-referenced with the host's `COMMAND_CAPABILITIES`. Errors on used-but-undeclared, warns on declared-but-unused. |
| `npm run check:security`   | Forbids dynamic code and remote scripts, flags HTML interpolation, and fails on undeclared sensitive storage keys or config fields (see [Sensitive data](#sensitive-data)). |
| `npm run check:i18n`       | Every `__MSG_*__` token in manifest + every `t('key')` call in code must resolve in `_locales/en/messages.json`. Non-EN catalogs flagged for empty / TODO strings.       |
| `npm run check:bundle`     | Forbids OS junk (`.DS_Store`, `Thumbs.db`), env files, `node_modules/`, sourcemaps, lock files, secrets. Per-file size cap 5MB; per-extension cap 10MB.                  |
| `npm run check:defaults`   | The copies of each setting's default agree (see [Settings defaults and `enabled`](#settings-defaults-and-enabled)): every settings control's `default`, the `DEFAULTS` in `defaults.js`, and literal code fallbacks (`config.x ?? 0`) must equal the manifest `config` default. Loads each settings provider in Node as a fresh install twice: on an older host, where the control default is what Settings shows and Save stores, and on a current one (`context.hostFeatures` with `config.manifest_defaults`), where Settings shows the manifest default and `normalize()` must leave it as it is. It sees only the page a fresh install gets, so controls that only a later state shows (spotify's connected page) aren't compared. Fails on a manifest that declares `enabled`, a settings control that holds a value with id `enabled` (found in those schemas, and by a static scan of the settings provider and the modules it imports), and code that reads a missing `enabled` (or a default-true boolean) as off. Controls whose id starts with `__` are inputs for action buttons, not config, and are skipped. Runs on every extension. |

### Affected-paths scoping (CI)

Heavy checks (`permissions`, `security`, `i18n`, `bundle`) only run on
extensions whose source files changed in the PR. Schema validation
runs against every manifest, every time. Locally `npm run check:*`
without arguments diffs against `origin/main`; pass `--all` to force
a full sweep.

This means a regression in extension X (say, a vendored library going
out of date) won't block a PR that only touches extension Y. The
trade-off is that "everything's fine after merge" is only guaranteed
for the extensions the PR touched — periodic full sweeps are run on
the host-capability-drift workflow.

### Hint comments for dynamic dispatch

The static analyzers can't follow indirection. If your code calls
`invoke(commandVar)` instead of `invoke('literal_command')`, or
`t(\`prefix.${id}\`)` instead of `t('literal.key')`, the checks miss
those usages and may report false positives. Two escape hatches:

```js
// permissions: clipboard, network
const cmd = pickCommand();
await this.invoke(cmd, args);

// i18n-keys: wmo.*
return this.t(`wmo.${code}`);
```

Both are comma-separated lists; `*` at the end of an i18n key makes
it a prefix glob (`wmo.*` whitelists every EN-catalog key starting
with `wmo.`).

## Layout

```
extensions/
  <id>/
    manifest.json          (required)
    search.js              (optional)
    settings.js            (optional)
    defaults.js            (optional, DEFAULTS for settings.js and code fallbacks)
    widget.js              (optional)
    tools.js               (optional)
    triggers.js            (optional)
    toolbar.js             (optional)
    styles.css             (optional)
    README.md              (optional, surfaced in the detail page)

themes/
  <id>/
    manifest.json
    dark.json
    light.json
```

The folder name **must equal** the manifest `id` for extensions. Themes
are slightly looser since theme ids conventionally end in `-theme`.

## Manifest minimum

```json
{
  "id": "my-thing",
  "name": "My Thing",
  "version": "1.2.3",
  "type": "extension",
  "description": "What it does in one line.",
  "icon": "🔧",
  "author": "you",
  "tags": ["productivity", "utility"],
  "permissions": [],
  "contributes": {}
}
```

| Field         | Notes                                                                 |
|---------------|-----------------------------------------------------------------------|
| `id`          | `^[a-z0-9][a-z0-9_-]{0,63}$`. Match folder name (extensions only).    |
| `name`        | Display name.                                                         |
| `version`     | Semver (`MAJOR.MINOR.PATCH`).                                         |
| `type`        | `"extension"`, `"theme"`, or `"commands"`.                            |
| `description` | One sentence. Shown in the catalog and Kage's settings.               |
| `icon`        | Emoji. Single character preferred.                                    |
| `author`      | Free-form.                                                            |
| `tags`        | Optional array of strings, used by the store search and to sort the extension into the web store's categories (`CATEGORIES` in `web/store-core.js`). |
| `permissions` | **Required for `type: extension`.** Use `[]` for none.                |
| `contributes` | What the extension provides — see `docs/EXTENSIONS.md` for the spec.  |

### Sensitive data

Declare every stored secret so Kage can label sensitive backup items. A backup
containing secrets must be encrypted with a password, or those items must be
left out. Older hosts ignore these manifest fields.

Use top-level `sensitiveData` for the **storage key** passed to
`save_extension_data`, `load_extension_data`, or `delete_extension_data`, without
the on-disk `.json` suffix. Each entry is an exact key or a nonempty prefix
ending in `*`, with at most 32 entries. Keys and glob prefixes use 1–128 ASCII
letters (either case), digits, `-`, `_`, or `.`, and cannot contain `..`. The
only wildcard is one final `*`; a bare `*` is invalid. Do not include `.json`
suffixes, duplicates, or overlapping entries. Repository checks match keys
**case-sensitively**, so `Token` does not declare `token`. The host's
case-insensitive safety net is deliberately more forgiving.

Mark a secret kept in settings with `config.<field>.sensitive: true`:

```json
{
  "sensitiveData": ["creds", "token_*", "connection"],
  "config": {
    "api_key": { "type": "string", "default": "", "sensitive": true },
    "calendar_url": { "type": "string", "default": "", "sensitive": true }
  }
}
```

Credentials, OAuth and refresh tokens, client secrets, API keys, passwords,
session cookies, and private capability URLs (including secret ICS addresses
and webhook URLs) are sensitive. Ordinary todos, bookmarks, snippets,
locations, and caches are personal data, but are not inherently secrets. Inspect
the values as well as the names: an innocuous key such as `connection` may hold
an OAuth token.

`check:security` parses every packaged JavaScript module without executing it
and fails on undeclared secret-bearing storage writes and config fields.
Storage keys use the host's conservative name heuristic
`/(token|secret|credential|creds|password|passwd|api[-_]?key|auth|oauth|session|cookie)/i`,
even when a particular payload is harmless. It also checks secret
property/variable names and capability URLs, including prefixed snake_case and
camelCase URL names. Flags, counts, limits and bounds (such as `hasApiKey` and
`tokenCount`) and bare plural `tokens` are not treated as secret values.
Settings value-control IDs are checked by name; only **text** control
**labels** are checked for secret input wording. Descriptions and select
labels cannot establish that a pasted secret will be stored.
It resolves `t()` labels, including aliases of `this.t`, through
`_locales/en/messages.json` and uses the host's supported control types
(`checkbox`, `text`, `number`, `select`, `range`, `action`, `info`); the host
does not provide a password input type or `secret`/`inputType` flags.
The Acorn parser follows lexical constants, object-member constants,
ternary alternatives, explicit local imports (including aliases), trailing
template/concatenation prefixes, and function/method/arrow storage wrappers
and wrapper chains. Every caller path is checked independently. A deferred
wrapper path is resolved only when every reference is a direct call whose
own path resolves; callbacks and escaped/indirect references fail that check.
Invoke commands must be literals or statically resolvable constants, including
when invoked through `.call`, `.apply` or `Reflect.apply`. Runtime command
construction with `.join`, `.replaceAll` or unresolved interpolation fails.
An unverified, user-supplied client identifier is a secret candidate: a pasted
client secret may pass format validation. Literal public identifiers are not
classified as secrets on that basis.

Unresolved keys/options, compound assignments, interior wildcard fragments,
and unresolved settings IDs/types/text labels or schema collections fail the
gate. Missing English translation keys fail too. Prefer literal keys, trailing
prefixes and visible settings arrays/objects, or annotate the storage/control
call (or its wrapper call) on the same line or the immediately preceding line:

```js
// Reviewed: every account record contains an access token.
// kage-sensitive-data: connection_*
await persist(makeAccountKey(account), record);

// Reviewed: this generated key stores only public exchange rates.
await persist(makeCacheKey(pair), rates); // kage-sensitive-data: not-sensitive
```

A key/prefix annotation requires the matching `sensitiveData` declaration.
It supplements every resolved key; it never replaces a known key.
`not-sensitive` permits an **unresolved** write after explicit review;
resolved keys still undergo name and value checks. For an unresolved settings
control/schema, a field annotation requires `config.<field>.sensitive: true`;
`not-sensitive` records a reviewed analysis gap. Resolved control names/labels
are still checked. Trailing punctuation such as `not-sensitive.` is accepted.
Every annotation, including an unattached annotation, produces a visible
`warn [sensitive-data-annotation]` with its file and line in CI output.
Annotations cannot bypass parse failures, unresolved invoke commands,
unassociated `save_extension_data` references, or missing relative modules.

Tests (`*.test.js`, `*.spec.js` and their `.mjs`/`.cjs` variants) are excluded
from ZIPs: their attack fixtures are development examples, not runtime code.
Production imports/re-exports of those files fail. All other packaged JS,
including `_locales/`, dot-directories and nested dependencies, undergoes both
sensitive-data and eval/remote-import checks. Every literal relative import,
including a dynamic import, must target an analyzed module.

This is a static gate, not complete data-flow or content inspection. Arbitrary
function results, fetched payloads with innocuous property names, indirect
object mutation, runtime-computed import URLs, and secrets embedded in strings
still need manual review. Ordinary cache values are not classified by their
contents, and this gate does not inspect host-owned search history/frecency
or result IDs. Named secret values and recognized OAuth exchange/await results
are checked, but an unknown API can still return secret material.
`__…` settings controls
are transient action inputs stripped by `normalize()`, so their eventual
storage writes need declarations rather than config flags. No extension or
storage-key allowlist is used. `action`/`info` controls cannot store config
input; transient `__…` IDs do not persist config. These host control semantics
are the only control exemptions. Status booleans such as `auth_revoked` and
coordination locks are not secret payloads.

Hosts advertising `export.sensitive_data` in `context.hostFeatures` understand
this backup contract. The host's name safety net also treats undeclared
secret-looking keys and fields as sensitive; it does not replace declarations.
See [the catalog audit](docs/sensitive-data-audit.md) for the current inventory.

### Capabilities (permissions)

The user is asked to approve every capability listed in `permissions`
when they install. Anything not listed is silently dropped at runtime,
so be honest — over-asking dampens trust without helping you.

The full table lives in
[`extension-permissions.js`](https://github.com/nachmore/Kage/blob/main/ui/js/shared/extension-permissions.js)
and is mirrored in [`docs/EXTENSIONS.md`](https://github.com/nachmore/Kage/blob/main/docs/EXTENSIONS.md). The
validator in this repo enforces a known-set check: unknown capability
names fail CI before merge.

### Mascot activity hints

Kage's mascot can react to what's going on. Your extension tells it
**what kind of thing** is happening — never who is doing it:

```js
// in initialize(context)
this._mascot = context.mascot;   // undefined on older hosts

// on every refresh cycle, while the state holds
this._mascot?.setActivity?.('music', { ttlMs: 45_000 });

// as soon as it stops
this._mascot?.clearActivity?.();
```

Four rules:

1. **The vocabulary is closed and generic.** `music`, `meeting`,
   `timer`. Spotify emits `music`, **not** `"spotify"` — the mascot
   deliberately knows nothing about individual extensions, so anything
   that plays audio sends the same hint. The list is vendored in
   [`scripts/host-capabilities.mjs`](scripts/host-capabilities.mjs)
   (`MASCOT_ACTIVITIES`); unknown names fail CI and are dropped at
   runtime.
2. **Declare what you emit** in the manifest, or the host rejects it:
   ```json
   "contributes": { "mascotActivities": ["music"] }
   ```
3. **It's a lease, not a switch.** The host clamps `ttlMs` to ~15s–10min
   and the activity *expires*. Re-assert it from your existing refresh
   cycle (widget poll, timer tick) while the state holds, with a TTL
   comfortably longer than that cycle — 3x the poll interval is a good
   default — so it never flickers between ticks. This is deliberate: a
   crashed, disabled or hidden extension can never pin the mascot.
4. **Always call it optionally.** `context.mascot` doesn't exist on
   older hosts, so `context.mascot?.setActivity?.(…)` — a missing API
   must never throw, and the extension must work unchanged without it.

Call `clearActivity()` on every path that *isn't* the active state,
including the ones where your widget renders nothing — otherwise a
stale hint lingers until the lease lapses. `extensions/spotify/widget.js`
(playing vs. paused) and `extensions/calendar/widget.js` (the few
minutes either side of a meeting start) are the reference
implementations; `makeContext({ mascot })` in
[`test-helpers/mock-context.mjs`](test-helpers/mock-context.mjs) mocks
the API, and `mascot: null` simulates a host that lacks it.

## Settings defaults and `enabled`

Declare every setting and its default in the manifest's `config` block.
That's the source of truth. Kage hosts that list
`config.manifest_defaults` in `context.hostFeatures` give your code the
manifest defaults overlaid with the user's saved values, show the
manifest default on the Settings page, and save only what the user
changed. See Kage's
[`docs/EXTENSIONS.md`](https://github.com/nachmore/Kage/blob/main/docs/EXTENSIONS.md)
(Config Schema).

Older hosts are still in use (users on stable and beta lag behind), and
an extension can't require a minimum host version. Those hosts show each
settings control's own `default`, give your code the saved config as it
is (so a key added after the user last saved is `undefined`), and on Save
replace the whole stored config with the controls on the page. Until the
minimum supported Kage includes `config.manifest_defaults`:

- Keep one `DEFAULTS` constant in the extension's `defaults.js` (see
  `extensions/hello-world/defaults.js`), and use it for every control
  `default` and every code fallback, never a literal:
  `(config.trigger || DEFAULTS.trigger)`, `config.flag ?? DEFAULTS.flag`.
  `npm run check:defaults` keeps it equal to the manifest. Its comment
  should say that it, the control defaults and the fallbacks can go once
  the minimum supported Kage includes `config.manifest_defaults`.
- If a page leaves some value controls out (a setup wizard), Save on an
  older host drops their stored values. Keep hidden copies of them there,
  and leave the copies out when `context.hostFeatures` includes
  `config.manifest_defaults` (see `extensions/spotify/settings.js`).

`enabled` belongs to the host: it's the Disable/Enable button in your
extension's Settings header, on every host. Don't add an "Enable"
checkbox (current hosts hide it; older ones show one that does nothing
unless your code reads it), and don't declare `enabled` in `config`.
Where code needs it, read `config.enabled !== false`: current hosts set
it from the header, and older ones pass on only what your own page saved
(usually nothing). `check:defaults` fails on all three. If your
extension used to have an "Enable" checkbox that your code read, an
older host still hands you whatever it saved. Keep honouring a saved
`false`: the user turned the extension off, and current hosts keep it
off for that value too. Nothing on the page shows that value any more,
so on older hosts (no `config.manifest_defaults` in
`context.hostFeatures`) say so in an `info` control, with how to clear
it: change any setting on the page and save, which stores only the
page's controls and so drops `enabled` (see
`extensions/link-preview/settings.js`).

## Internationalisation (i18n)

Every extension MUST ship `_locales/en/messages.json`. The Kage host's
i18n system loads it at sandbox start and exposes `context.i18n.t(key, vars)`
to your provider code; the manifest's `name` and `description` are
translated by referencing them as `__MSG_key__` tokens.

The full contract is in Kage's
[`docs/I18N.md`](https://github.com/nachmore/Kage/blob/main/docs/I18N.md);
the short version follows.

### Layout

```
extensions/<id>/
  manifest.json
  _locales/
    en/messages.json     (required, canonical)
    ja/messages.json     (optional, Kage's translate.py can seed these)
    de/messages.json
    ...
  search.js              (optional)
  settings.js            (optional)
  ...
```

### Manifest

Use `__MSG_key__` tokens for any user-visible field. The host resolves
them against the active language (with EN fallback) before showing the
manifest to the user.

```json
{
  "id": "my-thing",
  "name": "__MSG_manifest.name__",
  "description": "__MSG_manifest.description__"
}
```

### Catalog format

Same shape as Kage's host catalog — a wrapper around the Chrome
`_locales/<lang>/messages.json` convention with inline `{name}`
placeholders instead of `$placeholder$` indirection:

```json
{
  "_meta": {
    "language": "en",
    "name": "English",
    "rtl": false,
    "machine_translated": false
  },
  "manifest.name": {
    "message": "My Thing",
    "description": "Extension display name"
  },
  "result.no_data": {
    "message": "No data yet — set a {field} first",
    "description": "Shown when the user runs the command without configuring required field"
  }
}
```

### Provider code

```js
export default class MyProvider {
  initialize(context) {
    this.t = context.i18n.t;
  }

  match(query) {
    return [{
      label: this.t('result.label'),
      description: this.t('result.no_data', { field: 'home location' }),
    }];
  }
}
```

### Seeding more languages

Kage ships `python scripts/translate.py` (in the main repo) which calls
Claude to fill in `_locales/<lang>/messages.json` for each catalog under
`extensions/`. It's idempotent: re-running it only retranslates entries
whose source text has changed (tracked via `_source_hash`).

### CI

Kage's `python scripts/check_i18n.py` walks every extension under
`extensions/` and fails the build when:

- `_locales/en/messages.json` is missing.
- A non-EN catalog has a different key set than EN.
- A `__MSG_key__` token in the manifest references a key not in EN.
- A `t("...")` call in extension JS references a key not in EN.

CI in this repo doesn't run the host-side check directly, but Kage's
release CI does — a published extension with drift will be rejected at
ingest. Keep the catalogs in sync.

## Versioning

The published zip path includes the version (`packages/<id>-<version>.zip`),
so existing installs always resolve to a stable URL. Bump the manifest
`version` whenever you ship a behaviour change.

CI hashes each extension's source tree (sha256 over sorted file
contents). When the hash matches what the previous build published, the
existing zip is reused — no churn for unchanged extensions during
catalog rebuilds.

## What CI runs

| Trigger              | What happens                                                         |
|----------------------|----------------------------------------------------------------------|
| PR → `main`          | `npm run validate` (manifest schema, capability allow-list, paths)   |
| push → `main`        | Validate, rebuild changed zips, write catalog, deploy to gh-pages    |
| `workflow_dispatch`  | Same as push (handy for triggering a rebuild without a code change)  |

If validation fails, the PR is blocked. The error report lists every
problem at once — fix them in a single follow-up.

## Local testing against a Kage dev build

Until your extension is merged, point Kage at a local file server:

1. `npm run build` to produce `dist/`.
2. Serve `dist/` with `python3 -m http.server 8000` (or any static
   server).
3. In Kage, open Settings → Store → "Custom store URL" and enter
   `http://localhost:8000`. Loopback HTTP is allow-listed in Kage; any
   other host has to be HTTPS.

Open the store window — your extension should appear. Install,
exercise it, iterate.

## Adding a new theme

Themes are simpler — no JS, just colour overrides. Take an existing
theme as a template:

```bash
cp -r themes/nord themes/my-theme
$EDITOR themes/my-theme/manifest.json   # change id, name, version, icon
$EDITOR themes/my-theme/dark.json       # override the variables you want
$EDITOR themes/my-theme/light.json
```

Only override the variables you actually want to change. Everything
else falls back to the built-in defaults — see
[`shared-kage-tokens.css`](https://github.com/nachmore/Kage/blob/main/ui/css/shared-kage-tokens.css) for the
catalogue.

## MUST: your extension runs as multiple concurrent instances

Every Kage window that uses one of your contribution points (floating
bar, chat, settings, peer chat windows) hosts its **own sandbox with
its own copy of your modules**. There is no "the extension singleton".
This is the most common source of subtle production bugs, so treat the
following as requirements, not suggestions:

- **Module-level variables are per-window.** A cached token, an
  in-flight-promise single-flight guard, a "did I already migrate?"
  boolean — none of them exist in the other windows.
- **Instances race each other on shared side effects.** The canonical
  failure: two windows both see an expired OAuth access token and both
  refresh concurrently. Providers that rotate refresh tokens (Spotify,
  Google, Microsoft) may treat the loser's now-stale token as theft
  and **revoke the whole grant** — the user "keeps getting logged
  out" and nobody can reproduce it in a one-window dev setup.
- **The only cross-instance state is `extension-data`**
  (`save_extension_data` / `load_extension_data` /
  `delete_extension_data`). If two instances must agree, the agreement
  lives there — never in module scope.

Required patterns for non-idempotent side effects (token rotation,
one-shot migrations, write-behind caches):

1. **Re-read before failing**: on a credential error, reload stored
   state — a sibling instance may have already renewed it; retry with
   the stored value before surfacing "signed out".
2. **Serialize the side effect**: elect a leader instance, or take a
   TTL'd mutex through extension-data. Never assume your in-memory
   guard protects you.
3. **Read through for shared state**: anything another instance can
   change (auth status, credentials) must be re-read from
   extension-data, not trusted from a module cache.

`extensions/spotify/auth.js` is the reference implementation. The host
contract is documented in the Kage repo's `docs/EXTENSIONS.md`
("Your extension runs as MULTIPLE instances").

## OAuth-using extensions

Several extensions (Spotify, GitHub, etc.) need OAuth. Kage supports
**PKCE with a loopback listener** via the `oauth` capability — the
extension calls `start_oauth_loopback` on the host, gets back a one-shot
URL like `http://127.0.0.1:53212/callback`, opens the auth URL in the
user's browser, and receives the captured `code` directly.

For services that won't accept loopback redirect URIs there's a static
fallback page: `https://nachmore.github.io/Kage-Extensions/spotify-callback.html`
(and equivalents for other services on request — open a PR adding one,
and add the file to `WEB_FILES` in `web/stage.mjs` so it's published).
The user pastes the code back into the extension's settings.

See `extensions/spotify` for a complete working example.

## Code style

- Two spaces, single quotes, semicolons.
- ES modules (`type: module` is set in `package.json`).
- No bundlers. Each file the host imports must run as-is.

## Need help?

File an issue with the `question` label or open a draft PR — feedback
on shape is welcome before you finish.
