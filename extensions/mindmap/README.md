# Mind Map

**Local · Works offline · Answers with sources.**

Throw in thoughts, links, documents and todos. Mind Map organizes them as you
save — what kind of thing each one is, who and what it mentions, which lines
are actions, and when they're due — so you can ask for them later in plain
words and get back the notes themselves, not a guess.

```
mm+ Bingo team sync
- [ ] Send MTCS numbers to Dana by Friday
- Dana to share the roadmap deck
- I'll book the offsite
Action items:
- review the Bingo launch checklist
```

That one paste becomes a meeting with four actions, linked to the Bingo team,
Dana and MTCS. The preview before you press Enter says so:
`🗓️ meeting · Bingo · Dana · MTCS · 4 actions (1 suggested) · due Fri, Nov 6`.

## Triggers

| Type | To |
|---|---|
| `mm+ <anything>` | Save a thought, link, file path, todo, or a multi-line brain dump. |
| `mm+` | Save the window you came from (a document open in Word, Docs, …), or **Add a file…**. |
| `mm+ file` · `mm add file` | Add a file: Kage asks you to pick one and gives Mind Map its text. |
| `mm <question or keywords>` | Find things. Enter opens a link, jumps back to a document's window, or shows the note. |
| `mm actions` | Your open actions, due first. Enter marks one done (and Enter again reopens it). |
| `mm review` | Suggested actions waiting for you to accept. |
| `mm @bingo`, `mm #mtcs` | Everything about a person, team, project or topic. |
| `mm recent` · `mm undo` · `mm help` | Latest captures · undo the last change · syntax reference. |
| `mm map [name]` | A map centred on a person, team or note; click a node to move there. |
| `mm? <question>` | Ask your agent; it answers from your notes and cites them. |
| `mm organize` | Ask your agent to tidy up notes it hasn't seen yet (see below). |
| `mm archive <words>` · `mm archived` | Put an item away · see archived items (Enter restores one). |
| `mm merge @a into @b` · `mm rename @a to New name` · `mm forget @a` | Fix the names Mind Map found. |

`mm` alone shows your open actions, suggestions to review and recent
captures. The trigger word can be changed in settings (`mm` → `brain` also
gives `brain+` and `brain?`).

## Asking

```
mm remind me which doc spoke about mtcs last week
```

finds the docs and links from last week that mention MTCS. "Last week" is the
previous calendar week, starting on the day your region starts its week (Monday
in most of Europe, Sunday in the US); **Week starts on** in settings changes it.
Each row shows the day, where it came from, the matching words, and why it
matched. A "🔎" row shows how the question was read — `Docs & links · Mon, Oct
26 – Sun, Nov 1 · “mtcs”` — and Enter turns it into exact filters you can edit. If
nothing falls in the range, the search widens and says so ("Nothing from Thu,
Nov 5 — closest matches from Oct 6 – Nov 6").

```
mm what were my actions for the bingo team
```

lists your open Bingo actions (overdue first, then by due date), then the ones
you finished in the last two weeks. Actions inherit the team of the meeting or
note they came from, so "book the offsite" counts as a Bingo action. A row
offers everyone's actions too. `mm my actions for Dana` lists your actions that
involve Dana (and offers Dana's own); `mm what's due tomorrow`, `mm what's on my
plate` and `mm what did I finish last week` work too.

You can also just ask your agent in chat — "which doc spoke about mtcs last
week?" — and it uses Mind Map's tools. Answers cite items as numbered chips;
click one to see the date and snippet, open it, or show it on the map.

### Asking your agent: `mm?`

```
mm? what were my actions for the bingo team
```

finds the matching notes on your computer first, then sends your agent a
visible message: your question, how Mind Map read it ("actions; about
Bingo"), and up to 8 of those notes, each with its `[mm:…]` tag. The agent is
asked to cite every claim with those tags and to say so when your notes don't
answer it. If nothing matched exactly, the message says so and sends the
closest notes instead (a day with nothing widens to the 30 days around it).
Private items are never included. The launcher row tells you how many notes
will be sent before you press Enter.

### Filters

Filters work in any language and always win over the plain-words reading:

| Filter | Example |
|---|---|
| Kind | `kind:doc,link` (note, link, doc, action, meeting) |
| Time | `when:last-week`, `when:2026-10-26..2026-11-01`, `due:this-week` |
| Who / what | `@dana`, `#mtcs` |
| Status | `is:open`, `is:done`, `is:suggested`, `is:overdue`, `is:private` |
| Owner | `owner:me`, `owner:anyone`, `owner:dana` |
| Words | `"exact phrase"`, `-excluded` |

Plain-words questions are understood in English today. Your agent understands
any language.

## The map

```
mm map bingo
```

shows a map centred on Bingo: related people, teams and topics above, its
open actions on the left (suggestions marked ❔), docs and links on the
right, notes and meetings below. Click any node to move there; the trail at
the top ("Bingo › Dana") takes you back, **Home** shows the overview (your
teams, people and topics, what's waiting for review, and your latest
captures), and **List** shows the same neighbourhood as a plain list. A lane
with more than fits shows "+N more".

`mm map` alone opens the overview, `mm map <words>` centres on the best match
(and highlights the words), and `mm map @bingo kind:doc` keeps only docs in
the lanes. The **Map** button on a saved card, Enter on `mm @bingo`, and
**Map** on a citation chip (which adds a map to the end of that answer) open
it too. The map works the same in the floating bar and in chat, follows your
theme, and mirrors for right-to-left languages. On older Kage versions the map
is shown but can't be clicked; `mm @name` walks the same connections from
the keyboard.

## The explorer

On a Kage that supports extension windows, the map also opens full size:
**Open in explorer** at the top of `mm map …`, `mm explore [name]`, the
**⤢ Explorer** button on a map card, **Explore** on a saved card, or **Open the
map explorer** in settings. Kage asks you once to approve Mind Map's new
permission ("Its own windows"); until then none of these show.

The explorer starts on what you opened it from (or where you left it), with
its neighbours two links out: names above, actions on the left, docs and links
on the right, notes and meetings below (mirrored for right-to-left
languages).

- **Move around**: drag the background (or hold Space and drag), scroll, or
  use the arrow keys. Scrolling pans on macOS and zooms elsewhere; the
  toolbar switches it, and ⌘/Ctrl with scroll, a pinch, `+`, `−` and `0` (fit)
  always zoom.
- **Arrange**: drag a node to put it where you want it. It stays there
  (📌) when you come back, and on your other Kage windows. `P` pins or unpins
  the selected node, and ⌘/Ctrl+Z undoes the last move.
- **Explore**: click a node to see it in the panel, double-click it (or press
  Enter) to centre the map there, and press Space or its ＋ handle to show what
  else it connects to. **Back** and **Home** are in the toolbar.
- **Act**: the panel marks actions done, accepts or dismisses suggestions,
  makes items private, opens links, copies a file's path, shows a document's
  whole text, and **Ask** puts a question about the node into the launcher
  for you to send. Every change can be undone.
- **Find and filter**: `/` or ⌘/Ctrl+F searches (Enter centres on the first
  match); the chips show only some kinds, only your actions, or done ones too.
  **＋ Add** saves a new thought without leaving the window, and **📄 Add a
  file…** adds a document.
- **Keyboard and screen readers**: every node is also in a list (the
  **List** button shows it), and the selection is announced.

Private items show 🔒 in the explorer and stay on this computer: **Ask** is
off for them, and the window title doesn't name them. Pinned positions are
part of your mind map's data (Export JSON includes them, **Reset map layout**
in settings forgets them); the explorer's zoom, centre and filters are kept
for this computer only.

## How things get organized

Everything happens on your computer, the moment you save, without the network
or an agent:

- **Kinds**: a link, a document (a file path, a `.pdf`/`.docx`/… link, a
  docs or wiki page, or a window you saved), a meeting (a "sync", "1:1",
  "standup" … first line), an action, or a note.
- **Names**: `#tags`, `@people`, "Bingo team", "project Atlas", email
  addresses, and words you use in two or more notes (like `MTCS`) become
  people, teams, projects and topics. "Long Form (LF)" teaches an alias.
- **Actions**: `[ ]`, `TODO:`, "remind me to", "I'll …", "I need to …", lines
  under "Action items:", and one-line imperatives with a due date are actions.
  "Dana to …" and imperative lines inside a dump become *suggestions* you
  accept or dismiss (or turn on "Add inferred actions without review").
  "Friday" said on a Friday means next Friday.
- **Links**: the same link saved twice adds a dated note to the first one
  instead of a duplicate. Titles and descriptions are fetched after saving
  (this can be turned off).

Every change can be undone (`mm undo`, or **Undo** on the card), and nothing
is ever filed into folders.

### Fixing names, putting things away

- `mm merge @danak into @dana` makes two names one: every note, action and
  owner follows, and the old name keeps working as an alias.
- `mm rename @zebra to Zebra Crew` renames a person, team or topic; the old
  name still finds it.
- `mm forget @walrus` removes a name everywhere and stops Mind Map from
  suggesting it again, even when you type it.
- `mm archive <words>` lists what matches; Enter archives one. Archived items
  leave your lists, searches, the map and your agent's answers, but stay in
  exports. `mm archived` lists them, and Enter restores one. Archiving a note
  leaves its open actions where they are.

Each of these shows a card with **Undo**, and `mm undo` takes it back.

When a new version of Mind Map organizes things better, notes you saved
earlier are organized again in the background, a little while after Kage
starts. Only what Mind Map worked out itself changes: names you or your agent
added, and anything you removed, stay as they are. Link titles that couldn't
be fetched (you were offline, or Kage closed mid-save) are fetched again then
too.

## Documents

**Add a file…** (on a Kage that can read files for extensions) saves what a
document says. It's under `mm+` (and `mm+ file`, `mm add file`), in settings
under **Documents**, and in the explorer's toolbar. Kage opens its own file
dialog; you pick a text, Markdown, PDF or Word file, and Kage reads it on
this computer and gives Mind Map its text. Kage never tells Mind Map where
the file is, and asks you to approve Mind Map's "Files you choose" permission
once.

- The card says what it found: "Added Q3 plan.pdf: 12 pages, 48,211
  characters. Found 3 people, 2 projects and 4 suggested actions." Names,
  dates and actions come from the start of the document, key terms from all
  of it. A document's actions are always suggestions, because someone else
  may have written them.
- Mind Map keeps up to 200,000 characters of each file (settings → Documents:
  50,000, 200,000 or 1,000,000), and up to 64 MB of document text in all.
  Settings shows how much is used.
- Adding the same file again changes nothing. **Update from file…** on a
  document's card, or in the explorer, reads it again and replaces its text.
- Searches find words anywhere in a document, and the row shows the passage
  that matched. In the explorer, **Show text** pages through the whole
  document, with page numbers for PDFs.
- If Kage thinks the text holds a password or key, the document is private
  and your agent never sees it, until you choose **Let my agent see it**.

On a Kage without this, Mind Map stores documents as **references** — a
path, a link or a window title — and never reads files. Either way, you can
attach a file in chat and ask your agent to "add this to my mind map": it
saves a short summary, the key terms and the actions (each action must quote
the document word for word, and the agent's actions arrive as suggestions).

You can also ask your agent to organize notes you've already saved: type
`mm organize`. It sends your agent a visible message with up to 15 notes it
hasn't organized yet (never private ones) and the names you already use, and
asks for one Mind Map change. The agent can add a short summary, names
(reusing yours), key terms, actions that quote the note word for word, or fix
a note's kind. It only adds: nothing you wrote or a page provided is
overwritten, private items are refused, and one `mm undo` takes the whole
change back. Run it again for the next batch.

On macOS, window titles need the Screen Recording permission. Without it, only
the app's name is remembered and "Save the window you came from" isn't offered.

## Background organizing (off by default)

On a Kage that can ask your agent in the background, Mind Map can do what
`mm organize` does without you asking: turn on **Organize new notes in the
background** in settings, then **Allow on this computer…**. Kage shows which
agent will get your notes and asks you to confirm. Nothing is sent before
that, and you confirm again if you switch agents.

- While you aren't using Kage, Mind Map sends up to 15 new notes at a time
  (saved at least two minutes ago, from the last week) and the names you
  already use. Your agent sends back short summaries, names, key terms and
  suggested actions that quote the note.
- Private notes, notes that name a private person or topic, and documents
  Kage thought hold a password or key are never sent. Nor are window titles,
  apps, folders or the names that mean you.
- What it adds only adds, and its actions are suggestions for `mm review`.
  A note you change, delete or make private while its batch is out isn't
  touched.
- The note's card says "✦ Organized by your agent", with **Undo organizing**
  for the batch it came in. `mm undo` leaves background changes alone and
  undoes your own.
- Settings shows how many notes are organized and waiting, **Organize now**
  and **Organize older notes too**. Kage lists every request, what was sent
  and how many requests are left today in Mind Map's Background AI panel,
  and can stop or pause them.
- On several computers, each organizes its own new notes first, and the
  others' after a day.

## Privacy

Your mind map is stored only on this computer, in Kage's extension data
folder. Saving a link fetches that page's title and description (you can turn
this off). When you ask your agent — or it calls a Mind Map tool — the
matching snippets are sent to the agent you configured, which may be a cloud
service (for example Claude Code, Codex or Kiro) or local (for example
Ollama). Private items are never sent. Uninstalling Mind Map deletes its data:
export first if you want to keep it.

- Start a capture with `!` (`mm+ ! salary thoughts`) or add `#private` to make
  it private, or turn on "Make new items private". Private items work in the
  launcher but are never sent to an agent, and an agent's citation of one
  shows only "private item".
- Window titles and app names stay on this computer (a saved window's own
  title is the document's title).
- When you add a file, Kage reads it on this computer and gives Mind Map its
  text. Mind Map keeps up to the number of characters you chose with your
  notes. Kage never tells Mind Map where the file is. Your agent gets a
  document's name, size, summary and the passages that match a search, never
  the whole text.
- Everything sent to an agent is framed as your data, not instructions. The
  agent's writes only add (they never delete or overwrite what you wrote) and
  can be undone.
- Kage asks you before each Mind Map tool is used for the first time. Turn the
  tools off in settings ("Let your agent search and add to your mind map").
- Background organizing is off until you turn it on and confirm the agent in
  Kage. Then new notes you haven't marked private are sent to your agent in
  small batches while you aren't using Kage.
- Mind Map stores no passwords, keys or other credentials, and sends no
  telemetry.

## Your data

Settings shows what's stored, and offers **Export JSON** (everything,
private items and the full text of your documents included), **Export
Markdown**, **Import JSON** and **Delete everything**. Exports include
private items; keep them somewhere safe.

**Import JSON** reads an Export JSON file, for example from another computer.
Items already here are kept unless the file has a newer copy, people, teams
and topics with the same name become one, and one `mm undo` takes the whole
import back.

Export Markdown is a readable copy: a section for each person, team, project
and topic, then "Unsorted". Each item is a bullet with its date and kind,
links are links, actions are `- [ ]` / `- [x]` under the note or meeting they
came from, and a note's own words (its summary, the rest of its text, dated
notes you added later) follow it as a quote. A "Documents" section lists the
files you added, with their file names, pages and summaries.

Data is split into monthly files, written with a twin copy so a crash
mid-save can't lose it, and every Kage window coordinates through a short
lock. If stored data can't be read, Mind Map stops saving rather than risk
overwriting it, and settings offers **Export raw copies** and **Repair**.

Limits: 8,000 characters per capture (longer text is cut and the card says
so), 50 actions per brain dump, 200 undo steps, up to 1,000,000 characters
per added file and 64 MB of document text. It's built for about 10,000
items.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Your mind map itself. |
| `urls` | Opening saved links. |
| `network` | Fetching a saved link's title and description (can be turned off). |
| `windows` | Saving the window you came from, and jumping back to an open document. |
| `views` | The explorer's own window. |
| `file_text` | Reading a file you pick with **Add a file…**: only that file, each time, never its folder or any other file. |
| `agent_background` | Background organizing, off until you turn it on and confirm which agent gets your notes. |
