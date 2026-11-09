# Mind Map: architecture, interfaces, tests, work packages

Read [SPEC.md](./SPEC.md) first. It defines what to build, and this document
defines how. Section numbers like "SPEC §5" refer to SPEC.md.

Repos:
- **Extension** (all extension work): `Kage-Extensions`. Code goes in
  `extensions/mindmap/`.
- **Host** (WP-H only): `Kage`.

---

## 1. Constraints that shape the code

These are verified against host source. Breaking any of them causes runtime
failures that unit tests don't catch.

1. **The module loader handles one level of shared imports.**
   - The host finds relative imports with a regex, breadth-first, starting
     from the entry files (`ui/js/shared/extension-manager/sources.js`).
   - It then rewrites them in two passes (`registerSharedModules` in
     `ui/js/extension-sandbox/runtime.js`). A shared module that imports a
     *non-leaf* module points at a blob URL that has been revoked or never
     rewritten, so it fails to load.
   - The rule:
     - **Entries** (`search.js`, `tools.js`, `formatter.js`, `settings.js`,
       and the explorer's view module `explorer.js`) may import anything.
     - **Composers** (`mind.js`, `view.js`, `explorer-canvas.js`,
       `explorer-panel.js`) may import **only leaves**.
     - **Leaves** (`defaults.js`, `lib/*.js`) import **nothing**.
   - The explorer's window (Kage's extension views) loads its module and
     that module's imports with the same loader.
   - `host-loader.test.js` enforces this (§8). It is copied from
     `extensions/stocks/host-loader.test.js`.
2. **Specifiers resolve from the extension root.**
   - The host reads `filePath: rel.replace('./','')`, so specifiers are
     resolved from the extension root, not from the importing file. Only
     root-level files may import, and they use `./lib/x.js`.
   - The specifier string is the map key, so write it identically everywhere
     (`'./lib/text.js'`).
3. **Single-line, static imports only.**
   - Pass 2 only rewrites a module whose source matches
     `/import\s.*['"]\.{1,2}\//` on one line.
   - No dynamic `import()` and no re-exports (`export … from`).
   - Never write `import … from './…'` text inside comments: discovery would
     try to fetch it.
4. **Leaves get their dependencies injected.** A leaf that needs another
   leaf's functions takes a `lib` argument: the module namespaces
   `{ text, dates, url, entities, ids }`, built in `mind.js` with
   `import * as text from './lib/text.js'` and so on. Tests build the same bag.
5. **Every window has its own instance.**
   - Floating, chat, settings and peer chat windows each run a sandbox with
     their own copy of every module.
   - Within one sandbox, all providers share module singletons, because
     shared modules get one blob URL. So `getMind(context)` is a per-window
     singleton, keyed in a `WeakMap` on `context.invoke`, as in stocks'
     `getClient`.
   - The only cross-window state is extension-data (SPEC §7.4).
6. **Settings only loads its own provider.** The settings window loads only
   `settings.js` and what it imports, so `settings.js` must import `mind.js`
   directly.
7. **Widgets run in chat too.** v1 has no widget (SPEC §1). The map is
   rendered by the formatter.
8. **Formatter actions.**
   - Formatter `data-ext-action` clicks go to the search provider's
     `onResultAction(actionId, {resultId})`. The return value is ignored.
   - Repaint through `context.formatter.requestReformat()`. It is debounced
     100 ms and re-runs `format()` on up to 200 tracked messages, so
     `format()` must return `null` quickly for every message it doesn't
     change.
9. **Sanitizer.** Allowed tags, attributes and `data-ext-action` hosts are
   listed in SPEC §10.2. Other `data-*` attributes, `id`, inline `position`,
   and SVG `viewBox` are dropped.
   - Block elements inside `<p>` break when the host re-parses, so chips are
     inline `<button>`s.
   - Extension CSS is global. Prefix every class `mm-`.
   - Only `fixed` positioning and `z-index` above 10 are blocked; `absolute`
     is fine.
10. **Result actions the host handles** for extension rows: `copy`, `prompt`,
    `display`, `replace_input`, `refresh_widgets`, `open_extension_settings`.
    The `open_url` action in docs/EXTENSIONS.md is **not** handled
    (`ui/js/shared/result-executor.js`), so open links with
    `invoke('open_url', {url})` and return `null`.
11. **Invoke rate limit**: 100 per second per sandbox. Throttle to 70 on the
    client side (stocks `dataInvoke`).
12. **Static gates.**
    - `check:security`: storage keys must be literal or end in a wildcard at
      the call site, and the twin key is the *prefix* `nx-${key}`.
    - `check:permissions`: invoke commands must be literals, or go through a
      wrapper with a `// permissions:` hint (stocks pattern).
    - `check:i18n`: every `t('key')` must exist in the EN catalog.
    - `check:defaults`: manifest `config` = `DEFAULTS` = each settings
      control's `default`.
    - `check:tests`: at least one test.
13. **Tests run in Node** (vitest, `environment: 'node'`). Formatter and view
    tests opt into jsdom with `// @vitest-environment jsdom`. Use
    `vi.useFakeTimers({ toFake: ['Date'] })` plus `vi.setSystemTime()` to pin
    the clock, so the store's `setTimeout` throttling still runs.

---

## 2. File layout and ownership

```
extensions/mindmap/
  manifest.json                WP-D
  README.md                    WP-D
  defaults.js                  WP-D   leaf      DEFAULTS, LIMITS
  mind.js                      WP-D   composer  per-window facade: data, mutations, agent records, prompts
  view.js                      WP-C   composer  HTML, labels, formatter core, UI state (imports ./lib/graph.js and ./lib/filetext.js)
  search.js                    WP-D   entry     searchProvider
  tools.js                     WP-D   entry     toolProvider
  formatter.js                 WP-D   entry     thin messageFormatter wrapper around view.formatHtml
  settings.js                  WP-D   entry     settingsProvider
  styles.css                   WP-C
  explorer.js                  WP-V8  entry     the explorer's view module (contributes.views "explorer")
  explorer-canvas.js           WP-V8  composer  Canvas 2D renderer, hit tests, pointer/wheel input → intents
  explorer-panel.js            WP-V8  composer  DOM: toolbar, search, lenses, details panel, node list, toast
  explorer.css                 WP-V8            ex- classes, injected into the explorer's window only
  _locales/en/messages.json    WP-D   (merges WP-C's fragment)
  lib/ids.js                   WP-A   leaf
  lib/text.js                  WP-A   leaf
  lib/dates.js                 WP-A   leaf
  lib/url.js                   WP-A   leaf
  lib/entities.js              WP-A   leaf (lib-injected)
  lib/extract.js               WP-A   leaf (lib-injected)
  lib/query.js                 WP-A   leaf (lib-injected)
  lib/store.js                 WP-B   leaf
  lib/model.js                 WP-B   leaf      (FT-MM2: picked documents, bodies)
  lib/journal.js               WP-B   leaf
  lib/bm25.js                  WP-B   leaf
  lib/rank.js                  WP-B   leaf
  lib/graph.js                 WP-C   leaf
  lib/camera.js                WP-V8  leaf      pan/zoom maths (pure)
  lib/spatial.js               WP-V8  leaf      uniform grid: culling and hit tests
  lib/layout.js                WP-V8  leaf      relax(): force pass for runSandboxed (self-contained)
  lib/scene.js                 WP-V8  leaf      what the explorer draws: nodes, edges, seeds, expand
  lib/files.js                 FT-MM1 leaf (lib-injected) documents from Kage's file_text: checks, dedupe, title, keyphrases, passages
  lib/filetext.js              FT-MM3 leaf      the words for a picked document (size, outcome, errors) through an injected t
  lib/organize.js              AC-MM1 leaf (lib-injected) background organizing: eligibility, batch, payload, request, reply schema, org marks
  lib/syncmap.js               S7     leaf      Kage folder sync: state ↔ collection records, sync ids, local fields, what may leave, batches
  lib/*.test.js                owner of the module under test
  view.test.js, styles.test.js WP-C
  host-loader.test.js, mind.test.js, search.test.js, tools.test.js,
  formatter.test.js, settings.test.js, acceptance.test.js       WP-D
  explorer*.test.js            WP-V8
test-helpers/mindmap/memory-host.mjs   WP-B   in-memory invoke (data commands + pluggable handlers)
test-helpers/mindmap/view-host.mjs     WP-V8  fake view host: change events, context.view, canvas stub, frames
test-helpers/mindmap/file-host.mjs     FT-MM3 fake context.files (support, pickText) and §3.6-shaped results
test-helpers/mindmap/agent-host.mjs    AC-MM3 fake context.agent (complete, status) shared by windows: gates, dedupe, turns, framing, schema
test-helpers/mindmap/sync-host.mjs     S7     fake context.sync: a sync folder, computers with their own replica, base and cursor, the §12.2 cell rules
test-helpers/mindmap/corpus.mjs        WP-D   SPEC §3.1 fixture corpus builder
docs/mindmap/i18n/view.en.json         WP-C   i18n fragment, same format as messages.json; WP-D merges it, then deletes it
```

Shared test helpers live under the repo's `test-helpers/`, not in the
extension, so they are neither packaged nor security-scanned.

---

## 3. Dependency graph

```
            search.js ─┐   tools.js ─┐   formatter.js ─┐   settings.js ─┐     (entries)
                       │             │                 │                │
                       ├────────────►│◄────────────────┤◄───────────────┤
                       ▼             ▼                 ▼                ▼
                     mind.js  (composer)                          view.js (composer)
     ┌──────┬──────┬───┴──┬────────┬────────┬───────┬──────┬──────┐       │
     ▼      ▼      ▼      ▼        ▼        ▼       ▼      ▼      ▼       ▼
 defaults ids    text   dates     url   entities extract query  store   graph
                                                  model journal bm25 rank graph      (all leaves; no imports)
```

- `search.js` imports `mind.js`, `view.js`, `defaults.js`.
- `formatter.js` imports `mind.js`, `view.js`.
- `tools.js` and `settings.js` import `mind.js`, `defaults.js`.
- `mind.js` imports every `lib/*.js` and `defaults.js`, but never `view.js`.
- `view.js` imports only `./lib/graph.js`.
- `explorer.js` imports `mind.js`, `view.js`, `explorer-canvas.js`,
  `explorer-panel.js`, `lib/scene.js`, `lib/layout.js`, `lib/camera.js` and
  `defaults.js`. It hands `view.js`'s labels to the panel and the canvas,
  which can't import a composer.
- `explorer-canvas.js` imports only `./lib/camera.js` and `./lib/spatial.js`;
  `explorer-panel.js` imports nothing.

Logical dependencies between leaves (through `lib` injection, not imports):
- `entities` uses `text`.
- `extract` uses `text`, `dates`, `url`, `entities`.
- `query` uses `text`, `dates`, `entities`.
- `files` uses `text`.
- `organize` uses `text`, `dates`, `url`.

---

## 4. Shared conventions

- **Purity.** Leaves are pure, except `store.js` (I/O) and `ids.js` (random).
  Nothing reads `Date.now()` implicitly: time comes in as `now`. Leaves never
  call `context.*`.
- **Errors.** Leaves return codes, not text: `{code:'quote_not_found'}`,
  `StoreError('busy')`. Entries translate them with `t()`.
- **i18n.** Only `view.js` and the entries call `t`, and they receive it as
  `ctx.t`. Leaves are language-neutral apart from their English lexicons,
  which are exported constants so other locales can be added later.
- **Records are plain JSON objects.** Maps and Sets appear only in the
  in-memory `State` and the indexes.
- **Time.** All timestamps are ms epoch. "Day" means the start of the local
  calendar day. Week math uses `weekStart` 0–6 (0 = Sunday).
- **Ids.** See `lib/ids.js`. Never build ids from user text.
- **Logging.** `context.log.*` only, in English, with no user text (ids and
  counts only).
- **Style.** Two spaces, single quotes, semicolons, ES modules, no bundler
  (CONTRIBUTING.md).
- **Explorer DOM.** Built with `createElement` and `textContent`, never from
  HTML strings. Its CSS (`explorer.css`) uses `ex-` classes and Kage tokens
  only; `styles.css` keeps `mm-` for the host windows.

---

## 5. Module interfaces

Signatures are JS. `?` marks an optional value. Types are defined in §6.

### 5.1 `lib/ids.js` (WP-A)

```js
export const ID_RE;                 // /^(?:[ieo][0-9a-z]{14}|me)$/
export function newId(prefix, now = Date.now(), rand = (a) => crypto.getRandomValues(a)); // 'i'|'e'|'o' + 9 base36 time + 5 base36 random
export function idTime(id);         // ms | null
export function isItemId(s); export function isEntityId(s); export function isOpId(s);
export function cite(id);           // '[mm:' + id + ']'
export const CITE_RE;               // /\[mm:([ie][0-9a-z]{14}|me)\]/g   (global — reset lastIndex)
export const CARD_RE;               // /\[mm-card:(op|item|map|help)(?::(o|me|[ieo][0-9a-z]{14}))?\]/g
export function stripCite(s);       // '[mm:x]' | 'mm:x' | 'x' → 'x' when valid, else null
export function createIdPool(rand?); // { next(prefix, now): id, reset(): void } — reset() replays the same ids
```

### 5.2 `lib/text.js` (WP-A)

```js
export const STOPWORDS;            // Set<string> (English, lowercase)
export const ACRONYM_STOPLIST;     // Set<string> (uppercase), SPEC §5 S4
export function normalizeKey(s);   // NFKD, strip marks, lowercase, 'M.T.C.S.'→'mtcs', strip punctuation, collapse spaces
export function scanWords(s);      // [{raw, norm, start, end, caps, acronym}] — Intl.Segmenter('und',{granularity:'word'}) with regex fallback
export function stem(norm);        // s-stemmer: len≥5; ies→y; (s|x|z|ch|sh)es→stem; s→'' unless ss|us|is|ous
export function tokenize(s, { stop = false, stemming = true } = {}); // string[]; folds acronyms, plurals (MTCSs→mtcs) and possessives
export function splitLines(s);     // [{text, start, bullet: null|'dash'|'star'|'dot'|'num'|'box'|'boxdone', indent}]
export function splitSentences(s); // [{text, start, end}]
export function rake(text, { max = 5, idf = () => 1 } = {}); // [{phrase, score}]
export function snippet(text, terms, { max = 200 } = {});    // window around the first stemmed-term hit, with ellipses
export function firstLine(s, max = 80);
export function truncate(s, n);
export function collapseWs(s);
export function containsQuote(haystack, quote); // whitespace-normalized, case-insensitive substring
export function escapeHtml(s);
export function escapeMd(s);       // escape Markdown and remove < >
export function cleanWindowTitle(title, app); // strips " - Word", " — Google Docs", " - Microsoft Edge", "• Unsaved", etc.
```

### 5.3 `lib/dates.js` (WP-A)

```js
export function resolveWeekStart(setting, language);  // 'auto'|'mon'|'sun'|'sat' → 0..6
export function startOfDay(ms); export function addDays(ms, n); export function startOfWeek(ms, weekStart);
export function startOfMonth(ms); export function addMonths(ms, n); export function startOfQuarter(ms); export function startOfYear(ms);
export function parseRange(text, { now, weekStart }); // Range | null — first temporal expression, SPEC §8.3
export function parseDue(text, { now, weekStart });   // { at, span:[i,j], code } | null — SPEC §8.3
export function toIsoDay(ms);    // 'YYYY-MM-DD' (local)
export function parseIsoDay(s);  // ms (local start of day) | null
export function utcMonthKey(ms); // 'YYYY-MM' (UTC) — shard key
export const MONTHS;             // English month-name lexicon (for later locales)
export const WEEKDAYS;
```

### 5.4 `lib/url.js` (WP-A)

```js
export function findUrls(text);    // [{url, start, end}] http(s) and bare www., trailing punctuation trimmed, balanced parens
export function canonicalUrl(url); // scheme-less dedup key (SPEC §5 S3) | null
export function isDocUrl(url);     // SPEC F-CAP-5
export function urlHost(url);      // lowercase host without www. | null
export function urlTitleGuess(url);// 'example.com › mtcs-intro'
export function findPaths(text);   // [{path, start, end, style:'posix'|'home'|'win'|'unc'|'fileurl'}]
export function normalizePath(p);
export function baseName(p);
export function isDocPath(p);      // has a document extension, or a directory path
```

### 5.5 `lib/entities.js` (WP-A, uses `lib.text`)

```js
export function buildDictionary(entries, lib);        // entries: [{entityId, type, names: string[]}] → Dict
export function scanDictionary(dict, words);          // words = text.scanWords(...) → [{entityId, type, start, end}] longest match, no overlaps
export function explicitMentions(text, lib);          // [{type, name, key, start, end, marker:'#'|'@'|'team'|'project'|'email'}]
export function implicitCandidates(text, lib, { stoplist } = {}); // [{key, display, type:'term'|'person', start, end}]
export function ownerCue(segment, lib);               // {name, key, start, end} | null  ("<Name> to/will <verb>", "@x to/will")
export function learnAliases(text, lib);              // [{long, longKey, short, shortKey}]
export function bumpCandidates(candidates, found, itemId, now, { threshold = 2, rejected = new Set() } = {});
                                                      // mutates Map<key, Candidate>; idempotent per (key, itemId); returns {promote:[{key, display, type, itemIds}]}
export function parseNameList(setting);               // 'Alex, AL, alex@example.com' → ['Alex','AL','alex@example.com']
export const TEAM_STOP;                               // the stop words of SPEC §5 S4
```

### 5.6 `lib/extract.js` (WP-A, uses `lib.text/dates/url/entities`)

```js
export const EXTRACTOR_VERSION;   // 1
export const IMPERATIVE_VERBS;    // Set<string>, SPEC §5 S5
export const ACTION_HEADING_RE;
export function extract(input, env);  // → Extraction (§6.1). Pure; deterministic; ≤15 ms for 4 KB
//   input = { text, via, source?: {app?, window?}, hint?: {kind?, title?, url?, path?, summary?, terms?, private?, actions?: [{text, quote, owner?, due?}]} }
//   env   = { lib, now, weekStart, dict, myNames: string[], autoAccept: boolean, maxText = 8000, maxChildren = 50 }
export function previewOf(extraction); // → Preview (§6.1)
```

`extract()` covers SPEC §5 S0–S7. With `input.hint.actions` (agent capture),
each action's `quote` is checked with `lib.text.containsQuote`. A failure goes
to `extraction.rejectedActions` with `{text, reason:'quote_not_found'}`.

### 5.7 `lib/query.js` (WP-A, uses `lib.text/dates/entities`)

```js
export const COMMANDS;           // {map, actions, todos→actions, tasks→actions, review, recent, undo, help, organize, merge, forget, rename}
export const KIND_WORDS; export const FILLER; export const STATUS_WORDS; // lexicons (SPEC §8.1)
export function parseQuery(input, env);   // → QuerySpec (§6.4)
//   env = { lib, now, weekStart, resolveEntity(phrase, typeHint) → {entityId, name, type} | null, dict, trailingSpace: boolean }
export function toSyntax(spec, { nameOf }); // canonical filter syntax for "Enter to refine"
```

### 5.8 `lib/store.js` (WP-B)

Mirrors `extensions/stocks/client.js` (`dataInvoke`, `read`, `indexLease`). The
first line is the `// permissions: storage — commands are routed through dataInvoke.`
hint.

```js
export class StoreError extends Error { constructor(code, detail) }  // code: 'io'|'unreadable'|'busy'|'readonly'|'conflict'
export class Store {
  constructor({ invoke, atomic = false, owner, maxPerSecond = 70, sleep, now });
  async dataInvoke(command, args);       // throttled; retries "invoke rate limit exceeded" twice; else throws StoreError('io')
  async readJson(key);                   // object | null (missing); throws StoreError('unreadable') when not a JSON object
  async readBest(key);                   // { value, from:'primary'|'twin'|null, unreadable:boolean } — SPEC §7.3
  async write(key, value);               // value.rev is a number; twin `nx-${key}` first unless atomic
  async remove(key);                     // deletes key and `nx-${key}`
  async withLock(fn, { ttlMs = 4000, waitMs = 3000 } = {}); // fn(lease) — lease.check() throws StoreError('busy'); lease.renew()
  get stats();                           // { invokes, retries } for tests and logging
}
```

The lock key `'mm-lock'` is a literal inside `store.js`. Callers pass data keys
as literals or templates (`'mm-meta'`, `` `mm-items-${ym}` ``) at the call site
in `mind.js`. If `check:security` can't resolve the wrapper chain, annotate the
three raw `save/load/delete_extension_data` lines with
`// kage-sensitive-data: not-sensitive` and a one-line review note (SPEC §15).

### 5.9 `lib/model.js` (WP-B)

`State` is in-memory and mutable. Every `apply*` mutates `state` in place and
records undo data in a journal op (`lib/journal.js` functions are passed in
`env.journal`, since leaves can't import). `applyX` must be **idempotent when
re-run on freshly reloaded state with the same `env.newId` pool** (SPEC §7.4).

```js
export const SCHEMA;              // 1
export function emptyState(now);  // State
export function shardOf(item);    // 'YYYY-MM' (UTC month of createdAt)
export function fromPersisted(parts, { now }); // { state, problems:[{part, code}] }
//   parts = { meta, shards: {[ym]: payload}, entities, links, journal }  (payloads may be null)
export function payloadFor(state, part);       // part: 'items:YYYY-MM'|'entities'|'links'|'journal' → persisted object (without rev/txn)
export function migrate(payload, part);        // returns payload, or throws {code:'future_schema'}
export function findDuplicate(state, extraction);     // itemId | null (canonicalUrl, normalized path, docKey)
export function entityByKey(state, key, type?);       // Entity | null (follows mergedInto)
export function applyCapture(state, extraction, env); // Change — creates parent + children + new entities; or merges into a duplicate
export function applyPromotions(state, change, promote, env); // creates promoted entities, links them on change items
export function applyBackfill(state, change, entityId, itemIds, env); // adds a mention to earlier items (recorded in the same op)
export function applyStatus(state, itemId, status, env);      // 'open'|'done'|'dismissed'
export function applyAccept(state, itemId, env);              // suggested → false
export function applyEdit(state, itemId, patch, env);         // {title?, kind?, private?, pinned?, archived?}, origin user
export function applyDelete(state, itemIds, env);             // children deleted with their parent
export function applyEnrichLink(state, itemId, meta, env);    // {title, description} — the title only while titleSource==='auto'; silent op
export function applyReextract(state, itemId, extraction, env); // rule-origin fields only (enrich, P2 re-derivation)
export function applyAnnotate(state, entries, env);           // P1 → Change & {applied, rejected}
export function applyMerge(state, fromId, intoId, env);       // P2
export function applyForget(state, entityId, env);            // P2 (adds a Rejection)
export function applyRename(state, entityId, name, key, env); // P2
export function applyImport(state, data, env);                // P2
//   env = { now, newId(prefix), journal: {newOp, snapshotBefore, noteCreated, sealOp}, opKind?, label?, via?, source?, dev? }
//   dev: this computer's machine tag (16 hex); every new item gets source.dev from it.
```

`Change = { op, touched: Set<part>, itemId?, childIds?, newEntityIds?, dedupedInto?, result? }`.
The caller (mind) persists each part in `touched`, plus `'journal'` and
`'meta'`.

Documents the user picks (WP-FT-MM2, Kage's EXTENSION_FILE_TEXT §11.4–11.8).
`ingest = { file, extraction?, title?, titleSource?, keyphrases?, private? }`,
where `file` is `lib/files.js` `validateFileText`'s `file`, `extraction` is
`extract()` of the first 8,000 characters without a kind hint, and `title`
and `keyphrases` come from `docTitle` and `bodyKeyphrases`. The caller picks
the function with `dedupeDecision` on the state it holds under the lock.

```js
export const BODY_SCHEMA;                                  // 1
export function applyIngest(state, ingest, env);           // case N → Change & { itemId, childIds, pendingAliases, bodies, result }
export function applyReread(state, itemId, ingest, env);   // case U → Change & { itemId, childIds, removedIds, pendingAliases, bodies, result }
export function applyAddRef(state, itemId, fileRef, env);  // case C → silent op ('enrich', label 'file_ref')
//   bodies = [{ key, value }]: write them before the shard (once; hosts with files.pick_text are atomic).
//   result = { rejectedActions, droppedDone, truncated, private, secret }.
//   Refusals: 'bad_file', 'not_file', 'storage_full' (env.bodyBudget, default LIMITS.bodyBytes = 64 MiB).
export function bodyKey(id, n);                  // 'mm-body-<id>-<n>'
export function parseBodyKey(key);               // { id, n } | null
export function normalizeBody(raw, key);         // { schema, id, rev, format, chars, text, pageStarts? } | null
export function bodyKeys(state);                 // Set: keys items, kept-aside records and undo snapshots reference
export function bodyBytes(state, { except });    // UTF-8 bytes of those bodies' text (meta.counts.bodyBytes)
export function releasedBodies(held, state);     // keys in held that state no longer references, sorted
```

Bodies are written and deleted by the caller: under the lock, take
`held = bodyKeys(state)` after the sync and before apply, write
`change.bodies`, then the parts, journal and meta, and once the meta check
passes delete `releasedBodies(held, state)`. That one rule covers undo of an
ingest or re-read, a delete whose op left the journal (200 ops / 256 KB),
and an op `appendOp` made lossy.

Background organizing (WP-AC-MM2, Kage's EXTENSION_AGENT_CALLS §11.5). The
caller passes `lib/organize.js` results; `mind.js` (AC-MM3) calls these.

```js
export const ORG_STATES;                          // ['done', 'skipped', 'failed']
export function normalizeOrg(raw);                // Item.org in canonical form | null (dropped whole when malformed)
export function applyOrgMarks(state, marks, env); // marks = [{ id, org }] → Change & { marked, skipped }
//   One silent 'enrich' op (label 'org_mark') without snapshots; it records the revs it left. Refusal: 'noop'.
export function applyOrgSince(state, since, env); // meta.orgSince → Change & { orgSince }; a silent op with no records
//   Refusals: 'bad_org' (not a time), 'same'.
//   applyAnnotate env, besides autoAccept:
//     maxNewEntitiesPerItem  new entities per entry, names and owners together ('entity_cap')
//     via: 'background'      silent op with op.via 'background'; suggestions only, source.via 'background';
//                            no kind changes; private names never linked or made ('private_entity');
//                            a link's pending or failed title fetch stays.
```

In one `_mutate`, write the marks before the batch's `applyAnnotate`, so
undoing the annotate op brings the note back with its mark.

Kage folder sync (WP-S7, SYNC §12.9, SPEC §7.8):

```js
export function applyRemote(state, remote, env);  // a pull's changes → Change & { remote: true, unjournaled, ids, bodies, dedupe, counts }
//   remote = { items, entities, links, rejections, bodies }: Map<id, value | null> (null: deleted there).
//   Item and entity values carry this computer's local fields (lib/syncmap.js withLocal); a changed record
//   gets rev = local.rev + 1. Bodies are lib/syncmap.js bodyFromRecord's { key, value }, written by the
//   caller first; one older than the item's own key is skipped.
//   A silent op of kind 'sync', no snapshots: op.after holds only records an earlier op could still undo,
//   it replaces the previous sync op when that is the newest, and it isn't journaled when that's empty.
//   Then the dedupe: entities with the same (type, key) and no mergedInto → the larger id gets
//   mergedInto the smaller (updatedAt kept); change.dedupe lists them (the only part to push).
//   env.syncPrivate === false leaves local private items and names alone; env.relationId = syncmap.relationId.
//   Refusal: 'noop'.
```

`meta` also carries this computer's sync bookkeeping (normalized here, never
synced): `syncPending` (collection → id → `'p:<opId>'` or `'d:<opId>'`),
`syncFull` (`{ mode: 'initial'|'all', next, by?, at }`) and `syncTag` (the
device tag whose first push is done).

### 5.10 `lib/journal.js` (WP-B)

```js
export function newOp({ opId, kind, at, label, silent });
export function snapshotBefore(op, type, record);  // type: 'items'|'entities'|'links'|'rejections'; first snapshot per id wins
export function noteCreated(op, type, id);
export function sealOp(op, state);                 // records op.after = {[id]: rev} for every touched or created record
export function canUndo(state, op);                // {ok:true} | {ok:false, code:'superseded'|'already_undone'|'missing'}
export function applyUndo(state, op, env);         // Change (kind 'undo'); restores before, deletes created, sets op.undoneBy
export function appendOp(ops, op, { maxOps = 200, maxBytes = 262144 } = {}); // new trimmed array (oldest first out)
export function lastUndoable(ops);                 // newest op with !silent && !undoneBy && kind !== 'undo'
```

Children that later silent ops gave an item the op created (background
organizing's suggestions on a new note) go with it on undo; one the user
changed since makes the undo `superseded` (AC-MM3).

A `sync` op (another computer's change, S7) is silent for `mm undo` but a
real change for `canUndo`: an earlier op whose record it touched is
`superseded`, even when later silent ops touched the record too. A sync op
itself is never undone (`missing`).

### 5.11 `lib/bm25.js` (WP-B)

```js
export const DEFAULT_FIELDS; // { title: 2.0, kp: 1.5, ent: 1.5, sum: 1.2, body: 1.0, host: 0.5 }
export function createIndex({ fields = DEFAULT_FIELDS, k1 = 1.2, b = 0.75 } = {});
//  .add(id, fieldTokens)      fieldTokens: {[field]: string[]}; replaces an existing doc
//  .remove(id) .has(id) .size
//  .df(term) .idf(term) .postings(term) → Set<id>
//  .fieldTerms(id, field) → Set<string>
//  .search(terms, { filter, limit = 50 }) → [{id, score, hits: string[]}]   terms: [{t, w = 1, prefix?, neg?}]; neg excludes
//  .similar(id, { limit = 5, minRatio = 0.25, filter }) → [{id, score}]
//  .vocabPrefix(prefix, { limit = 20 }) → string[] by df desc
```

BM25F: per-field tf weighted by the field weight, a single length
normalization per field, and idf `ln(1 + (N − df + 0.5)/(df + 0.5))`. Updates
are incremental. 10k docs must build in ≤250 ms.

### 5.12 `lib/rank.js` (WP-B)

```js
export const WEIGHTS; // { entity: 0.6, alias: 0.7, kindDoc: 0.25, kindLink: 0.15, title: 0.2, recency: 0.2, pinned: 0.1 }
export function runQuery(spec, ctx);    // → QueryResult (§6.5). Applies hard filters, scores, relaxes (SPEC §8.2)
export function runActions(spec, ctx);  // → ActionResult (§6.5). Ordering and grouping per SPEC §8.2
//   ctx = { now, index, getItem(id), idsNewestFirst(): Iterable<id>, idsInRange(start, end, field) → id[],
//           entityItems(entityId) → Set<id>, aliasTerms(entityId) → [{t, w}], groupOf(item) → entityId|null,
//           hidden(id) → boolean /* private for the agent path */, limit }
```

### 5.13 `lib/graph.js` (WP-C)

```js
export const LANES;     // ['up','left','right','down']
export const LANE_CAP;  // { up: 5, down: 5, left: 4, right: 4 }
export const SLOTS;     // { up:[{x:18,y:12},…5], down:[…y:88], left:[{x:12,y:28},…4], right:[{x:88,…}], center:{x:50,y:50} }
export function neighborhood(focus, ctx); // → Neighborhood (§6.6); deterministic (score desc, id asc)
//   focus = {type:'entity'|'item'|'overview', id?}
//   ctx = { getItem, getEntity, itemsOfEntity(eid) → id[], cooccur(eid) → [{id, w}], related(iid) → [{id, score}],
//           childrenOf(iid) → id[], overview() → {teams, projects, people, topics, reviewCount, openCount, recent},
//           page: {up?, left?, right?, down?}, kinds?: string[], now }
export function layout(neigh, { rtl = false } = {}); // → Placed (§6.6) — slot classes, % coordinates, edges
```

### 5.14 `view.js` (WP-C, composer; imports `./lib/graph.js` and `./lib/filetext.js`)

```js
// labels (used by search.js too)
export const KIND_ICONS;   // note 📝, link 🔗, doc 📄, meeting 🗓️, action open ☐ / done ☑ / suggested ❔
export const ETYPE_ICONS;  // person 👤, team 👥, project 📁, topic #️⃣, term 🔤, org 🏢
export function escapeHtml(s);
export function fmtDay(ms, locale);                       // 'Mon, Oct 26' (gregory)
export function fmtRange(start, endExclusive, locale);    // 'Mon, Oct 26 – Sun, Nov 1'
export function dueText(dueAt, { now, t, locale });       // 'due today (Fri, Nov 6)' | 'overdue · Mon, Nov 2' | 'due Fri, Nov 6'
export function interpLabel(spec, result, { t, locale, nameOf }); // the 🔎 row label (SPEC AT-1 / AT-2)
export function relaxText(relaxed, spec, { t, locale });  // relaxation sentence (AT-1b, AT-2b)
// HTML (strings; every dynamic value escaped)
export function renderCite(vm, { n, msg, expanded, t, locale });
export function renderOpCard(vm, ctx);
export function renderItemCard(vm, ctx);
export function renderMapCard(neigh, ui, ctx);  // ui = {blk, rev, history:[{ref,label}], mode:'map'|'list', canNavigate}
export function renderHelpCard(ctx);
// formatter core
export const ui;                                  // module-level FormatterState (per window)
export function createFormatterState();           // for tests
export function formatHtml(html, port, ctx);      // string | null — SPEC §10; ctx = {t, locale, rtl, canReformat, state = ui}
export function parseAction(actionId);            // ParsedAction | null (§7.2)
export function applyUiAction(state, parsed);     // {changed:boolean} — focus/back/home/more/mode/expand/dock
```

`formatHtml` uses the global `DOMParser`, which exists in the sandbox and in
jsdom. It never throws: on internal error it logs through `ctx.log?.warn` and
returns `null`.

### 5.15 `mind.js` (WP-D, composer)

```js
export function getMind(context);  // per-window singleton (WeakMap on context.invoke)
class Mind {
  // lifecycle
  ready();                      // Promise<void>: loadAll once (SPEC §7.5); starts enrich retries (P2)
  whenIdle();                   // Promise<void>: resolves when background work (link enrichment, back-fill) settles — tests use it
  get loaded(); get rev(); get readOnly();   // readOnly: null | {code, keys}
  syncIfStale(maxAgeMs = 1500); // Promise<boolean changed>
  setConfig(config);            // my_names → me aliases → dictionary rebuild; week start; toggles
  // read (sync, from the in-memory snapshot)
  preview(text);                // Preview — extract() against the current dictionary
  parse(input, { trailingSpace }); // QuerySpec
  find(spec, { forAgent = false, limit = 8 });  // {hits:[{item, score, why, snippet}], relaxed, total, hiddenPrivate}
  actions(spec, { forAgent = false, limit = 50 }); // {groups:[{entity, items}], open, suggested, done, total, hiddenPrivate}
  resolveEntity(phrase, typeHint); entity(id); entitySummary(id); recent(n); stats(); undoTarget();
  get port();                   // DataPort for view.formatHtml (§6.7)
  // write (async, locked, journaled)
  capture(text, { via, source?, hint? });       // Promise<CaptureResult>; then background link enrichment
  captureWindow(win);                           // win = get_source_window result
  setStatus(id, status); accept(id); dismiss(id); setPrivate(id, on); remove(id);
  undo(opId?);                                  // Promise<{ok, code?, op?}>
  annotate(entries, { origin: 'agent' });       // P1
  // agent
  agentRecord(item, { terms });                 // AgentRecord (§6.8) — never for private items
  askPrompt(question, { t });                   // P1
  organizePrompt({ t });                        // P2
  // open
  openTarget(id);                               // Promise<null | {type:'copy', value} | {type:'display', value}>
  // data management
  exportJson(); exportMarkdown(t); exportRaw(); importJson(text); deleteAll(); repair();
  requestReformat();                            // context.formatter?.requestReformat?.()
  // documents the user picks (FT-MM3, EXTENSION_FILE_TEXT §11)
  get canPickFiles(); get syncOn(); get canSync(); // files.pick_text and context.files; Kage sync on here (SYNC §12.6); sync.records offered
  syncInfo();                                   // settings: { supported, available, paused, others, lastSyncAt, usedBytes, maxBytes, waiting, full }
  fileSupport();                                // context.files.support(), once per session → {formats, maxInputBytes, maxChars}
  addFile({ targetId?, source?, signal? });     // from a click: pickText → validateFileText → ingestFile. → FileResult | {ok:false, code, message?, key?}
  ingestFile(file, { targetId?, source? });     // under the lock: dedupeDecision on the fresh state, then applyIngest / applyReread / applyAddRef
  loadBody(item); cachedBody(item);             // the full text, read on demand, the last 8 bodies per window; null when it isn't here
  bodyOnlyHit(item, terms); passagesFor(body, terms, { max, chars });
  agentFile(item);                              // {name, format, chars, pages?} for agent records
  setNotice(id, line);                          // a card's "Update from file…" outcome, shown for two minutes
  exportBodies();                               // { [itemId]: text } for Export JSON
  // background organizing (AC-MM3, EXTENSION_AGENT_CALLS §11)
  get canOrganize();                            // agent.background and context.agent
  agentStatus();                                // context.agent.status(), one at a time → { available, access, connected, pausedUntil, nextStartAt } | null; caches the machine tag
  organizeTick();                               // one pass, as the timers run it → { ok: true, organized, skipped, stale } | { ok: false, code, message? }
  organizeNow();                                // from a click: when 'now', key 'organize-now'; a waiting idle reservation of this window gives way
  organizeBacklog();                            // meta.orgSince = 0
  organizeInfo();                               // settings: { available, access, connected, pausedUntil, counts: {organized, waiting, older}, lastRun, toolWarning }
  whenOrganized();                              // resolves when this window's pass is done (tests)
  // map explorer (WP-V8, EXTENSION_VIEWS §24)
  exNode(ref);                                  // ExNode (§6.6b) | null (archived, dismissed, gone)
  links(ref, { limit = 60 });                   // { node, links: [{ ref, role, style, w, node }] } | null; round robin over kinds
  loadLayout({ force });  get pins();           // mm-layout → { pins, rev, unreadable }
  setPins({ [ref]: {x, y} | null });            // under the lock, re-reads first: windows' moves merge; not journaled
  resetLayout();                                // deletes mm-layout (settings → Reset map layout)
  loadView(); saveView(view); cleanView(raw);   // mm-view (this computer only, no lock)
  onRemoteChange(fn);                           // fn({data, layout}) on another window's change (storage.change_events)
}
```

Kage folder sync (S7, SPEC §7.8). Where `sync.records` and `context.sync`
are offered, `_mutateLocked` takes `_syncSnapshot()` (the item and entity
maps and the relation ids) before `apply`, marks what changed in
`meta.syncPending` with the commit's txn (`_syncMark`: a diff by object
identity, or only `change.dedupe` for a pull), drops the marks Kage already
accepted (`_syncClearAccepted`), and after the commit check sends the pushes
for the marks (`_syncFlushLocked`, at most `LIMITS.syncPushCalls` calls)
while it still holds the lock; `_syncSettle` reads the replies afterwards
and remembers what was accepted. `_mutate` takes two hooks for the pull:
`before(lease)` (pull a page) and `after(result, lease, pre)` (write pins,
then ack). One sync run per window (`_syncKick(want)` → `_syncLoop`):
status, the first push (`_syncBeginFull`, `_syncFullStep`, a cursor in
`meta.syncFull`), pending marks, pulls (`_syncPullAll`, a one-call look
first; held by `_syncHoldPull`, in the loop and again under the lock,
while marks Kage hasn't taken are waiting), and the meta write that clears accepted marks (2 s later, or at
`whenIdle()`). Wants come from load ('start'), `onChanges` ('pull',
'enabled', 'status'), a config change of **Sync private items** ('repush'),
`syncIfStale` (a pull at most once a minute) and the retry timer. The
indexes follow `mergedInto`: `byEntity` lists an item under the entity its
names redirect to (`byRaw` finds it again when the redirect changes), and
ranking's `getItem` sees canonical owners and names; so do `isHidden`
(a name merged into a private one is private) and organize's `hidden`,
payload names and vocabulary. `setPins` and
`resetLayout` push pins while they hold the lock; `deleteAll` marks every
record that could have synced for a delete in the new store's mm-meta.

Background organizing (AC-MM3): the loop runs in each window where Mind Map
has loaded, while `background_organize` is on, `enabled` isn't false, the
store isn't read-only and Kage offers `agent.background`. `_orgSync` (on
load and every `setConfig`) starts a 10-minute interval and a pass that asks
`status()` again; `capture` and `ingestFile` start a 60 s debounce; a pass
that finds only settling notes comes back when the first one settles. One
pass per window at a time (`_org.pass`; triggers join it). A pass: status
when needed (access, pause), `orgSince` the first time, `syncIfStale(0)`,
a cheap eligibility scan, then `context.agent.complete(build, { purpose:
'organize', when, dedupeKey: 'organize' | 'organize-now', signal })`. `build`
runs at Kage's turn: sync, `selectBatch`, `vocabulary`, `buildRequest`; it
returns null when nothing is left. `_reindex` and `_loadAll` abort the call
when a note in the batch is deleted or hidden; turning the switch off
aborts it too. A reply is applied in one `_mutate`: notes deleted, hidden
or with another rev are left out, then `applyOrgMarks`, then `applyAnnotate`
with `{ via: 'background', silent: true, autoAccept: false,
maxNewEntitiesPerItem: 3 }` and back-fill, then `_trimBackgroundUndo`
(older background ops past 64 KB of snapshots become lossy). Failures
(`not_json`, `invalid_response`, `timeout`, `response_too_large`,
`agent_error`, `tool_attempted`, and `invalid_input` refusals) mark the
batch failed; `budget_exhausted`, `rate_limited` and `paused` wait for
Kage's time; gate refusals stop the loop until a status says access is on;
the rest mark nothing. `tool_attempted` writes `mm-org`. The machine tag is
stamped on new items (`env.dev`) while the switch is on.

Document bodies (FT-MM3): `_mutateLocked` takes `model.bodyKeys(state)`
after the sync and before `apply`, `_persist` writes every `change.bodies`
first, and after the commit check the keys `model.releasedBodies(held,
state)` returns are deleted (an undone ingest or re-read, a delete or re-read
the journal dropped, a lossy op). `ingestFile` draws the op's and the item's
first ids up front and leaves that item out of `dedupeDecision`, so a retry
over its own earlier attempt is still "new".

FileResult: `{ ok: true, case: 'new'|'update'|'copy'|'same'|'unchanged',
itemId, opId? (new, update), title, addedAt, file: {name, format, pages,
chars, truncated, warnings}, found?: {people, teams, projects, topics,
actions}, private, secret, keptLocal }`. `lib/filetext.js fileLines` turns it
into the card, status and toast lines; `fileErrorText` does the same for a
refusal.

The mutation skeleton is in SPEC §7.4. Inside the lock, `capture` re-runs
`extract()` against the freshly synced dictionary. It then calls
`model.applyCapture`, then `entities.bumpCandidates` and
`model.applyPromotions`, then the BM25 postings back-fill and
`model.applyBackfill`. It updates the derived indexes incrementally, persists
the touched parts, and then:
- starts `fetch_link_metadata` if `enrich.state === 'pending'`;
- calls `requestReformat()` when that finishes.

### 5.16 Entries (WP-D)

(The explorer's entry, `explorer.js`, is in §5.23.)

- `search.js`: `initialize`, `onConfigUpdate`, `getKeywords` (trigger, trigger+'+',
  trigger+'?' with `// i18n-keys:`), `match`, `matchAsync`, `execute`,
  `onResultAction` (routes `mm:a:*` to mind and `mm:b*`/`mm:c*` to
  `view.applyUiAction`, then `mind.requestReformat()`), `destroy`.
- `tools.js`: `getTools` (empty unless `agent_tools` is on and
  `enabled !== false`), `getToolTimeout() → 15000`, `execute(name, params)`.
  Params are validated and coerced: arrays may arrive as JSON strings or
  comma lists. The result shapes are in SPEC §11.
- `formatter.js`: `format(html, ctx)`. Skip streaming. Return `null` fast
  (no markers). Otherwise `view.formatHtml(html, mind.port, {t, locale, rtl,
  canReformat: !!context.formatter?.requestReformat, log})`.
- `settings.js`: SPEC §13. Uses `mind.stats()`, `exportJson()` etc. through
  `runAction`, returns `{host:{type:'download'|'pick_file'|'refresh'}}`
  effects, and implements `onFileSelected`.

### 5.17 `lib/camera.js` (WP-V8)

```js
export const ZOOM_MIN, ZOOM_MAX;               // 0.1, 4
export function createCamera({x, y, zoom});    // screen = world × zoom + (x, y)
export function worldToScreen(cam, wx, wy); export function screenToWorld(cam, sx, sy);
export function panBy(cam, dx, dy); export function zoomAt(cam, factor, sx, sy, {min, max});   // the point under (sx, sy) stays put
export function centerOn(cam, wx, wy, viewport, zoom); export function centerOf(cam, viewport);  // mm-view stores the centre
export function fit(cam, bounds, viewport, pad, {min, max = 1.25}); export function visibleRect(cam, viewport, margin);
export function lerpCamera(a, b, t, viewport); export function clampZoom(z, {min, max}); export function sameCamera(a, b);
```

### 5.18 `lib/spatial.js` (WP-V8)

```js
export function createGrid(cell = 256); export function insert(grid, id, {x, y, w, h}); export function remove(grid, id);
export function query(grid, rect);              // ids meeting rect, bottom to top
export function hit(grid, x, y);                // topmost id containing the point | null
```

### 5.19 `lib/layout.js` (WP-V8)

```js
export const RELAX_ITERATIONS, RELAX_TIMEOUT_MS; // 300, 250
export function relax({ nodes: [{id, x, y, w, h, fixed}], edges: [{a, b, len}], iterations, budgetMs });
//   → { xy: [x0, y0, …], iterations, done }. Self-contained (Function.toString() for runSandboxed),
//     deterministic (no randomness), fixed nodes never move, a weak pull keeps nodes near their seeds.
```

### 5.20 `lib/scene.js` (WP-V8)

```js
export const SCENE_CAP, EXPAND_CAP, SCENE_MAX, HOPS;  // 300, 60, 2000, 2
export function buildScene(port, { focus, hops, cap, pins, rtl, lens, origin, linkLimit, hopLimit }); // → Scene (§6.6b)
export function expand(scene, ref, port, { cap, max, pins });  // → { scene, added, full }
export function collapse(scene, ref);                          // → { scene, removed }
export function rebuildScene(prev, port, opts);                // same focus and expansions, positions kept
export function diffScene(prev, next);                          // → { added, removed, moved, changed }
export function applyPins(scene, pins); export function carryPositions(prev, next); export function moveNode(scene, ref, x, y, {pinned});
export function readingOrder(scene);                            // focus, then up, start, end, down
export function relaxInput(scene, { free }); export function applyRelax(scene, result);
export function normalizeLens(lens); export function passesLens(node, lens);
```

### 5.21 `explorer-canvas.js` (WP-V8, composer; imports `lib/camera.js`, `lib/spatial.js`)

```js
export class ExplorerCanvas {   // { canvas, onIntent, theme, rtl, scroll, labels: {iconOf, subOf, titleOf}, raf?, caf?, now? }
  attach(); destroy(); setScene(scene, {tweenFrom}); setSelection(ref); setMatches(refs); setTheme(theme);
  setScrollMode('pan'|'zoom'); setVisible(on); resize(w, h, dpr); setCamera(cam, {animate, report});
  cameraAt(x, y, zoom); fitCamera(); zoomBy(f); panBy(dx, dy); draw(); invalidate(); hitTest(sx, sy); spaceDown(); spaceUp();
}
// intents: select | move {ref, x, y, from} | focus | expand | camera
export function keyIntent(e, { selected, editing }); export function nearestInDirection(nodes, from, dir);
export function backingSize(w, h, dpr); export function lodOf(zoom); export function clipLabel(text, n); export function paletteOf(theme);
```

### 5.22 `explorer-panel.js` (WP-V8, composer; imports nothing)

```js
export class ExplorerPanel {    // { root, t, rtl, onCommand }
  build() → stage; setNav; setScroll; setListMode; setPanelOpen; setLens; focusSearch; setSearchValue; setHits;
  showDetails(detail); setList(options, selected); setListSelection(ref); listNeighbour(ref, step); announce(text); toast(text, {onUndo});
}
```

### 5.23 `explorer.js` (WP-V8, entry: the view module)

The class of EXTENSION_VIEWS §9.1 (`initialize`, `mount`, `onOpen`,
`onShow`, `onHide`, `onThemeChange`, `onConfigUpdate`, `destroy`). It owns
the focus, history, lens, selection and the layout undo stack, turns
canvas intents and panel commands into scene changes and Mind calls, saves
mm-view (at most once every 2 s) and pins (mm-layout), and applies other
windows' changes from `context.storage.onChanged`.

### 5.24 `lib/files.js` (WP-FT-MM1, uses `lib.text`)

Kage's EXTENSION_FILE_TEXT §11.3–11.7. Pure; FT-MM3 wired it into `mind.js`
(`addFile`, `ingestFile`, `loadBody`, `passagesFor`).

```js
export const FILE_REF_RE, SHA256_RE, FILE_WARNINGS, FILE_LIMITS, GENERIC_TITLE_RE;
export function validateFileText(raw, { maxChars, maxBytes, formats });
//   → { ok: true, file } | { ok: false, code }. `file` is camelCase: name, ext, format, size, modifiedAt?, title?,
//     text, chars, truncated, totalChars?, pages?, pageStarts? (JS string offsets), warnings, sha256, fileRef.
export function dedupeDecision(items, file, { targetId });   // → { case: 'same'|'update'|'copy'|'new', itemId? }
export function addRef(refs, ref, max = 8);                  // newest last, oldest dropped
export function docTitle(file, lib);                         // → { title, titleSource: 'meta'|'auto' }
export function bodyKeyphrases(text, lib, { max = 64 });     // forms that tokenize back to their term
export function findPassages(text, terms, lib, { max = 3, chars = 400, pageStarts }); // → [{ text, start, end, page? }], best first
```

### 5.24b `lib/filetext.js` (WP-FT-MM3, imports nothing)

The words for a picked document, shared by the cards, the launcher's line,
the settings status and the explorer's toast. A leaf, not part of `view.js`:
`settings.js` can import it without pulling view.js's objects into the
settings security scan.

```js
export function fileSize(file, { t, locale });               // "12 pages, 48,211 characters"
export function fileLines(info, { t, locale, now, fmtDay }); // FileResult or OpVM.doc → string[]: headline, found, notes
export function fileErrorText(out, { t });                   // an addFile refusal → its text, '' for a cancel
```

### 5.25 `lib/organize.js` (WP-AC-MM1, uses `lib.text`, `lib.dates`, `lib.url`)

Kage's EXTENSION_AGENT_CALLS §11.3–11.5. Pure; `mind.js` uses it (AC-MM3).
`ctx` below is `{ now, state, orgSince?, machineTag?, organized?(item) }`;
`organized` is `mind._agentOrganized` (a default without the children check
is used when it's missing). A doc Kage flagged `possible_secret` is never
eligible (`'secret'`), a picked doc sends its file name, and the settings
count of organized notes includes skipped ones (AC-MM3).

```js
export const ORGANIZE_V, PURPOSE, DEDUPE_KEY, ORG_STATES, MACHINE_TAG_RE, ORGANIZE_LIMITS, SCHEMA;
export function textHash(item);                     // FNV-1a 32 (base36) of the collapsed title and text
export function hidden(item, state);                // = mind.isHidden (follows mergedInto)
export function ineligibleReason(item, ctx);        // → null | 'private'|'short'|'organized'|'out_of_scope'|'settling'|…
export function eligible(item, ctx);
export function selectBatch(state, ctx & { max? }); // → Item[] (≤15): own newest first, then others by hash(tag + id)
export function organizeCounts(state, ctx);         // → { organized, waiting, older } for the settings status
export function initialOrgSince(now);               // now − 7 days
export function notePayload(item, { state, lib, myNames? }); // → { kind, date, title, text?, entities?, url? | file? }
export function vocabulary(state, { lib, myNames?, max = 50 }); // → [{ name, type }]
export function buildRequest(batch, vocab, { t, today, state, lib, myNames?, maxPromptChars? });
//   → null | { request, refs: Map<'n1'…, { id, rev, hash }>, ids }. Drops notes from the end, then vocabulary,
//     until the framed prompt fits maxPromptChars (16,000).
export function validateReply(json);                // → { ok: true } | { ok: false, code: 'not_json'|'invalid_response', path }
export function toAnnotateEntries(json, refs);      // → { entries: [{ id, summary?, terms?, entities?, actions? }], skipped: id[] }
export function markDone(hash, now, { skipped });   // → { state: 'done'|'skipped', v, at, hash }
export function markFailed(prevOrg, hash, now);     // → { state: 'failed', v, at, hash, tries, next }
export function stripUrl(url);                      // no userinfo, query or fragment
```

### 5.26 `lib/syncmap.js` (WP-S7, imports nothing)

Mind Map's records as Kage folder sync sees them (SYNC §12.6, §12.9;
SPEC §7.8). Pure.

```js
export const FEATURE;                               // 'sync.records'
export const COLLECTIONS;                           // ['items', 'entities', 'links', 'rejections', 'bodies', 'pins'] (the manifest's)
export const ID_RE;                                 // the host's id rule, /^[A-Za-z0-9_.:-]{1,128}$/
export const LOCAL_FIELDS;                          // { items: ['rev','enrich','v','fileRefs'], entities: ['rev'] }
export function relationId(relation);               // `${s}:${t}:${type}`, or 'h.' + 32 hex when that breaks ID_RE
export function isSecretDoc(item);                  // file.warnings includes possible_secret
export function itemSyncs(item, { syncPrivate, parent }); // not a secret doc or its action; private only with syncPrivate
export function entitySyncs(entity, { syncPrivate });     // never `me`
export function plan(before, after, syncedBefore, syncsAfter); // 'p' | 'd' | null for one changed record
export function itemRecord(item); export function entityRecord(entity);   // without local fields (null for me)
export function relationRecord(relation); export function bodyRecord(key, body); export function pinRecord(pin);
export function bodyFromRecord(itemId, record);     // → { key, value } to store, or null (not this item's)
export function withLocal(collection, record, local, { extractorVersion }); // this computer's local fields back
export function groupChanges(changes);              // pull's changes → { [collection]: Map<id, record|null>, skipped }
export function mark(action, opId); export function parseMark(value); // 'p:<opId>' | 'd:<opId>' ↔ { action, opId }
export function batches(entries, { maxRecords, maxBytes }); // push calls: one collection each, by count and bytes
export function fullKeys(state, { pins, syncPrivate });     // every record of a full push, '${index}|${id}', sorted
export function splitKey(key);                      // → { collection, id }
```

---

## 6. Data shapes (cross-module contracts)

Persisted records (`Item`, `Entity`, `Candidate`, `Link`, `Rejection`,
`JournalOp`) are defined in SPEC §6. Everything below is in memory.

### 6.1 Extraction and Preview (`extract.js` → `mind.js` / `model.js`)

```
Extraction {
  v, text, truncated, private,
  kind, title, titleSource: 'auto'|'agent'|'user',
  url?, canonicalUrl?, path?, docKey?, occurredAt?,
  summary?, terms?: string[],
  mentions: [{ entityId?, key, name, type, origin: 'rule'|'agent', explicit, seg }],   // entityId set for dictionary hits
  candidates: [{ key, display, type }],
  aliases: [{ long, longKey, short, shortKey }],
  keyphrases: string[],
  self: null | Action,          // set when kind === 'action' (the item itself is the action)
  actions: Action[],            // children (dumps / link "read later")
  links: [{ seg, url, canonicalUrl, isDoc }],   // child links inside a dump
  rejectedActions: [{ text, reason }],
  segments: number, isDump: boolean
}
Action { seg, text, title, quote, status: 'open'|'done', confidence, suggested, owner: 'me' | {key, name}, dueAt?, origin: 'rule'|'agent' }
Preview { kind, entityNames: string[], actionCount, suggestedCount, nextDue?, linkCount, private, truncated }
```

### 6.2 State (`model.js`)

```
State {
  meta: { schema, rev, txn, keys: {[storageKey]: rev}, counts, extractorVersion, createdAt, updatedAt, orgSince? },
  items: Map<id, Item>, entities: Map<id, Entity>, candidates: Map<key, Candidate>,
  links: Link[], rejections: Rejection[], ops: JournalOp[],
  shardRevs: Map<'YYYY-MM', rev>, partRevs: { entities, links, journal }
}
```

### 6.3 CaptureResult (`mind.capture` → search/tools)

```
CaptureResult { opId, itemId, childIds: id[], newEntityIds: id[], related: id[≤3], dedupedInto?: id,
                rejectedActions: [{text, reason}], truncated: boolean }
```

### 6.4 QuerySpec (`query.js` → `rank.js`, `view.js`, `mind.js`)

```
QuerySpec {
  raw, command: null|'map'|'actions'|'review'|'recent'|'undo'|'help'|'organize'|'merge'|'forget'|'rename', args,
  intent: 'home'|'find'|'actions'|'entity'|'command',
  kinds: string[]|null, kindBoost: 'doc'|null,
  range: Range|null, recency: boolean,
  status: null|'open'|'done'|'suggested'|'overdue'|'all',
  owner: null|'me'|'anyone'|entityId,
  entities: [{ entityId, hard, via: 'marker'|'phrase'|'dict' }],
  unresolved: [{ phrase, type: 'team'|'project'|'person'|null }],
  terms: [{ t, w, prefix?: true, neg?: true }], phrases: string[],
  includePrivate: boolean,
  chips: [{ type: 'kinds'|'range'|'owner'|'entity'|'unresolved'|'status'|'terms', value }],
  syntax: string
}
Range { start, end, granularity, span: [i, j], code, field: 'any'|'due', soft?: true }
```

### 6.5 QueryResult and ActionResult (`rank.js`)

```
QueryResult  { hits: [{ id, score, why: [{code: 'term'|'entity'|'alias'|'title'|'range'|'kind', value?}], terms: string[] }],
               relaxed: null | { code: 'range_widened'|'range_dropped'|'kinds_dropped'|'entities_softened'|'none', range? },
               total, hiddenPrivate }
ActionResult { open: id[], suggested: id[], done: id[], groups: [{ entityId|null, ids: id[] }], total, hiddenPrivate }
```

### 6.6 Neighborhood and Placed (`graph.js` → `view.js`)

```
NodeVM  { ref, kind, label, sub?, icon?, size: 's'|'m'|'l', status?, suggested?, private? }
        // ref: itemId | entityId | 'o' | 'more:<lane>' | 'review' | 'actions'
Lane    { role: 'entities'|'actions'|'docs'|'notes'|'teams'|'people'|'topics'|'stats', nodes: NodeVM[], more: number, page: number }
Neighborhood { focus, center: NodeVM & { counts?, snippet?, day?, app? }, lanes: { up, left, right, down: Lane } }
Placed  { center, nodes: [NodeVM & { lane, slot: 'u1'..'u5'|'d1'..'d5'|'l1'..'l4'|'r1'..'r4', x, y }],
          edges: [{ lane, x2, y2, style: 'solid'|'dashed' }] }
```

### 6.6b ExNode and Scene (`mind.links` → `scene.js` → the explorer)

```
ExNode { ref, group: 'entity'|'item'|'overview', kind, label, status?, suggested?, private?, mine?, at?, app?, dueAt?, doneAt? }
Link   { ref, role: 'entities'|'actions'|'parent'|'docs'|'notes'|'teams'|'people'|'topics'|'stats',
         style: 'solid'|'dashed'|'thin', w: 0..1, node: ExNode }
Scene  { focus, rtl, lens: {kinds, mine, done}, nodes: [ExNode & { depth, lane: 'center'|'up'|'start'|'end'|'down',
         via, focus, x, y, w, h, pinned }], edges: [{ a, b, style, w, role }], byRef, expanded: ref[], bounds, missing, full }
```

### 6.7 DataPort and view models (`mind.js` → `view.js`)

```
DataPort { loaded, rev, ensureLoaded(), cite(id) → CiteVM|null, op(opId) → OpVM|null, item(id) → ItemVM|null,
           map(focus, page) → Neighborhood|null, links(ref, {limit}) → {node, links}|null, nameOf(id) → string }
CiteVM { id, kind, title, day, snippet, url?, private, missing }
OpVM   { opId, code, undone, canUndo, at, item?: {id, kind, title, private}, dedupedInto?: {id, day},
         entities: [{id, name, type}], actions: [{id, title, status, suggested, dueAt?}], related: CiteVM[], truncated,
         doc?: FileResult }                                   // ingest and reread ops (§5.15)
ItemVM { id, kind, title, text, day, createdAt, app?, url?, path?, status?, suggested?, dueAt?, owner?: {id, name},
         private, summary?, entities: [{id, name, type, private}], actions: [...], parent?: CiteVM, related: CiteVM[],
         file?: {name, ext, format, size, pages, chars, truncated, warnings, canUpdate}, notice?,
         organized?: {opId?, canUndo, count} }                 // background organizing did it (AC-MM3)
```

When the port returns `null` for a known id that is private, it returns
`{private: true}` instead, so chips render "private item".

### 6.8 AgentRecord (`mind.agentRecord` → tools, prompts)

```
AgentRecord { cite, kind, title, date: 'YYYY-MM-DD', captured: 'YYYY-MM-DD', snippet, url?,
              file?: {name, format, chars, pages?}, entities: string[], status?, due?, owner?, why?: string[] }
```

---

## 7. Wire formats

### 7.1 Launcher result `data` payloads (`search.js` only; the host round-trips them)

```
{ a: 'capture', text }                  // mm:capture
{ a: 'window', title, app }             // mm:window
{ a: 'file' }                           // mm:file → Kage's file dialog → display with the op card (files.pick_text hosts)
{ a: 'open', id }                       // mm:i:<id>
{ a: 'toggle', id, query }              // action rows → replace_input(query) after the toggle
{ a: 'accept', id, query }
{ a: 'refine', syntax }                 // mm:interp
{ a: 'fill', value }                    // ask / everyone / related-entity / home rows → replace_input
{ a: 'entity', id }                     // entity header → display map (P1) or list
{ a: 'map', ref }                       // display [mm-card:map:<ref>]
{ a: 'undo', opId }
{ a: 'ask', question }                  // mm? → {type:'prompt'}
{ a: 'explore', ref, query? }           // mm:explore → {type:'open_view', view:'explorer', params:{focus, query?}} (views hosts)
{ a: 'help' }  { a: 'settings' }  { a: 'noop' }
```

### 7.2 `data-ext-action` grammar (formatter HTML → `search.onResultAction`)

```
mm:a:done:<itemId> | mm:a:reopen:<itemId> | mm:a:accept:<itemId> | mm:a:dismiss:<itemId>
mm:a:undo:<opId> | mm:a:open:<itemId> | mm:a:private:<itemId> | mm:a:share:<itemId> | mm:a:delete:<itemId>
mm:a:update:<itemId>        a doc's "Update from file…" (Kage's file dialog; the card shows the outcome)
mm:b<blk>:f:<ref> | mm:b<blk>:back | mm:b<blk>:home | mm:b<blk>:more:<lane> | mm:b<blk>:mode:<map|list> | mm:b<blk>:map
mm:b<blk>:explore           open the explorer on what the card shows (→ { host: open_view }; views hosts only)
mm:c<msg>:x:<n>:<id>        toggle a chip expansion
mm:c<msg>:map:<id>          dock a map card for <id> at the end of message <msg>
```

`<blk>` and `<msg>` are per-window counters in base36. Values only ever contain
`[a-z0-9:]`.

### 7.3 Tokens in display Markdown and agent text

- `[mm:<id>]` → a chip.
- `[mm-card:op:<opId>]` / `[mm-card:item:<id>]` / `[mm-card:map:<ref>]` /
  `[mm-card:help]` → a card. The token must be alone in its paragraph.
- Card DOM keeps its identity in classes:
  `mm-block mm-b<blk> mm-r<uiRev> mm-d<dataRev> mm-t-<op|item|map|help> mm-f-<ref>`.
  If the module state is lost, `formatHtml` rebuilds the block state from
  them.

---

## 8. Test plan

Every test is vitest. `npm test` runs all of them, and
`npx vitest run extensions/mindmap` runs just these.

| Module | Key tests |
|---|---|
| `lib/ids.js` | Format and length. Sortable by time. `CITE_RE` accepts valid ids and rejects `[mm:../x]`, uppercase and over-long ids. `createIdPool().reset()` replays the same ids. |
| `lib/text.js` | `normalizeKey('M.T.C.S.')==='mtcs'`, NFKD folding (`Café`→`cafe`). `tokenize('MTCSs MTCS’s mtcs')` gives 3× `mtcs`. Stemming: actions→action, status unchanged, docs unchanged (len 4), policies→policy. `snippet` centres on the hit with ellipses. `containsQuote` across whitespace and case. `escapeMd` neutralizes `*_[]()#<>`. `cleanWindowTitle` for Word, Google Docs, Edge, macOS "— Edited". Segmenter missing → regex fallback gives the same tokens for ASCII. |
| `lib/dates.js` | The fixture clock Fri 2026-11-06 10:00, run for weekStart Mon **and** Sun. Every phrase in SPEC §8.3, both tables. "last week" = Oct 26 – Nov 2 (Mon) / Oct 25 – Nov 1 (Sun). "friday" in due on a Friday = next Friday. EOW on Sat. "in october" (past-biased), "Q4" (current quarter is not in the future → Q4 2026 up to now). `YYYY-MM-DD..YYYY-MM-DD` is inclusive. A DST boundary (run the suite under `TZ=America/New_York` as one case, using local date constructors). `span` indices remove the phrase cleanly. Unknown text → `null`. |
| `lib/url.js` | `findUrls` trims `).,;` and keeps balanced parentheses. Canonicalization: www, case, trailing slash, `utm_*`, `fbclid`, `#top` dropped, `#/route` kept, sorted query. `isDocUrl` for .pdf, docs./wiki. hosts and /wiki/ paths. `findPaths` for `~/Docs/a b.pdf`, `C:\x\y.docx`, `\\srv\share`, `file:///Users/x/y.pdf`. No false path on "and/or". |
| `lib/entities.js` | Explicit `#mtcs`, `@dana`, "Bingo team", "the bingo team", "team Zebra", "team meeting" (no entity), "project Atlas", email. Dictionary longest match ("Bingo launch" vs "Bingo") with no overlaps. Implicit acronyms minus the stoplist; `MTCSs` folds. `ownerCue('Dana to share the deck')`. `learnAliases('Quarterly Planning Review (QPR)')`. `bumpCandidates` promotes on the 2nd distinct item, is idempotent for the same item id, and respects rejections. |
| `lib/extract.js` | All of SPEC §5 with the F1–F11 inputs: the kind for each, the F6 split (AT-3 table, including "Friday said on a Friday" and Dana linking across segments), single-line imperative + due → open 0.9, "read later <url>" child action, private markers, truncation at 8,000, dedup keys present, `previewOf` counts. Determinism: the same input twice gives deep-equal output. Performance: 4 KB in <15 ms (soft assertion: warn, don't fail, on slow CI). |
| `lib/query.js` | AT-1 parse (kinds, range, terms, no hard entity). AT-1b. AT-2 parse (intent actions, owner me, hard Bingo). AT-2b unresolved "walrus". Filter syntax round-trip `toSyntax(parseQuery(x))` is stable. `mm mtc` (no trailing space) → prefix term. `"exact phrase"`, `-term`. Commands. Kind and status words. `@`/`#`. "due this week" → field due. |
| `lib/store.js` | With `test-helpers/mindmap/memory-host.mjs`: <br>• twin write order (twin then primary); `readBest` picks the higher rev; corrupt primary → twin; both corrupt → `unreadable` <br>• atomic mode: single write <br>• the throttle never exceeds 70 per rolling second; rate-limit error → retried <br>• `withLock`: mutual exclusion under interleaved latency (two stores and 50 increments → 50); a stale lock past expiry is taken over; `lease.check()` fails after a takeover; release only when the nonce is ours <br>• `remove` deletes both keys. |
| `lib/model.js` | `fromPersisted` ↔ `payloadFor` round-trip. Validation drops malformed records and counts the problems. Future schema → `future_schema`. `applyCapture` for every Extraction shape: parent and children ids from the pool, inherited entities, owner entity creation, dedup merge (annotation line format `— YYYY-MM-DD: …`). Idempotency: apply on a clone, reload the clone, apply again with `pool.reset()` → deep-equal. Status, accept, dismiss, edit, delete (children cascade), enrich (title only while `auto`), annotate (quote check, additive only, private rejected), promotions and back-fill recorded in the same op. |
| `lib/model.js` documents (FT-MM2) | `applyIngest`: a doc with `file`, `fileRefs` and (past 8,000 characters) `body`; actions are open suggestions even with auto-accept, done lines left out; `possible_secret` and "new items private" make it private with its actions; title fallback; refusals (bad result, path in the name, budget). `applyReread`: new text, file, body and keyphrases; user title, agent mentions and acted-on actions stay; untouched rule suggestions the new text dropped go; new lines are suggestions; secret → private. `applyAddRef`: silent, newest last, 8 kept. Apply and undo deep-equal for ingest and re-read; re-apply after reload changes nothing. Bodies: `releasedBodies` after undo, after a delete leaves the journal, after a lossy op; a re-read never reuses a key a snapshot holds; `normalizeBody` and the stored-field checks. |
| `lib/journal.js` | Snapshot first-wins. `sealOp` revs. `canUndo` superseded after a later edit. `applyUndo` restores the exact before-state (deep-equal to the state before the op) and removes created entities. `appendOp` caps both count and bytes. `lastUndoable` skips silent, undo and undone ops. |
| `lib/bm25.js` | Hand-computed scores for a 3-document corpus. Field weights rank a title hit above a body hit. Incremental add/remove equals a rebuild. `similar` ratio threshold. `vocabPrefix` ordering. `neg` exclusion. 10k synthetic docs build in <250 ms (soft). |
| `lib/rank.js` | Over a hand-built ctx: AND-first then OR fallback (AT-5 shape: the only full match is hidden, so OR), hard filters (kinds, range on createdAt **or** occurredAt, status, owner, hard entity, archived), the score formula and deterministic ties, the full relaxation ladder with codes, AT-1b closeness ordering, agent path `hidden()` counted in `hiddenPrivate`, the actions ordering and grouping of SPEC §8.2 (AT-2 order), the 14-day done window. |
| `lib/graph.js` | Lane assignment for entity, item and overview focus. Caps and "+N more" paging. Stable ordering across calls. `layout` slot classes and coordinates. RTL swaps left and right. Empty lanes. Private nodes flagged. |
| `view.js` (jsdom) | <br>• **Sanitizer-allowlist assertion**: a helper encodes SPEC §10.2's tag and attribute allowlist and walks every rendered card and chip; any other tag or attribute fails. <br>• Chips are inline (no block element inside `<p>` after `formatHtml`). <br>• Numbering and reuse; deleted and private chips. <br>• `formatHtml` idempotency (`formatHtml(formatHtml(x))` → `null`); `null` for HTML without markers; tokens inside `code`/`pre`/`a` untouched. <br>• Card replacement only for paragraphs that hold just the token. <br>• Staleness by uiRev/dataRev. <br>• State rebuilt from classes after `createFormatterState()`. <br>• `parseAction` for every grammar entry and rejection of junk; `applyUiAction` focus/back/home/more/mode/expand/dock. <br>• Map card a11y: role and aria-labels present, DOM order centre → up → left → right → down; `canNavigate:false` footer. <br>• Labels: `fmtRange` and `dueText` for the fixture dates; `interpLabel` strings for AT-1 and AT-2 (with a stub `t` that echoes keys and params). <br>• Escaping: user text `<img src=x onerror=…>` renders as text. |
| `styles.css` | `styles.test.js` parses the CSS with a regex. Fails if a selector doesn't start with `.mm-` (`@media` allowed), on `position: fixed`/`sticky`, on `z-index` > 10, on `url(`, and if a `prefers-reduced-motion` guard is missing around transitions. |
| Explorer (WP-V8) | `lib/camera.test.js`: round trips, zoom at a point, clamps, fit. `lib/spatial.test.js`: query, topmost hit, moves. `lib/layout.test.js`: overlaps resolved, fixed nodes still, deterministic, survives `Function.toString()` and runs in a plain worker. `lib/scene.test.js`: lanes, determinism, RTL mirroring, pins, lens, caps, expand/collapse, rebuild with positions kept. `explorer-canvas.test.js` (jsdom, recording 2D context): LOD, culling, RTL text, theme colours, drag/pan/wheel/pinch, handle. `explorer.test.js`: open with focus, a drag pins to mm-layout and shows after reopening, a non-self mm-meta change redraws once, a private node never reaches compose, `onOpen` re-centres, mm-view round trip, keyboard, panel actions with Undo. `explorer-entry.test.js`: rows, card buttons and settings with and without views; `mind.links`, pins, mm-view, export/import, Delete everything. `explorer-styles.test.js`: the CSS gate for `explorer.css`. |
| `lib/files.js` (FT-MM1) | `validateFileText`: bad types, oversized fields, scalar counting, bad hex, bad ref, paths in names, page starts converted to string offsets. `dedupeDecision`: S, U, C, N, first match wins, oldest of equals, Update from file…. `addRef` cap. `docTitle`: usable titles, app defaults, paths. `bodyKeyphrases`: frequency, headings double, forms that re-tokenize, deterministic, 200,000 chars in <60 ms (soft). `findPassages`: length, best first, no overlap, folded spellings, the block test against a full scan, pages, surrogate pairs. |
| `lib/organize.js` (AC-MM1) | `lib/organize.test.js`. Eligibility: private, private entity, archived, child, kinds, short, pending link, settle time, `orgSince` (and its 7-day default), hash change, done and skipped marks, failed with backoff and the 3-try cap, malformed `org`, notes `mm organize` already did, machine tag and the 24-hour rule. Batch cap and order, insertion-order independence, two tags start apart, 20,000 items (soft). Payload omits window, app, folders, `my_names` and ids; URLs lose userinfo, query and fragment, in the text too; paths keep the file name; caps and no `<>`. Vocabulary excludes private, merged, hidden-only and own names. `SCHEMA` uses only the host's subset within its caps; fixture replies pass, bad ones fail at the first bad path. `buildRequest`: refs, label, budget trimming checked against the host's framing. `toAnnotateEntries`: ref mapping, skip, cleaning; end to end through `model.applyAnnotate`. Marks. |
| Background organizing (AC-MM3) | `mind.test.js` with `test-helpers/mindmap/agent-host.mjs`: off by default (no status call, no tag, no `orgSince`); no host feature; a batch end to end (request shape, nothing identifying sent, marks, suggestions, silent op, `mm organize` and the next pass skip it); `duplicate` across two windows; the builder gives the turn back; a stale rev; a private flip or delete in flight cancels; the switch off cancels; each failure, wait, stop and retry code; Undo organizing (and `superseded`); `mm undo` of the capture takes the background's children; Organize now (its own key; a waiting reservation gives way); `orgSince` and Organize older notes too; another computer's notes wait a day; the debounce and the settling retry; the 64 KB undo budget; `organizeInfo`. `settings.test.js`: the section after Agent, the switch off by default, the status per access state, Allow (`agent_access`), Organize now and older notes, pause and tool warnings, escaping. `view.test.js`: the ✦ line and Undo organizing. `search.test.js`: Undo organizing from a card. `lib/journal.test.js`: children a later silent op made go with their parent. |
| Documents (FT-MM3) | `lib/filetext.test.js`: sizes, every headline and note, error texts. `mind.test.js`: off without `files.pick_text`; body first, then the shard, journal and meta, and written once; a short file has no body; cancel, host refusals and bad results save nothing (and no file name in the log); S, C and U, with Undo of a re-read and of an ingest; Update from file… (unchanged, update, not a doc); `possible_secret` and Let my agent see it; the budget refused before the dialog; read-only before the dialog; a crash after the body write; a retry after a conflict is still "new"; the body cache (lazy, 8 per window) and another window after `syncIfStale`; a deleted doc's body kept until the delete leaves the journal; Export raw / JSON, Delete everything and Import with bodies. `search.test.js`: rows only with the feature, Enter, cancel, refusal and "already" lines, doc rows and passages, Update from file… on a card. `settings.test.js`, `tools.test.js`, `view.test.js` and `explorer.test.js`: the Documents section, passages within 8 KB and private docs hidden, the doc cards, Add a file… and Show text in the explorer. |
| Folder sync (S7) | `lib/syncmap.test.js`: the manifest's collections and local fields match the leaf; records without local fields (no `me`); local fields put back, `enrich: done` for a record new here; relation ids and the hash; secret documents and their actions stay, private ones only with the setting; plans for a push, a one-time delete and nothing; grouped changes, marks, batches by count and size, full-push keys. `sync.test.js`, two computers on `test-helpers/mindmap/sync-host.mjs`: a capture with its actions and names; a status change, never pushed back; edits to different fields merge; deletes; undo `superseded` after a remote change (and still fine otherwise); the same name made on both sides becomes one, pushed equally; private items with the setting on and off (removed from the other computer, the card says so, Undo brings it back; turning it on again sends them); a crash between the write and the push; marks cleared; the first push (the newer copy wins; pulls wait for it); bodies and secret docs; pins and Reset map layout; Delete everything; no `sync.records`, a `context.sync` without the feature, sync off; the settings section. |
| `host-loader.test.js` | Copied from stocks and adapted. <br>• Windows: floating/chat = search + tools + formatter; settings = settings. <br>• Checks BFS discovery, no re-exports, composers import only leaves, leaves import nothing, every import is single-line, no `import … from './` text in comments. <br>• Loads every provider through the host's two-pass rewrite in Node and asserts the default export class names. |
| `mind.test.js` | Load and sync (`syncIfStale` reloads only changed keys). Crash safety (AT-10). Read-only refuses writes and makes zero data writes. Two windows (AT-9). Undo (AT-8). Link enrichment (mock `fetch_link_metadata`; title only while `auto`; a reformat is requested). The window doc with an empty macOS title is not offered. `agentRecord` omits window and app, applies snippet caps and private exclusion. `askPrompt` with 0 and 8 records strips `<>`. `exportJson` and `deleteAll` (every key and twin deleted). |
| `search.test.js` | `getKeywords` for the default and a custom trigger. The `mm+` preview row and execute → display with an op token. `mm+` empty → window row (and the hint). The home rows. Loading placeholder → `matchAsync` real rows; a second `matchAsync` with no change returns `[]`. Row ids contain no user text (fuzz with random input). Enter behaviours per kind (`open_url` invoked; doc focus → copy → card). Action toggle returns `replace_input`. `onResultAction` routing. |
| `tools.test.js` | `getTools` gating (`agent_tools`, `enabled`). Param coercion (stringified arrays, comma lists, bad dates). Each tool's result shape (SPEC §11). The 8 KB cap. `hiddenPrivate`. Capture via agent (AT-11). The `note` field is always present. Unknown tool → error. |
| `formatter.test.js` | Wrapper: streaming skipped. Not loaded → placeholders + `ensureLoaded` + reformat requested. Older host without `context.formatter` → awaits load (≤1.5 s) and static map footer. |
| `settings.test.js` | Schema validity: only known control types; ids equal the manifest config keys; defaults equal `DEFAULTS`. `validate` (trigger regex, snippet bounds). `normalize`. `runAction` export/delete/raw/repair effects. Read-only mode shows the repair controls. |
| `acceptance.test.js` | Builds the SPEC §3.1 corpus through `search.execute` on the fixture clock, using `test-helpers/mindmap/corpus.mjs`. Runs **AT-1, AT-1-agent, AT-1b, AT-2, AT-2-agent, AT-2b, AT-3, AT-4, AT-5, AT-6 (P1), AT-7, AT-8, AT-9, AT-10, AT-11** exactly as written in SPEC §3. |

**Manual check in a Kage dev build** (WP-D, end of P0 and of P1):
1. `npm run build`, then serve `dist/` on loopback only:
   `python3 -m http.server 8000 --bind 127.0.0.1`.
2. In Kage, Settings → Store → custom store URL `http://localhost:8000`.
   Install Mind Map.
3. Floating bar:
   - capture F1–F11;
   - run AT-1 and AT-2;
   - `mm map bingo`: click nodes, check RTL with `ar`, Tab through the nodes, check the list view;
   - Undo from the card.
4. Chat window:
   - `mm+` and the op card;
   - `mm?` and the citation chips;
   - "add this to my mind map" with an attached file.
5. On macOS without Screen Recording, `mm+` offers no window row.
6. Check the floating window resizes to fit the map card.

---

## 9. Work packages

Every package works only on the files it owns (§2), and the file sets don't
overlap. Rules for every package:
- Run `npx vitest run <your files>` until green.
- Never `git add -A`: stage explicit paths only, because another agent edits
  the same checkout.
- Don't commit unless the session's instructions say to.
- Read SPEC.md and this file first. Where this document and SPEC disagree,
  SPEC wins for behaviour and this document wins for interfaces.

Order: WP-A, WP-B, WP-C and WP-H start together. WP-D starts when A, B and C
are done; its manifest, defaults, settings and README parts may start early.

### WP-A Language and organizer (no dependencies)

- **Files**: `lib/ids.js`, `lib/text.js`, `lib/dates.js`, `lib/url.js`,
  `lib/entities.js`, `lib/extract.js`, `lib/query.js`, with a `.test.js` for
  each.
- **Implements**: SPEC §5 (S0–S7), §8.1 and §8.3. Interfaces in §5.1–§5.7.
- **Done when**:
  - all tests in §8 for these modules pass;
  - the leaves import nothing;
  - the English lexicons are exported constants;
  - the F1–F11 inputs produce exactly what SPEC §3.1 and §3.4 AT-3 state.

### WP-B Data layer and retrieval (no dependencies)

- **Files**: `lib/store.js`, `lib/model.js`, `lib/journal.js`, `lib/bm25.js`,
  `lib/rank.js` with tests, and `test-helpers/mindmap/memory-host.mjs`.
- **Implements**: SPEC §6, §7 (except the orchestration in mind.js) and §8.2.
  Interfaces in §5.8–§5.12.
- **`memory-host.mjs`** exports
  `createMemoryHost({ atomic = false, latency = () => 0, handlers = {} })`,
  which returns `{ invoke, files: Map<key, string>, calls: [], corrupt(key), crashAfterWrites(n) }`.
  It implements `load/save/delete_extension_data` with the host's key
  validation (`^[A-Za-z0-9._-]{1,128}$`, no `..`) and the 100-per-second
  rate-limit error text `invoke rate limit exceeded`.
- **Done when**:
  - §8 tests pass;
  - the lock test with interleaved latency loses no increments;
  - undo restores state exactly;
  - the idempotent re-apply test passes.

### WP-C Presentation (no dependencies)

- **Files**: `lib/graph.js`, `view.js`, `styles.css`, `lib/graph.test.js`,
  `view.test.js`, `styles.test.js`, `docs/mindmap/i18n/view.en.json`.
- **Implements**: SPEC §9, §10 and §14 for its strings. Interfaces in §5.13,
  §5.14 and §6.6–§6.7.
- **Works against fakes**: a fake DataPort and hand-built Neighborhoods. It
  doesn't need A or B.
- **i18n**: it owns the namespaces `card.*`, `map.*`, `cite.*`, `kind.*`,
  `etype.*`, `due.*`, `range.*`, `relax.*`, `chip.*`, `help.*`.
- **Done when**:
  - §8 tests pass, including the sanitizer allowlist assertion and the CSS gate;
  - `view.js` imports only `./lib/graph.js`;
  - every `t()` key it uses is in `view.en.json`.

### WP-D Integration and entry points (depends on WP-A, WP-B, WP-C)

- **Files**: `manifest.json`, `defaults.js`, `mind.js`, `search.js`,
  `tools.js`, `formatter.js`, `settings.js`, `README.md`,
  `_locales/en/messages.json`, `host-loader.test.js`, `mind.test.js`,
  `search.test.js`, `tools.test.js`, `formatter.test.js`,
  `settings.test.js`, `acceptance.test.js`, `test-helpers/mindmap/corpus.mjs`.
- **Implements**: SPEC §1, §2, §3, §4, §7.4–§7.7 orchestration, §11, §12,
  §13, §15, §16, §18. Interfaces in §5.15–§5.16.
- **Order inside the package**:
  1. **P0**:
     - manifest, defaults, mind (load/sync/capture/find/actions/undo/export/delete),
       search, tools (5), formatter wrapper, settings, locales (merge WP-C's
       fragment, then delete `docs/mindmap/i18n/`), README;
     - `npm run check:all` green;
     - manual check (§8).
  2. **P1**: map card wiring, docking, `mm?`, `annotate`, Export Markdown. Then
     `check:all` and a manual check.
  3. **P2**: organize, merge/forget/rename, archive, import, re-derivation,
     enrich retry, context edges. Then `check:all`.
- **README**: what it does, the triggers, examples (including the owner's two
  queries), the privacy disclosure, the documents limitation and the agent
  capture flow, uninstall deletes data (so export first), and that it stores
  no credentials.
- **Done when**:
  - all AT tests pass;
  - `npm run check:all` passes;
  - the manual check list passes.

### WP-H Kage host improvements (no dependencies; Kage repo)

These are optional for the extension, which detects and degrades (SPEC §18).
They are small, isolated, and useful to every extension. Details are in §10.

- **Files**:
  - `src/extensions.rs`
  - `src/commands/extensions/files.rs`
  - `ui/js/extension-sandbox/runtime/host-api.js`
  - `ui/js/shared/extension-manager.js`
  - `ui/js/shared/extension-manager/tool-steering.js` (new)
  - `ui-tests/shared/tool-steering.test.js` (new)
  - `docs/EXTENSIONS.md`
- **Done when**:
  - `cargo test --lib extensions::` passes. Do **not** run the full
    `cargo test` locally: the mock app sweep can touch real config without an
    isolated config dir.
  - `cd ui-tests && npx vitest run shared/tool-steering.test.js` passes.
  - `cargo clippy` and `cargo fmt --check` are clean.
  - The docs are updated.

---

## 10. Host changes (WP-H), minimal design

### H1. Atomic `save_extension_data` plus the `storage.atomic_write` host feature

**Problem.** `std::fs::write` truncates first. A crash or kill mid-write
leaves a truncated JSON file, and today every extension loses that key.

**Design.**
- Add this to `src/extensions.rs`:

  ```rust
  pub fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()>
  ```

  It works as follows:
  1. Write to a temp file in the same directory (`<file>.<pid>-<nanos>.tmp`,
     which can never collide with a `<key>.json` data file).
  2. `sync_all` the temp file.
  3. `std::fs::rename(tmp, path)`. On Windows this replaces an existing
     target. Retry up to 3 times with a 20 ms sleep on a
     `PermissionDenied` caused by a sharing violation (antivirus or
     indexer).
  4. On any error, remove the temp file and return the error.
- `save_extension_data` in `src/commands/extensions/files.rs` calls
  `atomic_write` instead of `std::fs::write`. Its error text is unchanged.
- **Tests** (unit, in `src/extensions.rs`, using a tempdir):
  - writes a new file;
  - replaces an existing file;
  - leaves no `.tmp` file behind on success;
  - cleans up the temp file when the rename fails (simulate this by making
    the target a directory).
- **Feature flag.** Append `'storage.atomic_write'` to `HOST_FEATURES` in
  `ui/js/extension-sandbox/runtime/host-api.js`, with a comment: "`save_extension_data`
  replaces the file atomically (write temp + rename), so a crash never leaves
  a truncated value". If an existing ui-test pins this list, update it.
- **Docs.** `docs/EXTENSIONS.md` § Feature detection: add a table row.
  § Extension data: one sentence on atomicity.
- **Degradation.** Older hosts lack the feature, and Mind Map keeps its twin
  writes.

### H2. Tool steering shows `enum`, array `items`, `required`, and the real timeout

**Problem.** `buildToolSteeringBlock` prints only `name (type, default) —
description`. Tools such as stocks' `range` enum and Mind Map's `kinds` array
lose their allowed values, so agents guess.

**Design.**
- New pure module `ui/js/shared/extension-manager/tool-steering.js`:

  ```js
  export function formatToolParam(name, def)
  // → 'kinds (array of string, one of: note|link|doc|action|meeting, required, default: …) — description'
  ```

  It shows:
  - `enum` (when it's an array of strings or numbers, capped at 12 values);
  - `items.type` and `items.enum` for arrays;
  - `required: true`;
  - the default, as it does today.

  It is defensive about malformed defs: no throw, and it falls back to the
  current output.
- `buildToolSteeringBlock` in `ui/js/shared/extension-manager.js` uses
  `formatToolParam` for each parameter. Nothing else in the block changes.
- **Tests**: `ui-tests/shared/tool-steering.test.js` covers plain params
  (output identical to today), enum, array with items, required, a malformed
  def, and long enums.
- **Docs.** `docs/EXTENSIONS.md` § Tool Provider API:
  - document `enum`, `items` and `required` in the ToolDef shape;
  - document the optional `getToolTimeout(toolName)`. It exists in the
    runtime, and the host caps it at 60 s. Today the docs only say "5-second
    timeout".
- **Degradation.** Mind Map always writes the allowed values into its
  descriptions too.

### Observed host issues, out of scope (flag to the owner, don't fix in this project)

- `docs/EXTENSIONS.md` lists the `open_url`, `open_path` and `send_prompt`
  result actions. `ui/js/shared/result-executor.js` handles only `copy`,
  `prompt`, `display`, `replace_input`, `refresh_widgets` and
  `open_extension_settings` for extension rows. The bookmarks extension
  returns `{type:'open_url'}` and probably doesn't open anything. A fix should
  run the host-side capability check (`urls`) and `validateExtensionInvokeArgs`.
- `requestReformat()` re-runs a formatter over up to 200 messages. A scoped
  variant (`requestReformat({ match: 'mm-' })`) would cut the cost for
  formatters with interactive cards.
- Widgets render in windows with no slot (chat), and every refresh replaces
  their DOM, so keyboard focus is lost. Fixing this needs:
  - a `widgets.floating_bottom` host feature offered only by the floating
    window;
  - identical-render skipping in `_renderWidget`.

  Neither is needed for v1.
