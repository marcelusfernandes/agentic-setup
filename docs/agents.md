# Discipline agent catalogue

An opt-in catalogue of preset agent cards under `templates/agents/`, one directory per
card, each shipped in both routes' formats. Nothing in the repository installs this
catalogue yet — `scripts/init.mts --agents` and `scripts/setup-codex.mts --agents` (a
later issue in milestone M9) copy it into an adopting repository with its placeholders
filled from `ci/lib/detect.mts`. Until then, this is source material for a person (or a
future installer) to read and adapt by hand.

## The fourteen cards

| Card | What it does |
| --- | --- |
| `qa` | Verifies a change against its acceptance criteria by running the test suite. |
| `architecture` | Reviews structural fit and dependency direction before a change locks in. |
| `backend` | Implements/reviews server-side logic, APIs and data access. |
| `frontend` | Implements/reviews client-side UI, state and interaction logic. |
| `design` | Reviews visual consistency and accessibility (its own section) for UI changes. |
| `product` | Checks a change against its stated user-facing goal and scope. |
| `research` | Surveys existing code, prior art and docs before a decision is made. |
| `planner` | Turns an approved goal into an ordered, scoped implementation plan. |
| `investigator` | Investigates a bug or open question to a root cause or ranked candidates. |
| `security-reviewer` | Reviews for security defects; runs next to the pipeline `reviewer`. |
| `data-migrations` | Implements/reviews schema and data migrations for reversibility and safety. |
| `devops` | Implements/reviews CI/CD, infrastructure and deployment configuration. |
| `release-manager` | Prepares and verifies a release: changelog, version, rollout order. |
| `profiler` | One-time first-run step; fills every installed card, then removes itself. |

`planner` here is deliberately plain — it plans one scoped unit of work. The milestone
moulds (delivery/investigation/hardening) it will later carry are issue #127's content,
not this catalogue's.

## Card shape

Each card lives at `templates/agents/<name>/<name>.md` and `templates/agents/<name>/<name>.toml`.
Both forms carry **the same instructions** — the Markdown body after the frontmatter and
the TOML's `developer_instructions` string are the same text, whitespace aside — so
editing one route's card and forgetting the other is a drift a diff review catches, and
`tests/agents-catalogue.test.mts` catches mechanically.

Every card's instructions use exactly these three sections, in order:

- **Checks** — what the discipline verifies before it signs off.
- **Never** — what it must not do (edit code it shouldn't, merge, invent a decision that
  isn't its to make).
- **Output** — the exact shape of what it reports back.

`design` carries one more section, **Accessibility**, between Checks and Never, per the
milestone's spec (#123).

### Placeholders

A card's instructions may reference only these four placeholders, written `{{name}}`:

- `{{test_command}}` — the project's test command (from `ci/lib/detect.mts`).
- `{{stack}}` — the detected stack name (`node`, `python`, `ruby`, …).
- `{{test_dirs}}` — where the project's tests live.
- `{{default_branch}}` — the branch releases and CI protect.

No other placeholder is allowed; `tests/agents-catalogue.test.mts` greps every card for
`{{...}}` tokens and fails on anything outside this set. The forthcoming `--agents`
installer flag (#2 of milestone M9) fills them from detection; the `profiler` card's job
is to replace the generic fill with the repository's actual conventions on first run,
then remove itself.

## The Claude (`.md`) form

Frontmatter fields are `name`, `description`, `model`, `tools` — the same shape as the
existing pipeline agent `agents/reviewer.md`, which this catalogue's `.md` cards were
modeled on. `tools` is a comma-separated list (e.g. `Read, Grep, Glob, Bash`); a card
that only reviews omits `Edit`/`Write`, one that implements (`backend`, `frontend`,
`data-migrations`, `devops`, and `profiler` for `Write`) includes it.

## The Codex (`.toml`) form

This repository had no prior example of a Codex agent-role TOML file, so the schema here
follows Codex's own source rather than inventing one. `openai/codex`'s
`codex-rs/agent-roles/src/agent_role_config.rs` parses a role file as a TOML table with
top-level `name`, `description`, and optional `nickname_candidates`, plus every other
field flattened from `codex-rs/config/src/config_toml.rs`'s `ConfigToml` — which is where
`model`, `model_reasoning_effort` and `developer_instructions` (the instructions string,
required for a standalone role file per that same source) come from. A project wires a
role file in with a `[agents.<name>]` table in `.codex/config.toml` pointing
`config_file` at it (the comment `config_file = "./agents/researcher.toml"` in that same
`config_toml.rs` documents the convention) — that wiring is installer work for a later
issue, not shipped here.

Each card's `.toml` sets `model = "gpt-5-codex"` and a `model_reasoning_effort` (`high`
for the deeper-reasoning cards — `architecture`, `planner`, `investigator`,
`security-reviewer` — `medium` for the rest) as a placeholder default; a person adopting
the catalogue is expected to point `model` at whatever Codex model/profile their
environment actually uses.

## `index.json`: mapping `scope:*` to a card

`templates/agents/index.json` maps a project's `scope:<label>` issue labels to the card
name a dispatcher should inline into the `implementer`/`reviewer` prompt for that issue,
under `"scopes"`. `"runs_with_reviewer"` lists the cards that run alongside the pipeline
`reviewer` in addition to (not instead of) the discipline dispatched by scope —
currently just `security-reviewer`, which rejects with `state:qa-failed` exactly like the
pipeline reviewer's own rejection path when the mapping says it should run.

This file is data only. No script reads it yet — wiring the orchestrator (Claude) and the
autonomous loop (Codex) to dispatch by it is issue #128's job. `planner`, `investigator`
and `profiler` are intentionally absent from `"scopes"`: they are not chosen by a
`scope:` label, they are invoked directly (planning, investigation, and the first-run
step, respectively).

The mapping in this repository is a starting point for an adopting project to edit, not a
fixed contract — a project can rename cards, add its own, or point a `scope:` label at a
different card entirely.
