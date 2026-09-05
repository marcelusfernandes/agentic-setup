#!/usr/bin/env bash
# Runs every tests/smoke.d/*.sh in order. No network, no gh. Exit non-zero on any failure.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export PLUGIN_ROOT="$(cd "$HERE/.." && pwd -P)"
export TMP_BASE="$PLUGIN_ROOT/tests/tmp"
rm -rf "$TMP_BASE"; mkdir -p "$TMP_BASE"
fail=0; ran=0
for f in "$HERE"/smoke.d/*.sh; do
  [ -f "$f" ] || continue
  ran=$((ran+1))
  printf '== %s\n' "$(basename "$f")"
  if ! bash "$f"; then fail=$((fail+1)); fi
done
rm -rf "$TMP_BASE"
printf '\nsmoke: %d suites, %d failed\n' "$ran" "$fail"
[ "$fail" -eq 0 ]
