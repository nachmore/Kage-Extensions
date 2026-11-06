# The store page

The web store at <https://nachmore.github.io/Kage-Extensions/>. Plain HTML, CSS and JavaScript: no framework, no bundler, no web fonts, nothing loaded from another site. It follows the look of the [Kage site](https://nachmore.github.io/Kage/) (`site/` in the Kage repo).

```
web/
  index.html             the page; stage.mjs fills its <!--@…--> blocks
  style.css              everything visual (spotify-callback.html uses it too); stage.mjs fills its /*@theme-palettes*/ block
  store-core.js          pure logic: filters, categories, URL state, card and dialog markup, theme palette CSS
  boot.js                runs first: no-js → js, the OS, and which scripts failed to load
  app.js                 the browser side: catalog fetch, search, chips, detail dialog, Back/Forward
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
2. writes `dist/index.html` with every card already rendered, using the same `store-core.js` functions the browser uses, so the catalog shows up before, and without, JavaScript. The same extras go into the page as a JSON data block (`<script type="application/json" id="store-extras">`), and `app.js` filters with those, so a card's badges and the category counts can't disagree. (A page without the block fetches `store-extras.json`, and then renders every card itself.)
3. writes `dist/style.css` with one rule per theme, `.theme-card[data-id="<id>"] { --d-…; --l-…; }`, for its preview colors;
4. copies the files in `WEB_FILES` and `assets/` next to it.

It only writes those files, and only as regular files inside `dist/`. Everything is read and checked before anything is written; a symlink among the page's sources, or at or above any destination, fails the build instead of being followed; every destination folder must resolve inside `dist/`; and each file goes to a temporary file that's renamed into place, so a link (or a hard link) at a destination is replaced, never written through. `catalog.json`, `detail/`, `packages/` and `*.sha256` are what Kage downloads (and their checksums): the staging script reads `catalog.json` and refuses to write any of them. Add a new top-level file to `WEB_FILES` in `stage.mjs`, or it won't be published (a test checks that every local `src`/`href` in the staged pages resolves).

## Preview locally

```bash
npm run build                  # the catalog, into dist/
node web/stage.mjs dist        # the page, into dist/ next to it
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Then open <http://127.0.0.1:8000/>. Keep `--bind 127.0.0.1` so the preview isn't reachable from other machines, and stop the server (Ctrl+C) when you're done. Opening `web/index.html` without staging also works, as long as a `catalog.json` is next to it: `app.js` renders the cards itself and the detail view reads each manifest from `detail/<id>.json`.

## URLs

- `?q=<search>`, `?cat=<category>` and `?ext=<id>` (the open detail view) are kept in the address bar, so a link reopens the same view.
- History: typing in the search, the category chips and the reset buttons replace the current entry. Opening the detail view pushes one, so Back closes it and Forward opens it again; closing it yourself goes back off that entry (a detail view the page was opened on, from a shared link, has no entry of its own, so closing it replaces). Back and Forward restore the search, the category and the dialog from the entry, without writing to it.
- Cards have ids `ext-<id>`: `#ext-weather` scrolls to Weather's card, and with JavaScript a link to it inside the page opens its details instead.
- Install buttons are `kage://install/<id>` deep links; Kage registers the `kage:` scheme and shows its own install prompt.
- `spotify-callback.html` is the redirect URI people register in their own Spotify apps. Its address and its script must not change; restyle it only through its `<style>` block.

## Editing notes

- **Words.** Capability labels come from `scripts/host-capabilities.mjs` and the descriptions from Kage's install prompt (`ui/js/shared/extension-permissions.js`); a test fails if the labels drift. `EXAMPLES`, `ONLINE_NOTES` and `SETUP_PICKS` in `store-core.js` are hand-kept, and a test fails if they name an extension that doesn't exist.
- **Categories** come from tags, ids and names (`CATEGORIES` in `store-core.js`), plus **Agent tools** (a `toolProvider`) and **Online**. Tag a new extension sensibly and it sorts itself.
- **Escaping.** Every value from the catalog that reaches markup goes through `escapeHtml()`, links through `installUrl()`/`safeDownloadUrl()`, and theme colors through `safeColor()`/`safeGradient()` before they reach the stylesheet.
- **Content-Security-Policy.** The page works under `script-src 'self'; style-src 'self'`: no inline `<script>` (only the JSON data block, which isn't script), no `on…=` handlers, no `style` attributes and no `<style>`. Delays are classes (`.d-50` …), theme colors are in `style.css`, and script-set styles go through the CSSOM (`el.style.setProperty`), which a CSP allows. A test in `stage.test.mjs` keeps it that way.
- **Motion.** Animate `transform` and `opacity` only (reveals use the individual `translate`/`scale` properties so JS can own `transform` for parallax). Listeners are passive and only schedule a `requestAnimationFrame`. With `prefers-reduced-motion`, parallax, the cats' gaze and blinks, and the demo's typing are off, and the demo starts paused.
- **No JavaScript.** The page starts as `html.no-js`; `boot.js` (a file, not inline, so a CSP allows it) swaps it for `js` before the first paint. `.reveal` only hides things under `html.js`, and until `main.js` adds `reveal-ready` a CSS failsafe shows every `.reveal` after 2.5 s. The hero, the cards and the themes never use `.reveal`. Controls that need JavaScript carry `needs-js`. When a script fails to load, `boot.js` adds the class in its `data-fail-class` (`main-failed`, `demo-failed`, `store-failed`) and `style.css` drops what that script runs.
- **Auto-advancing demo.** It has a pause button (WCAG 2.2.2) and stops while it's off screen or the tab is hidden. Each run belongs to a generation: pausing, scrolling away or hiding the tab cancels the typing and every timer on the spot and shows that scene complete, and playing (or coming back) carries on from there.
- **Tests.** `npx vitest run web` runs the page's suites: `store-core` (logic and escaping), `stage` (extras, pre-render, CSP, what CI publishes and what it refuses to write), `app` (the browser side, history included, in jsdom) and `demo` (`demo.js` and `boot.js` in jsdom, on a fake clock).
