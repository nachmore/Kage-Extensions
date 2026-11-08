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
| `mm+` | Save the window you came from (a document open in Word, Docs, …). |
| `mm <question or keywords>` | Find things. Enter opens a link, jumps back to a document's window, or shows the note. |
| `mm actions` | Your open actions, due first. Enter marks one done (and Enter again reopens it). |
| `mm review` | Suggested actions waiting for you to accept. |
| `mm @bingo`, `mm #mtcs` | Everything about a person, team, project or topic. |
| `mm recent` · `mm undo` · `mm help` | Latest captures · undo the last change · syntax reference. |
| `mm map [name]` | A map centred on a person, team or note; click a node to move there. |
| `mm? <question>` | Ask your agent; it answers from your notes and cites them. |

`mm` alone shows your open actions, suggestions to review and recent
captures. The trigger word can be changed in settings (`mm` → `brain` also
gives `brain+` and `brain?`).

## Asking

```
mm remind me which doc spoke about mtcs last week
```

finds the docs and links from last week (Mon–Sun) that mention MTCS. Each row
shows the day, where it came from, the matching words, and why it matched. A
"🔎" row shows how the question was read — `Docs & links · Mon, Oct 26 –
Sun, Nov 1 · “mtcs”` — and Enter turns it into exact filters you can edit. If
nothing falls in the range, the search widens and says so ("Nothing from Thu,
Nov 5 — closest matches from Oct 6 – Nov 6").

```
mm what were my actions for the bingo team
```

lists your open Bingo actions (overdue first, then by due date), then the ones
you finished in the last two weeks. Actions inherit the team of the meeting or
note they came from, so "book the offsite" counts as a Bingo action. A row
offers everyone's actions too.

You can also just ask your agent in chat — "which doc spoke about mtcs last
week?" — and it uses Mind Map's tools. Answers cite items as numbered chips;
click one to see the date and snippet, or open it.

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

## Documents

Mind Map stores documents as **references** — a path, a link or a window
title — and never reads files. To save what a document says, attach it in chat
and ask your agent to "add this to my mind map": it saves a short summary, the
key terms and the actions (each action must quote the document word for word,
and the agent's actions arrive as suggestions).

On macOS, window titles need the Screen Recording permission. Without it, only
the app's name is remembered and "Save the window you came from" isn't offered.

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
- Everything sent to an agent is framed as your data, not instructions. The
  agent's writes only add (they never delete or overwrite what you wrote) and
  can be undone.
- Kage asks you before each Mind Map tool is used for the first time. Turn the
  tools off in settings ("Let your agent search and add to your mind map").
- Mind Map stores no passwords, keys or other credentials, and sends no
  telemetry.

## Your data

Settings shows what's stored, and offers **Export JSON** (everything,
private items included), **Export Markdown**, **Import JSON** and **Delete
everything**. Exports include private items; keep them somewhere safe.

Data is split into monthly files, written with a twin copy so a crash
mid-save can't lose it, and every Kage window coordinates through a short
lock. If stored data can't be read, Mind Map stops saving rather than risk
overwriting it, and settings offers **Export raw copies** and **Repair**.

Limits: 8,000 characters per capture (longer text is cut and the card says
so), 50 actions per brain dump, 200 undo steps. It's built for about 10,000
items.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Your mind map itself. |
| `urls` | Opening saved links. |
| `network` | Fetching a saved link's title and description (can be turned off). |
| `windows` | Saving the window you came from, and jumping back to an open document. |
