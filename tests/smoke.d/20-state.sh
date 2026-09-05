#!/usr/bin/env bash
# smoke: scripts/state/*.sh — architecture.md §10.3 items 9-10, plus ledger/lock/streams/progress.
. "$(dirname "$0")/../lib.sh"

S="$PLUGIN_ROOT/scripts/state"

# ---------- 9. init-state.sh is idempotent; hand-edited config.json survives ----------
t_begin "init-state: idempotent (same git status --porcelain both runs)"
REPO=$(make_repo)
( cd "$REPO" && bash "$S/init-state.sh" >/dev/null )
status1=$( cd "$REPO" && git status --porcelain )
( cd "$REPO" && bash "$S/init-state.sh" >/dev/null )
status2=$( cd "$REPO" && git status --porcelain )
assert_eq "$status1" "$status2"

t_begin "init-state: hand-edited config.json value survives a second run"
( cd "$REPO" && jq '.base_branch = "custom-base"' .claude/agentic/config.json > /tmp.$$ && mv /tmp.$$ .claude/agentic/config.json )
( cd "$REPO" && bash "$S/init-state.sh" >/dev/null )
base=$( cd "$REPO" && jq -r '.base_branch' .claude/agentic/config.json )
assert_eq "custom-base" "$base"

t_begin "init-state: creates the expected tree"
if [ -d "$REPO/.claude/agentic/epics" ] && [ -d "$REPO/.claude/agentic/runtime/streams" ] \
   && [ -d "$REPO/.claude/agentic/runtime/locks" ] && [ -f "$REPO/.claude/agentic/.gitkeep" ]; then t_ok
else t_fail "tree missing"; fi

# ---------- 10. next.sh on the seeded 5-task epic ----------
REPO2=$(make_repo)
seed_state "$REPO2"

t_begin "next.sh: exactly #103 is ready"
out=$( cd "$REPO2" && bash "$S/next.sh" demo-epic )
assert_eq "#103 Task 103 [demo-epic]" "$out"

t_begin "blocked.sh: lists 104 and 105"
bout=$( cd "$REPO2" && bash "$S/blocked.sh" demo-epic )
assert_contains "$bout" "#104"

t_begin "blocked.sh: lists 105 too"
assert_contains "$bout" "#105"

t_begin "blocked.sh: does not list the ready task #103 as a blocked task (only as a blocker)"
if printf '%s\n' "$bout" | grep -q '^#103 '; then t_fail "103 should not be blocked: $bout"; else t_ok; fi

t_begin "next.sh: injected cycle -> exit 2, message names 'cycle'"
REPO3=$(make_repo)
seed_state "$REPO3"
sed -i.bak '/^depends_on:/c\
depends_on: ["103"]' "$REPO3/.claude/agentic/epics/demo-epic/tasks/101.md" && rm -f "$REPO3/.claude/agentic/epics/demo-epic/tasks/101.md.bak"
cyc_out=$( cd "$REPO3" && bash "$S/next.sh" demo-epic 2>&1 >/dev/null )
cyc_rc=$?
case "$cyc_out" in *cycle*) has_cycle=1 ;; *) has_cycle=0 ;; esac
if [ "$cyc_rc" = 2 ] && [ "$has_cycle" = 1 ]; then t_ok
else t_fail "rc=$cyc_rc out=[$cyc_out]"; fi

# ---------- epic-progress.sh ----------
t_begin 'epic-progress.sh: prints "1/5" for the seeded epic'
prog=$( cd "$REPO2" && bash "$S/epic-progress.sh" demo-epic )
assert_eq "1/5" "$prog"

t_begin "epic-progress.sh: writes progress% into epic.md"
pct=$(grep '^progress:' "$REPO2/.claude/agentic/epics/demo-epic/epic.md")
assert_contains "$pct" "20%"

# ---------- ledger.sh ----------
t_begin "ledger.sh: appends one row"
before=$(wc -l < "$REPO2/.claude/agentic/epics/demo-epic/ledger.md")
( cd "$REPO2" && bash "$S/ledger.sh" demo-epic tester "#999" "did the thing" "because reasons" "nothing bad" "yes" >/dev/null )
after=$(wc -l < "$REPO2/.claude/agentic/epics/demo-epic/ledger.md")
row=$(tail -1 "$REPO2/.claude/agentic/epics/demo-epic/ledger.md")
if [ "$after" -eq $((before+1)) ] && case "$row" in *"did the thing"*) true;; *) false;; esac; then t_ok
else t_fail "before=$before after=$after row=[$row]"; fi

# ---------- lock.sh ----------
t_begin "lock.sh: acquire then owner shows it"
( cd "$REPO2" && bash "$S/lock.sh" acquire 102 A src/shared.ts >/dev/null )
owner=$( cd "$REPO2" && bash "$S/lock.sh" owner src/shared.ts )
assert_contains "$owner" '"stream":"A"'

t_begin "lock.sh: a different stream cannot acquire the same live lock"
assert_exit 1 bash -c "cd '$REPO2' && bash '$S/lock.sh' acquire 102 B src/shared.ts"

t_begin "lock.sh: release by a non-owner is refused"
assert_exit 1 bash -c "cd '$REPO2' && bash '$S/lock.sh' release 102 B src/shared.ts"

t_begin "lock.sh: release by the owner succeeds, then owner is none"
( cd "$REPO2" && bash "$S/lock.sh" release 102 A src/shared.ts >/dev/null )
owner2=$( cd "$REPO2" && bash "$S/lock.sh" owner src/shared.ts )
assert_eq "none" "$owner2"

# ---------- streams.sh ----------
t_begin "streams.sh: init then get round-trips"
( cd "$REPO2" && bash "$S/streams.sh" 102 init A data-layer '["src/f102.ts"]' >/dev/null )
got=$( cd "$REPO2" && bash "$S/streams.sh" 102 get A )
assert_contains "$got" '"status":"running"'
assert_contains "$got" '"name":"data-layer"'

t_begin "streams.sh: list shows the initialized stream"
lst=$( cd "$REPO2" && bash "$S/streams.sh" 102 list )
assert_contains "$lst" '"stream":"A"'

t_summary "20-state"
