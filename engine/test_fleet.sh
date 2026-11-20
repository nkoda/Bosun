#!/usr/bin/env bash
# Self-check for the engine's evidence features: brief, guard hook, gate, the review loop,
# the release guards, takeover, stale-claim status, resume evidence, session liveness,
# INTERRUPTED workers and gc. Builds a
# throwaway fleet in a temp dir; the reviewer is a stub returning canned verdicts.
# Usage: engine/test_fleet.sh [path/to/engine]     (default: engine/fleet next to this file)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="${1:-$HERE/fleet}"; ENGINE="$(cd "$(dirname "$ENGINE")" && pwd)/$(basename "$ENGINE")"
GUARD="$HERE/fleet-guard"
T="$(mktemp -d)"; sleep 600 & HOLDER=$!                 # a live "agent" process to own claims
trap 'kill $HOLDER 2>/dev/null; wait $HOLDER 2>/dev/null; rm -rf "$T"' EXIT
export CLAUDE_PID=$HOLDER CLAUDE_CODE_SESSION_ID=test-session CLAUDE_SESSIONS_DIR="$T/sessions"   # empty: the pid decides
mkdir -p "$T/sessions"
fleet() { "$ENGINE" -f "$T/fleet" "$@"; }
q()    { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}" >/dev/null 2>&1; }
guard() { jq -n --arg f "$1" --arg s "${2:-test-session}" '{session_id: $s, tool_input: {file_path: $f}}' | "$GUARD" 2>"$T/guard.err"; }
FAILS=0
ok()   { echo "ok   - $1"; }
bad()  { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }

# origin with one pre-existing typecheck error on main
git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/repo" 2>/dev/null
mkdir -p "$T/repo/src"
echo "old error" > "$T/repo/src/errors.txt"
cat > "$T/repo/tc.sh" <<'EOF'
n=10; while read -r m; do echo "src/a.ts($n,1): error TS1: $m"; n=$((n+1)); done < src/errors.txt; [ ! -s src/errors.txt ]
EOF
echo '[ ! -e src/broken ]' > "$T/repo/test.sh"
q "$T/repo" add -A; q "$T/repo" commit -m base; q "$T/repo" push origin main

# The stub reviewer saves its prompt and prints whatever verdict the test put in $T/verdict.json.
cat > "$T/stub" <<EOF
#!/usr/bin/env bash
printf '%s' "\$2" > "$T/prompt"
jq -n --slurpfile v "$T/verdict.json" '{session_id: "stub", structured_output: \$v[0]}'
EOF
chmod +x "$T/stub"
verdict() { echo "$1" > "$T/verdict.json"; }

mkdir -p "$T/fleet"
cat > "$T/fleet/fleet.conf" <<EOF
REPO=$T/repo
WORKERS="worker-1 worker-2"
BRIEF_REQUIRED=1
REVIEW_ROUNDS=2
REVIEW_BIN=$T/stub
GATE="
t|test|src/ lib/|sh test.sh
ty|typecheck||sh tc.sh
"
EOF
{ fleet init && fleet provision; } >/dev/null 2>&1 || { echo "setup failed"; exit 1; }
W="$T/fleet/worker-1"

# --- brief and guard
fleet claim T-1 --branch t-1 --title one > "$T/out" || bad "claim"
grep -q "No brief for T-1" "$T/out" && ok "claim asks for grilling when there is no brief" || { bad "claim hint"; cat "$T/out"; }
guard "$W/src/x"; [ $? = 2 ] && grep -q "grilling" "$T/guard.err" \
  && ok "guard blocks edits in the worker until the brief exists" || { bad "guard brief"; cat "$T/guard.err"; }
echo "change" > "$W/src/x"
fleet gate worker-1 > "$T/out" 2>&1; grep -q "no brief" "$T/out" && ok "gate refuses without a brief" || { bad "gate brief"; cat "$T/out"; }
mkdir -p "$T/fleet/briefs"; printf '# T-1\n## Goal\ng\n## Acceptance criteria\n- BRIEF-MARKER works\n' > "$T/fleet/briefs/T-1.md"
guard "$W/src/x" && ok "guard allows edits once the brief exists" || { bad "guard allow"; cat "$T/guard.err"; }
guard "$T/fleet/briefs/T-2.md" && ok "guard allows writing a brief" || bad "guard brief write"
guard "$T/fleet/main/src/x"; [ $? = 2 ] && ok "guard blocks edits in main/" || bad "guard main"
guard "$T/fleet/worker-2/src/x"; [ $? = 2 ] && grep -q "not claimed" "$T/guard.err" && ok "guard blocks an unclaimed worker" || bad "guard unclaimed"
guard "$W/src/x" other-session; [ $? = 2 ] && grep -q "another session" "$T/guard.err" && ok "guard blocks another session's worker" || bad "guard session"
guard "/tmp/elsewhere.txt" && ok "guard ignores files outside a fleet" || bad "guard outside"

# --- gate
fleet gate worker-1 > "$T/out" && grep -q "ty: ok — no new errors (1 here, 1 on the base" "$T/out" \
  && ok "an error already on the base is not blamed on the branch" || { bad "baseline"; cat "$T/out"; }
echo "my new error" >> "$W/src/errors.txt"
fleet gate worker-1 > "$T/out"; [ $? != 0 ] && grep -q "TS1: my new error" "$T/out" \
  && ok "a new typecheck error fails the gate and is printed" || { bad "new error"; cat "$T/out"; }
fleet release worker-1 --state review 2>"$T/err"; grep -q "last gate failed" "$T/err" \
  && ok "review refused after a failing gate" || { bad "review guard (fail)"; cat "$T/err"; }
echo "old error" > "$W/src/errors.txt"; touch "$W/src/broken"
fleet gate worker-1 > "$T/out"; grep -q "t: FAIL (exit 1; passes on the base)" "$T/out" \
  && ok "a test that passes on the base and fails here blocks" || { bad "test fail"; cat "$T/out"; }
rm "$W/src/broken"; fleet gate worker-1 >/dev/null || bad "gate should pass"
echo more >> "$W/src/x"
fleet release worker-1 --state review 2>"$T/err"; grep -q "changed since the last gate" "$T/err" \
  && ok "review refused when the code changed after the gate" || { bad "stale gate"; cat "$T/err"; }
fleet gate worker-1 >/dev/null; q "$W" add -A; q "$W" commit -m work   # committing keeps the gated tree

# --- review loop
fleet release worker-1 --state review 2>"$T/err"; grep -q "no independent review yet" "$T/err" \
  && ok "release needs an independent review" || { bad "needs review"; cat "$T/err"; }
verdict '{"verdict":"changes_requested","summary":"s","findings":[
  {"severity":"blocking","axis":"existence","file":"src/x","line":1,"text":"calls fooBar, which does not exist","evidence":"git grep fooBar: nothing"},
  {"severity":"should","axis":"ponytail","file":"src/x","text":"inline the helper"},
  {"severity":"nit","axis":"standards","file":"src/x","text":"NIT-ONLY name"}]}'
fleet review worker-1 > "$T/out"; [ $? != 0 ] && grep -q "1 blocking, 1 should" "$T/out" \
  && ok "review reports blocking findings and exits non-zero" || { bad "review round 1"; cat "$T/out"; }
grep -q "BRIEF-MARKER" "$T/prompt" && grep -q "mattpocock-skills:code-review" "$T/prompt" && grep -q "ponytail:ponytail-review" "$T/prompt" \
  && ok "the reviewer gets the brief and both review skills" || bad "review prompt"
RF="$T/fleet/scratchpad/reviews/T-1.md"
[ "$(grep -c '^- \[ \]' "$RF")" = 2 ] && ! grep -q NIT-ONLY "$RF" \
  && ok "blocking and should findings become review comments, nits stay in the report" || { bad "review file"; cat "$RF"; }
fleet release worker-1 --state review 2>"$T/err"; grep -q "1 blocking" "$T/err" \
  && ok "release refused while the review has blocking findings" || { bad "blocking guard"; cat "$T/err"; }
verdict '{"verdict":"approve","summary":"s","findings":[]}'
fleet review worker-1 >/dev/null || bad "review round 2 should approve"
fleet release worker-1 --state review 2>"$T/err"; grep -q "2 review comment(s) .* have no reply" "$T/err" \
  && ok "release refused while comments are unanswered" || { bad "unanswered"; cat "$T/err"; }
fleet review worker-1 2>"$T/err" >/dev/null; grep -q "goes to a human" "$T/err" \
  && ok "no review rounds beyond REVIEW_ROUNDS" || { bad "round cap"; cat "$T/err"; }
awk '{print} /^- \[ \]/{print "  > fixed in work"}' "$RF" > "$RF.new" && mv "$RF.new" "$RF"
fleet release worker-1 --state review >/dev/null 2>"$T/err" \
  && ok "release allowed: gate, review and every comment answered" || { bad "release"; cat "$T/err"; }
fleet show T-1 | grep -q "\[fleet\] at release: HEAD .*not pushed; gate: pass" && fleet show T-1 | grep -q "\[review\] round 2: approve" \
  && ok "the record carries the gate, review and push facts" || { bad "record facts"; fleet show T-1; }

out="$(fleet claim T-1)"
grep -q "claims, not facts" <<<"$out" && grep -q "last gate: pass .* covers this exact code" <<<"$out" \
  && grep -q "src/x" <<<"$out" && grep -q "Brief agreed with the user" <<<"$out" \
  && ok "resume separates notes from evidence and points at the brief" || { bad "resume"; echo "$out"; }

# --- takeover: the owner of worker-1 (holding T-1) dies
sed -i.bak "s/^pid=.*/pid=999999/" "$T/fleet/.locks/worker-1/owner"
fleet status | grep -q "T-1 .*stale-claim" && ok "status flags a claim whose owner is gone" \
  || { bad "stale status"; fleet status; }
fleet claim T-2 --branch t-2 >/dev/null 2>&1    # worker-1 is tried first: dead and clean, so taken over
fleet status | grep -Eq "T-1 +paused" && ok "a takeover marks the old record paused" \
  || { bad "takeover"; fleet status; }
git -C "$T/repo" worktree list | grep -q "/.gate/" && bad "base worktree left behind" \
  || ok "the base worktree is removed after the gate"

# --- liveness: a resumed session keeps its id but gets a new pid (worker-1 holds T-2 now)
owner_dies() { sed "s/^pid=.*/pid=999999/" "$1" > "$1.x" && mv "$1.x" "$1"; }   # no .bak: reclaim wants an empty lock dir
owner_dies "$T/fleet/.locks/worker-1/owner"
echo "{\"pid\":$HOLDER,\"sessionId\":\"test-session\"}" > "$T/sessions/$HOLDER.json"
fleet status | grep -Eq "^worker-1 +CLAIMED" && ok "a resumed session (same id, new pid) still holds its worker" \
  || { bad "session liveness"; fleet status; }
rm "$T/sessions/$HOLDER.json"

# --- interrupted: the session ends with uncommitted work in the worker
echo "half done" > "$W/src/wip"
fleet status > "$T/out"; grep -Eq "^worker-1 +INTERRUPTED" "$T/out" && grep -q "fleet claim T-2" "$T/out" && grep -q "claude --resume test-session" "$T/out" \
  && ok "a dirty worker whose session ended is INTERRUPTED, with both ways to resume" || { bad "interrupted status"; cat "$T/out"; }
out="$(fleet claim T-3 --branch t-3 2>&1)"
grep -q "WORKER=worker-2" <<<"$out" && [ -f "$W/src/wip" ] && fleet status | grep -Eq "^worker-1 +INTERRUPTED" \
  && ok "another task skips an INTERRUPTED worker and leaves its work alone" || { bad "interrupted skip"; echo "$out"; }
out="$(fleet claim T-2 2>&1)"
grep -q "WORKER=worker-1" <<<"$out" && grep -q "adopted worker-1" <<<"$out" && [ "$(cat "$W/src/wip")" = "half done" ] \
  && fleet status | grep -Eq "^worker-1 +CLAIMED +T-2" \
  && ok "claiming its own task adopts the INTERRUPTED worker, uncommitted work included" || { bad "adopt"; echo "$out"; }

# --- gc: T-3 merged into main, T-4 never committed on, T-5's branch deleted, worker-2 left by a dead session
W2="$T/fleet/worker-2"
echo three > "$W2/three"; q "$W2" add -A; q "$W2" commit -m three; q "$W2" push origin t-3
fleet release worker-2 --state paused --note "done, merging" >/dev/null 2>&1
q "$T/repo" merge --no-ff t-3 -m "merge t-3"; q "$T/repo" push origin main
for k in 4 5; do fleet claim T-$k --branch t-$k >/dev/null 2>&1; fleet release worker-2 --state paused --note n >/dev/null 2>&1; done
q "$T/repo" branch -D t-5
fleet claim T-6 --branch t-6 >/dev/null 2>&1; owner_dies "$T/fleet/.locks/worker-2/owner"
records() { BEADS_DIR="$T/fleet/beads/.beads" bd list --all -n 0 --json 2>/dev/null | jq -c '[.[] | [.id, .status, .metadata.state]]'; }
before="$(fleet status --json; records)"   # absolute times: the text countdown ticks
fleet gc > "$T/out"
[ "$before" = "$(fleet status --json; records)" ] \
  && ok "gc without --apply changes nothing" || { bad "gc report wrote"; diff <(echo "$before") <(fleet status --json; records); }
grep -Eq "close +T-3 .*merged into origin/main" "$T/out" && grep -Eq "needs-you +T-4 .*no commits of its own" "$T/out" \
  && grep -Eq "needs-you +T-5 .*is gone" "$T/out" && grep -Eq "free +worker-2" "$T/out" && ! grep -Eq " T-2 | T-1 " "$T/out" \
  && ok "gc closes merged records, frees dead clean workers, asks about the rest, skips live and unmerged work" || { bad "gc report"; cat "$T/out"; }
fleet gc --json | jq -e '.rows | length > 0' >/dev/null && ok "gc --json is machine-readable" || bad "gc json"
mkdir -p "$T/fleet/.fleet-view/turns" "$T/fleet/.fleet-view/graphs"
for k in 3 4; do touch "$T/fleet/.fleet-view/turns/T-$k.jsonl" "$T/fleet/.fleet-view/graphs/T-$k.json"; done
fleet gc --apply > "$T/out" 2>&1
[ ! -e "$T/fleet/.fleet-view/turns/T-3.jsonl" ] && [ ! -e "$T/fleet/.fleet-view/graphs/T-3.json" ] \
  && [ -e "$T/fleet/.fleet-view/turns/T-4.jsonl" ] && [ -e "$T/fleet/.fleet-view/graphs/T-4.json" ] \
  && ok "gc --apply drops a closed task's turns and graph, and keeps the open ones" || bad "gc turns/graphs"
! fleet show T-3 >/dev/null 2>&1 && fleet show T-4 >/dev/null && fleet status | grep -Eq "^worker-2 +FREE" \
  && fleet status | grep -Eq "^worker-1 +CLAIMED +T-2" && [ -f "$W/src/wip" ] \
  && ok "gc --apply closes T-3 and frees worker-2, and leaves the live worker and open questions alone" || { bad "gc apply"; cat "$T/out"; fleet status; }

# --- tree_id: a same-size edit in the second the index was written still changes the id (racy git),
# and an index left by a killed run is swept
R="$T/racy"; git init -q "$R"; echo aaaa > "$R/a"; q "$R" add -A; q "$R" commit -m r
eval "$(sed -n '/^tree_id()/,/^}/p' "$ENGINE")"; GATE_DIR="$T/gate"; mkdir -p "$GATE_DIR"; touch "$GATE_DIR/index-999999"
miss=0; for i in 1 2 3 4 5 6 7 8 9 10; do
  echo bbbb > "$R/a"; git -C "$R" add a; w="$(git -C "$R" write-tree)"; echo BBBB > "$R/a"
  [ "$(tree_id "$R")" = "$w" ] && miss=$((miss + 1))
done
[ "$miss" = 0 ] && [ ! -e "$GATE_DIR/index-999999" ] \
  && ok "tree_id sees racy same-size edits and sweeps a dead run's index" || bad "tree_id racy ($miss missed)"

[ "$FAILS" = 0 ] && echo "all passed" || { echo "$FAILS failed"; exit 1; }
