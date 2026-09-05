#!/usr/bin/env bash
# agentic-git — shared shell helpers.
# Portability baseline: bash 3.2 (macOS system bash), BSD + GNU userland, jq required.
# Source this file; never execute it.  Every script does:
#   AGENTIC_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/lib"   # adjust depth
#   . "$AGENTIC_LIB/common.sh"

# ---------- logging ----------
log()  { printf '%s\n' "$*" >&2; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }
stop() {
  # A hard STOP condition (see conventions.md). Prints a STOP block and exits 3.
  printf 'STOP: %s\n' "$1" >&2
  [ -n "${2:-}" ] && printf 'NEXT: %s\n' "$2" >&2
  exit 3
}

# ---------- requirements ----------
require_cmd() {
  # require_cmd jq "brew install jq | apt install jq"
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed. Install: ${2:-see README prerequisites}"
}
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# ---------- portable primitives ----------
date_utc() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

sha1_portable() {
  # sha1_portable "string"  -> 40-hex
  if have_cmd sha1sum; then printf '%s' "$1" | sha1sum | awk '{print $1}'
  elif have_cmd shasum; then printf '%s' "$1" | shasum -a 1 | awk '{print $1}'
  else printf '%s' "$1" | openssl sha1 | awk '{print $NF}'; fi
}

realpath_portable() {
  # realpath_portable path -> absolute physical path (file or dir). No readlink -f.
  local p="$1" d b
  if [ -d "$p" ]; then (cd "$p" 2>/dev/null && pwd -P)
  else d=$(dirname "$p"); b=$(basename "$p"); (cd "$d" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$b"); fi
}

sed_inplace() {
  # sed_inplace 's/a/b/' file   (GNU and BSD safe)
  local expr="$1" file="$2"
  sed -i.bak "$expr" "$file" && rm -f "$file.bak"
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

slugify() {
  # slugify "Add OAuth Login!" [maxlen=40] -> add-oauth-login
  local s max="${2:-40}"
  s=$(lower "$1" | sed -e 's/[^a-z0-9]/-/g' -e 's/-\{2,\}/-/g' -e 's/^-//' -e 's/-$//')
  s=$(printf '%s' "$s" | cut -c1-"$max" | sed -e 's/-$//')
  printf '%s\n' "$s"
}

escape_for_json() {
  # escape_for_json "text" -> JSON-safe string body (no surrounding quotes)
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  printf '%s' "$s"
}

version_ge() {
  # version_ge "2.43.0" "2.38"  -> exit 0 if $1 >= $2 (major.minor[.patch])
  local a="$1" b="$2" a1 a2 a3 b1 b2 b3
  a1=${a%%.*}; a=${a#*.}; a2=${a%%.*}; a3=${a#*.}; [ "$a3" = "$a2" ] && a3=0; a3=${a3%%.*}
  b1=${b%%.*}; b=${b#*.}; b2=${b%%.*}; b3=${b#*.}; [ "$b3" = "$b2" ] && b3=0; b3=${b3%%.*}
  a1=${a1//[!0-9]/}; a2=${a2//[!0-9]/}; a3=${a3//[!0-9]/}; b1=${b1//[!0-9]/}; b2=${b2//[!0-9]/}; b3=${b3//[!0-9]/}
  [ "${a1:-0}" -gt "${b1:-0}" ] && return 0
  [ "${a1:-0}" -lt "${b1:-0}" ] && return 1
  [ "${a2:-0}" -gt "${b2:-0}" ] && return 0
  [ "${a2:-0}" -lt "${b2:-0}" ] && return 1
  [ "${a3:-0}" -ge "${b3:-0}" ]
}

git_version() { git --version 2>/dev/null | awk '{print $3}'; }

# ---------- git / repo location ----------
git_root() {
  # main checkout root, even when called from inside a worktree
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  realpath_portable "$common/.."
}
git_toplevel() { git rev-parse --show-toplevel 2>/dev/null; }
in_worktree() {
  # exit 0 when the current checkout is a linked worktree (not the main one, not a submodule)
  local gd cd
  gd=$(git rev-parse --git-dir 2>/dev/null) || return 1
  cd=$(git rev-parse --git-common-dir 2>/dev/null) || return 1
  [ -n "$(git rev-parse --show-superproject-working-tree 2>/dev/null)" ] && return 1
  [ "$(realpath_portable "$gd")" != "$(realpath_portable "$cd")" ]
}
default_branch() {
  local b
  b=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); b=${b#origin/}
  [ -n "$b" ] && { printf '%s\n' "$b"; return 0; }
  b=$(git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p'); [ -n "$b" ] && { printf '%s\n' "$b"; return 0; }
  for c in main master; do git show-ref --verify --quiet "refs/heads/$c" && { printf '%s\n' "$c"; return 0; }; done
  printf 'main\n'
}

# ---------- plugin / state paths ----------
plugin_root() {
  # ${CLAUDE_PLUGIN_ROOT} when set by the harness, else derived from this file's location
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then printf '%s\n' "$CLAUDE_PLUGIN_ROOT"
  else realpath_portable "$(dirname "${BASH_SOURCE[0]}")/../.."; fi
}
project_root() {
  # The main checkout of the project being operated on (never the plugin).
  # Precedence: AGENTIC_PROJECT_ROOT > git main checkout of $PWD > CLAUDE_PROJECT_DIR > $PWD
  if [ -n "${AGENTIC_PROJECT_ROOT:-}" ]; then printf '%s\n' "$AGENTIC_PROJECT_ROOT"; return; fi
  local r; r=$(git_root 2>/dev/null) && [ -n "$r" ] && { printf '%s\n' "$r"; return; }
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then printf '%s\n' "$CLAUDE_PROJECT_DIR"; return; fi
  pwd -P
}
state_dir()   { printf '%s/.claude/agentic\n' "$(project_root)"; }
runtime_dir() { printf '%s/runtime\n' "$(state_dir)"; }
config_file() { printf '%s/config.json\n' "$(state_dir)"; }
profile_file(){ printf '%s/project-profile.json\n' "$(state_dir)"; }
epics_dir()   { printf '%s/epics\n' "$(state_dir)"; }

# ---------- json ----------
json_get() {
  # json_get file '.path' [default]  -> raw value or default (never fails)
  local f="$1" q="$2" d="${3:-}" v
  [ -f "$f" ] || { printf '%s' "$d"; return 0; }
  v=$(jq -r "$q // empty" "$f" 2>/dev/null) || v=""
  [ -n "$v" ] && printf '%s' "$v" || printf '%s' "$d"
}
json_set() {
  # json_set file '.path' '<json-value>'   (value must be valid JSON, e.g. '"str"' or '123' or '{"a":1}')
  local f="$1" q="$2" v="$3" tmp
  [ -f "$f" ] || printf '{}\n' > "$f"
  tmp=$(mktemp) && jq --argjson v "$v" "$q = \$v" "$f" > "$tmp" && mv "$tmp" "$f"
}
json_merge_defaults() {
  # json_merge_defaults file defaults.json  -> existing values win, missing keys filled from defaults
  local f="$1" d="$2" tmp
  if [ -f "$f" ]; then tmp=$(mktemp) && jq -s '.[0] * .[1]' "$d" "$f" > "$tmp" && mv "$tmp" "$f"
  else cp "$d" "$f"; fi
}
