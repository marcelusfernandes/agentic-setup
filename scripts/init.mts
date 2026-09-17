#!/usr/bin/env node
// init — sets a repository up for the agent loop. Run from the repository
// root; idempotent; never overwrites a file you edited unless --force.
//
//   node scripts/init.mts [--milestone "<title>"] [--no-gh] [--force] [--dry-run]
//                         [--rules] [--ruleset-name <name>] [--require-review]
//
// --dry-run prints the same report a real run would, changes nothing on disk
// or on GitHub. Every filesystem write is routed through the write() gate
// below, so its report line comes from the same code path in both modes. gh
// writes (label create, milestone POST, ruleset POST/PUT) are instead
// skipped by an explicit `if (dryRun)` and their report line names the
// outcome a fully successful write would reach (e.g. "N/N labels present")
// — reading gh state (auth status, milestone listing, the rulesets list and
// each ruleset's detail) still happens so the report can say "=" (exists) vs
// "+" (would be created). The one line a dry run does not share with a real
// run is the --rules payload preview, printed only under --dry-run.
//
// --rules updates the branch ruleset that already governs the repository's
// default branch — the one whose conditions name it, whatever it is called
// (#143: this repository's own is named "main") — or creates one named
// "agentic-setup" when nothing governs it. It requires a pull request,
// squash as the only merge method and the checks the merge model depends on
// (docs/decisions.md item 9(a)), and carries every rule, parameter and
// bypass actor it does not manage over from the ruleset it found.
// `--ruleset-name <name>` picks the ruleset by name instead. A 403 (rulesets
// are not available on a private repository on the free plan) is reported
// plainly instead of gh's raw error, and a ruleset whose detail cannot be
// read refuses the run — no POST, no PUT — rather than letting a ruleset
// with no readable conditions look like one that governs nothing. Without
// --rules, no rulesets call is made at all.
//
// --rules resets required_approving_review_count to 0 and carries the fetched
// dismiss_stale_reviews_on_push / require_last_push_approval through (false
// when there was no ruleset to fetch), so --rules on its own never turns a
// review gate on and is safe to run at any time. A count an operator raised
// by hand on the matched ruleset is reset by it — the count is the
// installer's to own, and --require-review is how it is raised.
//
// --require-review is the explicit opt-in that raises those three (count 1,
// stale approvals dismissed, last push approved). Run it only once a second
// reviewing identity exists: the identity that merges cannot approve its own
// pull request, so on a repository with a single identity every merge is
// frozen until the second one exists (scripts/land.mts's header and
// docs/decisions.md item 13 name the trap). The report warns about exactly
// that whenever AGENTIC_REVIEWER_TOKEN is unset in the environment, and says
// the flag was ignored when it is passed without --rules or under --no-gh.
//
// What it does is listed in skills/init/SKILL.md. Node built-ins only.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LABELS: [string, string, string][] = [
  ['state:ready', '0e8a16', 'Ready to be picked up by an agent'],
  ['state:in-progress', 'fbca04', 'An agent holds the branch lock'],
  ['state:in-review', '1d76db', 'PR open, waiting for CI and the reviewer'],
  ['state:qa-failed', 'd93f0b', 'Sent back by CI or the reviewer'],
  ['state:blocked', 'b60205', 'Two failed rounds; needs a person'],
  ['type:feature', 'a2eeef', ''],
  ['type:bug', 'd73a4a', ''],
  ['type:refactor', 'c5def5', ''],
  ['type:infra', 'bfd4f2', ''],
  ['type:spec', 'd4c5f9', ''],
  ['type:docs', '0075ca', 'Docs only: no reviewer, no negative control'],
  ['type:deps', 'ededed', 'Dependency change: orchestrator only'],
  ['review:approved', '0e8a16', 'The reviewer approved'],
  // Same names, colours and descriptions as the Codex route's `LABELS`
  // (`.agents/skills/autonomous-loop/scripts/github.mts`), so a repository
  // running both routes reads one vocabulary. The bare `human` label is no
  // longer seeded; an existing one is left as found and read as pending.
  ['human:pending', 'f9d0c4', 'A human decision is required; affected work is paused'],
  ['human:decided', 'c2e0c6', 'A human decision was recorded; kept as the audit trail'],
];

const MANAGED_RULE_TYPES = ['pull_request', 'required_status_checks', 'non_fast_forward', 'deletion'];
const DEFAULT_RULESET_NAME = 'agentic-setup';

type Rule = { type: string; parameters?: Record<string, unknown> };
type Ruleset = {
  id: number;
  name?: string;
  target?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: Rule[];
  bypass_actors?: unknown[];
};

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--') && !a.includes('=')));
const milestoneIdx = process.argv.indexOf('--milestone');
const milestone = milestoneIdx !== -1 ? process.argv[milestoneIdx + 1] : null;
const rulesetNameIdx = process.argv.indexOf('--ruleset-name');
const rulesetNameOverride = rulesetNameIdx !== -1 ? (process.argv[rulesetNameIdx + 1] ?? null) : null;
const requireReview = flags.has('--require-review');
const force = flags.has('--force');
const useGh = !flags.has('--no-gh');
const dryRun = flags.has('--dry-run');

const report: string[] = [];
const say = (line: string): number => report.push(line);
if (dryRun) say('dry run — nothing written');
// --require-review only ever changes the ruleset call --rules makes. Say so
// rather than accept the flag in silence and write nothing it asked for.
if (requireReview && !flags.has('--rules')) {
  say('! --require-review ignored: it raises the ruleset review gate, which only --rules writes');
} else if (requireReview && !useGh) {
  say('! --require-review ignored: --no-gh skips the ruleset call it would change');
}

/**
 * The single gate every filesystem write goes through: performs the action,
 * or no-ops under --dry-run. Report lines are produced by the caller
 * regardless of mode, so the report is identical either way.
 */
function write(action: () => void): void {
  if (!dryRun) action();
}

function run(cmd: string, args: string[], cwd?: string, input?: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}`.trim(), err: `${r.stderr ?? ''}`.trim() };
}

/**
 * The status check name for the adopting repository's own test workflow:
 * the id of the sole job in the sole workflow file this plugin does not
 * own, or "test" when that is not unambiguous. Detection is a default,
 * never a contract — same philosophy as ci/lib/detect.mts, kept separate
 * here since it reads workflow YAML rather than a test command.
 */
function detectTestCheckName(repoRoot: string): string {
  const dir = join(repoRoot, '.github', 'workflows');
  if (!existsSync(dir)) return 'test';
  const owned = new Set(['agentic-checks.yml', 'guard-main.yml', 'issue-lint.yml']);
  const candidates = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name) && !owned.has(name));
  const jobIds = candidates.flatMap((name) => {
    const text = readFileSync(join(dir, name), 'utf8');
    const jobsBlock = text.match(/^jobs:\r?\n((?:[ \t].*\r?\n?)*)/m);
    if (!jobsBlock) return [];
    return [...jobsBlock[1].matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)].map((m) => m[1]);
  });
  return jobIds.length === 1 ? jobIds[0] : 'test';
}

/** Parses gh's JSON output, answering `fallback` when it is empty or not JSON. */
function parseJson<T>(text: string, fallback: T): T {
  try {
    const value = JSON.parse(text || '');
    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/**
 * Every branch ruleset of the repository, each merged with its own detail
 * fetch. `GET .../rulesets` answers with summaries only — no `conditions`,
 * no `rules`, no `bypass_actors` — so everything the lookup and the update
 * body need comes from `GET .../rulesets/<id>`. Tag and push rulesets share
 * the endpoint and are dropped here: they can never govern a branch.
 *
 * A detail fetch that cannot be read is fatal to the whole run, not to that
 * one ruleset: a summary with no `conditions` reads exactly like a ruleset
 * that governs nothing, so carrying on would take the create path and POST a
 * second ruleset over the branch the unreadable one already governs — the
 * defect #143 exists to remove. `unreadable` carries the message for that
 * refusal; the caller makes no POST or PUT when it is set.
 */
function fetchBranchRulesets(repoRoot: string, listOutput: string): { rulesets: Ruleset[]; unreadable: string | null } {
  const summaries = parseJson<Ruleset[]>(listOutput, []);
  if (!Array.isArray(summaries)) return { rulesets: [], unreadable: null };
  const fetched = summaries
    .filter((r) => typeof r?.id === 'number' && (r.target ?? 'branch') === 'branch')
    .map((summary) => ({ summary, ...detailOf(repoRoot, summary.id) }));
  const broken = fetched.find((f) => f.detail === null);
  if (broken) return { rulesets: [], unreadable: `could not read ruleset #${broken.summary.id}: ${broken.err}` };
  return { rulesets: fetched.map((f) => ({ ...f.summary, ...(f.detail ?? {}) })), unreadable: null };
}

/**
 * One ruleset's detail as a plain object. `detail` is null when the call
 * failed or answered with something that is not a ruleset object, and `err`
 * then says why (gh's first stderr line, or the parse complaint).
 */
function detailOf(repoRoot: string, id: number): { detail: Partial<Ruleset> | null; err: string } {
  const r = run('gh', ['api', `repos/{owner}/{repo}/rulesets/${id}`], repoRoot);
  if (!r.ok) return { detail: null, err: r.err.split('\n')[0] || 'gh gave no reason' };
  const parsed = parseJson<unknown>(r.out, null);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { detail: null, err: 'the response is not a ruleset object' };
  }
  return { detail: parsed as Partial<Ruleset>, err: '' };
}

/**
 * Whether a ruleset is the one `--rules` owns. The test is what it governs,
 * never what it is called (#143: this repository's own ruleset over the
 * default branch is named "main"): its `conditions.ref_name.include` has to
 * name the default branch, either through GitHub's `~DEFAULT_BRANCH`
 * placeholder or as the literal `refs/heads/<default branch>`.
 */
function governsDefaultBranch(ruleset: Ruleset, defaultBranch: string): boolean {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  return include.includes('~DEFAULT_BRANCH') || include.includes(`refs/heads/${defaultBranch}`);
}

/**
 * The body of the create (POST) or update (PUT) call. A PUT replaces the
 * whole ruleset, so everything the installer does not manage is carried over
 * from `existing` unchanged: its name and its conditions, its
 * `bypass_actors`, every rule whose type is outside MANAGED_RULE_TYPES and,
 * inside the managed rules, every parameter the installer does not set
 * itself — the installer's own fields win, the rest survive (that is how
 * this repository's `require_extra_approval_for_unattributed_changes`
 * survives an update). `requireReview` is the `--require-review` opt-in; see
 * the `pull_request` rule below. Only the fields listed here are sent: a detail fetch
 * also carries `node_id`, `source`, `_links` and timestamps, which the API
 * refuses in a request body.
 */
function buildRulesetPayload(
  existing: Ruleset | null,
  defaultBranch: string,
  testCheck: string,
  newName: string,
  requireReview: boolean,
): Record<string, unknown> {
  const fetched = existing?.rules ?? [];
  const parametersOf = (type: string): Record<string, unknown> => fetched.find((r) => r.type === type)?.parameters ?? {};
  const pullRequest = parametersOf('pull_request');
  const fetchedFlag = (key: string): boolean => pullRequest[key] === true;
  const managed: Rule[] = [
    {
      type: 'pull_request',
      parameters: {
        ...pullRequest,
        // The default resets the count to 0 and carries the two
        // stale-approval fields through as the fetched ruleset had them
        // (#143): the reviewer is an isolated agent whose verdict becomes the
        // `review:approved` label, with no second GitHub identity to click
        // Approve, so requiring one approving review by default would freeze
        // every merge. --require-review is the explicit opt-in that raises
        // all three, for a repository that does have a second reviewing
        // identity.
        required_approving_review_count: requireReview ? 1 : 0,
        dismiss_stale_reviews_on_push: requireReview || fetchedFlag('dismiss_stale_reviews_on_push'),
        require_last_push_approval: requireReview || fetchedFlag('require_last_push_approval'),
        allowed_merge_methods: ['squash'],
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        ...parametersOf('required_status_checks'),
        required_status_checks: [{ context: 'scope' }, { context: 'negative-control' }, { context: testCheck }],
        strict_required_status_checks_policy: false,
      },
    },
    { type: 'non_fast_forward' },
    { type: 'deletion' },
  ];
  return {
    name: existing?.name ?? newName,
    target: 'branch',
    enforcement: 'active',
    conditions: existing?.conditions ?? { ref_name: { include: [`refs/heads/${defaultBranch}`], exclude: [] } },
    bypass_actors: existing?.bypass_actors ?? [],
    rules: [...managed, ...fetched.filter((r) => !MANAGED_RULE_TYPES.includes(r.type))],
  };
}

const top = run('git', ['rev-parse', '--show-toplevel']);
if (!top.ok) {
  console.error('init: run this from inside a git repository.');
  process.exit(1);
}
const root = top.out;

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  say(`! node ${process.versions.node}: the hooks and CI scripts run TypeScript directly and need 22.18 or newer`);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Copy one file. Existing files are left alone unless `overwrite` (plugin-
 * owned code) or --force; identical files are reported as `=`.
 */
function copyOne(src: string, dst: string, overwrite: boolean): void {
  const shown = relative(root, dst);
  if (existsSync(dst) && !overwrite && !force) {
    if (readFileSync(dst, 'utf8') === readFileSync(src, 'utf8')) say(`  = ${shown}`);
    else say(`  ! ${shown} exists and differs; left alone (--force to overwrite)`);
    return;
  }
  write(() => {
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  });
  say(`  + ${shown}`);
}

function copyTree(srcDir: string, dstDir: string, overwrite: boolean): void {
  for (const src of walk(srcDir)) copyOne(src, join(dstDir, relative(srcDir, src)), overwrite);
}

// 1. templates
say('templates');
copyTree(join(PLUGIN, 'templates', '.github'), join(root, '.github'), false);
copyOne(join(PLUGIN, 'templates', '.worktreeinclude'), join(root, '.worktreeinclude'), false);

// 2. CI scripts (plugin-owned: always current)
say('ci scripts');
copyTree(join(PLUGIN, 'ci'), join(root, '.github', 'scripts', 'agentic'), true);

// 3. permission deny list
say('.claude/settings.json');
const settingsPath = join(root, '.claude', 'settings.json');
const wanted = JSON.parse(readFileSync(join(PLUGIN, 'templates', 'claude-settings.json'), 'utf8'));
let settings: Record<string, any> | null = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    say('  ! .claude/settings.json is not valid JSON; not touched');
    settings = null;
  }
}
if (settings) {
  const current = new Set(settings.permissions?.deny ?? []);
  const added = wanted.permissions.deny.filter((rule: string) => !current.has(rule));
  const merged = { ...settings, permissions: { ...(settings.permissions ?? {}), deny: [...current, ...added] } };
  write(() => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  });
  say(added.length ? `  + ${added.length} deny rule(s) added` : '  = deny list already complete');
}

// 4. git pre-push
say('git pre-push');
const hooksDir = run('git', ['rev-parse', '--git-path', 'hooks']).out;
const prePush = resolve(root, hooksDir, 'pre-push');
const ours = readFileSync(join(PLUGIN, 'hooks', 'git-pre-push'), 'utf8');
if (existsSync(prePush) && readFileSync(prePush, 'utf8') !== ours && !/agentic-setup/.test(readFileSync(prePush, 'utf8')) && !force) {
  say(`  ! ${relative(root, prePush)} exists and is not ours; left alone (--force to replace)`);
} else {
  write(() => {
    mkdirSync(dirname(prePush), { recursive: true });
    writeFileSync(prePush, ours);
    chmodSync(prePush, 0o755);
  });
  say(`  + ${relative(root, prePush)}`);
}

// 5. labels and milestone
if (useGh) {
  say('github');
  const auth = run('gh', ['auth', 'status']);
  if (!auth.ok) {
    const skipped = flags.has('--rules') ? 'labels, milestone and ruleset' : 'labels and milestone';
    say(`  ! gh is not authenticated; skipped ${skipped} (run again, or --no-gh)`);
  } else {
    // auto-merge and delete-branch-on-merge: reading is allowed even in
    // dry-run (it decides "=" vs "+"); the write itself is skipped under
    // --dry-run, same gate as the milestone below. `repo view --json` has
    // no autoMergeAllowed/deleteBranchOnMerge field -- these are read via
    // `gh api` instead, the fields' real names on the repository object.
    const ghBool = (jqField: string): boolean => run('gh', ['api', 'repos/{owner}/{repo}', '--jq', jqField], root).out.trim() === 'true';

    const autoMergeAllowed = ghBool('.allow_auto_merge');
    if (autoMergeAllowed) say('  = auto-merge already enabled');
    else if (dryRun) say('  + auto-merge enabled');
    else {
      const r = run('gh', ['repo', 'edit', '--enable-auto-merge'], root);
      say(r.ok ? '  + auto-merge enabled' : `  ! auto-merge: ${r.err.split('\n')[0]}`);
    }

    // land.mts's `gh pr merge --auto` does not pass --delete-branch (#66
    // AC0: it fails a local `git branch -D` whenever the branch is checked
    // out in a worktree); only this repository setting deletes the branch
    // once GitHub merges.
    const deleteBranchOnMerge = ghBool('.delete_branch_on_merge');
    if (deleteBranchOnMerge) say('  = delete-branch-on-merge already enabled');
    else if (dryRun) say('  + delete-branch-on-merge enabled');
    else {
      const r = run('gh', ['repo', 'edit', '--delete-branch-on-merge'], root);
      say(r.ok ? '  + delete-branch-on-merge enabled' : `  ! delete-branch-on-merge: ${r.err.split('\n')[0]}`);
    }

    if (dryRun) {
      say(`  + ${LABELS.length}/${LABELS.length} labels present`);
    } else {
      let created = 0;
      for (const [name, color, description] of LABELS) {
        const r = run('gh', ['label', 'create', name, '--color', color, '--description', description, '--force'], root);
        if (r.ok) created++;
        else say(`  ! label ${name}: ${r.err.split('\n')[0]}`);
      }
      say(`  + ${created}/${LABELS.length} labels present`);
    }
    if (milestone) {
      // reading is allowed even in dry-run: it decides whether the report
      // says "=" (exists) or "+" (would be created), without writing.
      const list = run('gh', ['api', 'repos/{owner}/{repo}/milestones', '--jq', '.[].title'], root);
      const exists = list.ok && list.out.split('\n').includes(milestone);
      if (exists) say(`  = milestone "${milestone}" exists`);
      else if (dryRun) say(`  + milestone "${milestone}"`);
      else {
        const r = run('gh', ['api', '-X', 'POST', 'repos/{owner}/{repo}/milestones', '-f', `title=${milestone}`], root);
        say(r.ok ? `  + milestone "${milestone}"` : `  ! milestone: ${r.err.split('\n')[0]}`);
      }
    }

    // 6. branch ruleset (--rules only): updates the ruleset that already
    // governs the default branch — found by its conditions, never by its
    // name (#143) — or creates one named "agentic-setup" when none does.
    // It requires a pull request, resets required_approving_review_count to 0
    // and carries the fetched stale-approval fields through unless
    // --require-review raises them (buildRulesetPayload above), plus
    // the three checks the merge model depends on
    // (docs/decisions.md item 9(a)): scope, negative-control, and this
    // repository's own test workflow's job (detectTestCheckName above); an
    // update keeps every rule, parameter and bypass actor the installer
    // does not manage (buildRulesetPayload above). The reads always happen,
    // even under --dry-run, so the report can tell "+ created" from
    // "= updated" without writing anything; the write itself (POST/PUT) is
    // skipped under --dry-run, same gate as auto-merge/labels/milestone
    // above, and the payload is printed instead. A 403 (rulesets are not
    // available on a private repository on the free plan,
    // docs/decisions.md item 9(a)) is reported plainly instead of gh's raw
    // error either way, and so is a ruleset whose detail cannot be read —
    // which refuses the run rather than guessing (fetchBranchRulesets above).
    if (flags.has('--rules')) {
      // The freeze this flag can cause is worth a line in the report even
      // when the ruleset call itself then fails: a repository whose agents
      // have no second identity (no AGENTIC_REVIEWER_TOKEN anywhere) cannot
      // produce the approving review this flag makes mandatory, so every
      // merge blocks (scripts/land.mts's header, docs/decisions.md item 13).
      if (requireReview && !process.env.AGENTIC_REVIEWER_TOKEN) {
        say('  ! --require-review: AGENTIC_REVIEWER_TOKEN is unset — a single identity cannot approve its own pull request, so every merge freezes until a second reviewing identity exists');
      }
      const reportRulesetError = (err: string): void => {
        say(/403/.test(err) ? '  ! ruleset: not available on this plan for a private repository' : `  ! ruleset: ${err.split('\n')[0]}`);
      };
      const list = run('gh', ['api', 'repos/{owner}/{repo}/rulesets'], root);
      const listed = list.ok ? fetchBranchRulesets(root, list.out) : null;
      // Either read failing stops the run here: acting on a half-read list
      // is how a second ruleset ends up over an already governed branch.
      const refusal = list.ok ? listed?.unreadable ?? null : list.err || 'the rulesets list could not be read';
      if (refusal) {
        reportRulesetError(refusal);
      } else {
        const rulesets = listed?.rulesets ?? [];

        const repoView = run('gh', ['repo', 'view', '--json', 'defaultBranchRef'], root);
        const defaultBranch = parseJson<{ defaultBranchRef?: { name?: string } }>(repoView.out, {})?.defaultBranchRef?.name || 'main';

        // --ruleset-name overrides the choice; otherwise the match is by
        // what the ruleset governs. Several matches are a real state of the
        // world (this repository once had two): the first is updated and
        // the rest are named in the report, never created over.
        const matches = rulesetNameOverride ? rulesets.filter((r) => r.name === rulesetNameOverride) : rulesets.filter((r) => governsDefaultBranch(r, defaultBranch));
        const existing = matches[0] ?? null;
        if (matches.length > 1) {
          const others = matches.slice(1).map((r) => `"${r.name}" (#${r.id})`).join(', ');
          say(`  ! ruleset: ${matches.length} rulesets govern ${defaultBranch}; updating "${existing?.name}" (#${existing?.id}), leaving ${others} alone`);
        }

        const endpoint = existing ? `repos/{owner}/{repo}/rulesets/${existing.id}` : 'repos/{owner}/{repo}/rulesets';
        const method = existing ? 'PUT' : 'POST';
        const outcome = existing ? '  = ruleset updated' : '  + ruleset created';
        const payload = JSON.stringify(
          buildRulesetPayload(existing, defaultBranch, detectTestCheckName(root), rulesetNameOverride ?? DEFAULT_RULESET_NAME, requireReview),
          null,
          2,
        );

        if (dryRun) {
          say(outcome);
          say(`  payload for ${method} ${endpoint}:`);
          for (const line of payload.split('\n')) say(`    ${line}`);
        } else {
          const r = run('gh', ['api', endpoint, '-X', method, '--input', '-'], root, payload);
          if (r.ok) say(outcome);
          else reportRulesetError(r.err);
        }
      }
    }
  }
}

console.log(report.join('\n'));
console.log(`
next, by hand:
  - review \`git status\` and open the bootstrap PR
  - run \`node scripts/init.mts --rules\` to update the branch ruleset that already governs
    your default branch, whatever it is called (\`--ruleset-name <name>\` picks another one
    by name), or to create one when none does: a pull request required, squash as the only
    merge method, scope, negative-control and your test workflow's checks required, and
    force-push and deletion blocked; rules, parameters and bypass actors it does not manage
    are kept. It resets required_approving_review_count to 0 and carries the fetched
    dismiss_stale_reviews_on_push / require_last_push_approval through, so \`--rules\` on its
    own never turns a review gate on and is safe to run at any time. It reports "not available
    on this plan for a private repository" when your plan does not allow rulesets — make
    those three checks required by hand there instead, and keep the pre-push hook as the
    fallback
  - add scope: labels for your repository; set AGENTIC_TEST_CMD in agentic-checks.yml if needed
  - name the invariants in CLAUDE.md — the reviewer checks what it names
  - for a review gate the merging identity cannot satisfy itself: create a machine user or a
    GitHub App installation with pull-request write, then run \`--rules --require-review\`
    (it raises the ruleset's required_approving_review_count to 1, dismisses stale approvals
    and requires the last push approved), and only then store that identity's token as
    AGENTIC_REVIEWER_TOKEN wherever the orchestrator and reviewer run (never in this
    repository). Run \`--require-review\` only after that second identity exists: a
    repository with a single identity cannot produce the approving review it makes
    mandatory, so every merge is frozen until that identity is there. The order of the last
    two steps is the point too: GitHub computes a PR's reviewDecision only where a review is
    actually required, so a token set before the rule exists leaves it null forever and
    land.mts refuses every PR`);
