# The store page

The web store at <https://nachmore.github.io/Kage-Extensions/>. Plain HTML, CSS and JavaScript: no framework, no bundler, no web fonts, nothing loaded from another site. It follows the look of the [Kage site](https://nachmore.github.io/Kage/) (`site/` in the Kage repo).

```
web/
  index.html             the page; stage.mjs fills its <!--@…--> blocks
  style.css              everything visual (spotify-callback.html uses it too)
  store-core.js          pure logic: filters, categories, URL state, card and dialog markup
  app.js                 the browser side: catalog fetch, search, chips, detail dialog
  main.js                reveals, parallax, spotlights, menu, the cats
  demo.js                the launcher in the hero
  spotify-callback.html  the Spotify sign-in fallback page (see below)
  assets/                brand art copied from the Kage repo (ui/assets, icons) and its site
  stage.mjs              copies all of the above into a built catalog folder
  test/                  vitest suites (not published)
```

## How it's published

CI (`.github/workflows/build.yml`) builds the catalog into `dist/` and then runs `node web/stage.mjs dist`, which

1. writes `dist/store-extras.json`: for each item, a keyword to try (the manifest's `trigger` setting), what it contributes, whether its code makes web requests (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`; shown as **Online**), and a theme's dark and light colors;
2. writes `dist/index.html` with every card already rendered, using the same `store-core.js` functions the browser uses, so the catalog shows up before, and without, JavaScript;
3. copies the files in `WEB_FILES` and `assets/` next to it.

It only adds files. `catalog.json`, `detail/` and `packages/` are what Kage downloads; the staging script reads `catalog.json` and never writes any of them. Add a new top-level file to `WEB_FILES` in `stage.mjs`, or it won't be published (a test checks that every local `src`/`href` in the staged pages resolves).

## Preview locally

```bash
npm run build                  # the catalog, into dist/
node web/stage.mjs dist        # the page, into dist/ next to it
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Then open <http://127.0.0.1:8000/>. Keep `--bind 127.0.0.1` so the preview isn't reachable from other machines, and stop the server (Ctrl+C) when you're done. Opening `web/index.html` without staging also works, as long as a `catalog.json` is next to it: `app.js` renders the cards itself and the detail view reads each manifest from `detail/<id>.json`.

## URLs

- `?q=<search>`, `?cat=<category>` and `?ext=<id>` (the open detail view) are kept in the address bar, so a link reopens the same view.
- Cards have ids `ext-<id>`: `#ext-weather` scrolls to Weather's card, and with JavaScript a link to it inside the page opens its details instead.
- Install buttons are `kage://install/<id>` deep links; Kage registers the `kage:` scheme and shows its own install prompt.
- `spotify-callback.html` is the redirect URI people register in their own Spotify apps. Its address and its script must not change; restyle it only through its `<style>` block.

## Editing notes

- **Words.** Capability labels come from `scripts/host-capabilities.mjs` and the descriptions from Kage's install prompt (`ui/js/shared/extension-permissions.js`); a test fails if the labels drift. `EXAMPLES`, `ONLINE_NOTES` and `SETUP_PICKS` in `store-core.js` are hand-kept, and a test fails if they name an extension that doesn't exist.
- **Categories** come from tags, ids and names (`CATEGORIES` in `store-core.js`), plus **Agent tools** (a `toolProvider`) and **Online**. Tag a new extension sensibly and it sorts itself.
- **Escaping.** Every value from the catalog that reaches markup goes through `escapeHtml()`, links through `installUrl()`/`safeDownloadUrl()`, and theme colors through `safeColor()`/`safeGradient()` before they reach a `style` attribute.
- **Motion.** Animate `transform` and `opacity` only (reveals use the individual `translate`/`scale` properties so JS can own `transform` for parallax). Listeners are passive and only schedule a `requestAnimationFrame`. With `prefers-reduced-motion`, parallax, the cats' gaze and blinks, and the demo's typing are off, and the demo starts paused.
- **No JavaScript.** `.reveal` only hides things under `html.js`, and until `main.js` adds `reveal-ready` a CSS failsafe shows every `.reveal` after 2.5 s. The hero, the cards and the themes never use `.reveal`. Controls that need JavaScript carry `needs-js`.
- **Auto-advancing demo.** It has a pause button (WCAG 2.2.2) and stops while it's off screen or the tab is hidden.
- **Tests.** `npx vitest run web` runs the page's suites: `store-core` (logic and escaping), `stage` (extras, pre-render, what CI publishes) and `app` (the browser side, in jsdom).
