# Bosun

The bosun checks the crew's work before it reaches the captain.

Bosun runs several Claude Code agents in parallel, each in its own git worktree,
and won't hand you an agent's work until it can prove that work holds up.

- **Gate tied to the code.** `fleet gate` runs your checks on the worker and on its
  merge-base, and records the result against a tree id of the exact code, uncommitted
  changes included. Change one line and the pass no longer counts.
- **Briefs before edits.** The agent agrees acceptance criteria with you first. The
  brief becomes the reviewer's spec.
- **Review rounds with a cap.** A headless reviewer checks the work against the brief.
  Blocking findings go back to the agent; after the last round, a human decides.
- **Work that survives sessions.** Each task keeps a record of its branch and notes,
  so the next agent resumes where the last one stopped, even after a restart.
- **Fleet View.** A VS Code dashboard that shows which workers need you, plus line
  comments that reach the agent on its next prompt.

Status: early, and built on Claude Code internals that may change between releases.

## Shared engine, agent skill and Fleet View

The tooling lives in three folders, and `install.sh` links them into place so this
repo stays the single source:

- `engine/fleet` — the coordination script every fleet skill calls. Workers are locked
  through `.locks/<worker>/owner` (session, pid, task, branch, lease), and each task
  keeps one Beads record so a later agent resumes the same branch and notes. Configure
  a fleet with `<fleet-dir>/fleet.conf`; see `engine/fleet.conf.example`. `fleet claim`
  and `fleet note` also print the task's open review comments.
- `skills/bosun/SKILL.md` — the Claude Code skill with the shared protocol:
  claim, resume or start fresh, leave notes, answer review comments, run the gate,
  push for review, release. Project rules (gate commands, branch naming, protected
  branches) stay in each fleet's own `FLEET_POLICY.md` and `FLEET.md`; a project can
  add a short skill of its own that names its fleet folder and points here.
- `fleet-view/` — a VS Code extension plus a local live server (`server.js`, one per
  fleet on `127.0.0.1:7420`, token and Host checked) that shows occupancy, sessions,
  per-worker changes, charts, Mermaid diagrams and review comments. `hook.js` is a
  Claude Code hook (UserPromptSubmit and Stop) that records what each session is doing
  and hands new review comments to the agent.

### Install

Needs git, jq, [Beads](https://github.com/steveyegge/beads) (`bd`) and node; VS Code
for Fleet View.

```bash
./install.sh
```

It symlinks `~/.claude/fleet/fleet`, `~/.claude/fleet/fleet-view` and
`~/.claude/skills/bosun` to this checkout, links the VS Code extension to the
same folder, and adds the hook to `~/.claude/settings.json`. Anything already in
place is kept as `<path>.bak-<timestamp>`. Because the links point into this checkout,
keep it on a branch that has these files.

Then set up a fleet:

```bash
mkdir ~/code/myrepo-fleet && cp engine/fleet.conf.example ~/code/myrepo-fleet/fleet.conf   # edit it
~/.claude/fleet/fleet -f ~/code/myrepo-fleet init
~/.claude/fleet/fleet -f ~/code/myrepo-fleet provision
```

Self-checks: `engine/test_fleet.sh`, `node fleet-view/review.js` and `node fleet-view/gather.js <fleet-dir>`.

## Private use

This repository is intended for private or controlled use. It is a structured workflow for safe parallel execution and is not intended for public redistribution.

## License

Copyright (c) 2026 nkoda. All rights reserved.

People given access to this repository by the copyright holder may use and
modify the software for their own work. They may not publish, redistribute,
sublicense or sell it, in source or compiled form, without written permission.
This permission ends when their access is removed.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

The same terms are in `LICENSE`; `NOTICE` covers distribution.
