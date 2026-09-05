#!/usr/bin/env bash
# agentic-git — deterministic evidence collector (architecture.md §3.2.2 step 1).
# Facts only, no inference beyond what languages.sh/commands.sh already contribute.
# One of the three places stack knowledge is allowed to live (hard rule #2 exemption).
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
Usage: scan.sh [--root <dir>] [--json]

Deterministic evidence collector: manifests, config files, extension census, script names
(package.json / pyproject.toml / Makefile / justfile / Taskfile), CI files, monorepo markers,
claude-config inventory, and repo facts (from `git remote` only — never `gh`). Merges in
languages.sh (languages[], package_manager) and commands.sh (tools, commands, candidates,
globs). Emits ONE JSON object to stdout. --json pretty-prints; default is compact.
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
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

is_git_repo() { git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; }
IS_GIT=false
if is_git_repo; then IS_GIT=true; fi

list_files() {
  if [ "$IS_GIT" = true ]; then
    git -C "$ROOT" ls-files
  else
    ( cd "$ROOT" && find . -type f -not -path '*/.git/*' -print | sed 's#^\./##' )
  fi
}

to_json_lines() {
  # to_json_lines < newline-list -> compact JSON array, [] when empty
  jq -R -s -c 'split("\n") | map(select(length>0))'
}

# ================= manifests =================
MANIFEST_NAMES="package.json pnpm-lock.yaml yarn.lock package-lock.json bun.lockb bun.lock \
pyproject.toml uv.lock poetry.lock Pipfile Cargo.toml go.mod pom.xml build.gradle \
build.gradle.kts Gemfile composer.json mix.exs pubspec.yaml Package.swift CMakeLists.txt \
Makefile Taskfile.yml justfile"

tmp_manifests="$(mktemp)"
for name in $MANIFEST_NAMES; do
  if [ -f "$ROOT/$name" ]; then printf '%s\n' "$name" >> "$tmp_manifests"; fi
done
for f in "$ROOT"/requirements*.txt; do
  if [ -f "$f" ]; then basename "$f" >> "$tmp_manifests"; fi
done
for f in "$ROOT"/*.csproj; do
  if [ -f "$f" ]; then basename "$f" >> "$tmp_manifests"; fi
done
manifests_json="$(to_json_lines < "$tmp_manifests")"
rm -f "$tmp_manifests"

# ================= config files =================
CONFIG_NAMES="tsconfig.json .prettierrc .prettierrc.json .prettierrc.js .prettierrc.cjs \
.prettierrc.yaml .prettierrc.yml prettier.config.js prettier.config.cjs prettier.config.mjs \
.eslintrc .eslintrc.json .eslintrc.js .eslintrc.cjs .eslintrc.yaml .eslintrc.yml \
eslint.config.js eslint.config.mjs eslint.config.cjs biome.json biome.jsonc ruff.toml \
.flake8 setup.cfg mypy.ini pyrightconfig.json .rubocop.yml .golangci.yml rustfmt.toml \
.editorconfig .pre-commit-config.yaml .clang-format"

tmp_configs="$(mktemp)"
for name in $CONFIG_NAMES; do
  if [ -f "$ROOT/$name" ]; then printf '%s\n' "$name" >> "$tmp_configs"; fi
done
configs_json="$(to_json_lines < "$tmp_configs")"
rm -f "$tmp_configs"

# ================= extension census =================
# git ls-files | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -20  (facts only; git-ignore aware)
tmp_census="$(mktemp)"
list_files | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -20 > "$tmp_census"
census_json=$(awk '{count=$1; $1=""; sub(/^ /,""); printf "%s\t%s\n", count, $0}' "$tmp_census" \
  | jq -R -s -c 'split("\n") | map(select(length>0)) | map(split("\t")) | map({ext:.[1], count:(.[0]|tonumber)})')
rm -f "$tmp_census"

# ================= script names =================
pkg_scripts_json='[]'
if [ -f "$ROOT/package.json" ]; then
  pkg_scripts_json=$(jq -c '[.scripts // {} | keys[]?]' "$ROOT/package.json" 2>/dev/null) || pkg_scripts_json='[]'
fi

toml_section_keys() {
  # toml_section_keys file section -> newline list of keys
  local f="$1" sec="$2"
  [ -f "$f" ] || return 0
  awk -v sec="[$sec]" '
    $0==sec {insec=1; next}
    /^\[/{insec=0}
    insec && match($0,/^[A-Za-z0-9_.-]+[ \t]*=/) {
      k=$0; sub(/[ \t]*=.*/,"",k); gsub(/^[ \t]+|[ \t]+$/,"",k); print k
    }
  ' "$f"
}
project_scripts_json="$(toml_section_keys "$ROOT/pyproject.toml" "project.scripts" | to_json_lines)"
poe_tasks_json="$(toml_section_keys "$ROOT/pyproject.toml" "tool.poe.tasks" | to_json_lines)"
pdm_scripts_json="$(toml_section_keys "$ROOT/pyproject.toml" "tool.pdm.scripts" | to_json_lines)"

makefile_targets_json='[]'
if [ -f "$ROOT/Makefile" ]; then
  makefile_targets_json=$(grep -E '^[a-zA-Z0-9_.-]+:' "$ROOT/Makefile" 2>/dev/null | sed 's/:.*//' | sort -u | to_json_lines)
fi

just_recipes_json='[]'
if [ -f "$ROOT/justfile" ] && have_cmd just; then
  just_recipes_json=$( (cd "$ROOT" && just --summary 2>/dev/null) | tr ' ' '\n' | to_json_lines )
fi
task_recipes_json='[]'
if [ -f "$ROOT/Taskfile.yml" ] && have_cmd task; then
  task_recipes_json=$( (cd "$ROOT" && task --list 2>/dev/null) | sed -n 's/^\* \([a-zA-Z0-9_:-]*\).*/\1/p' | to_json_lines )
fi

scripts_json=$(jq -n \
  --argjson package_json "$pkg_scripts_json" \
  --argjson pyproject_project_scripts "$project_scripts_json" \
  --argjson pyproject_poe_tasks "$poe_tasks_json" \
  --argjson pyproject_pdm_scripts "$pdm_scripts_json" \
  --argjson makefile_targets "$makefile_targets_json" \
  --argjson just_recipes "$just_recipes_json" \
  --argjson task_recipes "$task_recipes_json" \
  '{package_json:$package_json, pyproject_project_scripts:$pyproject_project_scripts,
    pyproject_poe_tasks:$pyproject_poe_tasks, pyproject_pdm_scripts:$pyproject_pdm_scripts,
    makefile_targets:$makefile_targets, just_recipes:$just_recipes, task_recipes:$task_recipes}')

# ================= CI =================
# Per each workflow file: its path, top-level `name:` value, and job keys (2-space-indented
# keys under the `jobs:` mapping) — the evidence `pr`/`doctor` use to guess required checks.
workflow_name() {
  sed -n 's/^name:[ \t]*//p' "$1" | head -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
workflow_jobs() {
  awk '
    /^jobs:/ {injobs=1; next}
    injobs && /^[A-Za-z0-9_.-]+:/ {exit}
    injobs && match($0,/^  [A-Za-z0-9_.-]+:/) {
      k=$0; sub(/^  /,"",k); sub(/:.*/,"",k); print k
    }
  ' "$1"
}

tmp_workflows_json="$(mktemp)"
for f in "$ROOT"/.github/workflows/*.yml "$ROOT"/.github/workflows/*.yaml; do
  if [ -f "$f" ]; then
    wpath=".github/workflows/$(basename "$f")"
    wname="$(workflow_name "$f")"
    wjobs_json="$(workflow_jobs "$f" | to_json_lines)"
    jq -n --arg path "$wpath" --arg name "$wname" --argjson jobs "$wjobs_json" \
      '{path:$path, name:($name|if length>0 then . else null end), jobs:$jobs}' >> "$tmp_workflows_json"
  fi
done
workflows_json='[]'
if [ -s "$tmp_workflows_json" ]; then workflows_json="$(jq -s -c '.' "$tmp_workflows_json")"; fi
rm -f "$tmp_workflows_json"

# required_checks: the union of all workflow job names — a reasonable evidence-only default;
# `pr`/`doctor` may narrow this against branch protection, which needs `gh`, not this script.
required_checks_json="$(printf '%s' "$workflows_json" | jq -c '[.[].jobs[]] | unique')"

ci_provider="none"
if [ "$(printf '%s' "$workflows_json" | jq 'length')" -gt 0 ]; then ci_provider="github-actions"; fi
if [ -f "$ROOT/.gitlab-ci.yml" ]; then ci_provider="gitlab-ci"; fi
if [ -f "$ROOT/.circleci/config.yml" ]; then ci_provider="circleci"; fi

ci_json=$(jq -n --arg provider "$ci_provider" --argjson workflows "$workflows_json" \
  --argjson required_checks "$required_checks_json" \
  --argjson has_gitlab_ci "$([ -f "$ROOT/.gitlab-ci.yml" ] && echo true || echo false)" \
  --argjson has_circleci "$([ -f "$ROOT/.circleci/config.yml" ] && echo true || echo false)" \
  '{provider:$provider, workflows:$workflows, required_checks:$required_checks,
    has_gitlab_ci:$has_gitlab_ci, has_circleci:$has_circleci}')

# ================= monorepo markers =================
is_monorepo=false
monorepo_tool="null"
ws_json='[]'
if [ -f "$ROOT/pnpm-workspace.yaml" ]; then is_monorepo=true; monorepo_tool='"pnpm-workspaces"'; fi
if [ -f "$ROOT/package.json" ]; then
  pkg_ws=$(jq -c '.workspaces // empty' "$ROOT/package.json" 2>/dev/null) || pkg_ws=""
  if [ -n "$pkg_ws" ] && [ "$pkg_ws" != "null" ]; then
    is_monorepo=true
    ws_json=$(printf '%s' "$pkg_ws" | jq -c 'if type=="array" then . else (.packages // []) end')
  fi
fi
if [ -f "$ROOT/turbo.json" ]; then is_monorepo=true; monorepo_tool='"turborepo"'; fi
if [ -f "$ROOT/nx.json" ]; then is_monorepo=true; monorepo_tool='"nx"'; fi
if [ -f "$ROOT/lerna.json" ]; then is_monorepo=true; monorepo_tool='"lerna"'; fi
if grep -qE '^\[workspace\]' "$ROOT/Cargo.toml" 2>/dev/null; then is_monorepo=true; [ "$monorepo_tool" = "null" ] && monorepo_tool='"cargo-workspace"'; fi
if [ -f "$ROOT/go.work" ]; then is_monorepo=true; [ "$monorepo_tool" = "null" ] && monorepo_tool='"go-work"'; fi

monorepo_json=$(jq -n --argjson is_monorepo "$is_monorepo" --argjson tool "$monorepo_tool" --argjson workspaces "$ws_json" \
  '{is_monorepo:$is_monorepo, tool:$tool, workspaces:$workspaces}')

# ================= repo facts (git remote only, no gh, no network) =================
remote_url=""
if [ "$IS_GIT" = true ]; then
  remote_url=$(git -C "$ROOT" remote get-url origin 2>/dev/null) || remote_url=""
fi

repo_host=""; repo_owner=""; repo_name=""
if [ -n "$remote_url" ]; then
  rest="$remote_url"
  case "$rest" in
    git@*:*)
      rest=${rest#git@}; repo_host=${rest%%:*}; rest=${rest#*:} ;;
    ssh://git@*)
      rest=${rest#ssh://git@}; repo_host=${rest%%/*}; rest=${rest#*/} ;;
    https://*|http://*)
      rest=${rest#*://}; repo_host=${rest%%/*}; rest=${rest#*/} ;;
    *)
      repo_host=""; ;;
  esac
  rest=${rest%.git}
  repo_owner=${rest%%/*}
  repo_name=${rest#*/}
fi
repo_host_norm="unknown"
case "$repo_host" in
  *github*) repo_host_norm="github" ;;
  *gitlab*) repo_host_norm="gitlab" ;;
  "") repo_host_norm="none" ;;
  *) repo_host_norm="$repo_host" ;;
esac

repo_default_branch="main"
if [ "$IS_GIT" = true ]; then
  b=$(git -C "$ROOT" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || b=""
  b=${b#origin/}
  if [ -z "$b" ]; then b=$(git -C "$ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null) || b=""; fi
  [ -n "$b" ] && repo_default_branch="$b"
fi

repo_json=$(jq -n \
  --arg host "$repo_host_norm" \
  --arg owner "$repo_owner" \
  --arg name "$repo_name" \
  --arg default_branch "$repo_default_branch" \
  --arg remote "$remote_url" \
  '{host:$host, owner:($owner|if length>0 then . else null end),
    name:($name|if length>0 then . else null end),
    default_branch:$default_branch, remote:($remote|if length>0 then . else null end)}')

# ================= claude-config inventory =================
claude_json="$(bash "$SELF_DIR/claude-config.sh" --root "$ROOT")"

# ================= merge in languages.sh + commands.sh =================
lang_json="$(bash "$SELF_DIR/languages.sh" --root "$ROOT")"
cmd_json="$(bash "$SELF_DIR/commands.sh" --root "$ROOT")"

DEFAULT_COMMANDS='{"install":null,"build":null,"test":null,"test_file":null,"lint":null,"lint_fix":null,"format":null,"format_all":null,"typecheck":null,"run":null}'
commands_full=$(printf '%s' "$cmd_json" | jq --argjson d "$DEFAULT_COMMANDS" '$d * .commands')

out=$(jq -n \
  --arg schema_version 1 \
  --arg generated_at "$(date_utc)" \
  --arg root "$ROOT" \
  --argjson is_git_repo "$IS_GIT" \
  --argjson manifests "$manifests_json" \
  --argjson configs "$configs_json" \
  --argjson extension_census "$census_json" \
  --argjson scripts "$scripts_json" \
  --argjson ci "$ci_json" \
  --argjson monorepo "$monorepo_json" \
  --argjson repo "$repo_json" \
  --argjson claude "$claude_json" \
  --argjson languages "$(printf '%s' "$lang_json" | jq '.languages')" \
  --argjson package_manager "$(printf '%s' "$lang_json" | jq '.package_manager')" \
  --argjson tools "$(printf '%s' "$cmd_json" | jq '.tools')" \
  --argjson candidates "$(printf '%s' "$cmd_json" | jq '.candidates')" \
  --argjson source_globs "$(printf '%s' "$cmd_json" | jq '.source_globs')" \
  --argjson test_globs "$(printf '%s' "$cmd_json" | jq '.test_globs')" \
  --argjson generated_globs "$(printf '%s' "$cmd_json" | jq '.generated_globs')" \
  --argjson shared_files "$(printf '%s' "$cmd_json" | jq '.shared_files')" \
  --argjson secrets_globs "$(printf '%s' "$cmd_json" | jq '.secrets_globs')" \
  --argjson commands "$commands_full" \
  '{schema_version: ($schema_version|tonumber), generated_at:$generated_at, root:$root,
    is_git_repo:$is_git_repo, manifests:$manifests, configs:$configs,
    extension_census:$extension_census, scripts:$scripts, ci:$ci, monorepo:$monorepo,
    repo:$repo, claude:$claude, languages:$languages, package_manager:$package_manager,
    tools:$tools, commands:$commands, candidates:$candidates, source_globs:$source_globs,
    test_globs:$test_globs, generated_globs:$generated_globs, shared_files:$shared_files,
    secrets_globs:$secrets_globs}')

if [ "$PRETTY" = 1 ]; then printf '%s\n' "$out" | jq .
else printf '%s\n' "$out" | jq -c .
fi
