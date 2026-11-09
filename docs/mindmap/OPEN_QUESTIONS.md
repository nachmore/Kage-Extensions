# Mind Map: open questions for the owner

Each question below has an answer we have already built with. Where possible
we based the default on common practice in comparable tools (Mem, Tana,
Capacities, Reflect, Obsidian, Heptabase, Raindrop, Readwise, Khoj,
NotebookLM, Things/Todoist quick capture). We also say why we chose it, and
what would change if you answer differently, including how big the change
would be.

Size of change if you answer differently:
- **S**: a setting or default flips.
- **M**: one or two modules change.
- **L**: the architecture changes.

## The owner's answers

| Q | Answer | Change |
|---|---|---|
| Q1 | An installable extension | Kept |
| Q2 | Sync through Kage-wide folder sync, not a Mind Map sync ([SYNC.md](https://github.com/nachmore/Kage/blob/main/docs/design/SYNC.md)) | New host API |
| Q3 | Agent tools on by default | Kept |
| Q4 | Read file contents through the `file_text` host API ([EXTENSION_FILE_TEXT.md](https://github.com/nachmore/Kage/blob/main/docs/design/EXTENSION_FILE_TEXT.md)) | New host API |
| Q5 | Actions stay separate from Todos | Kept |
| Q6 | Background organising through the `agent_background` host API, off by default ([EXTENSION_AGENT_CALLS.md](https://github.com/nachmore/Kage/blob/main/docs/design/EXTENSION_AGENT_CALLS.md)) | New host API |
| Q7 | A full-window explorer through extension views ([EXTENSION_VIEWS.md](https://github.com/nachmore/Kage/blob/main/docs/design/EXTENSION_VIEWS.md)) | New host API |
| Q8 | Unassigned actions are mine ("me") by default | Kept |
| Q12 | Fetch link titles on | Kept |
| Q13 | Record the source window on | Kept |

Q9–Q11 and Q14–Q16 have no answer yet, so Mind Map uses their assumed
answers. Each new host API is optional: Mind Map checks
`context.hostFeatures` and works as described below on a Kage that doesn't
have it. The Mind Map side of each one is its own work package (V8 for Q7,
FT-MM3 for Q4, AC-MM3 for Q6, S7 for Q2). Until a package lands, that
question's "Assumed" text describes what Mind Map does. V8 (Q7), FT-MM3
(Q4), AC-MM3 (Q6) and S7 (Q2) have landed.

---

## Q1. Should Mind Map be an installable extension, or built into Kage?

**Decided:** an installable extension. The new host APIs in Q2, Q4, Q6 and
Q7 give it the parts that needed Kage.

- **Assumed:** an installable extension (`extensions/mindmap` in
  Kage-Extensions), using only today's extension APIs plus two optional host
  improvements (WP-H).
- **Why:**
  - You said "it can be an extension".
  - The sandbox model gives users a clear permission list.
  - It ships through the store without a Kage release.
  - It shows how capable extensions are.
- **If built in:**
  - The core (`lib/*`, `mind.js`, `view.js`) carries over.
  - What changes:
    - storage moves to host files or SQLite, and the twin writes and the
      lock go away;
    - the map can get its own window or canvas;
    - document text ingestion becomes possible;
    - background agent calls become possible.
  - The entry points (`search.js`, `tools.js`, `formatter.js`) would be
    rewritten against host APIs. **L**

## Q2. Should the mind map sync between your machines?

**Decided:** yes, through Kage's own folder sync, for all of Kage and not
just Mind Map ([SYNC.md](https://github.com/nachmore/Kage/blob/main/docs/design/SYNC.md), Mind Map in §12.9). Mind Map opts its
data in with the `sync` capability and the manifest `sync` block; no
extension-side folder access is needed. Built in S7 (SPEC §7.8): notes,
names, links, document text and map pins sync, encrypted; private items
too unless **Sync private items** is off; documents Kage thinks hold a
password or key stay on their computer. Without that host feature it
stays local, as below.

- **Assumed:** local only, one store per machine. Export and import use JSON.
  The data model is ready for sync: stable random ids, `rev`/`updatedAt` on
  every record, and `mergedInto` redirects.
- **Why:**
  - Local-first is the strongest trust signal in this category.
  - Kage has no sync service.
  - Shutdowns like Rewind/Limitless and Napkin's desktop app show the risk of
    depending on a vendor.
- **If you want sync:**
  - Add a "sync folder" setting (a user-chosen Dropbox/iCloud/OneDrive
    folder), tombstones, and a merge step (last writer wins per record, with
    union for mentions).
  - Extension data has to be readable and writable at a user-chosen path,
    which needs a host command for a scoped folder with a permission prompt. **M–L**

## Q3. Should your agent be able to search your notes by default?

**Decided:** yes, as assumed.

- **Assumed:** yes. `agent_tools` is on by default. The host still asks the
  first time each tool is used, private items are never sent, and the settings
  page says which agent receives the snippets.
- **Why:** your two example questions are things you'd type straight into the
  floating bar to your agent. With tools off by default, the main use case
  silently fails. Stocks defaults its tools off because quotes cost money; that
  doesn't apply here.
- **If off by default:** flip `DEFAULTS.agent_tools` and the manifest default.
  The launcher (`mm …`) and `mm?` still work without tools. **S**

## Q4. How should documents get in, given that extensions can't read files?

**Decided:** Mind Map reads the file's text. The user picks a file each
time, and Kage returns its text through the `file_text` capability
([EXTENSION_FILE_TEXT.md](https://github.com/nachmore/Kage/blob/main/docs/design/EXTENSION_FILE_TEXT.md), Mind Map in §11).
Built in FT-MM1 to FT-MM3:

- **Add a file…** in the launcher (`mm+`, `mm+ file`, `mm add file`), in
  settings → Documents and in the explorer's toolbar; **Update from file…**
  on a doc's card and in the explorer. Kage's dialog opens at once from these
  clicks. Kage reads text, Markdown, PDF and Word files (more formats later,
  with no change in Mind Map) and never tells Mind Map the path.
- Mind Map keeps up to `doc_max_chars` characters of each file (50,000,
  200,000 by default, or 1,000,000), at most 64 MB of document text in all.
  The first 8,000 characters are the doc's text; the rest is a body, read on
  demand. Names, dates and actions are found in the first 8,000 characters;
  keyphrases come from the whole text. A document's actions are always
  suggestions.
- The same file again changes nothing; the same content from another
  computer is recognised by its hash.
- Your agent gets a doc's name, size, summary and up to 3 matching passages,
  never the whole text. A file Kage flags as possibly holding a password or
  key is private until you choose **Let my agent see it**.
- On a Kage without this feature, nothing changes: documents are stored as
  references (a window title, a path or URL, your note, a link's title and
  description), and attaching the file in chat and asking the agent to "add
  this to my mind map" still works (C6).

## Q5. Should Mind Map's actions be the same thing as the Todos extension's todos?

**Decided:** separate, as assumed.

- **Assumed:** separate. Mind Map's actions live in Mind Map. Each one links
  back to the sentence it came from and inherits that note's team or project,
  which is what makes "my actions for the bingo team" answerable. Todos is
  untouched.
- **Why:**
  - Extensions can't call each other.
  - Todos has no agent tools.
  - Copying actions into Todos would lose the provenance and entity links.
- **If you want one list:**
  - Option (a): Todos gains agent tools, and Mind Map offers "send to Todos"
    through the agent.
  - Option (b): a host cross-extension bridge.
  - Option (c): fold Todos into Mind Map (`mm actions` replaces `todo`).

  Size: (a) **S–M**, (b) **M** (host), (c) **M**.

## Q6. Should AI organize things automatically in the background?

**Decided:** yes, as an option that is off by default. Mind Map asks the
agent in the background through Kage's `agent_background` capability
([EXTENSION_AGENT_CALLS.md](https://github.com/nachmore/Kage/blob/main/docs/design/EXTENSION_AGENT_CALLS.md), Mind Map in §11).
Built in AC-MM1 to AC-MM3:

- **Organize new notes in the background** in settings, off by default.
  Nothing is sent until the user turns it on and confirms, in Kage's own
  dialog, which agent gets the text on this computer (**Allow on this
  computer…**). Kage runs the calls while the user isn't using Kage, refuses
  every tool, and caps size, rate and a daily allowance.
- Batches of up to 15 settled notes from the last week (**Organize older
  notes too** takes in the rest). Private notes, notes naming a private
  name and documents Kage flagged as holding a secret are never sent; nor
  are ids, windows, apps, folders or "Names that mean you".
- The reply adds summaries, names, key terms and suggested actions that
  quote the note, through the same additive path as `annotate`. Actions are
  always suggestions. A note changed, deleted or made private while its
  batch was out isn't touched.
- The item card says "✦ Organized by your agent" with **Undo organizing**;
  `mm undo` skips background changes. Each computer organizes its own new
  notes first, and others' after a day.
- On a Kage without the feature, the switch stays, its status says to
  update Kage or approve the permission, and organizing works as before:
  locally when you save, and through the agent only when you ask (`mm?`,
  the tools, `mm organize`).

## Q7. Where should the visual map live?

**Decided: build it.** Built in WP-V8: the full-window pan/zoom explorer,
through the new extension views (the `views` capability,
[EXTENSION_VIEWS.md](https://github.com/nachmore/Kage/blob/main/docs/design/EXTENSION_VIEWS.md), Mind Map in §24; SPEC §9.5). The map card
stays. Without that host feature, the map card below is the only map.

- **Assumed:** a *map card* drawn by the message formatter inside the floating
  bar's response area and inside chat messages:
  - the focused item or entity sits in the centre;
  - typed lanes surround it (related entities, actions, docs/links,
    notes/meetings);
  - you click a node to re-centre it;
  - Back, Home, "+N more" and a list view are available.

  There is no always-on widget and no global "hairball" graph.
- **Why:**
  - Users of graph tools say global graphs look nice but don't help much, and
    that focus graphs do.
  - The formatter path works the same in chat and floating on today's Kage.
  - Widgets currently render invisibly in chat, and every refresh replaces
    their DOM.
- **If you want a free pan/zoom canvas with draggable, pinned positions:** the
  host needs a "view" surface: a sandboxed window or large panel with pointer
  events and Canvas 2D. Mind Map would add a canvas renderer next to the card,
  using the same `graph.js` neighbourhoods plus saved positions. Host **M–L**,
  extension **M**.
- **If you want an always-visible mini map or due-actions bar in the floating
  window:** add a widget once the host offers a `widgets.floating_bottom`
  feature and skips identical re-renders. **S–M**

## Q8. Who is "me", and who owns an action by default?

**Decided:** "me" by default, as assumed.

- **Assumed:**
  - A first-person or imperative action is yours (`owner: me`).
  - "Dana to …" or "@dana will …" belongs to Dana, and is created as a
    *suggestion* when it comes from a brain dump.
  - The settings field "Names that mean you" (empty by default) maps
    `@yourname` and your initials to you.
  - "My actions" means `owner: me`.
- **Why:** this is how meeting-notes tools (Reflect, Tana, Granola-style) treat
  first person, and it needs no setup.
- **If you'd rather unassigned actions be nobody's until confirmed:**
  - `extract.js` sets `owner: null`;
  - the query parser's `my` matches `owner ∈ {me, null}`;
  - `mm review` asks for the owner.

  **S–M**

## Q9. What should "last week" mean, and when does your week start?

- **Assumed:**
  - "last week" is the previous calendar week (Mon–Sun).
  - "past week" / "last 7 days" is a rolling window.
  - The week start comes from your locale when the webview reports it,
    otherwise Monday. A setting overrides it.
  - The resolved dates are always shown ("Mon, Oct 26 – Sun, Nov 1"), so you
    can see when the reading is wrong.
  - If nothing is found in the range, results widen to ±30 days, labelled.
- **Why:** this is the most common reading of the phrase. Showing the dates
  plus labelled widening covers people who mean "the last 7 days".
- **If you mean rolling:** change one case in `dates.parseRange` and its tests.
  **S**

## Q10. How sure must the extractor be before something becomes an action?

- **Assumed:** these become open actions:
  - explicit markers (`[ ]`, `TODO:`, "remind me to");
  - lines under an "Action items" heading;
  - first-person commitments ("I'll …", "I need to …");
  - a one-line imperative capture ("call dana about mtcs by friday").

  Imperative lines inside a longer dump, and "<Name> to …", become
  *suggestions* that you accept or dismiss with one click (`mm review`). The
  setting "Add inferred actions without review" (off) turns all suggestions
  into actions.
- **Why:**
  - False actions erode trust quickly.
  - Comparable tools either suggest with a link to the source or need
    approval for changes.
  - The one-click "Not an action" plus Undo keeps the cost low.
- **If you want everything auto-accepted:** flip the default. **S** If you want
  only explicit markers: drop the 0.8 tier in `extract.js`. **S**
- **Changed after the owner review:** "need to / have to / gotta / must …"
  without "I" is a 0.8 open action, and a dump whose lines mostly start with
  a verb (and isn't a meeting) is a to-do list whose verb lines are open
  actions, not suggestions. Lone verb lines in a note or meeting stay
  suggestions. To go back: drop `NEED_RE` and the `todoList` tier in
  `extract.js`. **S**

## Q11. Is `mm` the right trigger?

- **Assumed:** `mm` (find and ask), `mm+` (capture), `mm?` (ask the agent),
  configurable in settings. No other extension uses `mm`.
- **Why:**
  - It's short.
  - It's easy to type with one hand on most layouts.
  - It follows the store's existing `todo+` / `bm+` convention.
- **If you prefer another word** (`mind`, `brain`, `n`): change the default.
  Users can already change it. **S**

## Q12. Should saving a link fetch its page title in the background?

**Decided:** on, as assumed.

- **Assumed:** yes (`fetch_link_titles` on). After the save, Kage's host
  fetches the page's title and description. The page's site can see that
  fetch, and internal sites go through Kage's existing link-metadata handling.
- **Why:**
  - Titles and descriptions make links findable ("which doc spoke about mtcs").
  - Raindrop, Obsidian Auto Link Title and Capacities all do this.
- **If off by default:** flip the default. Links are then found only by URL and
  your note. **S**

## Q13. Should Mind Map remember which app and window you saved from?

**Decided:** on, as assumed.

- **Assumed:** yes (`record_source_window` on). The window title and app name
  are stored as provenance, and are never sent to the agent. The only
  exception is a doc whose title *is* that window title. With Kage sync on
  they are also in the encrypted sync folder, like the rest of the mind map.
- **Why:**
  - Provenance ("captured from Word — MTCS rollout plan") makes recall and
    "jump back to that doc" work.
  - It's never sent to your agent.
  - On macOS, window titles need Screen Recording permission. Without it, only
    the app name is recorded and the "save the window you came from" row is
    hidden.
- **If off by default:** flip the default. The "save the window" row still
  works when asked for explicitly. **S**

## Q14. Which languages should the natural-language questions understand?

- **Assumed:**
  - **English** for the built-in grammar: time phrases, "my actions",
    kind words, imperative verbs.
  - **Any language** for filter syntax (`kind:doc when:last-week @bingo`).
  - **Any language** for the agent path (`mm?` and plain chat).
  - **All 31 Kage languages** for the UI strings, after `translate.py` runs.
- **Why:**
  - Reliable deterministic grammars per language are a lot of work.
  - Your agent already understands other languages.
- **If you need another language now:** each language adds a lexicon file
  (the time words, fillers and verbs are already exported constants) and its
  tests. **M** per language.

## Q15. How long should things be kept?

- **Assumed:** forever, until you delete them.
- Done actions drop out of default lists after 14 days, but stay searchable
  (`is:done`).
- There is no automatic archiving.
- The journal keeps the last 200 operations for Undo.
- Uninstalling the extension deletes all of its data. This is the host's
  behaviour, and the settings page and README say "export first".
- **Why:** you want to ask about things from weeks ago. Comparable tools keep
  everything and rely on search. Automatic deletion would be surprising.
- **If you want decay** (auto-archive untouched notes after N months), or
  want data kept after uninstall:
  - decay is **S–M** in the extension;
  - keeping data after uninstall is a host change to `purge_extension_data`
    with a "keep my data" choice. **M**

## Q16. Are the host changes in WP-H acceptable?

- **Assumed:** yes. Mind Map works without them and detects them when they
  are there. The changes:
  1. Atomic `save_extension_data` (temp file and rename), which protects
     every extension against truncated files.
  2. The agent's tool instructions show the allowed values (`enum`), array
     item types, and required markers.
- **Why:** both are small and isolated, and they fix problems every extension
  has.
- **If not:** skip WP-H. Mind Map keeps its twin-write crash protection and
  writes the allowed values into the tool descriptions (it already does).
  Nothing else changes. **S**
