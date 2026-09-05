#!/usr/bin/env bash
# agentic-git — command-slot resolution (install/build/test/test_file/lint/lint_fix/format/format_all/typecheck/run).
# This is one of the three places stack knowledge is allowed to live (hard rule #2 exemption),
# encoding the references/stack-matrix.md table as case statements.
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
Usage: commands.sh [--root <dir>] [--json]

Resolves the command slots (install, build, test, test_file, lint, lint_fix, format,
format_all, typecheck, run) using: 1) an explicit manifest script (package.json / Makefile /
justfile), 2) the canonical invocation for the detected tool (references/stack-matrix.md),
3) null. Emits {"tools":{...}, "commands":{...}, "candidates":{...}, "source_globs":[...],
"test_globs":[...], "generated_globs":[...], "shared_files":[...], "secrets_globs":[...]}.
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

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# ---------- helpers ----------
has_file() { [ -f "$ROOT/$1" ]; }
has_dir()  { [ -d "$ROOT/$1" ]; }
any_glob() {
  # any_glob 'pattern' -> exit 0 if at least one file under $ROOT matches (non-recursive glob)
  local pat="$1" f
  for f in "$ROOT"/$pat; do
    if [ -e "$f" ]; then return 0; fi
  done
  return 1
}
grep_present() {
  # grep_present file pattern -> exit 0 if file exists and pattern found
  local f="$ROOT/$1" pat="$2"
  [ -f "$f" ] || return 1
  grep -qE "$pat" "$f" 2>/dev/null
}
pkg_script() {
  # pkg_script name -> value of package.json .scripts[name], or empty
  [ -f "$ROOT/package.json" ] || { printf ''; return 0; }
  jq -r --arg n "$1" '.scripts[$n] // empty' "$ROOT/package.json" 2>/dev/null || printf ''
}
pkg_dep() {
  # pkg_dep name -> exit 0 if name is in dependencies or devDependencies of package.json
  [ -f "$ROOT/package.json" ] || return 1
  jq -e --arg n "$1" '((.dependencies // {}) + (.devDependencies // {})) | has($n)' "$ROOT/package.json" >/dev/null 2>&1
}
make_target() {
  # make_target t1 [t2 ...] -> prints the first target name that exists in Makefile, or nothing
  [ -f "$ROOT/Makefile" ] || return 0
  local t
  for t in "$@"; do
    if grep -qE "^${t}:" "$ROOT/Makefile" 2>/dev/null; then printf '%s\n' "$t"; return 0; fi
  done
  return 0
}
just_recipe() {
  [ -f "$ROOT/justfile" ] || return 0
  have_cmd just || return 0
  local names t
  names="$(cd "$ROOT" && just --summary 2>/dev/null)" || names=""
  for t in "$@"; do
    case " $names " in *" $t "*) printf '%s\n' "$t"; return 0 ;; esac
  done
  return 0
}
pyproj_task() {
  # pyproj_task section task -> exit 0 (prints task) if [section] has a key == task, in pyproject.toml
  [ -f "$ROOT/pyproject.toml" ] || return 1
  awk -v sec="[$1]" -v want="$2" '
    $0==sec {insec=1; next}
    /^\[/{insec=0}
    insec {
      k=$0; sub(/[ \t]*=.*/,"",k); gsub(/^[ \t]+|[ \t]+$/,"",k)
      if (k==want) { found=1 }
    }
    END { exit(found?0:1) }
  ' "$ROOT/pyproject.toml"
}

# ---------- package manager (reuse languages.sh) ----------
LANG_OUT="$(bash "$SELF_DIR/languages.sh" --root "$ROOT")"
PM_NAME="$(printf '%s' "$LANG_OUT" | jq -r '.package_manager.name // empty')"
PM_PREFIX="$(printf '%s' "$LANG_OUT" | jq -r '.package_manager.runner_prefix // empty')"
PM_LOCK="$(printf '%s' "$LANG_OUT" | jq -r '.package_manager.lockfile // empty')"
TOP_LANG="$(printf '%s' "$LANG_OUT" | jq -r '.languages[0].name // empty')"

prefixed() {
  # prefixed "tool args..." -> "$PM_PREFIX tool args" (or bare if PM_PREFIX empty)
  if [ -n "$PM_PREFIX" ]; then printf '%s %s\n' "$PM_PREFIX" "$1"
  else printf '%s\n' "$1"; fi
}

# ---------- slot storage (plain vars; no associative arrays) ----------
S_install=""; S_build=""; S_test=""; S_test_file=""; S_lint=""; S_lint_fix=""
S_format=""; S_format_all=""; S_typecheck=""; S_run=""
T_test_runner=""; T_linter=""; T_formatter=""; T_typechecker=""; T_build=""
CAND_FILE="$(mktemp)"
trap 'rm -f "$CAND_FILE"' EXIT
add_candidate() {
  # add_candidate slot name1 name2 ...
  local slot="$1"; shift
  printf '%s\t%s\n' "$slot" "$(printf '%s,' "$@" | sed 's/,$//')" >> "$CAND_FILE"
}

get_slot() { eval "printf '%s' \"\$S_$1\""; }
set_slot() {
  # set_slot slot value  -- first writer wins (explicit-before-canonical)
  local slot="$1" val="$2" cur
  cur="$(get_slot "$slot")"
  if [ -z "$cur" ]; then eval "S_${slot}=\$val"; fi
  return 0
}

# ================= 1. explicit manifest scripts =================
if has_file package.json; then
  v="$(pkg_script test)";      [ -n "$v" ] && set_slot test      "$(prefixed "$v")"
  v="$(pkg_script lint)";      [ -n "$v" ] && set_slot lint      "$(prefixed "$v")"
  v="$(pkg_script format)";    [ -n "$v" ] && set_slot format    "$(prefixed "$v")"
  v="$(pkg_script build)";     [ -n "$v" ] && set_slot build     "$(prefixed "$v")"
  v="$(pkg_script dev)";       [ -n "$v" ] && set_slot run       "$(prefixed "$v")"
  v="$(pkg_script typecheck)"; [ -n "$v" ] && set_slot typecheck "$(prefixed "$v")"
fi
if [ -f "$ROOT/pyproject.toml" ]; then
  for sec in tool.poe.tasks tool.pdm.scripts; do
    for slot in test lint format build; do
      if pyproj_task "$sec" "$slot"; then
        rp="$PM_PREFIX"; [ -z "$rp" ] && rp="$PM_NAME"
        case "$PM_NAME" in
          uv) set_slot "$slot" "uv run poe $slot" ;;
          poetry) set_slot "$slot" "poetry run poe $slot" ;;
          *) set_slot "$slot" "poe $slot" ;;
        esac
      fi
    done
  done
fi
mt="$(make_target test)";              [ -n "$mt" ] && set_slot test      "make $mt"
mt="$(make_target lint)";              [ -n "$mt" ] && set_slot lint      "make $mt"
mt="$(make_target fmt format)";        [ -n "$mt" ] && set_slot format    "make $mt"
mt="$(make_target build)";             [ -n "$mt" ] && set_slot build     "make $mt"
jr="$(just_recipe test)";   [ -n "$jr" ] && set_slot test   "just $jr"
jr="$(just_recipe lint)";   [ -n "$jr" ] && set_slot lint   "just $jr"
jr="$(just_recipe fmt format)"; [ -n "$jr" ] && set_slot format "just $jr"
jr="$(just_recipe build)";  [ -n "$jr" ] && set_slot build  "just $jr"

# ================= 2. canonical fallback per detected stack =================

# ---- Node / TypeScript ----
if has_file package.json; then
  has_vitest=0; has_jest=0; has_eslint=0; has_biome=0; has_prettier=0; has_tsc=0
  pkg_dep vitest && has_vitest=1
  pkg_dep jest && has_jest=1
  { has_file .eslintrc || has_file .eslintrc.json || has_file .eslintrc.js || has_file .eslintrc.cjs \
    || has_file eslint.config.js || has_file eslint.config.mjs || has_file eslint.config.cjs \
    || pkg_dep eslint; } && has_eslint=1
  { has_file biome.json || has_file biome.jsonc || pkg_dep @biomejs/biome; } && has_biome=1
  { has_file .prettierrc || has_file .prettierrc.json || has_file .prettierrc.js || has_file .prettierrc.cjs \
    || has_file .prettierrc.yaml || has_file .prettierrc.yml || has_file prettier.config.js \
    || has_file prettier.config.cjs || has_file prettier.config.mjs || pkg_dep prettier; } && has_prettier=1
  { has_file tsconfig.json || pkg_dep typescript; } && has_tsc=1

  if [ "$has_vitest" = 1 ] && [ "$has_jest" = 1 ]; then add_candidate test_runner vitest jest; fi
  if [ "$has_eslint" = 1 ] && [ "$has_biome" = 1 ]; then add_candidate linter eslint biome; fi
  if [ "$has_prettier" = 1 ] && [ "$has_biome" = 1 ]; then add_candidate formatter prettier biome; fi

  if [ "$has_vitest" = 1 ]; then
    T_test_runner=vitest
    set_slot test "$(prefixed "vitest run")"
    set_slot test_file "$(prefixed "vitest run {file}")"
  elif [ "$has_jest" = 1 ]; then
    T_test_runner=jest
    set_slot test "$(prefixed "jest")"
    set_slot test_file "$(prefixed "jest {file}")"
  fi

  if [ "$has_eslint" = 1 ]; then
    T_linter=eslint
    set_slot lint "$(prefixed "eslint .")"
    set_slot lint_fix "$(prefixed "eslint --fix {file}")"
  elif [ "$has_biome" = 1 ]; then
    T_linter=biome
    set_slot lint "$(prefixed "biome lint .")"
    set_slot lint_fix "$(prefixed "biome lint --write {file}")"
  fi

  if [ "$has_prettier" = 1 ]; then
    T_formatter=prettier
    set_slot format "$(prefixed "prettier --write {file}")"
    set_slot format_all "$(prefixed "prettier --write .")"
  elif [ "$has_biome" = 1 ]; then
    T_formatter=biome
    set_slot format "$(prefixed "biome format --write {file}")"
    set_slot format_all "$(prefixed "biome format --write .")"
  fi

  if [ "$has_tsc" = 1 ]; then
    T_typechecker=tsc
    set_slot typecheck "$(prefixed "tsc --noEmit")"
  fi

  case "$PM_NAME" in
    pnpm) set_slot install "pnpm install --frozen-lockfile" ;;
    yarn) set_slot install "yarn install --frozen-lockfile" ;;
    npm)  set_slot install "npm ci" ;;
    bun)  set_slot install "bun install" ;;
  esac
fi

# ---- Python ----
if has_file pyproject.toml || has_file requirements.txt || has_file Pipfile || any_glob 'requirements*.txt'; then
  has_pytest=0; has_ruff=0; has_black=0; has_isort=0; has_flake8=0; has_mypy=0; has_pyright=0
  { grep_present pyproject.toml 'pytest' || has_dir tests || any_glob 'test_*.py' || any_glob '*_test.py'; } && has_pytest=1
  { has_file ruff.toml || grep_present pyproject.toml '^\[tool\.ruff' ; } && has_ruff=1
  { grep_present pyproject.toml '"black"' || grep_present pyproject.toml '^\[tool\.black' ; } && has_black=1
  { grep_present pyproject.toml '"isort"' || grep_present pyproject.toml '^\[tool\.isort' ; } && has_isort=1
  { has_file .flake8 || has_file setup.cfg ; } && has_flake8=1
  { has_file mypy.ini || grep_present pyproject.toml '^\[tool\.mypy' ; } && has_mypy=1
  has_file pyrightconfig.json && has_pyright=1

  if [ "$has_mypy" = 1 ] && [ "$has_pyright" = 1 ]; then add_candidate typechecker mypy pyright; fi

  if [ "$has_pytest" = 1 ]; then
    T_test_runner=pytest
    set_slot test "$(prefixed "pytest")"
    set_slot test_file "$(prefixed "pytest {file}")"
  fi
  if [ "$has_ruff" = 1 ]; then
    T_linter=ruff
    set_slot lint "$(prefixed "ruff check .")"
    set_slot lint_fix "$(prefixed "ruff check --fix {file}")"
    T_formatter=ruff
    set_slot format "$(prefixed "ruff format {file}")"
    set_slot format_all "$(prefixed "ruff format .")"
  elif [ "$has_flake8" = 1 ]; then
    T_linter=flake8
    set_slot lint "$(prefixed "flake8")"
  fi
  if [ -z "$T_formatter" ] && [ "$has_black" = 1 ]; then
    T_formatter=black
    if [ "$has_isort" = 1 ]; then
      set_slot format "$(prefixed "black {file}") && $(prefixed "isort {file}")"
      set_slot format_all "$(prefixed "black .") && $(prefixed "isort .")"
    else
      set_slot format "$(prefixed "black {file}")"
      set_slot format_all "$(prefixed "black .")"
    fi
  fi
  if [ "$has_mypy" = 1 ]; then
    T_typechecker=mypy
    set_slot typecheck "$(prefixed "mypy .")"
  elif [ "$has_pyright" = 1 ]; then
    T_typechecker=pyright
    set_slot typecheck "$(prefixed "pyright")"
  fi

  case "$PM_NAME" in
    uv) set_slot install "uv sync" ;;
    poetry) set_slot install "poetry install" ;;
    pipenv) set_slot install "pipenv install" ;;
    pip)
      for f in "$ROOT"/requirements*.txt; do
        if [ -f "$f" ]; then set_slot install "pip install -r $(basename "$f")"; break; fi
      done
      ;;
  esac
fi

# ---- Go ----
if has_file go.mod; then
  set_slot install "go mod download"
  set_slot build "go build ./..."
  set_slot test "go test ./..."
  T_test_runner="go test"
  if has_file .golangci.yml; then
    T_linter=golangci-lint
    set_slot lint "golangci-lint run"
  else
    T_linter="go vet"
    set_slot lint "go vet ./..."
  fi
  T_formatter=gofmt
  set_slot format "gofmt -w {file}"
  set_slot format_all "gofmt -w ."
  T_typechecker="go build"
  set_slot typecheck "go build ./..."
  T_build="go build"
fi

# ---- Rust ----
if has_file Cargo.toml; then
  set_slot install "cargo fetch"
  set_slot build "cargo build"
  set_slot test "cargo test"
  T_test_runner="cargo test"
  T_linter=clippy
  set_slot lint "cargo clippy -- -D warnings"
  set_slot lint_fix "cargo clippy --fix --allow-dirty"
  T_formatter="cargo fmt"
  set_slot format "cargo fmt -- {file}"
  set_slot format_all "cargo fmt"
  T_typechecker="cargo check"
  set_slot typecheck "cargo check"
  T_build=cargo
fi

# ---- Ruby ----
if has_file Gemfile; then
  set_slot install "bundle install"
  if has_dir spec; then
    set_slot test "bundle exec rspec"
    T_test_runner=rspec
  else
    set_slot test "bundle exec rake test"
    T_test_runner=rake
  fi
  if has_file .rubocop.yml; then
    T_linter=rubocop
    set_slot lint "bundle exec rubocop"
    set_slot lint_fix "bundle exec rubocop -a"
    T_formatter=rubocop
    set_slot format_all "bundle exec rubocop -A"
  fi
fi

# ---- PHP ----
if has_file composer.json; then
  set_slot install "composer install"
  { has_file phpunit.xml || has_file phpunit.xml.dist; } && set_slot test "vendor/bin/phpunit"
  if any_glob '.php-cs-fixer*'; then
    T_formatter=php-cs-fixer
    set_slot format "vendor/bin/php-cs-fixer fix {file}"
    set_slot format_all "vendor/bin/php-cs-fixer fix"
    T_linter=phpstan
    set_slot lint "vendor/bin/phpstan analyse"
  fi
fi

# ---- Elixir ----
if has_file mix.exs; then
  set_slot install "mix deps.get"
  set_slot build "mix compile"
  set_slot test "mix test"
  set_slot test_file "mix test {file}"
  T_test_runner="mix test"
  T_linter=credo
  set_slot lint "mix credo"
  T_formatter="mix format"
  set_slot format "mix format {file}"
  set_slot format_all "mix format"
  T_typechecker=dialyzer
  set_slot typecheck "mix dialyzer"
fi

# ---- Dart / Flutter ----
if has_file pubspec.yaml; then
  is_flutter=0
  grep_present pubspec.yaml 'flutter:' && is_flutter=1
  if [ "$is_flutter" = 1 ]; then
    set_slot install "flutter pub get"
    set_slot test "flutter test"
    set_slot test_file "flutter test {file}"
    set_slot build "flutter build"
    T_test_runner="flutter test"
  else
    set_slot install "dart pub get"
    set_slot test "dart test"
    set_slot test_file "dart test {file}"
    T_test_runner="dart test"
  fi
  T_formatter="dart format"
  set_slot format "dart format {file}"
  set_slot format_all "dart format ."
  T_linter="dart analyze"
  set_slot lint "dart analyze"
fi

# ---- Java / Kotlin (Gradle) ----
if has_file gradlew; then
  set_slot build "./gradlew build"
  set_slot test "./gradlew test"
  T_test_runner=gradle
  T_linter=gradle
  set_slot lint "./gradlew check"
  T_typechecker=gradle
  set_slot typecheck "./gradlew compileJava"
  T_build=gradle
  if grep_present build.gradle 'spotless' || grep_present build.gradle.kts 'spotless'; then
    set_slot format_all "./gradlew spotlessApply"
  fi
fi

# ---- Maven ----
if has_file pom.xml; then
  mvn_bin="mvn"
  has_file mvnw && mvn_bin="./mvnw"
  set_slot install "$mvn_bin install"
  set_slot build "$mvn_bin package"
  set_slot test "$mvn_bin test"
  T_test_runner=maven
  T_build=maven
fi

# ---- C / C++ ----
if has_file .clang-format; then
  T_formatter=clang-format
  set_slot format "clang-format -i {file}"
  T_linter=clang-tidy
  set_slot lint "clang-tidy {file}"
fi
if has_file CMakeLists.txt; then
  set_slot build "cmake --build build"
  T_build=cmake
fi

# ---- Terraform ----
if any_glob '*.tf'; then
  T_formatter=terraform
  set_slot format "terraform fmt {file}"
  set_slot format_all "terraform fmt -recursive"
  T_linter=tflint
  set_slot lint "tflint"
  T_typechecker=terraform
  set_slot typecheck "terraform validate"
fi

# ================= 3. globs & shared/secrets defaults =================
source_globs='[]'; test_globs='[]'; generated_globs='[]'; shared_files='[]'

case "$TOP_LANG" in
  typescript|javascript)
    if has_dir src; then source_globs='["src/**"]'; else source_globs='["**/*.ts","**/*.js"]'; fi
    test_globs='["**/*.test.ts","**/*.spec.ts","**/*.test.js","**/*.spec.js","tests/**"]'
    generated_globs='["dist/**","build/**",".turbo/**","**/*.generated.*"]'
    sf="$(mktemp)"
    [ -n "$PM_LOCK" ] && printf '%s\n' "$PM_LOCK" >> "$sf"
    printf 'package.json\n' >> "$sf"
    for cand in src/types/index.ts src/index.ts src/routes.ts src/routes/index.ts; do
      if [ -f "$ROOT/$cand" ]; then printf '%s\n' "$cand" >> "$sf"; fi
    done
    shared_files="$(jq -R -s -c 'split("\n") | map(select(length>0))' "$sf")"
    rm -f "$sf"
    ;;
  python)
    if has_dir src; then source_globs='["src/**"]'; else source_globs='["**/*.py"]'; fi
    test_globs='["tests/**","**/test_*.py","**/*_test.py"]'
    generated_globs='["dist/**","build/**","**/*.egg-info/**","**/__pycache__/**"]'
    sf="$(mktemp)"
    printf 'pyproject.toml\n' >> "$sf"
    [ -n "$PM_LOCK" ] && printf '%s\n' "$PM_LOCK" >> "$sf"
    shared_files="$(jq -R -s -c 'split("\n") | map(select(length>0))' "$sf")"
    rm -f "$sf"
    ;;
  go)
    source_globs='["**/*.go"]'
    test_globs='["**/*_test.go"]'
    generated_globs='["vendor/**"]'
    shared_files='["go.mod","go.sum"]'
    ;;
  rust)
    source_globs='["src/**"]'
    test_globs='["tests/**","src/**/*_test.rs"]'
    generated_globs='["target/**"]'
    shared_files='["Cargo.toml","Cargo.lock"]'
    ;;
  *)
    source_globs='["src/**"]'
    test_globs='["tests/**","test/**"]'
    generated_globs='["dist/**","build/**"]'
    shared_files='[]'
    ;;
esac

secrets_globs='[".env",".env.*","!.env.example","!.env.sample","!.env.template","*.pem","*.key","**/id_rsa*","secrets.*","credentials.json","*.p12",".npmrc",".pypirc"]'

# ================= 4. candidates{} =================
candidates_json='{}'
if [ -s "$CAND_FILE" ]; then
  candidates_json=$(awk -F'\t' '{printf "{\"%s\":[", $1; n=split($2,a,","); for(i=1;i<=n;i++){printf "%s\"%s\"", (i>1?",":""), a[i]} printf "]}\n"}' "$CAND_FILE" \
    | jq -s -c 'reduce .[] as $o ({}; . * $o)')
fi

# ================= 5. emit =================
# NB: `select(length>0)` in an object VALUE position yields zero results (not null) when the
# scalar is empty, which collapses the WHOLE object build (jq's object constructor does a
# cartesian product over its field generators). Use an if/else that always emits exactly one
# value per field instead.
tools_json=$(jq -n \
  --arg test_runner "$T_test_runner" --arg linter "$T_linter" --arg formatter "$T_formatter" \
  --arg typechecker "$T_typechecker" --arg build "$T_build" \
  '{test_runner: ($test_runner | if length>0 then . else null end),
    linter: ($linter | if length>0 then . else null end),
    formatter: ($formatter | if length>0 then . else null end),
    typechecker: ($typechecker | if length>0 then . else null end),
    build: ($build | if length>0 then . else null end)}')

commands_json=$(jq -n \
  --arg install "$S_install" --arg build "$S_build" --arg test "$S_test" --arg test_file "$S_test_file" \
  --arg lint "$S_lint" --arg lint_fix "$S_lint_fix" --arg format "$S_format" --arg format_all "$S_format_all" \
  --arg typecheck "$S_typecheck" --arg run "$S_run" \
  '{install:($install|if length>0 then . else null end), build:($build|if length>0 then . else null end),
    test:($test|if length>0 then . else null end), test_file:($test_file|if length>0 then . else null end),
    lint:($lint|if length>0 then . else null end), lint_fix:($lint_fix|if length>0 then . else null end),
    format:($format|if length>0 then . else null end), format_all:($format_all|if length>0 then . else null end),
    typecheck:($typecheck|if length>0 then . else null end), run:($run|if length>0 then . else null end)}')

out=$(jq -n \
  --argjson tools "$tools_json" --argjson commands "$commands_json" --argjson candidates "$candidates_json" \
  --argjson source_globs "$source_globs" --argjson test_globs "$test_globs" \
  --argjson generated_globs "$generated_globs" --argjson shared_files "$shared_files" \
  --argjson secrets_globs "$secrets_globs" \
  '{tools:$tools, commands:$commands, candidates:$candidates, source_globs:$source_globs,
    test_globs:$test_globs, generated_globs:$generated_globs, shared_files:$shared_files,
    secrets_globs:$secrets_globs}')

if [ "$PRETTY" = 1 ]; then printf '%s\n' "$out" | jq .
else printf '%s\n' "$out" | jq -c .
fi
