---
name: bosun
description: The shared protocol for working inside a Bosun fleet (a folder with fleet.conf, worker-N worktrees and the ~/.claude/fleet/fleet script). Claim a worker for a task, resume where the last agent stopped or start fresh, leave notes, answer review comments, run the project's gate, push the task branch, release the worker. Use when a project's own *-fleet skill sends you here, or when you are about to edit a repo that has a fleet folder and other agents may be active.
---

# bosun

Several agents share working copies of one repository. This is the protocol that
stops them clobbering each other and lets one agent pick up where another stopped:
claim a worker for a task, work on its branch, run the gate, push, release.

## Where things are

The project's own skill names the fleet folder. If none did, it is the nearest folder
above your working directory that holds `fleet.conf`.

```bash
FLEET=/path/to/<repo>-fleet                 # the folder holding fleet.conf
fleet() { ~/.claude/fleet/fleet -f "$FLEET" "$@"; }
```

Shell state does not persist between Bash calls, so define `fleet()` in each call.

- `~/.claude/fleet/fleet` — the coordination script. It owns locks, leases and task
  records. **Never `mkdir`/`rmdir` a lock by hand.**
- `$FLEET/fleet.conf` — workers, base branch, lease length, task key pattern, and the
  source clone (`REPO`) the worktrees share a `.git` with.
- `$FLEET/FLEET_POLICY.md` — the project's rules: branch naming, repo areas, the
  verification gate, and branches no worker may push to. **Read it before you start.**
- `$FLEET/FLEET.md` — gate baselines and any notes the project keeps for agents.
- `$FLEET/.locks/<worker>/owner` — who holds a worker: session, task, branch, lease.
- `$FLEET/beads/` — the task records (Beads). Never run `bd init` in a worker or `REPO`.
- `$FLEET/main/` — read-only reference at the base branch. Never work there.
- `$FLEET/worker-N/` — the worktrees you work in.

`REPO` is a human's own clone. It shares `.git` with the workers but is not a worker:
never claim it, branch in it, or touch its working tree.

## 1 — Claim a worker for the task

```bash
fleet provision          # restores any missing worktree; safe every time
fleet status             # who holds what, and which tasks are resumable
fleet claim <TASK> --branch <branch> --title "one-line description"
```

`<TASK>` must match `TASK_KEY_PATTERN` in `fleet.conf` (usually the ticket key);
`<branch>` follows the naming in `FLEET_POLICY.md`. `claim` prints `WORKER=`, `DIR=`,
`BRANCH=` and `MODE=`. Work only in `DIR`.

- **`MODE=new`** — no record existed; the branch was cut from the base branch.
- **`MODE=resume`** — a record existed. `--branch` is ignored; the recorded branch is
  checked out, and `claim` prints the earlier agents' notes, then the **Evidence**: the
  last gate result and whether it still covers this code, whether the branch is
  pushed, the commits and the changed files. **Notes are claims, not facts.** Before
  building on "done: X", find X in the evidence (the commits, the diff, a `[gate]` or
  `[fleet]` line). If you can't find it, treat X as not done and say so in your first
  note. Do not redo work the evidence shows is finished.
- **`MODE=fresh`** — see below.

If the user says **start fresh** ("start over", "from scratch") for a task, add
`--fresh`. The old record is closed and the old local branch parked as
`salvage/<branch>-<timestamp>`; nothing is deleted. Only use `--fresh` when asked. If
the old branch was already pushed, `claim` refuses the same name: pick a new one and
tell the user the old remote branch still exists.

If `claim` says all workers are busy, **stop and tell the user**, with the
`fleet status` output. A worker whose owner process died or whose lease ran out is
taken over automatically when its tree is clean; one with uncommitted work is not
(see Recovery).

## 1b — Pin down what the user wants (the brief)

When the fleet sets `BRIEF_REQUIRED=1`, each task needs a brief at
`$FLEET/briefs/<TASK>.md` before any code changes. The guard hook blocks edits in the
worker and `fleet gate` refuses until it exists. `claim` tells you whether the task has
one.

- **It has one** (a resumed task): read it. It is what the user agreed to, and it is the
  spec the reviewer checks against. Don't re-grill. If the user changes scope, update
  the brief with them first.
- **It has none:** load the `mattpocock-skills:grilling` skill and interview the user,
  starting from the ticket (fetch it, and paste its text into the brief). Look facts up
  yourself rather than asking; put every *decision* to the user. Stop when nothing is
  left silently assumed and the user confirms.

Then write the brief:

```markdown
# <TASK>: <title>
## Ticket
<the ticket text, verbatim>
## Goal
## Acceptance criteria
- <each one checkable: a reviewer must be able to say yes or no>
## Out of scope
## Decisions
- <decision> (user, <date>)
```

Small tasks get a short brief, not a skipped one: one round of questions is fine.

## 2 — Do the task, and leave a trail

Work inside `DIR` and commit as you go on the task branch. The lease (see
`LEASE_HOURS`) is renewed by every `fleet note`. Record progress at each milestone;
it is what the next agent resumes from:

```bash
fleet note worker-N "Decided X because Y. Done: A, B. Next: C. Open question: D."
```

Write notes for a reader with no access to this conversation: decisions and their
reasons, what is finished, what is next, what the user still has to decide. Make every
"done" checkable: name the commit, file or command that proves it. Never write test
or error counts by hand; `fleet gate` records its own.

### Review comments

The user may review from the Fleet View panel. Comments land in
`$FLEET/scratchpad/reviews/<TASK>.md`, and `fleet claim`, every `fleet note` and every
new prompt (through the Fleet View hook) show the ones still open. Treat them as
requests from the user: make the change or explain why not, then edit that file —
turn the item's `- [ ]` into `- [x]` and add an indented `> what you did` line under
it. A `>> ` line under an item is the user following up (it unticks the item again):
answer the newest one with another `> ` line. Leave the `## file:line` headings alone. `release --state review` refuses while
any open item has no reply. The reviewer (step 3b) writes its findings into the same
file.

## 3 — Verification gate

```bash
fleet gate worker-N
```

It runs the checks in `fleet.conf` (`GATE`) that match the paths you changed, on your
worker and on your branch's merge-base, and blocks only on what your branch broke: a
test that passes on the base but fails here, or a typecheck error line that isn't on
the base (the new lines are printed). The result is recorded against the exact code
it ran on, so any later edit or rebase means running it again. Read the logs it
points to rather than guessing why a check failed. If the project has no `GATE`, run
the gate `FLEET_POLICY.md` lists by hand.

## 3b — Independent review (the loop)

The gate proves the code builds and nothing regressed. It doesn't prove the change
does what the user asked, or that your notes are true. When you think you're done and
the gate passes:

```bash
fleet review worker-N     # takes minutes: run it in the background, or with a 10-minute timeout
```

With `REVIEW_ROUNDS` set, the harness starts a **fresh, read-only, headless Claude**
that never saw your reasoning. It gets the brief, the diff against the merge-base, your
notes and the review comments so far. It runs `mattpocock-skills:code-review` (Standards
and Spec axes) and `ponytail:ponytail-review`, checks every claim in your notes, and
checks that everything the diff relies on actually exists. Then:

- **blocking** and **should** findings are added to `$FLEET/scratchpad/reviews/<TASK>.md`
  as review comments; nits only go in the report it prints.
- For each comment: fix it and tick it, or answer it (`> why not`). Then
  `fleet gate worker-N && fleet review worker-N` again. The next round sees your replies.
- `release --state review` needs a review of the exact final code with no blocking
  findings, and every comment answered.
- After `REVIEW_ROUNDS` rounds the loop stops: answer every remaining comment, release
  for review, and tell the user what is still disputed. A human settles it.

Don't argue with the reviewer by rewording your notes; change the code or reply on the
comment. If the reviewer is wrong, say why in the reply: the human reads both.

Without `REVIEW_ROUNDS`, do the same by hand: start a fresh subagent with only the
brief, `git diff <merge-base>` and `fleet show <TASK>`, and ask it for the same checks.

## 4 — Push the branch

```bash
cd "$DIR"
git fetch origin <base>
git rebase origin/<base>        # land on the current integration point
# re-run the gate if the rebase moved anything
git push -u origin <branch>
```

`<base>` is `BASE_BRANCH` in `fleet.conf`. **Never push to the base branch** and never
to any branch `FLEET_POLICY.md` protects: a task ends at a pushed branch awaiting
human review, unless the policy explicitly says agents merge. If the rebase conflicts
beyond mechanical resolution, stop and surface it to the user.

## 5 — Release the worker

Always release when you stop, whatever the outcome. The tree must be clean; `--wip`
commits leftovers to the task branch as a `wip` commit.

```bash
fleet release worker-N --state review --note "pushed; review round 2 approved; needs decision on X"
fleet release worker-N --state paused --note "done: A, B. next: C. blocked on: D" [--wip]
fleet release worker-N --state done
```

Release adds a `[fleet]` line of facts next to your note: HEAD, whether the branch is
pushed, and whether the last gate covers this code.

- `review` — branch pushed, waiting on a human. **Refused** unless `fleet gate` passed
  on exactly the code being released, the reviewer passed it (when `REVIEW_ROUNDS` is
  set), and every review comment has a reply. A failing gate you can't fix means `paused`,
  with a note saying why. The record stays open, so review feedback is handled by
  claiming the same task again.
- `paused` — stopping mid-task. `--note` is required; it is the handoff.
- `done` — merged or abandoned for good. Closes the record.

Then report to the user: branch, gate results (quote the `[gate]` line), the
reviewer's verdict (quote the `[review]` line), and what still needs their decision.

## Invariants

- **One agent per worker**, and one live claim per task.
- **Locks and records change only through `fleet`.**
- **Never touch `$FLEET/main/` or `REPO`'s working tree.**
- **Never write to the base branch** unless `FLEET_POLICY.md` says so.
- **Preserve, never discard.** Unexpected uncommitted work is salvaged, not cleaned.
- **Resume by default; start fresh only when the user says so.**
- **Evidence over claims.** Notes say what an agent believed; commits, the diff and
  `[gate]`/`[fleet]` lines say what is true. When they disagree, the evidence wins.

## Recovery

`fleet status` shows each worker's state. A session counts as running while a Claude
process carries its id, so a session resumed with `claude --resume` still holds its worker.

- `CLAIMED` — live. Leave it alone.
- A record marked `stale-claim` — its agent stopped without releasing. Nobody holds
  it; `fleet claim <TASK>` resumes it.
- `DEAD` — the session ended and the tree is clean. The next `claim` takes it over and
  the old task stays resumable.
- `INTERRUPTED` — the session ended with uncommitted work (a crash, a restart). Nothing
  collects it. To pick it back up, `fleet claim <its TASK>` adopts the worker with the
  work in it, or the user continues the old conversation with `claude --resume <session>`
  (status prints both). Any other task skips it. Only if the user gives up on it:
  `fleet reclaim worker-N --salvage` commits it to its task branch before freeing it.
- `EXPIRED` — the session still runs but has not renewed its lease. With a clean tree
  the next `claim` takes it over; otherwise leave it and tell the user.
- `LEGACY` — a lock made by hand (no owner file). Never reclaim it without the user
  confirming nobody is in it; then `fleet reclaim worker-N --legacy`.

`fleet gc` lists the bookkeeping that no longer matches the world: workers of ended
sessions (`free`), records whose branch is merged into a base (`close`), records that say
claimed while nobody holds them (`pause`), INTERRUPTED workers (`resume`) and what it
cannot judge (`needs-you`: a missing branch, a branch nobody ever committed on). It only
reports; `fleet gc --apply` frees, closes and pauses, and never touches uncommitted work.
Run `--apply` only when the user asks.
