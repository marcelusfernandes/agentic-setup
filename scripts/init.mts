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
// — reading gh state (auth status, the default branch, milestone listing,
// the rulesets list and each ruleset's detail) still happens so the report
// can say "=" (exists) vs "+" (would be created). The one line a dry run
// does not share with a real run is the --rules payload preview, printed
// only under --dry-run.
//
// Whenever that default branch is neither main nor master the report carries
// one "! default branch is ..." line (#261): the workflow templates, the
// pre-push hook and hooks/protect-main.mts this installer copies are all
// written around main/master, and that assumption is otherwise invisible
// until the first refused push. When the branch cannot be read at all the
// report says that instead, and --rules refuses rather than guessing (#229).
//
// --rules updates the branch ruleset that already governs the repository's
// default branch — the one whose conditions name it, whatever it is called
// (#143: this repository's own is named "main") — or creates one named
// "agentic-setup" when nothing governs it. It requires a pull request,
// squash as the only merge method and the checks the merge model depends on
// (docs/decisions.md item 9(a)), and carries every rule, parameter and
// bypass actor it does not manage over from the ruleset it found.
// `--ruleset-name <name>` picks the ruleset by name instead; it only ever
// updates, so a name matching nothing refuses and lists the rulesets that do
// exist rather than creating a second one under that name (#229). Without
// --rules, no rulesets call is made at all.
//
// Crash policy on this path: every read either produces a ruleset the run can
// act on or refuses with a named "! ruleset: <reason>" line, and a refusal
// makes no POST and no PUT. One read is deliberately outside that rule and
// says so in its own prefix: the adoption record the check *names* are taken
// from (requiredChecks below, #302). A record that cannot be read or rendered
// prints "! check names: <reason>" — not "! ruleset:" — and the write still
// happens, with the historical detected names. It is not a ruleset read: the
// ruleset is still fully known, and refusing to write a protection because a
// repository's optional record is malformed would leave the branch ungoverned
// over a file that is not the installer's business. `adopt` is where a
// rejected record is fatal. It stays a report line and exit 0 — a failed read
// is not a reason to abandon the filesystem work already done, and the report
// is what the operator acts on. The refusals name *what* could not be read,
// because a bare failure out of an installer cannot be told apart from a
// missing token, a missing repository or a network problem, and the operator
// will guess. What refuses: --ruleset-name with no name after it; a default
// branch gh could not read; a rulesets list that is not valid JSON or not a
// JSON array; and a ruleset detail that failed, did not parse, is not a
// ruleset object, or whose rules/bypass_actors is not an array, conditions
// not an object or conditions.ref_name.include not an array. Letting any of
// those through is how a ruleset with no readable conditions comes to look
// like one that governs nothing, and the run POSTs a second ruleset over the
// branch the first already governs — the defect #143 removed and #229 closed
// the remaining entrances to. A 403 (rulesets are not available on a private
// repository on the free plan) is reported plainly instead of gh's raw error,
// and only for a genuine HTTP 403 from a gh call — never by matching those
// digits inside some other message (#229).
//
// A refused *write* is the one departure from that exit 0 (#373). The reads
// above end in a report line and exit 0 because nothing was changed and the
// operator is told why; a POST or PUT GitHub refuses means the protection the
// run was asked for does not exist, so the process exits 1 — after the whole
// report has printed, the filesystem work included, so nothing is hidden by
// the failure. Its "! ruleset:" line keeps every line gh printed, not only
// the first: GitHub's 422 says "gh: Invalid request." first and names the
// property it refused on the next line.
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
// The labels it seeds are not written here: they are the `claude`-routed
// entries of `labels.json` at the plugin root, the one dictionary this
// repository keeps (#145), read through scripts/lib/labels.mts. That read
// happens before the first byte is written, and a malformed dictionary
// refuses the whole run with the reason named — a partial set of labels is
// worse than none.
//
// What it does is listed in skills/init/SKILL.md. Node built-ins only.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labelsSeededByInit, loadLabels, type LabelEntry } from './lib/labels.mts';
import { HOOK_MARKER, SUPERSEDED_DENY_RULES } from './lib/adopt/constants.mts';
import { RECORD_FILE, readRecord, RecordError } from './lib/adopt/record.mts';
import { readTemplates, renderWorkflows, WorkflowError } from './lib/adopt/workflows.mts';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LABELS_FILE = join(PLUGIN, 'labels.json');

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
const rulesetNameValue = rulesetNameIdx === -1 ? null : (process.argv[rulesetNameIdx + 1] ?? null);
// `--ruleset-name` with nothing usable after it — the end of the command
// line, or the next flag — used to become "no override" in silence, and the
// run fell back to matching by conditions with nothing in the report to say
// the operator's choice had been dropped (#229). It is a usage error: the
// ruleset step is refused rather than aimed at a ruleset nobody named.
const rulesetNameMissing = rulesetNameIdx !== -1 && (rulesetNameValue === null || rulesetNameValue.startsWith('--'));
const rulesetNameOverride = rulesetNameMissing ? null : rulesetNameValue;
const requireReview = flags.has('--require-review');
const force = flags.has('--force');
const useGh = !flags.has('--no-gh');
const dryRun = flags.has('--dry-run');

const report: string[] = [];
const say = (line: string): number => report.push(line);
// Set when GitHub refuses the ruleset POST or PUT. The run exits 1 on it,
// but only after the whole report has printed (#373): the rest of the
// install did happen and the operator needs to read it, while an installer
// that leaves the default branch unprotected and answers 0 tells every
// caller the protection is there.
let rulesetWriteRefused = false;
if (dryRun) say('dry run — nothing written');
// --require-review only ever changes the ruleset call --rules makes. Say so
// rather than accept the flag in silence and write nothing it asked for.
if (requireReview && !flags.has('--rules')) {
  say('! --require-review ignored: it raises the ruleset review gate, which only --rules writes');
} else if (requireReview && !useGh) {
  say('! --require-review ignored: --no-gh skips the ruleset call it would change');
}
if (rulesetNameMissing) {
  say('! --ruleset-name: no name follows it; the ruleset step is refused rather than falling back to matching by conditions');
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
/**
 * The checks the ruleset requires, from one place (#302).
 *
 * `scripts/adopt.mts --workflows` renders `agentic-checks.yml` from the
 * adoption record and answers with the job names that file produces; the
 * ruleset must require exactly those, or it can block every merge on a check
 * nothing runs. So when the repository has a record, its rendering is the
 * list. Without one there is nothing to render from, and the historical
 * default stands: the two checks this setup ships, plus whatever the
 * repository's own test workflow calls its job — detection, which invariant 4
 * says is a default and never a contract. A record that is not the shape, or a
 * rendering that refuses, falls back to the same default rather than stopping
 * the run, and says so as `! check names:` — deliberately not the
 * `! ruleset:` prefix this file's header reserves for a refusal that writes
 * nothing, because this one writes. `scripts/adopt.mts` is where a rejected
 * record is fatal.
 */
function requiredChecks(repoRoot: string): string[] {
  try {
    const record = readRecord(repoRoot);
    if (record !== null) return renderWorkflows(record, readTemplates()).checks;
  } catch (err) {
    if (!(err instanceof RecordError) && !(err instanceof WorkflowError)) throw err;
    say(`  ! check names: ${RECORD_FILE} could not be rendered from (${(err as Error).message.split('\n')[0]}); falling back to detection for the check names`);
  }
  return ['scope', 'negative-control', detectTestCheckName(repoRoot)];
}

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
 * A fetch that cannot be read is fatal to the whole run, not to that one
 * ruleset: a summary with no `conditions` reads exactly like a ruleset that
 * governs nothing, so carrying on would take the create path and POST a
 * second ruleset over the branch the unreadable one already governs — the
 * defect #143 exists to remove. `unreadable` carries the message for that
 * refusal; the caller makes no POST or PUT when it is set.
 *
 * That holds for the list itself and not only for a detail (#229). A list
 * that is not valid JSON used to fall back to `[]`, and a list that parsed
 * but was not an array — a `{ "message": ... }` error body, most obviously —
 * used to answer `unreadable: null`, which the caller reads as "nothing to
 * refuse over". Both reached the create path. A read that cannot see the
 * current state must not go on to change it.
 */
function fetchBranchRulesets(repoRoot: string, listOutput: string): { rulesets: Ruleset[]; unreadable: string | null } {
  const summaries = parseJson<unknown>(listOutput, null);
  if (summaries === null) return { rulesets: [], unreadable: 'the rulesets list is not valid JSON' };
  if (!Array.isArray(summaries)) return { rulesets: [], unreadable: 'the rulesets list is not a JSON array' };
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
  const problem = rulesetShapeProblem(parsed as Record<string, unknown>);
  if (problem) return { detail: null, err: problem };
  return { detail: parsed as Partial<Ruleset>, err: '' };
}

/**
 * What makes a parsed detail unusable as a ruleset, or null when every field
 * the run reads has the shape it must (#229). This is where the cast to
 * `Partial<Ruleset>` above stops being a promise the compiler keeps and
 * starts being one the response has to earn, so it is checked here rather
 * than at each use: a detail that fails it is an unreadable detail, refused
 * by the caller exactly like one that never arrived, and everything
 * downstream — `governsDefaultBranch`, `buildRulesetPayload` — may then trust
 * its input.
 *
 * Each field fails differently without this, and only the first is loud. A
 * non-array `rules` throws a TypeError out of the process from `.find` and
 * the spread in `buildRulesetPayload`. A non-array `bypass_actors` and a
 * non-object `conditions` are assigned into the request body, not spread, so
 * they are shipped to the API malformed and the run reports success. A
 * `ref_name.include` that is a string does not throw either: `.includes`
 * substring-matches it, so a ruleset can be "found" by a fragment of a branch
 * name and updated in place of the one that governs the branch.
 */
function rulesetShapeProblem(detail: Record<string, unknown>): string | null {
  const isPlainObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (detail.rules !== undefined && !Array.isArray(detail.rules)) return 'its "rules" is not an array';
  if (detail.bypass_actors !== undefined && !Array.isArray(detail.bypass_actors)) return 'its "bypass_actors" is not an array';
  const conditions = detail.conditions;
  if (conditions === undefined) return null;
  if (!isPlainObject(conditions)) return 'its "conditions" is not an object';
  const refName = (conditions as { ref_name?: unknown }).ref_name;
  if (refName === undefined) return null;
  if (!isPlainObject(refName)) return 'its "conditions.ref_name" is not an object';
  const include = (refName as { include?: unknown }).include;
  if (include !== undefined && !Array.isArray(include)) return 'its "conditions.ref_name.include" is not an array';
  return null;
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
  checks: string[],
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
        // The other two parameters the API documents as required on this
        // rule. They are not part of --require-review's opt-in — that flag
        // owns the three fields above — but the API refuses a create that
        // omits them ("Invalid property /rules/0: data matches no possible
        // input", HTTP 422, #373), and the update path only ever worked
        // because the spread above carried them over from the fetched
        // ruleset. Sent false on a create, fetched value on an update, the
        // way the stale-approval fields beside them are carried.
        require_code_owner_review: fetchedFlag('require_code_owner_review'),
        required_review_thread_resolution: fetchedFlag('required_review_thread_resolution'),
        allowed_merge_methods: ['squash'],
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        ...parametersOf('required_status_checks'),
        required_status_checks: checks.map((context) => ({ context })),
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

/**
 * The labels this route seeds, read from the dictionary before anything is
 * written. Fail closed: a dictionary that cannot be read or does not
 * validate refuses the run, naming the reason, rather than seeding whatever
 * part of it happened to parse.
 */
function labelsToSeed(): LabelEntry[] {
  try {
    return labelsSeededByInit(loadLabels(LABELS_FILE));
  } catch (err) {
    console.error(`init: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
const LABELS = labelsToSeed();

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
//
// This destination is the one path `ci/negative-control.mts` carves out of
// every skipped path class (its NEVER_SKIP_GLOBS, which AGENTIC_SKIP_GLOBS
// cannot put back): the gate's `.github/**` class covers everything under
// `.github/`, so without the carve-out a pull request rewriting the copy of
// the gate written here would be skipped by the gate (#214). Moving this
// destination means moving that glob with it.
say('ci scripts');
copyTree(join(PLUGIN, 'ci'), join(root, '.github', 'scripts', 'agentic'), true);

// 3. permission deny list
//
// `SUPERSEDED_DENY_RULES` (scripts/lib/adopt/constants.mts) is every rule this
// installer has ever seeded, keyed by the wording it was written as. A rule in
// the target's list that this map knows is replaced, not kept beside its
// successor (#204: a repository that ran an older `init` carried the narrower
// `Bash(gh pr merge *--admin*)` forever, next to the `Bash(gh pr merge *)` that
// superseded it). The set is named rather than derived on purpose: "whatever
// the wanted file no longer contains" would also delete rules the adopter
// wrote themselves. It had a second, identical definition here until #302.
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
  const existing: string[] = [...new Set<string>(settings.permissions?.deny ?? [])];
  const stale = existing.filter((rule) => Object.hasOwn(SUPERSEDED_DENY_RULES, rule));
  const kept = existing.filter((rule) => !Object.hasOwn(SUPERSEDED_DENY_RULES, rule));
  const current = new Set(kept);
  const wantedDeny: string[] = [...wanted.permissions.deny, ...stale.map((rule) => SUPERSEDED_DENY_RULES[rule])];
  const added = [...new Set(wantedDeny)].filter((rule) => !current.has(rule));
  const merged = { ...settings, permissions: { ...(settings.permissions ?? {}), deny: [...kept, ...added] } };
  write(() => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  });
  if (stale.length) say(`  ~ ${stale.length} superseded deny rule(s) replaced`);
  say(added.length ? `  + ${added.length} deny rule(s) added` : '  = deny list already complete');
}

// 4. git pre-push
say('git pre-push');
const hooksDir = run('git', ['rev-parse', '--git-path', 'hooks']).out;
const prePush = resolve(root, hooksDir, 'pre-push');
const ours = readFileSync(join(PLUGIN, 'hooks', 'git-pre-push'), 'utf8');
if (existsSync(prePush) && readFileSync(prePush, 'utf8') !== ours && !readFileSync(prePush, 'utf8').includes(HOOK_MARKER) && !force) {
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
    // The repository's real default branch, read once for the whole run:
    // the report line below names it, and --rules matches the ruleset that
    // governs it further down. It is a read, so it happens in --dry-run too.
    //
    // A `repo view` that fails used to fall back to "main" and say nothing,
    // on the grounds that a guess is not a finding worth printing (#229).
    // The guess is the finding: on a repository whose default branch is not
    // main, every governsDefaultBranch test below compares against the wrong
    // ref, nothing matches, and --rules creates a ruleset over a branch that
    // is already governed. So the failure is named, and --rules refuses on it
    // rather than acting on a branch nobody read.
    const repoView = run('gh', ['repo', 'view', '--json', 'defaultBranchRef'], root);
    const defaultBranch = repoView.ok
      ? parseJson<{ defaultBranchRef?: { name?: string } }>(repoView.out, {})?.defaultBranchRef?.name ?? null
      : null;
    const unreadableDefaultBranch = defaultBranch === null
      ? `could not read the default branch: ${repoView.ok ? 'gh answered with no default branch name' : repoView.err.split('\n')[0] || 'gh gave no reason'}`
      : null;
    // #261: everything this installer copies — the workflow templates, the
    // pre-push hook, hooks/protect-main.mts — is written around main/master.
    // On a repository whose default branch is called something else, that
    // assumption stays invisible until the first refused push, so name it at
    // install time instead (dogfood 2026-09-06, finding F2).
    if (unreadableDefaultBranch) {
      say(`  ! ${unreadableDefaultBranch}`);
    } else if (defaultBranch !== 'main' && defaultBranch !== 'master') {
      say(`  ! default branch is "${defaultBranch}", not main or master: the installed workflow templates and hooks/protect-main.mts are written around main/master`);
    }

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
      for (const { name, color, description } of LABELS) {
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
    // (docs/decisions.md item 9(a)): the jobs the generated `agentic-checks.yml`
    // produces when the repository has an adoption record, and scope,
    // negative-control plus the detected test job when it has none
    // (requiredChecks above); an
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
      // A refusal names what could not be read, because an operator who gets
      // a bare failure out of an installer cannot tell a missing token from a
      // missing repository from a network problem, and will guess (#229).
      const refuseRuleset = (reason: string): void => {
        say(`  ! ruleset: ${reason}`);
      };
      // The plan diagnosis is a reading of a *gh call's own* failure, so it
      // takes the call's result and matches its stderr. Matching `403`
      // anywhere in an arbitrary message reported an unreadable ruleset whose
      // id merely contained those digits as a billing problem (#229), which
      // is a different and non-actionable diagnosis.
      const reportGhCallFailure = (r: { err: string }): void => {
        if (/\bHTTP 403\b/.test(r.err)) say('  ! ruleset: not available on this plan for a private repository');
        else refuseRuleset(r.err.split('\n')[0] || 'gh gave no reason');
      };
      // A read's failure is one line: gh's first line is all it has to say
      // about a GET it could not make. A refused write is not — GitHub
      // answers a ruleset POST it will not accept with "gh: Invalid
      // request." and puts the property it refused on the next line, so the
      // first line alone sends the operator hunting for a malformed command
      // instead of the field (#373). Every line gh printed is kept, joined
      // into the one report line, and the run is a failure from here on.
      const reportRefusedWrite = (r: { err: string }): void => {
        rulesetWriteRefused = true;
        if (/\bHTTP 403\b/.test(r.err)) say('  ! ruleset: not available on this plan for a private repository');
        else refuseRuleset(r.err.split('\n').map((l) => l.trim()).filter(Boolean).join(' ') || 'gh gave no reason');
      };

      const list = !rulesetNameMissing && defaultBranch !== null
        ? run('gh', ['api', 'repos/{owner}/{repo}/rulesets'], root)
        : null;
      const listed = list?.ok ? fetchBranchRulesets(root, list.out) : null;
      // Every read this step depends on stops it here when it fails: the
      // flag that says which ruleset to aim at, the default branch the match
      // is made against, the list, and each detail behind it. Acting on a
      // half-read state is how a second ruleset ends up over an already
      // governed branch — the defect #143 removed and #229 closed the rest of.
      if (rulesetNameMissing) {
        refuseRuleset('--ruleset-name was given no name, so no ruleset was read and none was written');
      } else if (defaultBranch === null) {
        refuseRuleset(unreadableDefaultBranch ?? 'could not read the default branch');
      } else if (list && !list.ok) {
        reportGhCallFailure(list);
      } else if (listed?.unreadable) {
        refuseRuleset(listed.unreadable);
      } else {
        const rulesets = listed?.rulesets ?? [];
        const branch = defaultBranch;

        // --ruleset-name overrides the choice; otherwise the match is by
        // what the ruleset governs. Several matches are a real state of the
        // world (this repository once had two): the first is updated and
        // the rest are named in the report, never created over.
        const matches = rulesetNameOverride ? rulesets.filter((r) => r.name === rulesetNameOverride) : rulesets.filter((r) => governsDefaultBranch(r, branch));
        const existing = matches[0] ?? null;
        if (matches.length > 1) {
          const others = matches.slice(1).map((r) => `"${r.name}" (#${r.id})`).join(', ');
          say(`  ! ruleset: ${matches.length} rulesets govern ${branch}; updating "${existing?.name}" (#${existing?.id}), leaving ${others} alone`);
        }

        // An override that matches nothing used to POST a ruleset under that
        // name, over a default branch another ruleset may already govern
        // (#229). The operator asked for one specific ruleset to be updated;
        // creating a second one is not a smaller version of that request. The
        // refusal names the rulesets that do exist, so the next run can name
        // one of them — creating is what the flag's absence asks for.
        if (rulesetNameOverride && matches.length === 0) {
          const known = rulesets.length ? rulesets.map((r) => `"${r.name}" (#${r.id})`).join(', ') : 'none';
          refuseRuleset(
            `no branch ruleset is named "${rulesetNameOverride}"; existing branch rulesets: ${known}. Nothing was created — drop --ruleset-name to match the ruleset by what it governs, or name one of those`,
          );
        } else {
          const endpoint = existing ? `repos/{owner}/{repo}/rulesets/${existing.id}` : 'repos/{owner}/{repo}/rulesets';
          const method = existing ? 'PUT' : 'POST';
          const outcome = existing ? '  = ruleset updated' : '  + ruleset created';
          const payload = JSON.stringify(
            buildRulesetPayload(existing, branch, requiredChecks(root), rulesetNameOverride ?? DEFAULT_RULESET_NAME, requireReview),
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
            else reportRefusedWrite(r);
          }
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
// The report is out; only now does the refused ruleset write become the exit
// code (#373). `exitCode` rather than `exit(1)`: the process ends once the
// two writes above have drained, which `exit` does not wait for.
if (rulesetWriteRefused) process.exitCode = 1;
