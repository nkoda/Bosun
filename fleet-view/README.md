# Fleet View

A live view of a Bosun fleet, in VS Code or a browser: who holds which worker, what
each agent is doing, what changed, and a way to review the changes and send comments
back to the agent.

It is a local server (`server.js`, one per fleet) plus a thin VS Code extension
(`extension.js`) that shows the same page (`ui.html`) in the Explorer sidebar and in an
editor tab. The servers keep running when VS Code closes; the first fleet's is on
`http://127.0.0.1:7420/`, and *Fleet: Open Dashboard in Browser* finds any of them.

## Which fleets a window shows

A VS Code window shows the fleet it is inside (opened at a worker, `main/` or the fleet
folder) and every fleet up to three folders below its workspace folders, and nothing
beside or above them. A fleet is a folder with a `fleet.conf`; the search never goes
inside a git repo. Opened at a folder holding two fleets, the window shows both: a
status bar item each, a dashboard tab each (*Fleet: Open Dashboard* asks which), and a
switcher at the top of the sidebar. Each fleet runs its own server; the first asks for
`fleetView.port` and any other takes a free port, recorded in its `.fleet-view/server.json`.

## What it shows

Every worker is in one of five states, worked out by `phase()` in `gather.js`:
**Working** (the agent is mid-turn), **Needs you** (claimed, the agent stopped),
**Ready for review** (stopped and passing everything `release --state review`
checks), **Stuck** (its session ended, with or without uncommitted work, its lease ran out, or a hand-made lock) and
**Idle** (free). The engine's lock state stays in the tooltip.

- **Needs you** (the overview) — one card per thing a person has to do, most urgent
  first: agents waiting on you (with their last reply and a box to answer them), stuck
  workers, tickets ready for review or released for review, and files two workers are
  both changing. Below it: the agents still working, the **Fleet map** (a live diagram
  of who holds each worker, their running subagents, who they message and files two
  workers share), **Fleet over time** (a scrubber
  over the last 200 state changes), changes by repo area (folded), and the tickets
  with their harness steps, flagged with what `fleet gc` would do about them. Worker
  state and those flags come from the engine (`fleet status --json`, `fleet gc --json`),
  so the panel never disagrees with `claim`; a Stuck card shows gc's advice.
- **Lanes** — every open ticket as a card in the column of the first harness step it
  still has to pass (Brief, Gate, Review, Comments, Push, Ready for a person).
- **Worker pages**, in the order you act on them — the ticket, its state and harness
  steps; its **review guide**; the conversation with a reply box; its **agents** (a
  live diagram of the session's subagents and `SendMessage` calls, then each agent with
  what it is doing now, what it was asked and what it answered); the changed files
  with their review comments inline (click a file for a before / after diff); then,
  folded, the timeline, Mermaid branch graph, change map and churn by file.
- **Ticket pages** — click any ticket (open or finished) for its review guide and full
  timeline, merged across start-overs, with every claim's session resumable.

The timeline comes from the task's Beads records: every claim, note, handoff, reclaim
and closure, each tied to the session that made it.

Agents come from what Claude Code writes beside each session's transcript
(`<session>/subagents/agent-<id>.jsonl` and `.meta.json`). An agent is Done once its last
reply ends its turn, Running if it wrote in the last two minutes, else Stopped. The server
re-reads those files every 3 seconds (cached, no git), and a worker whose session finished
its turn while background agents still run shows as Working.

Live updates repaint only what changed and keep focus, open folds and half-typed
replies. <kbd>j</kbd> / <kbd>k</kbd> step through the pages; **Fleet: Go to Worker…**
does the same from the command palette.

## Notifications

In VS Code, the focused window shows a notification when a worker turns **Needs you**
(only after a turn of 90 seconds or more, so a quick back-and-forth stays quiet),
**Ready for review** or **Stuck**, and when a file starts being changed in two workers.
Nothing fires for what was already true when VS Code started. Mute them from the
notification's gear like any extension's.

## Continuing a session

Every session on the page has one **Open** button. `fleetView.openIn` decides where it
goes, and ⌥-click goes the other way:

- `tab` (default) — a new Claude Code editor tab in the current window
  (`claude-vscode.primaryEditor.open`, the command behind Claude Code's own
  `vscode://anthropic.claude-code/open?session=` links).
- `terminal` — `claude --resume <session>` in a terminal, in the folder the session
  was started in.

A reply typed on the page opens the session the same way, with the reply as the next
prompt. In a browser the tab route goes through the `vscode://` link and the terminal
route copies the resume command.

## Review comments

Comments come from four places: the comment button on a changed file, the **+** in a
diff's gutter (VS Code Comments API), the **+** on a line of a diff preview, and
annotations on the review guide. Every one starts as a **draft** in
`<fleet>/scratchpad/reviews/<TASK>.draft.json`, which the hook and the engine never read,
so an agent never acts on half a review. Drafts show on the page and in the gutter,
marked as drafts. **Submit review** moves them all, with an optional overall note, into
`<fleet>/scratchpad/reviews/<TASK>.md`, and can send them to the agent at once:

```markdown
## path/to/file.ts:42
- [ ] comment text — Author · 2026-11-04 10:31
  > what the agent did
  >> a follow-up from the reviewer — Author · 2026-11-04 11:02
```

The agent sees new open comments on its next prompt (through `hook.js`), and in the
output of `fleet claim` and `fleet note`. It answers by ticking `[x]` and adding a `> `
line; the page and the gutter threads update from the file. Each gutter thread, and its row in
the Comments panel, has a colour: none for a draft, 🔴 while the agent owes an answer, 🟡 once
it answered, 🟢 when you **Mark complete** it. **Reply** under a thread adds a `>> ` follow-up and
hands the item back to the agent. Completed items are resolved threads, so the Comments
panel's filter can hide them.

## Review guides

A reviewer who has never seen the ticket starts from the big picture and is led to each
change. Each ticket gets a guide with these sections, in this order:

- **Why**: the problem and the ask, from the brief.
- **Summary**: what changed and where it lives.
- **D1: Big picture**: a flowchart of the part of the system involved, with changed
  boxes drawn thicker. Clicking a changed box scrolls to its files.
- **D2: Data flow**: a sequence diagram of the request path, with the request and
  response shapes on the arrows.
- **Reading order**: files grouped by concern, core change first. Each file gets what
  changed, why, and what to check, and every file link opens the before / after diff
  at that line.
- **Tests**: what ran (including the gate) and what is not covered.

Two kinds, written by `server.js` running `claude -p` read-only (Read, Grep, Glob, Skill
and read-only git; edits denied) on your Claude account:

| Kind | When | Adds |
| --- | --- | --- |
| Guide (`<TASK>.md`) | automatically after every gate pass on new code, or *Write guide* | the sections above |
| In-depth review (`<TASK>.review.md`) | automatically when the ticket is released for review or passes everything release checks, or *Write in-depth review* | a line-level **Review checklist** (logic; request and response schemas as tables; security; team standards; code and comments), each finding linked to its line, and numbered **Open items** for the reviewer to challenge |

Both live in `<fleet>/scratchpad/overviews/`. Each file's header names the code tree it
was written for, so a guide is written once per version of the code (a failed run too,
so it is not retried every refresh; rewrite it by hand). At most two run at once. Tickets
with no work beyond their base are skipped. The brief and review comments go into the
prompt; a `change-walkthrough` skill and a team writing-standard skill are used when
installed.

**Reading it.** Each section has its own colour band, and a jump bar at the top counts
the files and checklist findings. In the reading order, every file is a card: its link
opens the full diff at that line, ⧉ opens the file, and 👁 previews the diff right there,
starting at the cited line, with a **+** on each line to comment. **What changed**, **Why**
and **Check** are labelled, and Check is highlighted. Checklist areas show *nothing found*
in green or their finding count in amber; security findings are red. Diagrams are live:
changed boxes are tinted, a box or message lights up on hover, and clicking one lists its
files and offers to annotate it. *Zoom* shows a wide diagram at actual size.

**Annotating it.** Select any text in the guide or a preview, or click a diagram box, and
annotate it for the agent with one of three intents: **Inspect** (look into it and
explain, no code change), **Review** (check it for problems and report) or **Change**
(make the change). It is stored as a comment `[change] "quoted passage": note` on the
file it sits in, and the passage stays highlighted in the intent's colour.

**Sharing it.** *Copy for GitHub PR* copies a PR description (Summary, Data flow, Tests,
Open items) with Mermaid blocks, which GitHub renders. *Copy with PNG diagrams*, for
review tools that cannot render Mermaid, copies the same text with image placeholders and
saves each diagram as a PNG (light theme) to `<fleet>/scratchpad/guides/<TASK>/` to attach.
The reading order and checklist stay in Fleet View for the developer doing the line-level
review.

## The hook

`hook.js` runs on `UserPromptSubmit` and `Stop` (`install.sh` registers it). For any
session working in a fleet it writes `<fleet>/.fleet-view/sessions/<id>.json` (last
prompt, last reply, whether it is working), which refreshes the page on every prompt.
On `UserPromptSubmit` it prints review comments the session has not seen yet, which
Claude Code adds to the agent's context. It never blocks a session: every failure is
swallowed and it always exits 0.

## Configuration

In the fleet's `fleet.conf`, besides the engine's keys:

| Key | Use |
| --- | --- |
| `EXTRA_BASES` | other refs task branches may be cut from, e.g. `"origin/develop"` |
| `JIRA_URL` | turns task keys like `PROJ-123` into ticket links |

VS Code settings: `fleetView.dir` (one more fleet folder to show, besides the ones found
in the workspace), `fleetView.port` (the first fleet's port, default `7420`) and
`fleetView.openIn` (`tab` or `terminal`).

## Security

The server binds to `127.0.0.1` only. Every `/api` and `/events` call needs the token
in `<fleet>/.fleet-view/token` (created with mode 600), and the `Host` header must be
`127.0.0.1` or `localhost`, which blocks DNS rebinding. This matters because review
comments end up in agents' context.

## Files and state

| Path | What |
| --- | --- |
| `gather.js` | read-only snapshot: locks, git state per worker, Beads records and timelines, sessions |
| `review.js` | the review file format: parse, add, tick; drafts and submit |
| `server.js` | `node server.js <fleet-dir> [port]`; watches the fleet and pushes state over SSE |
| `extension.js` | starts or reuses the server, hosts `ui.html`, routes clicks into VS Code |
| `hook.js` | the Claude Code hook above |
| `<fleet>/.fleet-view/` | token, server log, state history (`history.json`, the last 200 changes), session files |
| `~/.claude/fleet/fleets.json` | fleets the hook knows about, written by the server |

The page loads Mermaid, marked and DOMPurify from jsdelivr. The codicons are bundled in `media/` (MIT, from `@vscode/codicons` 0.0.36), so icons work offline.

Self-checks: `node review.js` and `node gather.js <fleet-dir>`.
