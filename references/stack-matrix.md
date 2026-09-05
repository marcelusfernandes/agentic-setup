# Stack matrix

The human/agent-readable version of the detection→commands table implemented as case
statements in `scripts/detect/commands.sh`. The `project-scanner` agent reads this file
alongside `scripts/detect/scan.sh`'s evidence JSON when it needs to explain a resolution or
break a tie; it does not need to recompute anything here — `commands.sh` already applied it.

## Resolution order (per command slot)

1. **Explicit manifest script** — `package.json` `scripts.{test,lint,format,build,dev,typecheck}`,
   a `pyproject.toml` `[tool.poe.tasks]`/`[tool.pdm.scripts]` entry named `test`/`lint`/`format`/`build`,
   a `Makefile` target (`test`, `lint`, `fmt`|`format`, `build`), or a `justfile` recipe of the
   same names.
2. **Canonical invocation** for the detected tool (the table below), with the package
   manager's runner prefix applied.
3. **`null`** — the gate is skipped, never guessed. `null` is a decision, not a gap (see
   `04-architecture.md` §8.1): `doctor` reports it as `WARN` with the exact `overrides` JSON
   to paste in, and `pr` prints "skipped (no command configured)" in the PR body.

## Package-manager runner prefixes

Applied to the canonical tool invocation so a locally-installed (non-global) binary resolves.
Detected from the first matching lockfile; falls back to the bare manifest file (no lockfile
yet — e.g. dependencies never installed) so detection still works on a fresh checkout.

| Lockfile (or manifest fallback) | `package_manager.name` | `runner_prefix` |
|---|---|---|
| `pnpm-lock.yaml` | pnpm | `pnpm exec` |
| `yarn.lock` | yarn | `yarn` |
| `package-lock.json` (or bare `package.json`) | npm | `npx` |
| `bun.lockb` / `bun.lock` | bun | `bunx` |
| `uv.lock` | uv | `uv run` |
| `poetry.lock` | poetry | `poetry run` |
| `Pipfile.lock` | pipenv | `pipenv run` |
| `requirements*.txt` (or bare `pyproject.toml`) | pip | *(empty)* |
| `Gemfile.lock` | bundler | `bundle exec` |
| `Cargo.lock` (or bare `Cargo.toml`) | cargo | *(empty)* |
| `go.sum` (or bare `go.mod`) | go | *(empty)* |
| `composer.lock` (or bare `composer.json`) | composer | *(empty)* |
| `mix.lock` (or bare `mix.exs`) | mix | *(empty)* |
| `pubspec.lock` (or bare `pubspec.yaml`) | dart / flutter† | *(empty)* |
| `gradlew` | gradle | `./gradlew` |
| `mvnw` | maven | `./mvnw` |
| `pom.xml` (no `mvnw`) | maven | `mvn` |

† `flutter` when `pubspec.yaml` contains a `flutter:` key, else `dart`.

Node, Python and Ruby canonical commands below are written **without** the prefix; `commands.sh`
prepends `runner_prefix` at resolution time (`"$runner_prefix $tool_cmd"`, or bare `$tool_cmd`
when the prefix is empty). Go/Rust/Elixir/Dart/Gradle/Maven/Terraform/C canonical commands
already include their own root binary and need no separate prefix.

## Canonical commands by detected tool

`{file}` is substituted by the consumer (format-on-edit hook, `implementer` agent, etc.);
`{files}` denotes a multi-file variant, not currently emitted by `commands.sh`.

| Detected | `test` | `lint` | `lint_fix` | `format` | `format_all` | `typecheck` |
|---|---|---|---|---|---|---|
| Vitest (`vitest` dep) | `vitest run` | — | — | — | — | — |
| Jest (`jest` dep) | `jest` | — | — | — | — | — |
| ESLint (`.eslintrc*`, `eslint.config.*`, or `eslint` dep) | — | `eslint .` | `eslint --fix {file}` | — | — | — |
| Biome (`biome.json*`, or `@biomejs/biome` dep) | — | `biome lint .` | `biome lint --write {file}` | `biome format --write {file}` | `biome format --write .` | — |
| Prettier (`.prettierrc*`, `prettier.config.*`, or `prettier` dep) | — | — | — | `prettier --write {file}` | `prettier --write .` | — |
| TypeScript (`tsconfig.json`, or `typescript` dep) | — | — | — | — | — | `tsc --noEmit` |
| pytest (`pytest` in deps, or `tests/` dir, or `test_*.py`) | `pytest` | — | — | — | — | — |
| Ruff (`ruff.toml`, or `[tool.ruff]`) | — | `ruff check .` | `ruff check --fix {file}` | `ruff format {file}` | `ruff format .` | — |
| flake8 (`.flake8`, `setup.cfg`) — only when Ruff absent | — | `flake8` | — | — | — | — |
| Black (+ isort if present) — only when Ruff absent | — | — | — | `black {file}` [`&& isort {file}`] | `black .` [`&& isort .`] | — |
| mypy (`mypy.ini`, `[tool.mypy]`) | — | — | — | — | — | `mypy .` |
| pyright (`pyrightconfig.json`) — only when mypy absent | — | — | — | — | — | `pyright` |
| Go (`go.mod`) | `go test ./...` | `golangci-lint run` (if `.golangci.yml`) else `go vet ./...` | — | `gofmt -w {file}` | `gofmt -w .` | `go build ./...` |
| Rust (`Cargo.toml`) | `cargo test` | `cargo clippy -- -D warnings` | `cargo clippy --fix --allow-dirty` | `cargo fmt -- {file}` | `cargo fmt` | `cargo check` |
| Ruby (`Gemfile`) | `rspec` (if `spec/`) else `rake test` | `rubocop` (if `.rubocop.yml`) | `rubocop -a` | — | `rubocop -A` | — |
| PHP (`composer.json`) | `vendor/bin/phpunit` (if `phpunit.xml*`) | `vendor/bin/phpstan analyse` (if `.php-cs-fixer*`) | — | `vendor/bin/php-cs-fixer fix {file}` | `vendor/bin/php-cs-fixer fix` | — |
| Elixir (`mix.exs`) | `mix test` | `mix credo` | — | `mix format {file}` | `mix format` | `mix dialyzer` |
| Dart (`pubspec.yaml`, no `flutter:`) | `dart test` | `dart analyze` | — | `dart format {file}` | `dart format .` | — |
| Flutter (`pubspec.yaml` with `flutter:`) | `flutter test` | `dart analyze` | — | `dart format {file}` | `dart format .` | — |
| Java/Kotlin Gradle (`gradlew`) | `./gradlew test` | `./gradlew check` | — | **null** (too slow per-file) | `./gradlew spotlessApply` (if `spotless` in build file) | `./gradlew compileJava` |
| Maven (`pom.xml`/`mvnw`) | `<mvn> test` | — | — | — | — | — |
| C/C++ (`.clang-format`) | — | `clang-tidy {file}` | — | `clang-format -i {file}` | — | — |
| Terraform (`*.tf`) | — | `tflint` | — | `terraform fmt {file}` | `terraform fmt -recursive` | `terraform validate` |
| Nothing detected | `null` | `null` | `null` | `null` | `null` | `null` |

`install` per package manager: `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile`
/ `npm ci` / `bun install` / `uv sync` / `poetry install` / `pipenv install` /
`pip install -r <requirements file>` / `bundle install` / `cargo fetch` / `go mod download` /
`composer install` / `mix deps.get` / `dart pub get` / `flutter pub get` / `<mvn> install`.
Gradle has no canonical `install` (dependencies resolve on build) — left `null`.

## Ambiguity rules

Two candidates for the same slot (e.g. `vitest` **and** `jest` both present) are recorded in
`candidates.<slot>` (`scripts/detect/commands.sh`'s `candidates` map) rather than silently
picked. `commands.sh` still resolves a *default* (first match in the table's own left-to-right
order — Vitest before Jest, ESLint before Biome, Prettier before Biome, mypy before pyright) so
the profile is never left with a hole, but `scan`'s calling skill must surface the ambiguity as
**one** consolidated question, recommendation pre-selected, and — if the session is
non-interactive — record the recommendation with `"confidence": "medium"` and populate
`ambiguities[]` in the profile instead of silently trusting the default.

Slots currently tie-checked: `test_runner` (vitest/jest), `linter` (eslint/biome),
`formatter` (prettier/biome), `typechecker` (mypy/pyright, Python only).

## The "null is a decision" rule

A `null` command slot is never invented and never silently treated as passing. Consumers:

| Slot | If `null` |
|---|---|
| `install` | skip; `start` warns once that the worktree may not run |
| `test` | skip the gate; print "no test command configured" — never invent one, never treat as pass |
| `test_file` | fall back to `test` (whole suite) |
| `lint` / `lint_fix` | skip, reported as skipped |
| `format` / `format_all` | skip; `format-on-edit.sh` exits 0 silently |
| `typecheck` | skip |
| `build` | skip (only checked when `ci.required_checks` includes a build) |
| `run` | unused in v1 |

`doctor` reports every `null` slot as `WARN` with the exact `overrides` JSON to paste into
`.claude/agentic/project-profile.json` (§6.2/§8.2 of `04-architecture.md`) — the **only**
override mechanism; there is no second config file.
