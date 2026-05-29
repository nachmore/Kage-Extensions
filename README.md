# Kage-Extensions

The catalog of community extensions and themes for [Kage](https://github.com/nachmore/Kage).

Browse the live store at **<https://nachmore.github.io/Kage-Extensions/>**.

## What lives here

```
extensions/
  <id>/
    manifest.json    # required
    search.js        # optional — adds search-box results
    settings.js      # optional — settings page
    widget.js        # optional — persistent UI in a Kage slot
    tools.js         # optional — exposes tools to the LLM agent
    styles.css       # optional
    README.md        # optional — shown on the store detail page

themes/
  <id>/
    manifest.json
    dark.json        # color overrides for dark mode
    light.json       # color overrides for light mode
```

CI bundles every folder into a `.zip`, signs it with a SHA-256 checksum,
generates `catalog.json`, and publishes the whole thing to GitHub Pages
on every push to `main`.

## Add or update an extension

1. Fork this repo.
2. Add or modify a folder under `extensions/` or `themes/`.
3. Run the validator locally:
   ```
   npm install
   npm run validate
   ```
4. Open a PR. CI re-runs validation; merging triggers a rebuild + redeploy.

The manifest schema, capability list, sandbox rules, and contribution
points are documented in [`CONTRIBUTING.md`](CONTRIBUTING.md). For the
authoritative spec, see Kage's [`docs/EXTENSIONS.md`](https://github.com/nachmore/Kage/blob/main/docs/EXTENSIONS.md).

## Build the catalog locally

```
npm install
npm run build
```

Output lands in `dist/` (gitignored). The script detects unchanged
source folders and reuses the existing zip from a prior build — useful
when iterating on one extension out of many.

## How distribution works

- Catalog index → `https://nachmore.github.io/Kage-Extensions/catalog.json`
- Per-item detail → `…/detail/<id>.json`
- Installable bundle → `…/packages/<id>-<version>.zip`
- Web browser → `https://nachmore.github.io/Kage-Extensions/`

The Kage app reads the catalog URL on startup and on store-window
open. Versioned zip URLs are immutable; cache them aggressively. The
checksum sidecar (`<id>-<version>.zip.sha256`) is published next to
each zip for clients that want to verify integrity.
