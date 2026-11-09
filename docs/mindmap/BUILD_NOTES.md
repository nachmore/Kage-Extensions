
## WP-H: Kage host improvements (Kage repo)

What landed, and where it differs from ARCHITECTURE.md §9 WP-H / §10:

- **H1, atomic writes.** The Rust half was already on Kage `main`
  (`src/atomic_write.rs`, used by `save_extension_data` in
  `src/commands/extensions/files.rs`: temp file, fsync, rename, directory
  fsync, Windows retry). So `src/extensions.rs` and `files.rs` are
  untouched and there's no new Rust. WP-H only adds `'storage.atomic_write'` to
  `HOST_FEATURES` (`ui/js/extension-sandbox/runtime/host-api.js`), with a
  test, and documents it (Feature detection row, plus a bullet in the
  multi-instance section, because EXTENSIONS.md has no "Extension data" section).
  Hosts that already write atomically but don't advertise the flag yet
  just keep Mind Map on twin writes. That's harmless.
- **H2, tool steering.** It stays where the block is built today, not in a
  new `extension-manager/tool-steering.js` module. `ui/js/shared/extension-manager.js`
  now exports `formatToolParam(name, def)` (it replaces the private
  `describeParam`), and its tests are in the existing
  `ui-tests/shared/extension-tool-steering.test.js`, not a new
  `tool-steering.test.js`. Output:
  `kinds (array of string, one of: note|link|doc|action|meeting, required, default: …) — …`.
  `enum` must be all strings or finite numbers, at most 12 are listed
  (`|… (+N more)`), and values containing whitespace, `|,;()` or empty
  are JSON-quoted. `required` must be literally `true`. An array prefers
  `items.enum` and falls back to its own `enum`. Malformed fields are
  dropped, and a plain def prints exactly what it did before.
  "Real timeout": §10 H2 says nothing else in the block changes, so the
  per-tool timeout is **documented** (`getToolTimeout(toolName)`, default
  5 s, host cap 60 s, asked before every call) and not printed in the
  steering text.
- **Result actions (was "Observed host issues", now fixed).**
  `ui/js/shared/result-executor.js` now handles these for extension rows:
  - `open_url` needs the `urls` capability, and only absolute `http:`,
    `https:` and `mailto:` URLs (parsed with `new URL`, sent as `href`) open.
  - `open_path` needs `launch`, which exists, so it's implemented.
  - `send_prompt` is an alias of `prompt`.

  The gate is `ExtensionManager.extensionInvokeDenial(id, command, args)`:
  extension loaded and enabled, then `decideInvoke` and
  `validateExtensionInvokeArgs`, exactly as for the extension's own
  `invoke()`. A refusal or failure is logged and the row does nothing. A
  successful open returns `{handled:true, action:'hide'}`. The docs'
  action table now matches what the host does (`prompt`, `display`,
  `refresh_widgets` added). **No host feature flag** marks this, so Mind
  Map should keep calling `invoke('open_url', {url})` itself from
  `execute()` and returning `null`/`custom` (ARCHITECTURE §1.10), which
  works on every host.
- **Widget identical-render skipping** (was out of scope, now done).
  `_renderWidget` in `ui/js/shared/extension-manager/ui.js` keeps the DOM
  when a render's `html`, `className` and `actions` are unchanged. The
  comparison also covers the date-picker wiring state and the UI language.
  It always repaints after a hidden render, the paused notice, a retry, a
  stale clear or a paint that threw. Tests are in
  `ui-tests/shared/extension-widget-repaint.test.js`. It doesn't add
  `widgets.floating_bottom`, so v1 still has no widget (SPEC §1).
- No user-visible strings changed (refusals are English console
  warnings), so there's no i18n translate run. `check_i18n.py` passes.

## WP-A: Language and organizer (`extensions/mindmap/lib/{ids,text,dates,url,entities,extract,query}.js`)

All seven are leaves (no imports, no `Date.now()` except `ids.newId`'s
default, no `Math.random`); `ids.test.js` asserts that. Interfaces are
ARCHITECTURE §5.1–§5.7 plus the additions below. Decisions where the spec
was ambiguous or self-contradictory:

- **`resolveWeekStart('auto', 'en')` is Sunday.** CLDR maximizes bare `en`
  to `en-US` (`firstDay: 7`). The fixture clock says "week start Monday,
  language en", so WP-D's acceptance setup must pass `week_start: 'mon'`
  (or a Monday locale such as `en-GB`), or AT-1's "last week" becomes
  Oct 25 – Oct 31.
- **"call" as a meeting word.** S2's meeting regex starts with `call`, which
  would make F8 ("call the Zebra team about invoices") a meeting, but SPEC
  §3.1 expects an action. `call` only marks a meeting when followed by
  nothing, `:`/a dash, or `with`/`w/`/`notes`/`recap`/`summary`
  ("call with Dana" is a meeting; "call Dana" is an action). Other meeting
  words are as specified. A one-line meeting doesn't also get itself as a
  child action.
- **Due "this <weekday>"** is this week's day, but rolls to next week when
  that day already passed ("this monday" said on a Friday is the coming
  Monday); on the day itself it is today, as specified.
- **Past-biased ranges.** `in <current month>` and `Q<current>` end at
  `now` ("not in the future"). `before X` starts at 0. `past/last N
  days|weeks|months` start at the local midnight N units ago and end at
  `now`. "the last week" / "in the past week" are rolling 7 days; bare
  "last week" is the calendar week. Bare `sat`/`sun`/`may`/`mar` are not
  dates (full names, or a day number, or `in May`).
- **Stemmer.** `(s|x|z|ch|sh)es → stem` is applied as
  `sses|xes|zzes|ches|shes`, so "houses" → "house" (not "hous") and
  "classes" → "class". Stemming is the same on both sides, so only
  consistency matters.
- **Actions.** A one-line `<Name> to <verb>` (0.6) is a `note` with one
  suggested child action, because S2 requires ≥0.8 for the item itself to
  be an action. Commitments inside a longer single line ("Lunch with Dana.
  I need to send her the JD.") become child actions of the note; the
  "I'll / I need to" test on a whole line only looks at its first sentence.
  Owner cues never name a known team or project ("Bingo will launch").
  Agent-supplied actions are `confidence: 0.6`, `origin: 'agent'`,
  suggested unless `autoAccept`; when `hint.actions` is an array, no rule
  actions are derived from the text.
- **Entities.** The person cue list adds `met`/`meet`. A single capitalized
  word right after a person cue ("with Dana"), or before "said/says", is a
  `person` candidate; single capitalized words are otherwise not
  candidates. Single-word dictionary names that are stop words (initials
  like "AN") never match. Mentions are ordered team, project, org, person,
  topic, term, then by position (this gives the F-CAP-1 preview order
  "Bingo · Dana · MTCS").
- **Query parser.** `X team|project` is read with or without a preceding
  `for|about|with|on|from`, and before `for <Name>`, so "for the bingo
  team" is the team. In the actions intent, `for X` that resolves to a
  non-person entity is a hard filter too ("my actions for bingo"). Status
  words count only in the actions intent ("done deal notes" keeps
  "done"); `overdue`/`suggested` switch the actions intent on, as do
  `due …`, `owner:`, and `is:open|done|suggested|overdue|all`. The actions
  intent defaults `owner: 'me'` and `status: 'open'` in the parser, and
  `toSyntax` leaves those defaults out, so AT-2's syntax is
  `actions @bingo` and "Show everyone's actions" is
  `actions @bingo owner:anyone`. A query that is exactly one entity's name
  (`mm bingo`) is the `entity` intent, with that entity hard and its words
  dropped from `terms`. `typeHint` passed to `resolveEntity` is a
  preference: markers (`@x`, `#x`) pass `null`, and `@bingo` must resolve
  the team.

Additions to the §5/§6 shapes (all optional for consumers):

- `Extraction.extra`: the text left after removing the URL/path of a
  link/doc capture (AT-4's "note: send to Ravi"). `Extraction.empty`: true
  when there is nothing to save (empty text and no usable window title:
  the macOS-without-Screen-Recording case of F-CAP-2).
- `extract()` scans `hint.title`, `hint.summary` and the cleaned window
  title as well as the text (mentions from them have `seg: -1`/`-2`). Link
  enrichment should re-run `extract({text, hint: {title, summary}})` to get
  MTCS-style candidates from the page title (F1).
- `Action.owner` may carry `entityId` when the person is already known.
  An email mention carries `alias` (the address).
- `QuerySpec.privateOnly` (`is:private` / `#private`). `entities[]` carry
  `name` and `type`; `terms[]` carry `raw` (the word as typed, used by
  `toSyntax`) and `phrase: true` for words of a quoted phrase.
- Extra exports: `text.wordTerm(word)` (the indexable form of one
  `scanWords` word: acronym-plural fold + stem), `entities.extendDictionary`,
  `entities.lookupKey(dict, key)`, `url.DOC_EXTENSIONS`,
  `dates.NUMBER_WORDS`, `extract.IMPERATIVE_PHRASES`, the meeting regexes,
  and `query.MINE_WORDS` / `RECENCY_WORDS`. `text._setSegmenterForTests`
  is a test hook only.

## WP-B: Data layer and retrieval (`extensions/mindmap/lib/{store,model,journal,bm25,rank}.js`, `test-helpers/mindmap/memory-host.mjs`)

All five are leaves (no imports). Interfaces are ARCHITECTURE §5.8–§5.12 plus
the additions below. 139 tests in the five `*.test.js` files.

**Store (`lib/store.js`)**
- Host status: Kage `main` already writes atomically but doesn't advertise
  `storage.atomic_write` yet (WP-H adds it). Detect with
  `hasAtomicWrites(context.hostFeatures)` and pass the result as
  `new Store({ invoke, atomic })`. Until a host advertises it, twin writes stay on.
- One raw `this.invoke(command, args)` line (in `dataInvoke`) carries the
  reviewed `// kage-sensitive-data: not-sensitive` annotation, in place of
  three annotated lines. `check:security` then reports a warning and no error
  even when `mind.js` writes computed keys
  (`store.write(model.partKey(part), …)`). Without it, any computed key fails.
- Additions: `readRaw(key)` (for "Export raw copies"), a `store.readOnly`
  flag (data `write`/`remove` throw `StoreError('readonly')` unless called
  with `{ force: true }`, which is for Repair and Delete everything; lock
  writes still work), `ATOMIC_FEATURE`, `TWIN_PREFIX`, and `stats` also
  counts `reads`/`writes`.
- `readBest` decision table. A valid copy is a JSON object with a numeric
  `rev`; pass `{valid}` to change that.
  - Both copies valid: the higher rev wins, the primary on a tie.
  - Primary missing, twin valid: take the twin.
  - **Primary missing, twin torn: missing, not unreadable.** The primary
    write is the commit point, so that state can only mean a crashed first
    write of the key, and treating it as unreadable would make every crashed
    new-month write read-only.
  - Primary torn and twin torn or missing: `unreadable`.
  - `remove` deletes the twin first, so an interrupted delete never
    resurrects a stale twin.
- Lock. The host has no compare-and-set, so I added Fischer's settle delay
  to the stocks write-then-reread pattern:
  - after writing `{owner, nonce, expiresAt}`, wait max(20 ms,
    3 × observed invoke round trip) before re-reading the nonce;
  - waiters poll at 15–40 ms;
  - a window that just released waits 60 ms before taking the lock again,
    so a waiting window gets a turn;
  - expiry is wall-clock (`now`), while waits, renewals and the throttle use
    `performance.now()`, so tests that pin `Date` still run.
  - `lease.check()` renews automatically after 1.5 s.
  - `withLock` calls from one window queue. It is **not reentrant**: don't
    call it from inside `fn`.
  - Measured: two windows × 25 contended increments lose nothing, at about
    76 ms each.

**Model (`lib/model.js`) and journal (`lib/journal.js`)**
- Refusals and no-ops return `{op: null, touched: ∅, code}` and need no
  saving. Codes: `not_found`, `not_action`, `bad_status`, `noop`, `same`,
  `me`, `conflict`, `bad_format`, `future_schema`. `applyUndo` returns the
  `canUndo` code.
- Op label codes, for WP-C/WP-D i18n: `capture`, `capture_dedup`,
  `status_done`, `status_open`, `dismiss`, `accept`, `edit`, `privacy_on`,
  `privacy_off`, `delete`, `enrich` (silent), `reextract` (silent, op kind
  `enrich`), `annotate`, `merge`, `forget`, `rename`, `import`, `undo`.
  Params hold only ids and counts (`itemId`, `count`, `entityId`, `opId`,
  `kind`). Titles come from state, or from `op.before` once deleted.
- Change additions:
  - `pendingAliases`, the long forms whose short form isn't an entity yet.
    **Always call `applyPromotions`, even with an empty promote list.**
  - `result: {annotated, rejectedActions, truncated, linkDupes}`.
  - `applyAnnotate` returns `{applied, rejected, childIds}`, where a
    rejection is `{id, reason: 'not_found'|'private'|'quote_not_found', text?}`.
  - `applyDelete` returns `deleted`, and `applyImport` returns
    `result: {added, updated, skipped}`.
- Extra exports: `KINDS`, `ENTITY_TYPES`, `STATUSES`, `LIMITS`,
  `partKey(part)` / `keyPart(key)` ('items:2026-11' ↔ 'mm-items-2026-11'),
  `listParts(state)`, `normalizeItem`. `payloadFor(state, 'meta')` also
  works (counts recomputed).
- Extra env fields:
  - `enrichLinks: false` (fetch_link_titles off) makes new links
    `enrich: {state: 'none'}`;
  - `autoAccept` applies to `applyAnnotate`;
  - `replaceRule` (P2 re-derivation) removes rule mentions that are no
    longer found;
  - `lib.text` is optional; built-in fallbacks follow
    `normalizeKey`/`containsQuote`.
- Record additions:
  - action items carry `origin: 'rule'|'agent'|'user'` (AT-11's "origin agent");
  - a user kind edit sets `kindSource: 'user'`, which agents can't override;
  - a candidate may carry `aliases`, the pending long forms.
- Rejection conventions: `{s:'*', t:<entity key>, type:'entity'}` (`mm
  forget`: never create or link that key) and
  `{s:<itemId>, t:<entityId>, type:'mention'}`.
- Candidates are snapshotted by `applyCapture`/`applyReextract` for the keys
  in `extraction.candidates`. To keep undo exact, call
  `entities.bumpCandidates(state.candidates, x.candidates, itemId, now)`
  with that same list, after the apply. The journal groups add
  `candidates`, `links` and `rejections` to `before`/`created`;
  `op.cand` holds candidate signatures.
- Idempotent re-apply works like this:
  - every id an op could need is drawn up front, in an order fixed by the
    inputs (one `e` per mention, per object-shaped action owner, and per
    promotion);
  - a re-applied op reuses its earlier attempt's before-snapshots when that
    attempt's journal landed;
  - records the op creates are rewritten at rev 1;
  - unchanged records keep their rev;
  - annotation lines and mentions are never added twice.
- Undo:
  - later **silent** ops (link enrichment) don't supersede an earlier op;
  - entities the op created are deleted only when nothing still mentions them;
  - undoing ops in reverse order walks back one at a time.
  - An op larger than the 256 KB journal on its own keeps its created ids
    but drops its snapshots (`lossy: true`, not undoable). A 200-item
    back-fill of long notes can reach that.
- Dedup:
  - the annotation text is extract's `extra` when present;
  - a URL inside a dump that is already saved doesn't become a second
    child (`result.linkDupes`);
  - a private re-capture makes the existing item private;
  - the `me` entity's aliases are never persisted.

**BM25 (`lib/bm25.js`)**
- `search` hits also carry `matched` (the indexes of the query terms they
  matched), which `rank.js` uses for AND-first matching.
- `fieldHas(id, field, term)` is added.
- `similar` queries with the document's 32 highest tf·idf terms.
- **Deviation:** a one-character prefix term matches exactly instead of
  expanding (`PREFIX_MIN = 2`). Expanding `mm a` pulls in the 20 most common
  words, costs about 30 ms at 10k items and ranks noise.

**Rank (`lib/rank.js`)**
- ctx contract: `aliasTerms(entityId)` must return the entity's **own name
  tokens with `w: 1`** plus alias tokens with `w < 1` (0.7). The name tokens
  are how a mentioned entity counts as matching the query words that spell
  it.
- Defaults:
  - `runActions` owner `null` means `me` (`anyone` for `status: 'suggested'`,
    i.e. review);
  - status `null` means `open`, which also returns done actions from the
    last 14 days;
  - `dismissed` actions never appear;
  - groups follow first appearance in the ordered list, with Other (`null`)
    last.
- Behaviour:
  - `spec.privateOnly` (`is:private`) is honoured.
  - A `range.soft` range is a +0.2 boost, not a filter.
  - When every relaxation step is empty, `hiddenPrivate` is the count for
    the query as asked.
  - At most 30 positive terms and 30 entities take part in matching (bit
    masks).
- Measured at 10k synthetic items: 0.1–4 ms for realistic queries (filtered,
  or a selective term). A term present in half of all documents is about
  8 ms.
- End-to-end smoke, not committed: the SPEC §3.1 corpus through WP-A's
  `extract` and `parseQuery`, then these modules. It reproduces AT-1, AT-1b,
  AT-2, AT-2b and AT-5 exactly.

**Memory host (`test-helpers/mindmap/memory-host.mjs`)**
- `connect()` returns a second window's `{invoke}`: the same files, with its
  own 100/s rate window, as each Kage window has its own sandbox. **AT-9
  should give each Mind its own `connect()`**. Two Minds on one `invoke`
  share a rate window, hit the host limit and stall for about 1 s per retry.
- `revive()` ends a `crashAfterWrites` crash.
- `corrupt(key, 'torn'|'empty'|'null')`.
- Every `calls` entry carries `window`.

**Repo tooling bug (flag to the owner, not fixed here).**
`scripts/lib/check-sensitive-data.mjs` overflows the stack (RangeError) on a
self-referential spread reassignment such as
`let x = spec; x = { ...x, k: v }`. `members()` doesn't carry `seen` through
spread elements. `rank.js` avoids the pattern. **WP-D: avoid it in `mind.js`
and the entry points, or `check:security` crashes.**

**Lease loss and retries.** Under a host or CPU stall longer than the
settle delay, a late lock write can still get through. `lease.check()` then
throws `StoreError('busy')` before the losing window writes. Callers retry:
mind.js should retry a mutation on `busy` (a few times, with jitter) rather
than surface it at once. `store.test.js` models exactly that.

**Commit note.** The WP-B files landed in `2f393e2` (the WP-C commit),
because they were staged in the shared index when that commit ran; the
content is final. `dc57dda` is an empty WP-B marker commit. Stage and
commit in one step with the same pathspec.

## WP-C: Presentation (`extensions/mindmap/{view.js,styles.css}`, `lib/graph.js`, `docs/mindmap/i18n/view.en.json`)

`view.js` imports only `./lib/graph.js` (one static single-line import),
and `graph.js` imports nothing. `view.test.js` asserts both and checks that
view's local copies of the citation and card patterns match `lib/ids.js`.
The suite is 93 tests across `lib/graph.test.js`, `view.test.js` (jsdom)
and `styles.test.js`. Everything was also rendered in headless Chrome
through the host's real `sanitizeExtensionHtml` and CSS gate (from
`extension-manager/sources.js`), inside copies of the floating and chat
window CSS, light and dark, with clicks routed the way the host routes
them. The gate keeps all 162 rules. The harness and its screenshots are
not committed.

**For WP-D (wiring)**
- `formatter.js`:
  `view.formatHtml(html, mind.port, { t, locale, rtl, canReformat, requestReformat, trigger, log })`.
  When it renders placeholders (port not loaded) it calls
  `port.ensureLoaded()` once, then `ctx.requestReformat()` if
  `canReformat`. The wrapper doesn't need to do that itself. `trigger` is
  the configured keyword, used in the help card and the old-host note.
- `search.onResultAction(id)`:
  `const p = view.parseAction(id)`.
  - When `p.scope === 'data'`, the verb is
    `done|reopen|accept|dismiss|undo|open|private|share|delete` with `p.id`.
    Run it on mind, then `requestReformat()`.
  - Otherwise, `if (view.applyUiAction(view.ui, p).changed) mind.requestReformat()`.
  - `parseAction` returns `null` for anything outside ARCHITECTURE §7.2.
- **DataPort additions** (all optional):
  - `changedSince(sinceRev, ids) → boolean`. Without it, every `rev` bump
    re-renders every card and chip in up to 200 tracked messages, and the
    user loses focus each time. With it, only the affected cards change.
  - `port.map(focus, page)` should build the `lib/graph.js` ctx and call
    `graph.neighborhood(focus, {...ctx, page})`. To highlight matched terms
    on the centre card (SPEC §9.3), set `neigh.center.highlight = [words]`.
  - `CiteVM.day`, `ItemVM.day` and `OpVM.dedupedInto.day` may be epoch ms
    (formatted here) or a ready string. `ItemVM.doneAt` is used when present.
- **OpVM.code** takes WP-B's label codes (`capture`, `capture_dedup`,
  `status_done`, `status_open`, `dismiss`, `accept`, `edit`, `privacy_on`,
  `privacy_off`, `delete`, `annotate`/`enrich`/`reextract`, `merge`,
  `forget`, `rename`, `import`, `undo`). Unknown codes say "✓ Done".
  `dedupedInto` takes precedence: "Already saved Mon, Oct 26 · note added".
- **graph ctx `overview()`**:
  - `teams`, `projects`, `people` and `topics` are arrays of `{id, n}`
    (`n` = items in the last 90 days), or bare ids (degree is used);
  - `recent` is item ids, newest first;
  - `reviewCount` and `openCount` are numbers (zero hides the node);
  - `counts: {items, entities}` is optional, for the centre card.
  `cooccur` may include `'me'`; it isn't filtered.
- **Extra exports for `search.js` rows**:
  - `itemIcon(vm)` (action state icons included);
  - `kindLabel(kind, t)`, `etypeLabel(type, t)`;
  - `doneText(doneAt, {t, locale})` gives "done Wed, Nov 4";
  - `rangeLabel(range, {t, locale})`;
  - `fmtRange(start, endExclusive, locale, {t, short})`, where `short`
    drops the weekday ("Oct 6 – Nov 6");
  - `relaxText(..., {trigger})`. For the actions intent with code `none`
    it gives AT-2b's "No actions found for “walrus”".
  - `interpLabel` reads `spec.entities[].name/type`, `terms[].raw/phrase`
    and `privateOnly` from `lib/query.js`, falling back to
    `nameOf`/`typeOf`.
  - Precedence: an unknown team or project first (AT-2b), then a
    relaxation (AT-1b), then "🔎 …". It returns `''` when nothing was
    understood, so the row is skipped.
- **Neighbourhood shape additions** (ARCHITECTURE §6.6):
  - `NodeVM.group: 'item'|'entity'|'more'|'stat'|'overview'`, with
    `at`, `dueAt` and `doneAt`. Stat nodes carry `count`. More-nodes carry
    `more` (count after this page), `hidden` and `wrap` (last page:
    "↺ First").
  - `Lane.total` is added. An action's item focus uses lane role `parent`
    ("From").
  - The entity centre carries `counts {items, actions, suggested, docs, notes}`.
  - The item centre carries `snippet`, `day`, `app`, `url` and `path`.
  - Paging wraps: `page % pageCount`.
- **Fragment.** `docs/mindmap/i18n/view.en.json` holds the namespaces
  `card`, `map`, `cite`, `kind`, `etype`, `due`, `range`, `relax`, `chip`
  and `help`, with no `_meta`. Merge it into `_locales/en/messages.json` as
  is. Dynamic lookups carry `// i18n-keys:` hints (`kind.*`, `etype.*`,
  `map.lane_*`, `map.empty_*`).

**Deviations from SPEC / ARCHITECTURE, and why**
- **Map geometry.** At Kage's default floating width (570 px window,
  about 460 px response area), SPEC §9.2's grid with 24-character
  one-line labels truncated almost every action and note ("Send MT…").
  What I did instead:
  - partial lanes are centre-justified (1 node at 50%, 2 at 34/66, and so on);
  - node labels wrap to two clamped lines, and the JS cap is 40 characters
    (the full text is in `title` and `aria-label`);
  - up/down max-width depends on density: 30% for up to 3 nodes, 20% for
    4, 15.5% for 5;
  - the side lanes sit at **x 14/86** (spec 12/88) with 26% max-width and
    step **y 27/42/57/72** (spec 28/44/60/76), so two-line labels clear
    the centre card and the corner nodes of the up/down lanes;
  - nodes use `width: max-content`, because an absolute box near the right
    edge otherwise shrink-wraps to the space left of its `left:`.

  Up and down keep y = 12% / 88%, the centre stays 36% wide, and the stage
  is 264 px. Positions are classes (`mm-x-*`, `mm-y-*`, plus the
  `mm-s-<slot>` id). RTL mirrors x in `layout()`, so the CSS uses physical
  `left`/`top` there and logical properties everywhere else.
- **Sanitizer allowlist** is SPEC §10.2 plus two attributes the host
  sanitizer also allows:
  - `dir` (`ltr` on code, URLs and paths per SPEC §14; `rtl` on the map
    card when the UI is RTL);
  - `open` on `<details>` (list mode).

  Interactive SVG isn't used. Edges are `<line>`s with % coordinates and no
  `viewBox`. User text uses `unicode-bidi: plaintext`, so English titles
  read correctly in an RTL card.
- **DOM order vs. the header.** The DOM order is: centre, up, left,
  right, down, list, then the header bar. SPEC §9.4 asks for controls after
  the lanes. The bar is shown on top with `order: -1`.
- **Related items in op and item cards** are chips that re-centre that
  card as a map (`mm:b<blk>:f:<id>`), not numbered `[n]` cite chips.
  Numbered chips need a message's numbering state, and navigating is the
  more useful click. The item card leaves its own actions and parent out
  of Related.
- **"Map" on an op or item card** turns that card into a map focused on
  the item. Back at the root of its history returns to the card.
  Re-centring from a card's entity chip works the same way. A breadcrumb
  click on an earlier focus truncates the history to it instead of pushing
  a duplicate. History holds at most 20 entries.
- **Overview count nodes** ("1 to review", "7 open actions") are
  non-interactive `<span>`s. The action grammar has no verb for them, and
  formatter actions can't fill the launcher. Their tooltip says
  "Type mm review to see them".
- **List mode** hides the stage, and the `<details>` list opens. In map
  mode the list stays in the DOM, collapsed, as SPEC §9.4 asks.
- **Older hosts** (`canReformat: false`): nodes render as `<span>`s, there
  are no Back/Home/List buttons, and the footer says "Update Kage to
  navigate the map — or use mm @name". Open still shows, because it works
  through `invoke`.
- **❔ is outlined** with a `text-shadow`. Emoji fonts draw it white, and it
  nearly disappears on light surfaces.
- **Fast path.** `formatHtml` decides "nothing to do" from the serialized
  classes (`mm-b/r/d`, chip `mm-m/r/d`) without building a DOM, so a
  reformat pass over 200 messages stays cheap. Anything unusual takes the
  full pass. A test asserts no `DOMParser` use on unchanged messages.
- **State recovery.** Block and message counters are base36, seeded from
  the clock, so a reloaded sandbox never reuses a card's id. A click that
  arrives for a card the state no longer knows is queued and applied on
  the next pass, rebuilt from the card's classes.
- `[mm-card:map]` with no ref is the overview. Markers whose ref doesn't
  fit the card type (`op` needs an op id, `item` an item id) stay text.
- `styles.test.js` also allows `@supports` (needed: a custom property
  can't fall back from `color-mix()`) and `@keyframes mm-*`, and it
  forbids `!important`.

## WP-D P0: Integration and entry points (`manifest.json`, `defaults.js`, `mind.js`, `search.js`, `tools.js`, `formatter.js`, `settings.js`, `README.md`, `_locales/`, the WP-D tests, `test-helpers/mindmap/corpus.mjs`)

Commits: `d60a4cb` (entry points, mind, EN catalog,
acceptance suite), `4998f91` (module tests and the fixes they found), and
the P0 closing commit `7746e87` (README, 31 translations, all-locale test). Two
interrupted attempts had left most of the code uncommitted; it was kept
after review and testing.

**What P0 proves**
- `acceptance.test.js` builds the SPEC §3.1 corpus through `search.match`
  → `execute` on the fixture clock and runs AT-1, AT-1-agent, AT-1b,
  AT-2, AT-2-agent, AT-2b, AT-3, AT-4, AT-5, AT-7, AT-8, AT-9, AT-10 and
  AT-11 as written. AT-6 (map card) is P1 and not asserted.
- The same file renders the owner's two queries, the home rows, AT-1b,
  AT-2b, `mm @bingo`, `mm undo`, the F6 preview and an op card in all 32
  catalogs and fails on any leftover `{placeholder}` or raw key name.
- `host-loader.test.js` models the older two-pass loader (strict:
  entries → composers → leaves). A local host-load harness (not
  committed) loads every entry in headless Chrome through Kage
  origin/main's real loader for the floating, chat and settings windows;
  its log is not committed either.
- Budgets measured: `match()` for AT-1 well under 10 ms on the corpus; a
  warm capture commits in ~80 ms (16 invokes). Bursts faster than ~4
  captures a second wait ~0.7 s for the 70/s client throttle.

**Deviations and decisions**
- **Leaf annotations (21 lines in WP-A/B leaves, comment-only).** Once a
  manifest exists `check:security` scans mindmap, and it treats every
  object literal whose `type:` value it can't resolve as a possible
  settings control ("Settings control has unresolved type"). The leaves
  build many such records (`{ type: m.type, … }`). Each carries a reviewed
  `// kage-sensitive-data: not-sensitive` line, so CI shows 27 annotation
  warnings (21 in entities/extract/model/query, 5 in mind.js, and WP-B's
  own on the store's raw invoke). Restructuring
  the leaves to dodge the analyzer would have been riskier.
- **Repo test touched:** `scripts/check-sensitive-review.test.mjs` "inventories
  every real relative import" assumed flat extensions and pinned 75
  imports. It now lists files recursively (skipping `_locales/`) and
  expects 101 (75 + mindmap's 26). Every import still resolves to an
  analyzed module.
- **WP-C files touched:** `docs/mindmap/i18n/view.en.json` is merged and
  deleted (ARCHITECTURE §2); `view.test.js` reads `_locales/en/messages.json`
  and its namespace check is scoped to WP-C's namespaces.
- **Version** is `0.1.0` (SPEC §1); an earlier attempt had `1.0.0`.
- **Translations.** Kage's `scripts/translate.py` hard-codes
  `../Kage-Extensions/extensions`, so it ran unmodified from a temporary
  staging copy whose extensions directory holds only a link to this
  checkout's `extensions/mindmap` (`--catalog extensions`, 31 languages, 12,307
  strings, 0 failures). Afterwards 30 agent-facing entries
  (`tool.search_from`, `tool.search_to`, `tool.actions_due_before`) had the
  literal `YYYY-MM-DD` restored where it had been localized (`JJJJ-MM-TT`
  …); the `_source_hash` values are untouched, and a dry re-run reports
  nothing pending. P1/P2 must re-run it after adding EN keys (only new or
  changed keys are sent).
- **Tool results.** Every result, errors included, carries the SPEC §11
  `note`. `capture` puts its undo hint in a separate `undo` field.
  Unknown `assignee`/`entity` names come back as `unresolved` plus
  `suggestions`. `search` reports an unknown `entity` in
  `scope.unresolved` instead of ignoring it.
- **Rows.** The 🔎 / ⚠️ glyphs are the row `icon`, not part of `label`
  (the host draws the icon). A one-line action's preview doesn't count
  itself ("☐ action · Bingo", not "· 1 action"). The undo label for a
  status change reads "Undo: Marked “…” done". AT-2b also shows the
  everyone and ask rows. Displays without a card have no empty token
  paragraph.
- **`owner:<name>`** lists that person's open actions only; their
  suggestions show with `is:suggested` or in `mm review` (SPEC §8.2).
- **Entity header Enter** shows the map card centred on the entity (the
  map card exists from WP-C) rather than a plain item list.
- **Import JSON** reports item counts; `applyImport`'s counts include
  entities, so mind.js counts items itself.
- **`syncIfStale`** reloads at once after a write failed mid-way, rather
  than serving the unsaved change for up to 1.5 s.

**Already wired beyond P0 (from the earlier attempts; smoke-tested, not
acceptance-tested)** — P1/P2 agents should verify and test these rather
than rebuild them: `mm map [entity|item|query]` and entity-header map
cards, chip docking (view.js), `mm?` (`askPrompt`, privacy-tested by
AT-5), the `annotate` tool, Export Markdown, `mm organize`,
`mm merge/forget/rename`, Import JSON (settings test round-trips an
export), idle re-derivation (`rederive`), the enrich retry 20 s after
load, and same-window context edges in `related()`. AT-6 has no test yet.

**For P1/P2**
- Test helpers: `makeHarness({ config, formatter, hostFeatures, i18n })`
  (floating window: search + tools + formatter on one Mind), `buildCorpus(h,
  { only })`, `captureVia`, `makeI18n(catalog, { language, rtl })`, and
  `makeContext(host, { invoke: host.connect().invoke })` for a second
  window.
- Pin time with `vi.useFakeTimers({ toFake: ['Date'] })`; the store's lock
  and throttle use `performance.now()` and real timers.
- Host-load harness (local, not committed): `node run.mjs [<rev>]`, the
  working tree when no rev is given (plans are at the bottom; `$OP`/`$HIT`
  are filled from earlier rows).
- Known cosmetic nit (WP-C): the interpretation chip for a quoted phrase
  reads `“"rollout plan"”`.

## WP-D P1: map card and `mm map`, chip docking, `mm?`, `annotate`, Export Markdown

Commits: `f5a839a` (code + 31 translations),
`e7c1cb4` (acceptance and module tests, and the fixes they found),
`ac11661` (sync/write race fix), `e14732d` (i18n-keys hint), `e03da6b`
(README). P0 had already wired most of P1 (BUILD_NOTES WP-D P0, "Already
wired beyond P0"); P1 verified it in tests and in the real host, then fixed
what that turned up.

**What P1 proves**
- `acceptance.test.js` AT-6 exactly as SPEC §3.4 states it — `mm map bingo`
  → up Dana/MTCS, left 3 actions + "+2 more" (4 open + 1 suggested), right
  the "No docs yet" hint, down F6 and 🔒F10 — and clicking Dana re-centres
  with the trail "Bingo › Dana". Also: paging and wrap, Back/Home/crumbs, List
  view, DOM order (centre → up → left → right → down → controls), op/item
  card **Map** buttons (Back returns to the card), the entity header and the
  home row, `mm map <words>` (top hit, highlighted words), `kind:` passed to
  the lanes, toggling an action from the centre card, the chat window
  (placeholder → load → map), and the static map on hosts without
  `context.formatter`.
- Chip docking: Map on a chip docks one map card at the end of the message;
  Map on another chip re-centres that same card (with a trail); private chips
  dock locally and never show a title.
- `mm?` for both owner queries (record lines exactly as SPEC §12 specifies),
  the relaxed case (AT-1b) and the empty case; the agent's cited reply
  becomes chips.
- `annotate` end to end: applied/rejected (quote_not_found, private,
  not_found), existing vocabulary reused, agent entities created and
  back-filled, actions as suggestions, meta summaries never overwritten, one
  `mm undo` removes the lot.
- Export Markdown's structure on the corpus; the all-locale test also
  renders the map rows, the map card (and every aria-label/title), the `mm?`
  prompt template and the export headings in all 32 catalogs.
- Budgets: map neighbourhood + HTML at 10,000 items (median of 5) entity
  5 ms, item 21 ms, overview 3 ms (budget 30 ms); ~3 ms per map render on
  the corpus.
- `npx vitest run extensions/mindmap`: 23 files, 734 tests. `npm test`: 62
  files, 1853 tests. `npm run check:all`: exit 0 (27 reviewed-annotation
  warnings, as in P0).
- Real host: the host-load harness (P0 plans unchanged, plus P1
  plans) loads every entry through Kage origin/main's real loader, applies
  formatter output through the host's real `sanitizeExtensionHtml`, routes
  clicks to `onResultAction`, and re-runs the formatter on each
  `reformat-request`. In the floating, chat and an Arabic RTL window it builds
  the corpus on the fixture clock and drives AT-6 (Dana click → "Bingo ›
  Dana"), paging, list, Home/Back, the op card → map, chip expand → dock →
  re-centre, `mm?`, annotate → undo and Export Markdown. Every click produced
  one reformat request and the sanitizer kept every `data-ext-action`
  (e.g. 18/18). Screenshots p1-01…p1-16 (not committed) are
  rendered in Kage's floating/chat CSS with `styles.css` through the real
  CSS gate (168/168 rules kept, no node overflow or overlap). The run log
  is not committed.

**Fixes and decisions**
- **Race (data loss), found by the host-load run.** `_mutate` set `_stale`
  just before persisting, and an unlocked `syncIfStale()` (any launcher
  keystroke, tool call or formatter pass) took that for a failed write and
  reloaded mid-persist. Its reads (slowed by the invoke throttle) returned
  after the write committed, so the window's memory went back to the
  pre-write record — a link's fetched title vanished — and the next write of
  that month put the old record back on disk. An unlocked sync still reading
  when a capture started could likewise merge an older shard over the new
  item. Now `syncIfStale` skips while this window writes and coalesces
  concurrent calls, every write (and Delete everything / Repair) first waits
  for a sync already reading, and a failed write reloads inside the lock.
  `mind.test.js` reproduces both interleavings deterministically (both fail
  without the fix).
- **`mm?` honesty.** When the notes come from a widened or relaxed search,
  the prompt's scope says so (`prompt.scope_widened` with the widened
  dates, `prompt.scope_relaxed` otherwise) and the launcher row reads
  "Nothing matched exactly — sends the N closest notes"
  (`row.ask_found_relaxed`). Before, the scope claimed "from 2026-11-05 to
  2026-11-05" over notes from October.
- **`mm map <words>` with no match** keeps the overview but says "Nothing
  matched “…” — showing the overview" (`row.map_nomatch`).
- **annotate**: entities the agent introduces are back-filled onto earlier
  items that name them, in the same op (SPEC §5 S4 lists explicit, owner and
  promotion; agent entities were missing). The undo label counts items
  changed, not entries sent (`model.applyAnnotate` counts entries; mind.js
  corrects it, so WP-B's model is untouched).
- **Export Markdown** goes beyond the SPEC §7.7 minimum so the file reads on
  its own: child actions nest under their note or meeting, and each item's
  own words (summary, text beyond its title, dated notes) follow it once as
  a `>` quote — in the first section that lists it — instead of being lost.
  Private items are included and marked (the user's own file, like Export
  JSON). Links encode `(`/`)` (which `encodeURIComponent` leaves alone and
  which ended the link); body lines can't start a list, heading or rule. The
  settings status says "Exported N items as Markdown" (`settings.exported_md`
  changed).
- **Translations**: the 4 new keys and the 1 changed one were translated
  with Kage's unmodified `translate.py` from the same staging directory
  as P0 (155 strings, 0 failures); placeholders and plural forms checked in
  all 31.
- **Harness only** (nothing in the extension): a `Date` shim inside the
  sandbox iframe sets the fixture clock by `postMessage`; the CSS gate is
  extracted from `sources.js` (it's module-private); the chat message
  entrance animation is disabled in the screenshot viewer; the P1 windows
  use `week_start: 'mon'` like the tests.

**For the owner / P2**
- With default settings the real host reads "last week" as Sun–Sat: Kage's
  UI language is plain `en`, and `week_start: auto` asks
  `Intl.Locale('en')` (CLDR: Sunday). That follows SPEC §8.3 and
  OPEN_QUESTIONS Q9, but a European user on an English UI gets Sunday weeks
  unless they set "Week starts on". The owner's two queries still return F1/F2
  and the Bingo actions on the corpus.
- Cosmetic (WP-C layout): in the overview's bottom lane at 570 px, the "1 to
  review" and "5 open actions" stat nodes sit edge to edge (no overlap).
- `mind.syncIfStale()` now returns `false` while this window is writing; a
  P2 caller that needs fresh data mid-write should go through `_mutate`.
- Still smoke-tested only (P2's scope): `mm organize`, merge/forget/rename,
  Import JSON beyond the settings round-trip, `rederive`, the enrich retry
  and same-window context edges.

## WP-D P2: organize, merge / forget / rename, archive, Import JSON, re-derivation, enrich retry, context edges

Commits: `bbc9669` (organize, entity-command
cards, archive, help line, 18 strings × 31 languages), `b4cf3fb` (Import
JSON, re-derivation, enrich retry, context edges, 1 string), `4eec6bf`
(README, idle-work jitter), and `d4407c8` (one journal slot per
enriched link). P0 had wired most of P2 (BUILD_NOTES WP-D P0,
"Already wired beyond P0"); P2 tested it end to end and in the real host and
fixed what that showed. Every P2 item in SPEC §2 is done.

**What P2 proves**
- `acceptance.test.js` (each on its own corpus copy): `mm organize` (the
  prompt lists exactly the 9 organizable corpus items newest first, F10 and
  "salary" never appear, the vocabulary line, annotated items leave the
  list and `mm undo` brings them back, names known only from private notes
  never reach the vocabulary, the "Everything is already organized" row);
  `mm rename` / `mm merge` / `mm forget` (rows, op cards, Undo rows, alias
  behaviour, merged owners, a forgotten name not re-created by an explicit
  "Zebra team", rename onto a taken name, "me" refused); archive (`mm
  archive <words>`, op card + Undo, gone from AT-2's list, search, the map,
  the agent's search and actions tools, kept in Export JSON, `mm archived`
  with word filtering, Enter restores, `mm undo`); Import JSON through the
  settings window's `onFileSelected` (an export from another computer
  joins Bingo/Dana/MTCS instead of duplicating them, re-import changes
  nothing, newer copies win, older don't, a second window sees it, one `mm
  undo` removes it, bad and future-schema files). The all-locale test also
  renders the P2 rows, the help line and the organize prompt in all 32
  catalogs.
- `mind.test.js`: enrich retry on a later load (pending → fetched, failed
  ≥1 h ago → retried, failed 30 min ago → waits, failed 17 days ago → given
  up, silent, re-organized, reformat requested, other window sees it,
  `fetch_link_titles` off fetches nothing, nothing to do schedules nothing);
  re-derivation with a simulated organizer upgrade (`new Mind(ctx,
  { extractorVersion: 2 })`): a stale rule mention is dropped, user/agent
  names stay, a child keeps its parent's Bingo, names from a page title or
  window title survive, one compact silent op, Undo still targets and can
  undo the user's last op, a second window finds nothing to do); context
  edges (same window within 10 min only, shown on the map, never the window
  title to the agent, none with `record_source_window` off).
- `npx vitest run extensions/mindmap`: 22 files, 754 tests. `npm test`: 62
  files, 1874 tests. `npm run check:all`: exit 0 (29 reviewed-annotation
  warnings: P1's 27 plus one on the entity-op card view model and one on
  the inherited-name mention re-derivation adds).
- Real host: the host-load harness gained P2 plans (p2-floating,
  p2-settings, p2-after-import, p2-retry) run through Kage origin/main's
  real loader and sanitizer: organize → annotate → undo, rename / merge /
  forget op cards with their Undo buttons clicked (one reformat request
  each), archive and restore, the help line, Import JSON in the settings
  window then seen and undone from another window, and a pending link title
  fetched ~20–30 s after a later load. The screenshots
  (p2-0{1,2,3}) and the run log are not committed.

**Fixes and decisions**
- **`mm organize` resent annotated items forever**: it skipped only items
  with an agent summary. Now an item counts as organized once annotate has
  touched it (`enrich.state === 'done'`); for http links, whose page
  metadata also sets `done`, only an agent trace counts (agent summary,
  terms, agent mentions or agent child actions). Items show title — summary
  — text (a link used to show only its URL), and the vocabulary counts only
  items the agent may see.
- **Entity-op cards** showed the first item the op relabelled. `opVM` now
  returns the entity (merge target, renamed, or the forgotten one from the
  op snapshot) and no item; `opSummary` returns `from` so labels read
  "Merged Danak into Dana" / "Renamed Zebra to Zebra Crew" (`op.merge` and
  `op.rename` changed, retranslated). A rename refused with model code
  `conflict` (another entity has the name) says "combine them with mm
  merge" instead of the write-race text (`err.rename_taken`);
  `not_found` says the name is gone (`err.entity_missing`).
- **Archive UI, within WP-D files.** SPEC lists "archive" for P2 without a
  surface; `view.js` (WP-C: item card buttons, `DATA_VERBS`, help card),
  `lib/query.js` (WP-A: `COMMANDS`) and `lib/rank.js` (WP-B: archived is
  always excluded) are other packages' files. So archive is launcher-only:
  `mm archive <words>` / `mm archived [words]` / `mm unarchive [words]` are
  recognised in `search.js` by the first word, before parsing, like the
  parser's own commands (so `mm archive` can't search for the word
  "archive", as `mm review` can't). The op is model `applyEdit` relabelled
  `archive`/`unarchive` for Undo rows; the card shows "✓ Updated"
  (view.js has no archive headline). Archiving a note leaves its child
  actions as they are. **Follow-up for WP-C:** an Archive/Restore button on
  the item card (new `mm:a:archive|unarchive` verbs routed to
  `mind.setArchived`), and the P2 commands in the help card.
- **Help**: `mm help`'s display adds one line after the card, "More: `mm
  organize` · `mm archive …` · …" (`help.more`), since the help card is
  WP-C's.
- **Import JSON** (SPEC §7.7 says ids dedupe; it doesn't say names): an
  export from another computer has other random ids for the same people
  and teams, so a plain import split "Bingo" in two (and `mm merge @bingo
  into @bingo` can't fix that). `mind._unifyImport` rewrites the incoming
  file first: an incoming entity whose key or alias resolves here
  (`model.entityByKey`, as a capture would) becomes that entity in the
  items' `entityIds`, `mentionOrigin`, `owner`, links, rejections and
  `mergedInto`; the incoming duplicate entity record is dropped (its
  aliases aren't merged in). The Undo label counts items, not entities,
  and a file that changes nothing says "Everything in that file is already
  here" (`settings.import_nothing`). The host ignores `onFileSelected`'s
  `host: refresh`, so the stats refresh on the next render.
- **Re-derivation** had four bugs: it re-extracted without the item's
  title/source, so `replaceRule` dropped names that came from a page title
  (F1) or window title (F2); it removed the names children inherit from
  their parent (AT-2's "book the offsite" lost Bingo); a version the
  extractor doesn't stamp would loop forever; and 200 per-item silent ops
  per batch pushed the user's whole undo history out of the 200-op
  journal. Now it reads each item with `hint {title, summary, terms}` and
  `source`, adds the parent's entities as dictionary mentions for
  children, processes parents first, tries each id once per run, and folds
  a batch into **one compact silent op** (`_silentBatch`: revs and created
  ids, no before-snapshots, `lossy: true`) — `canUndo` of earlier user ops
  still passes because the later op that moved their revs is silent. An
  empty extraction only bumps `v` (keyphrases kept). `new Mind(ctx,
  { extractorVersion, idleDelayMs })` are test seams.
- **Enrich retry**: was pending-only, which never helps the common case (a
  capture made offline is marked `failed`). Now pending links, and failed
  ones whose last attempt is ≥1 h old and whose capture is ≤7 days old, are
  retried (newest first, ≤20 per load), after a `syncIfStale(0)` so a
  window doesn't refetch what another already did; the host's link cache
  absorbs duplicates. Idle work starts 20–30 s after the first load,
  jittered per window, once per load (`runIdleWork` = `retryEnrichment` then
  `rederive`).
- **Link enrichment** journalled two silent ops per link (fetch and
  re-organize), so each saved link took three of the 200 undo slots; they
  now share one compact silent op (`_silentBatch`), as re-derivation does.
- **Context edges** used a scan of every item per `related()` call; now a
  `byWindow` index (title → ids), weight 0.5, and a child maps to its
  parent like shared-entity edges do. `contextOf(id)` is public.

**Not done / for the owner**
- SPEC §15 mentions a P2 `mm private @x` (private entities). It isn't in
  SPEC §2's P2 list and needs a model mutation for `entity.private`
  (lib/model.js, WP-B), so it isn't built. `mind.isHidden` already hides
  items that mention a private entity; nothing in the UI marks one yet.
- The item card has no Archive button and the help card doesn't list the
  P2 commands (WP-C follow-ups above).

## Verify (fresh eyes): checks, two fixes, open issues

Commit `9db5494` ("mindmap: verify fixes — …").

**Results**
- `npm run check:all`: exit 0 (29 reviewed-annotation warnings, as in P2).
  `npm test`: 62 files, 1876 tests pass (was 1874; +2 regression tests).
  `npx vitest run extensions/mindmap`: 22 files, 756 tests.
- I read every SPEC §3 acceptance test body (AT-1 … AT-11, AT-1-agent,
  AT-1b, AT-2-agent, AT-2b). They build the corpus through
  `search.match → execute` on the fixture clock and assert the spec's exact
  strings, order and counts. None of them is vacuous.
- Host load: the host-load harness at `9db5494` (Kage main
  `3aedcc9`). All 11 windows load in the real loader (`init-ack ok=true`,
  no page logs). The sanitizer keeps every `data-ext-action`, and the CSS
  gate keeps 168 of 168 rules. Extra plans, in a local verify script
  (not committed): a thought, a brain dump with todos and a
  link, link dedup, 12 time phrases, team actions, map recentring
  (Bingo › Dana › MTCS › Overview), `mm?`, cited replies, chip docking and
  undo. Screenshots verify-01…17 are not committed.
- Kage with the WP-H changes: ui-tests pass
  (120 files, 1895 tests). WP-H changes no Rust, so clippy isn't needed.

**Fixes**
- The op card listed a brain dump's actions by id. Sibling ids share one
  millisecond, so the order was random. It now uses `childrenOf`, which
  sorts by `seg` like the item card does. A deterministic test pins the id
  tail.
- A bare `mm` called `stats()`, which stringifies every part to size the
  store. At 10k items that took about 100 ms per keystroke. Home now uses
  `stats({ size: false })`; settings still shows the size. At 10k, bare `mm`
  dropped from 128 ms to 1.9 ms (median).

**10k-item budgets (SPEC §17)**, measured with
a local perf script (not committed) on a Zipfian corpus (6.5 MB, memory host):
- Within budget:
  - every launcher path has p95 ≤ 7.3 ms (owner queries ≤ 3.7 ms)
  - the `mm+` preview of 4 KB has p95 3.4 ms
  - capture commit has p95 65–76 ms; a brain dump takes 60–80 ms
  - the formatter takes < 0.2 ms when a message has no markers
  - `syncIfStale` makes 1 invoke when nothing changed
- At or over budget (not changed, because each would need a redesign):
  - cold `ready()` takes 550–900 ms (budget 600); most of it is tokenizing
    with Intl.Segmenter and building BM25
  - the heap grows about 40–44 MB per window (budget 25)
  - map + HTML has a median of 6–12 ms but a p95 of 19–33 ms over 15 runs
    (budget 30)

**Open (not fixed; spec gaps or cosmetic)**
- "what did I save this week" / "…on wednesday" find nothing. `save` isn't
  filler (SPEC §8.1), so it stays a required term, and relaxation never drops
  terms.
- After you undo a dedup, the op card strikes through the item, which still
  exists.
- A brain dump's child link is titled with the raw URL until its metadata
  arrives. The parent's snippet keeps a bare "read".
- Filter-only `docs` queries are ordered by date, so a link can come before
  docs (as specified).

## Review fixes (security/robustness review + owner review)

Commits: `68f0718` (all fixes, 18 strings × 31
languages, `hardening.test.js`, `phrasings.test.js`), `ffc978e` (map centre
counts wrap) and `46e7e47` (shard recovery with an unreadable `mm-meta`).
Every local repro (not committed) that asserted a bug now fails (the
bug is gone); each finding has a regression test in the repo.

**Security / robustness review — all blockers and should-fixes fixed**
- **Private-only names (blocker).** "Agent-visible" now means: not private
  and mentioned by at least one item the agent may see
  (`mind.agentVisible`). The `entity` tool answers `not_found` (no
  suggestions) for anything else; `related` counts only visible items
  (`cooccur(eid, {forAgent})`); `suggestNames`, the `search`/`actions`
  entity and assignee params, `scope.entities`, `why` and the `mm?` scope
  all use it; agent-path parsing (`parse(…, {forAgent})`) resolves only
  visible names, so its scope never confirms a private-only one. Aliases:
  there is no stored provenance, so an alias reaches the agent only when an
  item the agent may see that mentions the entity spells it out (the newest
  400 are read; `agentAliases`). Alias tokens moved from the BM25 `ent`
  field to their own `als` field, which the agent's searches skip
  (`bm25.search({skip})`); the launcher still finds MTCS items by
  "termination".
- **Delete everything vs. other windows (blocker).** `mm-meta` carries a
  random store generation (`gen`), created with the first save of a fresh
  store or by Delete everything. `_absorbMeta` does a full reload when it
  differs, so a window that missed the delete drops the old shards instead
  of serving them to the agent and writing them back.
- **Forged card buttons.** Data actions are now `mm:b<blk>:a:<verb>:<id>`
  (ARCHITECTURE §7.2 changed) and run only when that block exists in this
  window and its last render contained exactly that action
  (`view.boundAction`, `st.acts`). Block numbers are clock-seeded with
  random low digits. Host note: current Kage already escapes raw HTML in
  agent markdown (`markdown.js` P1.8 `renderer.html`), so an agent can't
  get a `<button>` into the DOM today; the binding is defence in depth. No
  host change.
- **Agent capture of a privately saved URL** never merges into or reveals
  the private item (`findDuplicate({skip})`, `env.skipDuplicate`): it
  becomes its own item. A private agent capture returns only `{saved,
  private, rejected, undo, note}`.
- **Timestamps** outside 1970–9999 are not times (`model` `time()`): an
  item with such a `createdAt` is skipped on import and counted ("1 item in
  the file couldn't be read"), optional times are dropped, and
  `view.fmtDay`/`dueText` never throw.
- **Unreadable records** are kept per part (`state.raw`) and written back
  unchanged after the rest; also exported. A data part with the wrong shape
  (`items` not a list) makes the store read-only like an unreadable key.
  Items found in the wrong month shard get their own shard written with the
  next save.
- **Large imports.** `journal.appendOp` now drops an oversized op's
  snapshots *before* trimming, so it never evicts the undo history;
  `canUndo` says `too_large`, and the import status says "This import
  changed too much to undo" instead of promising Undo. **Deviation:** SPEC
  §7.7's "the import is one undoable op" doesn't hold for imports that
  overwrite more than ~256 KB of existing items (new items are always
  undoable). A spill key (`mm-undo-<opId>`) would close this; not built.
- **Stale twins.** With `storage.atomic_write`, the first write of each key
  deletes its old-host twin, so a later bad primary reads as unreadable
  (read-only, Export raw copies) instead of falling back to months-old data.
- **Stale maps.** Reindexing an item also bumps its entities and parent, so
  maps and cards centred on them re-render.
- **Back-fill** candidates are the items holding every token of the name
  (rarest postings first), at most 600 verified: "Data Mesh" at 10k items
  went from 591 ms to 59 ms (4 KB items: 3.2 s → 62 ms).
- **Me** shows as `card.me` (localized); storage keeps "Me".
- **Unreadable `mm-meta`** (from a local skeptic repro, not in the
  defect list): the load only probed the last two month shards, so Export
  raw copies, Repair and Delete everything missed the rest, and Repair
  orphaned them. Now the month keys a torn copy still names, plus every
  month from the oldest dated record in entities/candidates/journal (≤10
  years), are read too.

**Owner review — all blockers, should-fixes and nits addressed**
- **Future dates (blocker).** `occurredAt` comes only from clearly past
  phrases (yesterday, N days ago, last <weekday>; last week / N weeks ago /
  today for meetings), a weekday with a past-tense cue and no future cue, or
  a month-day whose nearest occurrence is in the past ("Oct 3" said in
  November). "the launch moves to Dec 3", "deadline is Jan 15", "Offsite
  planning meeting on Dec 10" and "dentist appt thu 3pm" get no date.
- **"my actions for Dana" (blocker).** With my/mine/I in the actions intent,
  `for <Person>` is a hard filter and I stay the owner; a "Show Dana's own
  actions" row offers `owner:dana`. "actions for Sarah"/"Sarah's actions"
  with nothing open show her suggestions.
- **"what did I save yesterday" (blocker).** Saving verbs and generic nouns
  (save, add, capture, wrote, stuff, things, everything, said, …) are
  filler; "what did I finish …" is the done actions by `doneAt` (new
  `done:` filter); a last relaxation step `terms_dropped` shows everything
  from the asked time ("Nothing matched “zeppelins” — everything from Thu,
  Nov 5").
- **Children inherit** only teams, projects, topics and orgs, plus names on
  the heading line and on their own line (extraction mentions carry
  `segs`); promoted terms reach a child only if its own text names them.
  **Deviation** from SPEC §5 S5 / F-CAP-3 ("inherit the parent's
  entities"). AT-2/AT-6 unchanged.
- **Todos:** "need to / have to / gotta / must …" (not questions) are 0.8
  open actions; a dump whose lines mostly start with a verb (not a meeting)
  is a to-do list — its imperative lines are open, not suggestions; "the
  1st / 15th" is a due date. (OPEN_QUESTIONS Q10 updated.)
- **Action questions:** "on my plate", "need to do", "should I do next",
  "what's due …", "due tomorrow/eow" (due grammar when the range grammar has
  nothing), a weekday asked on that weekday includes today, a child matches
  its parent's title words ("from the bingo retro"), an AND miss falls back
  to any word (labelled), `mm suggestions` = `mm review`, and
  `mm? what do I need to do this week` sends the actions due.
- **Stemming** adds -ing/-ed (Porter step-1b fix-ups) and 4-letter "-es"
  ("owes"); **"Did you mean “launch”?"** (`bm25.nearTerms`, edit distance
  1–2) when nothing matched; the empty row says "No notes match “…” — try
  fewer or different words".
- **Map at 570 px:** four nodes per top/bottom row (`LANE_CAP` 4, x
  16/39/61/84; **deviation** from SPEC §9.2's five), 22% wide two-line
  labels, 24 px minimum node height, centre meta and entity counts wrap.
  Measured in Kage's floating CSS: no overflow, no overlaps, no hit target
  under 24 px (screenshots not committed). Kind words that find the
  centre no longer filter its lanes (only `kind:` does).
- **Week start:** `auto` follows the OS region (`navigator.languages` /
  `Intl.DateTimeFormat().resolvedOptions().locale`, a locale with a region),
  not Kage's bare `en`; the README says so; a test runs AT-1 with the
  shipped default. **Deviation** from SPEC §8.3's `Intl.Locale(language)`.
- **Cards:** a one-line action isn't repeated or counted; op cards list 8
  actions then "N more actions — see mm actions" and say when lines passed
  the 50-action limit; a link's own words are its provisional title
  (`titleFromText`, still `auto`); a pending link's first line names the
  site ("Saved a link from example.com"); undoing a duplicate save no
  longer strikes the item; fetched page titles/descriptions never create
  teams, projects or people, and "team OKRs" is never a team.
- **Labels:** "(3 overdue · 2 due this week)", "saved Sat, Oct 31" after a
  due date, "teams, people & topics", "8 of 23" on the interpretation row,
  and a short first line with a mid-line meeting word ("Launch sync with
  Sarah and Raj") is a meeting.

**Checks:** `npx vitest run extensions/mindmap` 24 files / 784 tests;
`npm test` 64 files / 1904 tests; `npm run check:all` exit 0 (30 reviewed
annotation warnings: P2's 29 plus the agent dictionary). Host-load harness
(on the working tree, with Kage origin/main's loader and
sanitizer): every window `init-ack ok=true`, no page logs, sanitizer keeps
every `data-ext-action`, bound Undo clicks work, CSS gate 171/171. Kage
with WP-H: ui-tests 120 files / 1895 tests, biome clean on the WP-H files; no
Rust changed. Translations: Kage's unmodified `translate.py` from
a staging copy (558 strings, 0 failures).

## MM0: Housekeeping and the host table mirror

- **Docs.** Branch names and unpublished commit ids are replaced with the
  commits on `main`. OPEN_QUESTIONS records the owner's answers.
- **`card.me` stays.** `mind.js` reads it through `t?.('card.me')` for the
  "me" entity's name. `check:i18n` missed optional calls and warned that the
  key was unused; its regex now accepts `t?.(`.
- **Mirror of the four Kage designs** (SYNC §23.3). `views`, `file_text`,
  `agent_background` and `sync` are in `scripts/host-capabilities.mjs` and
  `web/store-core.js`, with their extension commands and their host-only
  commands as `null`. The table also gains the 23 host-only commands Kage
  `main` had added since the last sync, so the drift check is clean.
- **Checks.** `validate` checks `contributes.views` (EXTENSION_VIEWS §4)
  and `agentBackground` (EXTENSION_AGENT_CALLS §3.2), each together with its
  capability, both ways. `check:i18n` resolves `__MSG_` tokens in view
  titles and the `agentBackground` reason. `check:tests` counts a view
  module as code.
- **Not here.** The manifest `sync` block and `config.<field>.sync` belong
  to S7. Until it lands, `validate` rejects a top-level `sync` block as an
  unknown field.

## WP-V8: the map explorer (`explorer*.js`, `explorer.css`, `lib/{camera,spatial,layout,scene}.js`)

Kage's EXTENSION_VIEWS §24 and §24.9. Kage's host side (V1–V6) is built in
parallel, so the explorer is coded against that document and tested with
fakes in `test-helpers/mindmap/view-host.mjs` (change events over the memory
host, `context.view`, a recording 2D context, hand-run animation frames).
Every new host feature is detected: without `views` nothing explorer-related
shows; with `storage.change_events` but no `views`, settings says to approve
the permission.

- **Manifest.** `views` capability and one view, `explorer` (1200 × 800,
  at least 640 × 420). Version 0.2.0.
- **Data.** `mind.links(ref)` feeds `lib/scene.js`; `mm-layout` (pins, under
  the lock, merged per pin) and `mm-view` (this computer, at most one write
  every 2 s). Delete everything removes both; Export JSON carries
  `layout.pins` and Import JSON restores them. Every window's Mind syncs at
  once on another window's `mm-meta` change.
- **Choices the design left open, or where it differs:**
  - The details panel is on the start side in both directions (left, or
    right in RTL), so it mirrors with the rest of the window.
  - Ask fills the launcher with the configured trigger (`brain? …`), not a
    literal `mm? `.
  - Each `links()` entry carries its ExNode, so the scene needs no second
    lookup.
  - `explorer` joins the model's capture sources, so `via: 'explorer'` is
    stored (older versions read it as `launcher`).
  - Space or ＋ on a node that's already expanded hides its connections:
    the "collapse something" the full-map toast asks for.
  - Search lists `@name` first, then matching notes, then names met in
    plain words.
  - A private focus titles the window "Private item".
- **Not here:** the organiser's status chip and Accept/Dismiss for inferred
  names (AC-MM3's background organiser); **Add a file…** (FT-MM3).
- **Strings.** 59 new EN keys only. The acceptance test's locale-parity
  check lists them as pending, and `check:i18n` reports them missing from
  the 31 other catalogs until Kage's `translate.py` runs.
- **Budgets** (Node, soft checks): `buildScene` of 2,000 nodes, a 300-node
  `relax` and a 2,000-node frame stay inside their budgets. Matrix item 10
  (50 fps on a real WebView) waits for a Kage build with V1–V6.

## WP-FT-MM1: the files leaf (`lib/files.js`)

Kage's EXTENSION_FILE_TEXT §11.3–11.7, as a pure leaf that uses `lib.text`.
Nothing imports it yet: FT-MM2 (model) and FT-MM3 (wiring) build on it. Kage's
host side is built in parallel, so the tests use hand-built `pick_file_text`
results in the §3.6 shape.

- **`validateFileText`** returns `{ ok, file }` with camelCase fields, or
  `{ ok: false, code }`. Unknown fields are dropped, so nothing the host adds
  later is stored by accident. Beyond the design's list (types, lengths,
  `chars` ≤ `maxChars`, hex, ref) it also refuses a name that is a path or
  holds a control character, a lone surrogate, `total_chars` < `chars`, and
  page starts outside the text, unordered, without `pages` or more than
  `pages.read`. The format must be one that was asked for; a format or
  warning this code doesn't know yet is accepted. `size` is capped at 32 MiB
  unless the caller passes `support.max_input_bytes`.
- **Page starts.** The wire type calls them a "char offset", and `chars`
  counts scalar values, so they are read as scalar offsets and converted to
  JS string offsets. Equal for text without emoji or rare scripts.
- **Dedupe** names the cases `same`, `update`, `copy` and `new` (S, U, C, N).
  Equal matches go to the oldest item. **Differs from the design:** with
  **Update from file…** the doc the user chose decides, before S: it is
  re-read unless its stored file has the same `sha256`, `chars` and
  `truncated` (then `same`, or `copy` when it lacks the ref). So raising
  "Keep up to … characters" and updating gets the longer text, and picking
  another doc's file updates the doc the user chose. A target that is gone
  falls back to S, U, C, N.
- **Keyphrases.** Each comes back as the first spelling seen (`norm`), or the
  stem, whichever tokenizes back to the term. The index re-tokenizes
  `keyphrases`, and stems aren't always stable ("composed" → "compos" →
  "compo"); RAKE keyphrases store `norm` too. Numbers, one-letter terms and
  terms over 40 characters are left out, and so are the "## Slide N" and
  "Notes:" lines Kage writes for structure. `#tag` lines aren't headings.
  `model.js` still caps `keyphrases` at 5 (`LIMITS.keyphrases`): FT-MM2 has
  to raise it for docs.
- **Titles.** Besides "Microsoft Word - ", the PowerPoint and Excel prefixes
  are stripped. App defaults ("Untitled", "Document1", "Slide 1", …), other
  file names and paths don't count as usable titles.
- **Passages** come best first: most distinct terms, then most hits, then
  earliest. A passage is cut at spaces and trimmed to meet an earlier one
  rather than dropped. Blocks of 4,096 characters are scanned only when the
  folded block holds a term minus its last letter (the stemmer only changes
  word endings); a test checks this against a full scan.
- **Budgets** (Node, soft): keyphrases for 200,000 characters ~20 ms;
  passages in 1,000,000 characters ~8 ms for a rare term, ~85 ms when every
  block has a hit.
- **Checks:** `npx vitest run extensions/mindmap` 33 files / 966 tests;
  `npm test` 76 files / 2320 tests. `check:all` stops at `check:i18n`,
  which already failed before this package on WP-V8's 59 EN-only keys
  (translations pending); every other gate passes.

## WP-AC-MM1: the organizer leaf (`lib/organize.js`)

Kage's EXTENSION_AGENT_CALLS §11.3–11.5 as a pure leaf that uses `lib.text`,
`lib.dates` and `lib.url`. Nothing imports it yet: AC-MM2 (model) and AC-MM3
(the loop in `mind.js`, settings) build on it. Kage's host side is built in
parallel, so the tests check the reply schema with the host's subset rules
and measure requests against a copy of the host's framing (§5.2).

- **Files.** The test is `lib/organize.test.js`, next to the module like
  every other leaf, not `organize.test.js` at the extension root as §13
  lists. Two EN keys land here because `buildRequest` calls `t()`:
  `prompt.organize_bg` (the design's copy, with ’ like the rest of the
  catalog) and `op.organized_bg_label`. They are in `acceptance.test.js`'s
  pending-translation list until the next translation run.
- **Eligibility** follows §11.3, plus: a note with no `org` mark that the
  visible `mm organize` already did is left out (the design's "reuses
  `organizeItems()`"). The caller passes `organized` (`_agentOrganized`); the
  default is the same check without the children. A malformed `org` reads
  as missing; a missing `orgSince` as a week back; without a machine tag no
  note counts as this machine's, so all wait 24 hours. `ineligibleReason`
  names the rule that failed, and `organizeCounts` gives the settings
  status its organized, waiting and older counts.
- **Hash.** FNV-1a over UTF-16 units of the collapsed title and text,
  joined by a newline. The collapse is written out here, not taken from
  `lib.text`, so a change there can't re-queue every organized note.
- **Payload.** `text` is the organize body without the title, which goes on
  its own; a summary the text already contains is left out. URLs lose
  userinfo, query and fragment in the text and title too, not only in `url`,
  and paths in the text keep only the file name: a doc's text is often its
  path, and a link's its URL as pasted. A quote that spans a rewritten URL or
  path no longer matches the note and is rejected. `lib.url` reads
  "/etc/hosts and /var/log/system.log" as one path, so the words between
  are dropped. Empty `text` and `entities` are left out. Entity names that
  match "Names that mean you" are dropped, from notes and the vocabulary.
- **Size.** The manifest's 16,000-character cap doesn't fit 15 worst-case
  notes (each up to ~1,800 characters as the host pretty-prints them).
  `buildRequest` drops notes from the end, then vocabulary, until the
  framed prompt fits (framing reserve 1,000; the schema counted
  pretty-printed). A worst-case batch keeps 5 notes; 15 ordinary notes and
  50 names fit. The design's ~9,000 characters is the average.
- **Reply.** `validateReply` re-checks the host's subset (characters
  counted as code points). `toAnnotateEntries` returns entries in batch
  order and `skipped` ids; `skip: true` wins over fields, and an entry that
  adds nothing counts as skipped. Strings lose controls and bidi overrides;
  "me", "I" and "myself" are dropped as owners and entity names; a due date
  must be a real `YYYY-MM-DD`.
- **Marks.** `markFailed` counts tries only while the hash stays the same
  and waits tries × 1 hour (1 h, 2 h, 3 h; the design's formula reads either
  way). Failed marks carry `v` and `at` too.
- **Budget** (Node, soft): `selectBatch` over 20,000 notes ~50 ms with the
  whole backlog in scope.
- **Checks:** `npx vitest run extensions/mindmap` 34 files / 1012 tests;
  `npm test` 77 files / 2366 tests. `check:i18n` still fails only on keys
  waiting for translation (now 61); every other gate passes.

## WP-FT-MM2: picked documents in the model (`lib/model.js`)

Kage's EXTENSION_FILE_TEXT §11.4, §11.5 and §11.8 in the model. Nothing calls
it yet: FT-MM3 wires it into `mind.js` with `lib/files.js`. The tests build
`validateFileText` results by hand, as FT-MM1's do.

- **Fields.** `file` keeps name, extension, format, size, modified time,
  sha256, pages, chars, truncated and warnings; never the text, the title
  Kage read or a path. A name with a path or a control character, or a bad
  hash, drops `file`; unknown fields inside it are dropped. `fileRefs` is
  top level, newest last, 8 at most. **Additions:** `body` carries `bytes`
  (UTF-8 bytes of the text) besides `key` and `chars`, so the 64 MB budget
  is a sum over State and needs no body reads; `meta.counts.bodyBytes` is
  written only once there are bodies, so existing meta payloads don't
  change. Page starts go in the body value; a doc without a body keeps up to
  256 of them in `file.pageStarts` (offsets into `text`). `source.via` gains
  `file`. A doc with `file` keeps 64 keyphrases (5 for everything else).
- **Ops.** `applyIngest` (case N, op `ingest`), `applyReread` (case U, op
  `reread`) and `applyAddRef` (case C, a silent `enrich` op labelled
  `file_ref`). The caller decides the case with `dedupeDecision`; the model
  doesn't dedupe files. `applyIngest` reuses the capture path (the old
  `applyCapture` body, now `captureInto`, unchanged for captures): it never
  merges into a saved link or path and gets **no link children**, since a
  document's reference list would flood the map.
- **Actions.** Every action from a picked document is an open suggestion,
  auto-accept or not, and so are the agent's (`applyAnnotate`). **Differs
  from the design:** `[x]` lines are left out (`result.droppedDone`): as a
  suggestion they would ask the user to accept finished work, and as done
  actions they would count as the user's.
- **Re-read.** Text, file, body, keyphrases and rule mentions come from the
  new read. A user or agent title, the kind, summary, terms, user and agent
  mentions stay. A child the user hasn't acted on (open, suggested, found by
  the rules) goes when the new text doesn't have it; accepted, done,
  dismissed and agent actions stay, and a new line is a new suggestion.
  Only `possible_secret` or `#private` makes the doc private; nothing makes
  it public again. Re-read refuses an item without `file` (`not_file`), so a
  path the user typed (C5) keeps its own words.
- **Body keys.** `mm-body-<id>-<n>`, where `n` is past the item's rev and
  every body key of that item an undo snapshot still holds. Usually `n` is
  the new rev. After "re-read, a silent change, undo", the first re-read's
  body is still held, and the next re-read takes the next number instead of
  overwriting it. A retry of the same op gets the same key.
- **Bodies are deleted by the caller**, not the journal: take
  `bodyKeys(state)` under the lock before apply, and after the commit delete
  `releasedBodies(held, state)`. One diff covers undo of an ingest or
  re-read, a delete or re-read that left the journal, and an op `appendOp`
  made lossy. `journal.js` needed no change. Records kept aside unread
  still hold their bodies.
- **Budget.** `storage_full` when the referenced bodies plus the new one
  pass `env.bodyBudget` (64 MiB, the host's own MB). Bodies the journal
  still holds count, since they are on disk. A text up to 8,000 characters
  has no body and doesn't count. A retried ingest whose earlier attempt's
  item landed counts that body twice, so near the limit it can be refused.
- **For FT-MM3:** add EN strings `op.ingest` and `op.reread` (search.js
  renders `op.<code>`); pass `bodyKeyphrases` to `applyReextract` for a doc
  with `file` (otherwise its keyphrases are kept); run `dedupeDecision`
  inside `_mutate` on the fresh state, leaving out the item this attempt's
  pool already drew, so a retried ingest isn't read as "same"; write bodies
  with a literal-prefix key for `check:security`; `Delete everything` needs
  `bodyKeys(state)`. SPEC §6.2, §6.4 and §7.1 are FT-MM3's to update.
- **Checks:** `npx vitest run extensions/mindmap` 34 files / 1036 tests;
  `npm test` 77 files / 2390 tests. `check:i18n` still fails only on the
  61 keys waiting for translation (none added here); every other gate
  passes.

## WP-AC-MM2: background organizing in the model (`lib/model.js`)

Kage's EXTENSION_AGENT_CALLS §11.5 in the model. Nothing calls it yet: AC-MM3
wires it into `mind.js` with `lib/organize.js`.

- **`applyAnnotate` options.** `via: 'background'` makes the op silent (even
  if the caller passes `silent: false`) and sets `op.via: 'background'`.
  Its actions are suggestions with `source.via: 'background'`. **Additions:**
  the model forces suggestions itself, not only through the caller's
  `autoAccept: false`; it ignores `kind` corrections (the leaf never sends
  them); and it leaves a link's `pending` or `failed` title fetch alone,
  since marking it `done` would stop the fetch for good.
- **`maxNewEntitiesPerItem`** works with any `via`. Names and owners count
  together, names first; existing and forgotten names don't count. Past the
  cap a new name is left out, and an action whose owner would be new is
  rejected (`entity_cap`), never given to "me". A retry counts the
  entities its earlier attempt made, so it decides the same way.
- **Private names** (background only): a name or owner is dropped
  (`private_entity`) when its key is a private entity's key or alias, or
  when it resolves, through merges, to a private entity. So a public twin
  with the same key isn't linked either. The `annotate` tool is unchanged.
  `rejected` gains `name` for a capped name; a private one is reported
  without it.
- **Stored fields.** `org` keeps `state`, `v`, `at` and `hash` (base36, 1–16
  characters), plus `tries` and `next` on a failed mark. A mark missing one
  of the four is dropped whole; other fields are dropped. `source.dev` is
  16 lowercase hex characters, or it's dropped. `meta.orgSince` is a time
  (0 allowed) and is written only once set. `via` gains `background`. An
  older Mind Map reads that as `launcher` and drops `dev` and `org`, so it
  only causes one more organize.
- **`env.dev`**: captures, ingests and re-read children stamp `source.dev`
  from it, whether or not the source window is recorded. A dedup merge
  keeps the first computer's tag.
- **Additions: two silent ops**, because the model is the only writer of
  items and nothing commits without an op. `applyOrgMarks(state, [{ id,
  org }], env)` is one `enrich` op (label `org_mark`) with no
  before-snapshots: it records the revs it left, so earlier ops on those
  notes can still be undone, and it costs the journal little.
  `applyOrgSince(state, since, env)` sets `meta.orgSince` in an op with no
  records. Their labels fall back to `op.generic`, so no new strings.
- **For AC-MM3:**
  - Env: `{ via: 'background', silent: true, autoAccept: false,
    maxNewEntitiesPerItem: 3 }`; put the cached machine tag in `_env()` as
    `dev`.
  - In one `_mutate`: the step-2 checks (deleted, hidden, rev), then
    `applyOrgMarks`, then `applyAnnotate`, returning both changes in that
    order. Undo of the annotate op then keeps the mark, so the note isn't
    sent again (tested).
  - `_agentOrganized` should also return true for `org.state === 'done'`.
  - **Undo gap (checked):** `journal.js` treats silent ops as transparent to
    undo. `mm undo` of the capture that made a note passes over the
    background op and deletes the note, but leaves the background's
    suggested actions with no parent. Fixing it needs a `journal.js` change,
    outside this package: either a later silent op that created children of
    an item the undo deletes makes the undo `superseded`, or `applyUndo`
    deletes those children too. Also, `mm undo` of an earlier user edit takes
    back the background's fields and mark; the note is organized again later.
  - **Journal size:** an annotate op keeps before-snapshots of up to 15
    notes (up to 8,000 characters of text each). A few batches can push the
    user's undo history out of the 256 KB journal.
  - SPEC §6 (`Item.org`, `source.dev`, `via: 'background'`, `meta.orgSince`)
    is AC-MM3's to update.
- **Checks:** `npx vitest run extensions/mindmap` 34 files / 1048 tests;
  `npm test` 77 files / 2402 tests. `check:i18n` still fails only on the
  61 keys waiting for translation (none added here); every other gate
  passes.

## Status

**Works (P0/P1/P2, all phases of SPEC §2):**
- P0: capture (text, link, path, brain dump, source window, private), URL
  dedup, link titles, the deterministic organizer, sharded twin-written
  storage with the lock and read-only mode, `mm` find with NL parsing and
  relaxation, actions/review/entity pages/recent/undo, the op and item
  cards and citation chips, the five agent tools, settings, Export JSON,
  Delete everything — with both owner queries (AT-1, AT-2) passing on the
  shipped default week start.
- P1: the map card and `mm map`, chip docking, `mm?`, `annotate`, Export
  Markdown.
- P2: `mm organize`, merge/forget/rename, archive, Import JSON,
  re-derivation, enrich retry, context edges.
- WP-V8: the full-window explorer (pan, zoom, pins, search, lenses, the
  node list), on Kage builds with extension views.

**Known gaps:**
- Imports that overwrite more than the journal holds aren't undoable (they
  say so). Cold `ready()` (550–900 ms) and heap (~40 MB) at 10k items are
  over budget (unchanged since Verify).
- Alias visibility is inferred from text, not stored provenance.
- e-final verbs past four letters stem apart ("release"/"released").
- A time-only query lists a note and its child actions as separate hits.
- Not built: a `mm today` view (overdue / today / this week / waiting on
  others), "waiting on Dana", `mm private @x`, an Archive button on the item
  card, keyboard focus kept after re-centring (needs the host).

**Top open questions for the owner:**
1. Children now inherit only teams/projects/topics (and heading names), not
   every person and term in the dump. Right default?
2. A plain to-do list in a dump now becomes open actions without review
   (Q10). Keep, or keep them as suggestions?
3. "Last week" follows the OS region's week (Sunday in the US). Keep, or
   default to Monday?
4. Large imports that would overwrite a lot: build a spill key so they stay
   undoable, or ask before importing?
5. Should bare `mm` grow a daily "what's on my plate" view?
