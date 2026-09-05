#!/usr/bin/env bash
# agentic-git — inventory of existing Claude Code config in a target project. Facts only.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
# shellcheck source=../lib/common.sh
. "$LIB/common.sh"
# shellcheck source=../lib/json.sh
. "$LIB/json.sh"
# shellcheck source=../lib/state.sh
. "$LIB/state.sh"

usage() {
  cat <<'EOF'
Usage: claude-config.sh [--root <dir>] [--json]

Inventories a project's existing Claude Code configuration: CLAUDE.md (path/size/sentinel),
.claude/settings.json (parses? hook events? has agentic hooks?), .claude/settings.local.json
presence, .claude/agents/*.md (name+description), .claude/skills/* names, .claude/commands/*.md
names. Emits one JSON object to stdout. --json pretty-prints; default is compact.
EOF
}

ROOT=""
PRETTY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --json) PRETTY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[ -n "$ROOT" ] || ROOT="$(project_root)"
[ -d "$ROOT" ] || die "no such directory: $ROOT"
ROOT="$(realpath_portable "$ROOT")"

SENTINEL='<!-- BEGIN agentic-git -->'

# ---------- CLAUDE.md ----------
claude_md_path=""
if [ -f "$ROOT/CLAUDE.md" ]; then claude_md_path="CLAUDE.md"
elif [ -f "$ROOT/.claude/CLAUDE.md" ]; then claude_md_path=".claude/CLAUDE.md"
fi

claude_md_json='null'
if [ -n "$claude_md_path" ]; then
  size=$(wc -c < "$ROOT/$claude_md_path" | tr -d ' ')
  has_sentinel=false
  if grep -qF "$SENTINEL" "$ROOT/$claude_md_path" 2>/dev/null; then has_sentinel=true; fi
  claude_md_json=$(jq -n --arg path "$claude_md_path" --argjson size "${size:-0}" --argjson has_sentinel "$has_sentinel" \
    '{path:$path, size:$size, has_sentinel:$has_sentinel}')
fi

# ---------- .claude/settings.json ----------
settings_json='null'
if [ -f "$ROOT/.claude/settings.json" ]; then
  parse_ok=false; events='[]'; has_agentic=false
  if jq_valid "$ROOT/.claude/settings.json"; then
    parse_ok=true
    events=$(jq -c '(.hooks // {}) | keys' "$ROOT/.claude/settings.json" 2>/dev/null)
    [ -n "$events" ] || events='[]'
  fi
  if grep -qF 'agentic/hooks/' "$ROOT/.claude/settings.json" 2>/dev/null; then has_agentic=true; fi
  settings_json=$(jq -n --argjson parse_ok "$parse_ok" --argjson events "$events" --argjson has_agentic "$has_agentic" \
    '{path:".claude/settings.json", parse_ok:$parse_ok, hook_events:$events, has_agentic_hooks:$has_agentic}')
fi

settings_local_exists=false
if [ -f "$ROOT/.claude/settings.local.json" ]; then settings_local_exists=true; fi

# ---------- .claude/agents ----------
agents_json='[]'
if [ -d "$ROOT/.claude/agents" ]; then
  tmp="$(mktemp)"
  for f in "$ROOT"/.claude/agents/*.md; do
    if [ -f "$f" ]; then
      name=$(fm_get "$f" name)
      [ -n "$name" ] || name=$(basename "$f" .md)
      desc=$(fm_get "$f" description)
      jq -n --arg name "$name" --arg description "$desc" --arg file "$(basename "$f")" \
        '{name:$name, description:$description, file:$file}' >> "$tmp"
    fi
  done
  if [ -s "$tmp" ]; then agents_json=$(jq -s -c '.' "$tmp"); fi
  rm -f "$tmp"
fi

# ---------- .claude/skills ----------
skills_json='[]'
if [ -d "$ROOT/.claude/skills" ]; then
  tmp="$(mktemp)"
  for d in "$ROOT"/.claude/skills/*/; do
    if [ -d "$d" ]; then basename "$d" >> "$tmp"; fi
  done
  if [ -s "$tmp" ]; then skills_json=$(jq -R -s -c 'split("\n") | map(select(length>0))' "$tmp"); fi
  rm -f "$tmp"
fi

# ---------- .claude/commands ----------
commands_json='[]'
if [ -d "$ROOT/.claude/commands" ]; then
  tmp="$(mktemp)"
  for f in "$ROOT"/.claude/commands/*.md; do
    if [ -f "$f" ]; then basename "$f" .md >> "$tmp"; fi
  done
  if [ -s "$tmp" ]; then commands_json=$(jq -R -s -c 'split("\n") | map(select(length>0))' "$tmp"); fi
  rm -f "$tmp"
fi

out=$(jq -n \
  --argjson claude_md "$claude_md_json" \
  --argjson settings "$settings_json" \
  --argjson settings_local_exists "$settings_local_exists" \
  --argjson agents "$agents_json" \
  --argjson skills "$skills_json" \
  --argjson commands "$commands_json" \
  '{claude_md:$claude_md, settings:$settings, settings_local_exists:$settings_local_exists,
    agents:$agents, skills:$skills, commands:$commands}')

if [ "$PRETTY" = 1 ]; then printf '%s\n' "$out" | jq .
else printf '%s\n' "$out" | jq -c .
fi
