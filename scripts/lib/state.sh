#!/usr/bin/env bash
# agentic-git — state helpers: config/profile reads with overrides, frontmatter get/set.
# Source after common.sh (and json.sh).

# ---------- config / profile ----------
config_get() {
  # config_get '.base_branch' [default]
  json_get "$(config_file)" "$1" "${2:-}"
}

profile_json() {
  # Emits the profile with .overrides deep-merged over detected values. {} when absent.
  local f; f=$(profile_file)
  [ -f "$f" ] || { printf '{}'; return 0; }
  jq -c 'del(.overrides) * (.overrides // {})' "$f" 2>/dev/null || printf '{}'
}
profile_get() {
  # profile_get '.commands.test' [default]  -> value with overrides applied; "" (or default) when null
  local q="$1" d="${2:-}" v
  v=$(profile_json | jq -r "$q // empty" 2>/dev/null) || v=""
  [ -n "$v" ] && printf '%s' "$v" || printf '%s' "$d"
}
profile_cmd() {
  # profile_cmd test [file]  -> resolved command with {file} substituted; empty when null
  local slot="$1" file="${2:-}" c
  c=$(profile_get ".commands.$slot")
  [ -z "$c" ] && return 0
  if [ -n "$file" ]; then
    case "$c" in *"{file}"*) c=${c//\{file\}/$file} ;; *) c="$c $file" ;; esac
  fi
  printf '%s' "$c"
}

# ---------- frontmatter (YAML between the first two '---' lines) ----------
fm_get() {
  # fm_get file key -> raw scalar value (quotes stripped) or ""
  local f="$1" k="$2"
  [ -f "$f" ] || return 0
  awk -v k="$k" '
    NR==1 && $0!="---" {exit}
    NR>1 && $0=="---" {exit}
    NR>1 && index($0, k ":")==1 { v=substr($0, length(k)+2); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v);
      gsub(/^"|"$/, "", v); gsub(/^'"'"'|'"'"'$/, "", v); print v; exit }
  ' "$f"
}
fm_has() { [ -n "$(fm_get "$1" "$2")" ]; }
fm_set() {
  # fm_set file key value   -> replaces the line "key: ..." inside the frontmatter, or appends it before the closing '---'
  # value is written verbatim (caller quotes strings / writes flow lists like ["1","2"]).
  local f="$1" k="$2" v="$3" tmp
  [ -f "$f" ] || die "fm_set: no such file: $f"
  tmp=$(mktemp)
  awk -v k="$k" -v v="$v" '
    BEGIN { infm=0; done=0 }
    NR==1 && $0=="---" { infm=1; print; next }
    infm && !done && index($0, k ":")==1 { print k ": " v; done=1; next }
    infm && $0=="---" { if (!done) { print k ": " v; done=1 }; infm=0; print; next }
    { print }
  ' "$f" > "$tmp" && mv "$tmp" "$f"
}
fm_list() {
  # fm_list file key -> items of a flow list  key: ["a", "b"]  one per line (quotes stripped)
  fm_get "$1" "$2" | tr -d '[]"'"'"' ' | tr ',' '\n' | sed '/^$/d'
}
fm_body() {
  # fm_body file -> everything after the frontmatter
  awk 'NR==1 && $0!="---" {p=1} p {print; next} NR>1 && $0=="---" {p=1}' "$1"
}
fm_to_json() {
  # fm_to_json file -> {"key":"value",...} for scalar keys and lists (as arrays); best-effort, no nested YAML
  awk '
    NR==1 && $0!="---" {exit}
    NR>1 && $0=="---" {exit}
    NR>1 && match($0, /^[A-Za-z_][A-Za-z0-9_]*:/) {
      k=substr($0, 1, RLENGTH-1); v=substr($0, RLENGTH+1); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v)
      if (n++) printf ","
      if (v ~ /^\[/) { gsub(/[\[\]]/, "", v); gsub(/"/, "", v); gsub(/'"'"'/, "", v); gsub(/[ \t]/, "", v); m=split(v, a, ",");
        printf "\"%s\":[", k; for (i=1;i<=m;i++){ if(a[i]!=""){ printf "%s\"%s\"", (i>1?",":""), a[i] } } printf "]" }
      else { gsub(/^"|"$/, "", v); gsub(/"/, "\\\"", v); printf "\"%s\":\"%s\"", k, v }
    }
    END { }
  ' "$1" | { printf '{'; cat; printf '}\n'; }
}

# ---------- epics ----------
epic_dir() { printf '%s/%s\n' "$(epics_dir)" "$1"; }
find_task_file() {
  # find_task_file <epic-slug> <id-or-issue> -> path or ""
  local d; d=$(epic_dir "$1")/tasks
  [ -f "$d/$2.md" ] && { printf '%s\n' "$d/$2.md"; return 0; }
  [ -f "$d/$(printf '%03d' "$2" 2>/dev/null).md" ] && printf '%s\n' "$d/$(printf '%03d' "$2").md"
}
find_task_by_issue() {
  # find_task_by_issue <issue-number> -> "<slug> <path>" searching all epics
  local n="$1" f
  for f in "$(epics_dir)"/*/tasks/*.md; do
    [ -f "$f" ] || continue
    [ "$(fm_get "$f" issue)" = "$n" ] && { printf '%s %s\n' "$(basename "$(dirname "$(dirname "$f")")")" "$f"; return 0; }
  done
  return 1
}
