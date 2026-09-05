#!/usr/bin/env bash
# conflict-classify.sh [--json]
# Run inside a repo mid-merge/rebase. For each conflicted file (git diff --diff-filter=U),
# counts conflict hunks and classifies it: protected | regenerable | trivial | semantic.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() { printf 'Usage: conflict-classify.sh [--json] [<file> ...]   (default: every conflicted file)\n'; }

as_json=0; only=""
for a in "$@"; do
  case "$a" in
    --json) as_json=1 ;;
    --help|-h) usage; exit 0 ;;
    --*) die "unknown argument: $a" ;;
    *) only="${only}${only:+
}$a" ;;
  esac
done

files="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"
[ -n "$only" ] && files="$only"
if [ -z "$files" ]; then
  [ "$as_json" -eq 1 ] && printf '[]\n'
  exit 0
fi

# glob_match <path> <glob> -- "*" matches across "/" here (case-pattern semantics, not pathname
# expansion), and a leading "**/ " is also tried stripped so it matches at zero depth too.
glob_match() {
  local path="$1" pat="$2"
  case "$path" in $pat) return 0 ;; esac
  case "$pat" in
    '**/'*)
      local rest="${pat#**/}"
      case "$path" in $rest) return 0 ;; esac
      ;;
  esac
  return 1
}

any_match() { # any_match <path> <newline-separated patterns> -> 0 if any (non-negated) matches and no negation excludes it
  local path="$1" patterns="$2" p match=1 excl=1
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in
      '!'*) glob_match "$path" "${p#!}" && excl=0 ;;
      *) glob_match "$path" "$p" && match=0 ;;
    esac
  done <<EOF
$patterns
EOF
  [ "$match" -eq 0 ] && [ "$excl" -ne 0 ]
}

protected_patterns="$(jq -r '.protected_paths[]? // empty' "$(config_file)" 2>/dev/null || true)
$(profile_json | jq -r '.secrets_globs[]? // empty' 2>/dev/null || true)"
generated_patterns="$(profile_json | jq -r '.generated_globs[]? // empty' 2>/dev/null || true)"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

classify_one() {
  local f="$1" class hunks base_f ours_f theirs_f
  hunks="$(grep -c '^<<<<<<< ' "$f" 2>/dev/null || true)"; hunks="${hunks:-0}"

  if any_match "$f" "$protected_patterns"; then
    class="protected"
  elif any_match "$f" "$generated_patterns"; then
    class="regenerable"
  else
    base_f="$tmp/base"; ours_f="$tmp/ours"; theirs_f="$tmp/theirs"
    git show ":1:$f" > "$base_f" 2>/dev/null || : > "$base_f"
    git show ":2:$f" > "$ours_f" 2>/dev/null || : > "$ours_f"
    git show ":3:$f" > "$theirs_f" 2>/dev/null || : > "$theirs_f"

    if diff -q <(sed -e 's/[[:space:]]*$//' "$ours_f") <(sed -e 's/[[:space:]]*$//' "$theirs_f") >/dev/null 2>&1; then
      class="trivial"
    else
      # additive-list: neither side deletes a line that was present in base. Diff output is
      # written to a file (never piped straight into grep) — `diff | grep -q` is unsafe under
      # `pipefail`: grep can exit right after its first match, SIGPIPE-killing diff before it
      # finishes, which makes the *pipeline's* exit status nonzero even though grep matched.
      local ours_diff="$tmp/ours.diff" theirs_diff="$tmp/theirs.diff"
      diff "$base_f" "$ours_f" > "$ours_diff" 2>/dev/null || true
      diff "$base_f" "$theirs_f" > "$theirs_diff" 2>/dev/null || true
      if [ -s "$base_f" ] && ! grep -q '^< ' "$ours_diff" && ! grep -q '^< ' "$theirs_diff"; then
        class="trivial"
      else
        class="semantic"
      fi
    fi
  fi
  printf '%s\t%s\t%s\n' "$f" "$hunks" "$class"
}

results="$tmp/results.tsv"; : > "$results"
printf '%s\n' "$files" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  classify_one "$f" >> "$results"
done

if [ "$as_json" -eq 1 ]; then
  out="["
  first=1
  while IFS=$'\t' read -r path hunks class; do
    obj="$(jq -nc --arg path "$path" --argjson hunks "$hunks" --arg class "$class" '{path:$path,hunks:$hunks,class:$class}')"
    [ "$first" -eq 1 ] || out="$out,"
    out="$out$obj"; first=0
  done < "$results"
  printf '%s]\n' "$out" | jq -c .
else
  while IFS=$'\t' read -r path hunks class; do
    printf '%-9s hunks:%-3s %s\n' "$class" "$hunks" "$path"
  done < "$results"
fi
