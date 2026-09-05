#!/usr/bin/env bash
# agentic-git — language census + package-manager detection (facts + light inference).
# Allowed to know stack-specific extension/lockfile mappings (per hard rule #2 exemption).
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
Usage: languages.sh [--root <dir>] [--json]

Emits {"languages":[{"name","share","evidence"}...], "package_manager":{...}} to stdout.
Language shares are computed from `git ls-files` extension census (falls back to `find`
outside a git repo); package manager is resolved from the first lockfile match.
--json pretty-prints; default is compact single-line JSON.
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

is_git_repo() { git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; }

list_files() {
  if is_git_repo; then
    git -C "$ROOT" ls-files
  else
    ( cd "$ROOT" && find . -type f -not -path '*/.git/*' -print | sed 's#^\./##' )
  fi
}

# ---------- extension -> language ----------
ext_lang() {
  case "$1" in
    ts|tsx|mts|cts) printf 'typescript\n' ;;
    js|jsx|mjs|cjs) printf 'javascript\n' ;;
    py) printf 'python\n' ;;
    go) printf 'go\n' ;;
    rs) printf 'rust\n' ;;
    java) printf 'java\n' ;;
    kt|kts) printf 'kotlin\n' ;;
    rb) printf 'ruby\n' ;;
    php) printf 'php\n' ;;
    ex|exs) printf 'elixir\n' ;;
    dart) printf 'dart\n' ;;
    swift) printf 'swift\n' ;;
    c|h) printf 'c\n' ;;
    cpp|cc|cxx|hpp|hh) printf 'cpp\n' ;;
    cs) printf 'csharp\n' ;;
    sql) printf 'sql\n' ;;
    sh|bash) printf 'shell\n' ;;
    tf) printf 'terraform\n' ;;
    *) printf '\n' ;;
  esac
}

lang_evidence_candidates() {
  case "$1" in
    typescript) printf 'tsconfig.json\npackage.json\n' ;;
    javascript) printf 'package.json\n' ;;
    python) printf 'pyproject.toml\nrequirements.txt\nsetup.py\nPipfile\n' ;;
    go) printf 'go.mod\n' ;;
    rust) printf 'Cargo.toml\n' ;;
    java) printf 'pom.xml\nbuild.gradle\nbuild.gradle.kts\n' ;;
    kotlin) printf 'build.gradle.kts\n' ;;
    ruby) printf 'Gemfile\n' ;;
    php) printf 'composer.json\n' ;;
    elixir) printf 'mix.exs\n' ;;
    dart) printf 'pubspec.yaml\n' ;;
    swift) printf 'Package.swift\n' ;;
    terraform) printf '\n' ;;
    *) printf '\n' ;;
  esac
}

TMP_LANGS="$(mktemp)"
trap 'rm -f "$TMP_LANGS"' EXIT

list_files | { while IFS= read -r f; do
  ext=$(printf '%s\n' "$f" | sed -n 's/.*\.\([A-Za-z0-9]*\)$/\1/p')
  [ -n "$ext" ] || continue
  ext=$(lower "$ext")
  l=$(ext_lang "$ext")
  [ -n "$l" ] && printf '%s\n' "$l"
done; } > "$TMP_LANGS" || true

total=$(wc -l < "$TMP_LANGS" | tr -d ' ')

langs_json='[]'
if [ "${total:-0}" -gt 0 ]; then
  tmp_objs="$(mktemp)"
  for lang in $(sort -u "$TMP_LANGS"); do
    count=$(grep -c "^${lang}$" "$TMP_LANGS" || true)
    share=$(awk -v c="${count:-0}" -v t="$total" 'BEGIN{ if (t>0) printf "%.2f", c/t; else print "0" }')
    ev_list="$(mktemp)"
    lang_evidence_candidates "$lang" | while IFS= read -r cand; do
      [ -n "$cand" ] || continue
      if [ -f "$ROOT/$cand" ]; then printf '%s\n' "$cand"; fi
    done > "$ev_list"
    ev_json=$(jq -R -s -c 'split("\n") | map(select(length>0))' "$ev_list")
    rm -f "$ev_list"
    jq -n --arg name "$lang" --argjson share "$share" --argjson evidence "$ev_json" \
      '{name:$name, share:$share, evidence:$evidence}' >> "$tmp_objs"
  done
  langs_json="$(jq -s -c 'sort_by(-.share)' "$tmp_objs")"
  rm -f "$tmp_objs"
fi

# ---------- package manager ----------
pm_name=""; pm_lock=""; pm_prefix=""
if [ -f "$ROOT/pnpm-lock.yaml" ]; then pm_name=pnpm; pm_lock=pnpm-lock.yaml; pm_prefix="pnpm exec"
elif [ -f "$ROOT/yarn.lock" ]; then pm_name=yarn; pm_lock=yarn.lock; pm_prefix="yarn"
elif [ -f "$ROOT/package-lock.json" ]; then pm_name=npm; pm_lock=package-lock.json; pm_prefix="npx"
elif [ -f "$ROOT/bun.lockb" ]; then pm_name=bun; pm_lock=bun.lockb; pm_prefix="bunx"
elif [ -f "$ROOT/bun.lock" ]; then pm_name=bun; pm_lock=bun.lock; pm_prefix="bunx"
elif [ -f "$ROOT/uv.lock" ]; then pm_name=uv; pm_lock=uv.lock; pm_prefix="uv run"
elif [ -f "$ROOT/poetry.lock" ]; then pm_name=poetry; pm_lock=poetry.lock; pm_prefix="poetry run"
elif [ -f "$ROOT/Pipfile.lock" ]; then pm_name=pipenv; pm_lock=Pipfile.lock; pm_prefix="pipenv run"
elif [ -f "$ROOT/Gemfile.lock" ]; then pm_name=bundler; pm_lock=Gemfile.lock; pm_prefix="bundle exec"
elif [ -f "$ROOT/Cargo.lock" ]; then pm_name=cargo; pm_lock=Cargo.lock; pm_prefix=""
elif [ -f "$ROOT/go.sum" ]; then pm_name=go; pm_lock=go.sum; pm_prefix=""
elif [ -f "$ROOT/composer.lock" ]; then pm_name=composer; pm_lock=composer.lock; pm_prefix=""
elif [ -f "$ROOT/mix.lock" ]; then pm_name=mix; pm_lock=mix.lock; pm_prefix=""
elif [ -f "$ROOT/pubspec.lock" ]; then
  pm_lock=pubspec.lock; pm_prefix=""
  is_flutter=false
  if [ -f "$ROOT/pubspec.yaml" ] && grep -q 'flutter:' "$ROOT/pubspec.yaml" 2>/dev/null; then is_flutter=true; fi
  if [ "$is_flutter" = true ]; then pm_name=flutter; else pm_name=dart; fi
elif [ -f "$ROOT/gradlew" ]; then pm_name=gradle; pm_lock=gradlew; pm_prefix="./gradlew"
elif [ -f "$ROOT/mvnw" ]; then pm_name=maven; pm_lock=mvnw; pm_prefix="./mvnw"
elif [ -f "$ROOT/pom.xml" ]; then pm_name=maven; pm_lock=pom.xml; pm_prefix="mvn"
elif [ -f "$ROOT/package.json" ]; then pm_name=npm; pm_lock=package.json; pm_prefix="npx"
elif [ -f "$ROOT/Cargo.toml" ]; then pm_name=cargo; pm_lock=Cargo.toml; pm_prefix=""
elif [ -f "$ROOT/go.mod" ]; then pm_name=go; pm_lock=go.mod; pm_prefix=""
elif [ -f "$ROOT/composer.json" ]; then pm_name=composer; pm_lock=composer.json; pm_prefix=""
elif [ -f "$ROOT/mix.exs" ]; then pm_name=mix; pm_lock=mix.exs; pm_prefix=""
elif [ -f "$ROOT/pubspec.yaml" ]; then
  pm_lock=pubspec.yaml; pm_prefix=""
  is_flutter=false
  if grep -q 'flutter:' "$ROOT/pubspec.yaml" 2>/dev/null; then is_flutter=true; fi
  if [ "$is_flutter" = true ]; then pm_name=flutter; else pm_name=dart; fi
elif [ -f "$ROOT/pyproject.toml" ]; then pm_name=pip; pm_lock=pyproject.toml; pm_prefix=""
else
  for f in "$ROOT"/requirements*.txt; do
    if [ -f "$f" ]; then pm_name=pip; pm_lock="$(basename "$f")"; pm_prefix=""; break; fi
  done
fi

version_file="null"
case "$pm_name" in
  pnpm|yarn|npm|bun)
    for vf in .nvmrc .node-version; do
      if [ -f "$ROOT/$vf" ]; then version_file="\"$vf\""; break; fi
    done ;;
  uv|poetry|pipenv|pip)
    if [ -f "$ROOT/.python-version" ]; then version_file="\".python-version\""; fi ;;
  bundler)
    if [ -f "$ROOT/.ruby-version" ]; then version_file="\".ruby-version\""; fi ;;
esac
if [ "$version_file" = "null" ] && [ -f "$ROOT/.tool-versions" ]; then version_file="\".tool-versions\""; fi

if [ -n "$pm_name" ]; then
  pm_json=$(jq -n --arg name "$pm_name" --arg lockfile "$pm_lock" --arg prefix "$pm_prefix" --argjson version_file "$version_file" \
    '{name:$name, lockfile:$lockfile, runner_prefix:$prefix, version_file:$version_file}')
else
  pm_json='{"name":null,"lockfile":null,"runner_prefix":null,"version_file":null}'
fi

out=$(jq -n --argjson languages "$langs_json" --argjson pm "$pm_json" '{languages:$languages, package_manager:$pm}')
if [ "$PRETTY" = 1 ]; then printf '%s\n' "$out" | jq .
else printf '%s\n' "$out" | jq -c .
fi
