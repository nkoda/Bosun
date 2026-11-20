#!/usr/bin/env bash
# Self-check for the turn snapshots in hook.js: a session that holds a worker appends one
# line per prompt and per stop to <fleet>/.fleet-view/turns/<task>.jsonl, with the worker's
# exact code tree; a session that holds nothing appends nothing. Builds a throwaway fleet
# in a temp dir, with HOME in the temp dir.
# Usage: fleet-view/test_turns.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"' EXIT
export HOME="$T"
q()    { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}" >/dev/null 2>&1; }
FAILS=0
ok()   { echo "ok   - $1"; }
bad()  { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }
W="$T/fleet/worker-1"
TURNS="$T/fleet/.fleet-view/turns"
hook() { # hook <event> <session> [prompt]: pipe one hook event, record a non-zero exit
  jq -n --arg e "$1" --arg s "$2" --arg p "${3:-}" --arg c "$W" \
    '{hook_event_name: $e, session_id: $s, cwd: $c, prompt: $p, transcript_path: "/nonexistent"}' \
    | node "$HERE/hook.js" > "$T/out" || bad "hook exited non-zero on $1"
}

# repo with one commit, and a fleet whose worker-1 is held by session S for T-1
git init -q -b main "$T/repo"
echo one > "$T/repo/a.txt"
q "$T/repo" add -A; q "$T/repo" commit -m base
mkdir -p "$T/fleet/.locks/worker-1"
echo "REPO=$T/repo" > "$T/fleet/fleet.conf"
q "$T/repo" worktree add -b t-1 "$W" || { echo "setup failed"; exit 1; }
printf 'session=S\ntask=T-1\nbranch=t-1\n' > "$T/fleet/.locks/worker-1/owner"

hook UserPromptSubmit NOBODY "not held"
[ ! -e "$TURNS" ] && [ -f "$T/fleet/.fleet-view/sessions/NOBODY.json" ] \
  && ok "a session that holds nothing writes its session file and no turn line" || { bad "unheld session"; ls -R "$T/fleet/.fleet-view"; }

hook UserPromptSubmit S "$(printf 'x%.0s' {1..400})"
# a new size: a same-size edit in the same second as the index write looks clean to git (racy git)
echo changed > "$W/a.txt"; echo new > "$W/b.txt"
hook Stop S
[ "$(wc -l < "$TURNS/T-1.jsonl" | tr -d ' ')" = 2 ] && ok "a prompt and a stop append 2 lines" || { bad "line count"; cat "$TURNS/T-1.jsonl"; }
L1="$(sed -n 1p "$TURNS/T-1.jsonl")"; L2="$(sed -n 2p "$TURNS/T-1.jsonl")"
echo "$L1" | jq -e '.event == "prompt" and .session == "S" and .worker == "worker-1" and .task == "T-1" and (.at | length > 0) and (.prompt | length) == 300 and (.tree | test("^[0-9a-f]{40,64}$"))' >/dev/null \
  && echo "$L2" | jq -e '.event == "stop" and (has("prompt") | not)' >/dev/null \
  && ok "lines carry at, event, session, worker, task, tree, and a 300-char prompt on prompt events" || { bad "line fields"; echo "$L1"; echo "$L2"; }
T1="$(echo "$L1" | jq -r .tree)"; T2="$(echo "$L2" | jq -r .tree)"
[ -n "$T1" ] && [ "$T1" != "$T2" ] && ok "the two trees differ" || bad "trees: $T1 $T2"
[ "$(git -C "$W" diff --name-only "$T1" "$T2" | tr '\n' ' ')" = "a.txt b.txt " ] \
  && ok "the stop tree has the uncommitted edit and the untracked file" || { bad "tree diff"; git -C "$W" diff --name-only "$T1" "$T2"; }
[ "$T2" = "$(node -e 'require(process.argv[1]).codeTree(process.argv[2]).then(t => console.log(t))' "$HERE/gather.js" "$W")" ] \
  && ok "tree equals codeTree(worker dir)" || bad "tree is not codeTree"
[ ! -s "$T/out" ] && ok "no review comments, so stdout stays empty" || { bad "stdout"; cat "$T/out"; }

mkdir -p "$T/fleet/scratchpad/reviews"
printf '## a.txt:1\n- [ ] fix this\n' > "$T/fleet/scratchpad/reviews/T-1.md"
hook UserPromptSubmit S "again"
grep -q "\[Fleet review\] 1 open review comment(s) on T-1" "$T/out" && grep -q "a.txt:1: fix this" "$T/out" \
  && [ "$(wc -l < "$TURNS/T-1.jsonl" | tr -d ' ')" = 3 ] \
  && ok "an open review comment still reaches stdout, next to the turn line" || { bad "review output"; cat "$T/out"; }
hook Stop NOBODY
[ "$(wc -l < "$TURNS/T-1.jsonl" | tr -d ' ')" = 3 ] && [ "$(ls "$TURNS")" = "T-1.jsonl" ] \
  && ok "a session that holds nothing still adds no line after held turns" || { bad "unheld session after"; ls "$TURNS"; }

echo 'not json' | node "$HERE/hook.js" >/dev/null 2>&1 && ok "bad input still exits 0" || bad "bad input exit"

[ "$FAILS" = 0 ] && echo "all passed" || { echo "$FAILS failed"; exit 1; }
