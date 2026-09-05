# Parallelism — streams, worktrees, dispatch and merge order

Normative rules for `start`, `work` and `merge`. Conflict handling lives in `conflicts.md`.

## 1. How streams are computed

1. Start from the task's `files[]` (already narrowed at plan time).
2. Expand every glob against `git ls-files` into a concrete path set, plus the "will create" set the plan named explicitly.
3. Group paths along seams that exist in the code: layer (schema / data / service / api / ui), module boundary, or test-vs-implementation. Prefer 2–4 streams; `config.max_parallel_streams` (default 4) is the cap.
4. **Intersect every pair of streams.** A non-empty intersection has exactly two remedies: merge the two streams, or lift the intersecting paths into `shared` with a single owner. There is no third option — overlapping writers is the failure mode this whole design exists to prevent.
   ```bash
   git ls-files -- 'src/db/**' | sort -u > A.txt
   git ls-files -- 'src/api/**' | sort -u > B.txt
   comm -12 A.txt B.txt        # must print nothing
   ```
5. Any path in `profile.shared_files` is **always** `shared`, never implicitly owned by a stream.
6. `depends_on` between streams creates waves. Wave 1 = streams with no dependencies. A stream needing another's type, migration or interface waits — it does not stub and hope.
7. If steps 4–6 leave one stream, run one stream. Serial is a valid plan and costs nothing to say.

## 2. Shared epic worktree vs per-task worktrees

**Default: one worktree per epic** — `.worktrees/epic-<slug>` on `epic/<slug>`, with N implementers inside it on disjoint scopes. One dependency install, one branch, one PR closing several issues.

**Escalate to one worktree per task** when any of these is true:

1. two tasks' file scopes intersect and cannot be made disjoint by lifting paths into `shared`;
2. tasks need different dependency states (a task bumps a dependency, adds a native module, changes the lockfile) — separate installs are then mandatory;
3. tasks must ship and be reviewed independently (different reviewers, different release timing, a hotfix among features);
4. CI must be green per task rather than per epic;
5. a task rewrites history (a rebase-heavy refactor) that would disturb its siblings.

A per-agent worktree is a full checkout plus a full dependency install; reserve it for genuine simultaneous mutation. `config.worktree_mode` (`auto|shared|per-task`) overrides; `auto` applies the rule above and records the decision as a ledger ruling naming the triggering condition.

**PR shape follows worktree shape.** Shared ⇒ one PR on the epic branch with one `Closes #N` per completed sub-issue plus `Part of #<epic>`. Per-task ⇒ one PR per task branch.

## 3. The single-writer rule for shared files

- Shared files come from `epic.md:shared_files[]` (the plan) plus `profile.shared_files` (lockfiles, root manifests, type barrels, i18n catalogs, route tables, DI containers).
- Exactly one stream owns each. Ownership is recorded in `analysis/<issue>.md` and enforced by a lock in `runtime/locks/<sha1(path)>.lock` via `scripts/state/lock.sh`.
- A non-owner never edits the file. It appends to `runtime/streams/<issue>/requests.jsonl` and continues with its own scope. The orchestrator routes each request to the owner in the next wave, or applies it directly if the owner already finished.
- Before touching a shared file the owner checks `git status --porcelain <path>`; if another stream has it modified, it stops and reports.
- **After every wave the orchestrator diffs the worktree against the union of declared scopes. Any file changed outside its lane stops the run.** This audit is what makes a shared worktree safe rather than merely cheap.

## 4. Merge order

1. **Topological** by task `depends_on`. A task never merges before what it depends on.
2. Within a level, **smallest diff first**, by total changed lines from `git diff --shortstat origin/<base>...origin/<head>`. Small PRs land clean; the large one absorbs the rebase cost once instead of forcing N small rebases.
3. Ties by ascending PR number — deterministic, so a re-run produces the same order.
4. **Re-validate after every merge.** A merge changes the base, so every remaining PR's earlier dry run is void: re-run `merge-tree` for all of them; anything now conflicting moves to the end and is flagged.
5. `rerere` is enabled locally by `init`, so a conflict resolved once during a train replays automatically on the next branch that hits it — exactly the repeated-rebase case a train produces.

The `integration-manager` agent computes this order and returns a verdict per PR; the `merge` skill executes it one PR at a time.

## 5. The mechanical dispatch rule

**Every stream of a wave is dispatched as a separate Agent tool call inside ONE assistant message.**

Several dispatch calls in the same response run concurrently. One call per response runs serially, no matter how the prompt is worded. This is a property of the harness, not of phrasing — "in parallel" in an instruction changes nothing. `--serial` deliberately reverts to one call per message.

Corollaries: collect the whole wave before starting the next one; a wave's size is bounded by `max_parallel_streams`; and each dispatched prompt must be self-contained, because subagents inherit none of the orchestrator's context.

## 6. Why native worktree isolation is NOT used

The plugin creates its worktrees itself, with `scripts/git/worktree-add.sh`, under `config.worktree_dir` (default `.worktrees/`). Do not "improve" this into the native mechanisms:

- **`EnterWorktree` / `claude --worktree NAME`** creates `.claude/worktrees/<name>` on a `worktree-<name>` branch. That name carries no issue number, follows neither `branch_template` nor the worktree naming convention, and is invisible to `mapping.json` — so `status`, `merge` and `cleanup` cannot see it.
- **`isolation: worktree` on an agent** makes Claude Code create *its own* temporary worktree branched from the remote default. That is a second, unrelated checkout the state model knows nothing about, and its isolation enforcement then **blocks the agent from writing to the worktree we actually created**. No agent in this plugin sets it.

The two systems coexist without overlap: the plugin owns `.worktrees/`, the harness owns `.claude/worktrees/`, and `cleanup` only ever touches `config.worktree_dir`.
