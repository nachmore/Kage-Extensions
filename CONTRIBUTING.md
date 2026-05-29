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
npm run validate           # check every manifest under extensions/ and themes/
npm run build              # produce dist/ (catalog.json + per-id zips)
```

## Layout

```
extensions/
  <id>/
    manifest.json          (required)
    search.js              (optional)
    settings.js            (optional)
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
| `tags`        | Optional array of strings, used by the store search.                  |
| `permissions` | **Required for `type: extension`.** Use `[]` for none.                |
| `contributes` | What the extension provides — see `docs/EXTENSIONS.md` for the spec.  |

### Capabilities (permissions)

The user is asked to approve every capability listed in `permissions`
when they install. Anything not listed is silently dropped at runtime,
so be honest — over-asking dampens trust without helping you.

The full table lives in
[`extension-permissions.js`](https://github.com/nachmore/Kage/blob/main/ui/js/shared/extension-permissions.js)
and is mirrored in [`docs/EXTENSIONS.md`](https://github.com/nachmore/Kage/blob/main/docs/EXTENSIONS.md). The
validator in this repo enforces a known-set check: unknown capability
names fail CI before merge.

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

## OAuth-using extensions

Several extensions (Spotify, GitHub, etc.) need OAuth. Kage supports
**PKCE with a loopback listener** via the `oauth` capability — the
extension calls `start_oauth_loopback` on the host, gets back a one-shot
URL like `http://127.0.0.1:53212/callback`, opens the auth URL in the
user's browser, and receives the captured `code` directly.

For services that won't accept loopback redirect URIs there's a static
fallback page: `https://nachmore.github.io/Kage-Extensions/spotify-callback.html`
(and equivalents for other services on request — open a PR adding one).
The user pastes the code back into the extension's settings.

See `extensions/spotify` for a complete working example.

## Code style

- Two spaces, single quotes, semicolons.
- ES modules (`type: module` is set in `package.json`).
- No bundlers. Each file the host imports must run as-is.

## Need help?

File an issue with the `question` label or open a draft PR — feedback
on shape is welcome before you finish.
