// The adoption pull request (#167). The earlier steps generate files;
// this one lands them the way this repository requires everything else to
// land — through a pull request the required checks pass on. That is also
// what makes adoption self-verifying: if the generated `scope`,
// `negative-control` and `test` checks cannot go green on the very pull
// request that installs them, the adoption is wrong and says so before
// anyone trusts it.
//
// `planPullRequest(record, options)` answers the branch as a value: every
// file it would carry, which of the two commits each belongs to, the globs
// the body declares and the checks the generated workflow produces — and it
// **writes nothing**, not into the working tree and not into the object
// database. `buildBranch` turns that plan into commits through git's
// plumbing, and `scripts/adopt.mts --pr` is the only thing that pushes them
// and opens the pull request.
//
// **Nothing is ever written into the working tree.** The branch is assembled
// with `hash-object`/`update-index`/`write-tree`/`commit-tree` against a
// temporary index, from the *base tree* rather than from the checkout: the
// repository being adopted is left byte-identical, and an adopter who does
// not like the answer deletes a branch rather than reverting their own files.
// That is also why every comparison here reads the base tree (`baseFile`) and
// never the disk — a file edited but not committed must not make a generated
// file look unchanged.
//
// **Two commits, and the first one is red.** `ci/negative-control.mts` copies
// the test files of the diff onto a checkout of the base and requires that
// run to fail. The branch therefore carries one test under the record's
// `proof.dir` that asserts what adoption generated — absent on the base,
// present at head — committed on its own as `test(red):`, which is also the
// vouch the check reads when a red looks structural. The rest of the
// adoption follows in a second commit.
//
// **What it refuses rather than faking.** The generated test is a `node:test`
// file, so a repository whose stack is not `node` is refused by name
// (`pr:stack-not-supported`) instead of being handed a file its runner would
// never discover — which `negative-control` would report as `no-tests` or
// `vacuous` and nobody would read as the adoption failing. A record with no
// test command is refused the same way (`pr:no-test-command`): there is
// nothing for the deliberate red to be red in.
//
// **The `pre-push` hook cannot ride in a pull request.** Git hooks live under
// the directory git runs hooks from (`.git/hooks` by default), which is not
// tracked and which no diff can carry. `scripts/adopt.mts --hooks` installs
// it in each clone, and the body says so rather than leaving a reader to
// believe the merge protected them.
//
// **Crash policy: fail closed.** Every function either returns the answer or
// throws a named `PrError`. A plan with nothing to commit, a git plumbing
// command that cannot answer and a record this module cannot generate from
// are each a named refusal — never a half-assembled branch, and never a pull
// request that claims to prove something it does not carry.
//
// Node built-ins only.
import { CHECKS_WORKFLOW, MARKER, WORKFLOW_DIR, isGenerated, readTemplates, renderWorkflows, type RenderedWorkflow } from './workflows.mts';
import { SETTINGS_FILE, mergeDeny, readShipped, type DenyMerge, type Shipped } from './hooks.mts';
import { PROOF_DIR, RECORD_FILE, type AdoptionRecord } from './record.mts';

/** The one adoption branch. One per repository, and never force-pushed. */
export const ADOPTION_BRANCH = 'chore/adopt-agentic-setup';

/** Its slug — what `node scripts/proof.mts <slug>` is given. */
export const ADOPTION_SLUG = 'adopt-agentic-setup';

/** The pull request's title, in this repository's conventional-commit shape. */
export const PR_TITLE = 'chore(adopt): install the agentic-setup loop';

/** The only stack whose test runner discovers the generated `node:test` file. */
export const SUPPORTED_STACK = 'node';

/** The two commits the branch carries, in order. The red one is first. */
export const RED_COMMIT = 'test(red): the generated checks are not there yet';
export const ADOPT_COMMIT = 'chore(adopt): the adoption record, the generated workflows and the deny list';

/**
 * The globs the plan issue declares and `ci/scope-check.mts` reads the
 * adoption pull request against. Fixed rather than derived from one
 * repository's report: the plan issue is opened before the record exists, so
 * the globs have to name everything adoption may write, and nothing else.
 */
export const ADOPTION_GLOBS = [RECORD_FILE, `${WORKFLOW_DIR}/**`, SETTINGS_FILE, `${PROOF_DIR}/**`];

/**
 * One issue as the plan search returned it, before anything about it is
 * believed. Every field is optional because this is what GitHub answered, not
 * a shape this repository controls.
 */
export type PlanCandidate = {
  number?: number;
  title?: string;
  state?: unknown;
  labels?: Array<{ name?: string } | string>;
};

/** Every named reason the plan-issue gate can refuse for. */
export type PlanRefusal = 'pr:no-plan-issue' | 'pr:plan-not-decided' | 'pr:plan-ambiguous';

/**
 * The gate's answer: the issue that authorises, or a named refusal carrying
 * the message a person reads and the issue(s) it was about.
 */
export type PlanDecision =
  | { ok: true; issue: number }
  | { ok: false; reason: PlanRefusal; missing: string[]; message: string; issue: number | null; issues: number[] | null };

/** True only for a state this reader recognises as open; everything else is closed. */
const isOpen = (issue: PlanCandidate): boolean => String(issue.state ?? '').toUpperCase() === 'OPEN';

const numbersOf = (issues: PlanCandidate[]): number[] => issues.map((issue) => Number(issue.number)).sort((a, b) => a - b);

/**
 * Which plan issue authorises an adoption pull request, out of everything the
 * search returned.
 *
 * **Two issues can share the title.** `scripts/adopt.mts --plan-issue`
 * deduplicates against *open* issues only, so closing a plan issue and running
 * the documented sequence again leaves a closed one beside an open one — an
 * ordinary state, not an anomaly. `--pr` is the only mode that writes to a
 * remote repository, and reading whichever match the search returned first
 * would not be a gate: a closed `human:decided` issue could authorise the push
 * and put `Closes #<a closed issue>` into the body, a keyword GitHub will not
 * act on, while a closed undecided one could refuse on behalf of a live
 * question that was in fact decided.
 *
 * So the **open** issue is what authorises. It is the live question, and the
 * one `--plan-issue` maintains as unique; a closed issue is a decision already
 * acted on and filed, which is history rather than a standing authorisation.
 * Preference settles the ordinary case. Where it cannot — several open matches,
 * which only a person opening one by hand produces — this refuses by name
 * rather than choosing, because each may carry a different decision.
 *
 * A `state` this reader cannot recognise as open counts as closed: the
 * fail-closed direction, since a state it cannot name must never authorise a
 * push. Pure — it reads the search's answer and nothing else.
 */
export function resolvePlanIssue(plans: PlanCandidate[], title: string, decidedLabel: string): PlanDecision {
  const matches = plans.filter((issue) => issue?.title === title && Number.isInteger(issue?.number));
  const open = matches.filter(isOpen);

  if (open.length > 1) {
    const issues = numbersOf(open);
    return {
      ok: false,
      reason: 'pr:plan-ambiguous',
      missing: ['plan:ambiguous'],
      issue: null,
      issues,
      message:
        `this repository has ${open.length} open \`${title}\` issues (#${issues.join(', #')}), and adoption cannot choose ` +
        'between them: each may carry a different decision, and the one a search happens to return first is not an answer. ' +
        'Close all but the one that holds the decision, then run this again.',
    };
  }

  const planIssue = open[0];
  if (!planIssue) {
    const closed = numbersOf(matches);
    return {
      ok: false,
      reason: 'pr:no-plan-issue',
      missing: ['plan:not-found'],
      issue: null,
      issues: null,
      message:
        closed.length === 0
          ? `there is no \`${title}\` issue in this repository; run \`node scripts/adopt.mts --plan-issue\` and let a person ` +
            'decide what adoption should do before it does any of it.'
          : `every \`${title}\` issue in this repository is closed (#${closed.join(', #')}). A closed plan issue is a decision ` +
            'that was already acted on, not a standing authorisation, and a pull request cannot close one. Run ' +
            '`node scripts/adopt.mts --plan-issue` to ask the question again.',
    };
  }

  const number = Number(planIssue.number);
  const labels = (planIssue.labels ?? []).map((label) => (typeof label === 'string' ? label : (label?.name ?? '')));
  if (!labels.includes(decidedLabel)) {
    return {
      ok: false,
      reason: 'pr:plan-not-decided',
      missing: ['plan:not-decided'],
      issue: number,
      issues: null,
      message:
        `the adoption plan issue (#${number}) does not carry \`${decidedLabel}\`; adoption is not something a script decides ` +
        'for a repository. Read the plan, tick what should happen, and move it to `human:decided`.',
    };
  }
  return { ok: true, issue: number };
}

/** Every named reason this module can refuse to assemble a pull request for. */
export type PrReason =
  | 'pr:stack-not-supported'
  | 'pr:no-test-command'
  | 'pr:nothing-to-commit'
  | 'pr:base-unreadable'
  | 'pr:git-failed';

/**
 * The one way out on a refusal: a named `reason` a caller can branch on, and
 * the `field` it rejected — a record field or a git command — when there is
 * one. The message is for a person; the reason is the contract.
 */
export class PrError extends Error {
  readonly reason: PrReason;
  readonly field: string | null;

  constructor(reason: PrReason, message: string, field: string | null = null) {
    super(message);
    this.name = 'PrError';
    this.reason = reason;
    this.field = field;
  }
}

/** Which of the two commits a planned file belongs to. */
export type CommitName = 'red' | 'adopt';

/** What happens to one file, and why. The same three actions `--workflows` uses. */
export type PlannedFile = {
  /** Where it lands, relative to the adopted repository's root. */
  path: string;
  /** The bytes to commit, or `null` when nothing is written. */
  content: string | null;
  outcome: 'created' | 'updated' | 'skipped';
  reason: string;
  commit: CommitName;
  /** The deny-list report, on the permission file's entry and nowhere else. */
  deny?: DenyMerge;
};

/** What `planPullRequest` answers with; every field is a value, nothing is on disk. */
export type PullRequestPlan = {
  branch: string;
  slug: string;
  files: PlannedFile[];
  /** The globs the body declares, as `ADOPTION_GLOBS`. */
  globs: string[];
  /** The checks the generated workflow produces — one list, as #165 made it. */
  checks: string[];
  /** What `node scripts/proof.mts <slug>` will run, and from where. */
  proof: { slug: string; command: string; source: 'record'; declaration: string };
};

/** Reads one path out of the base tree; `null` when the base does not carry it. */
export type BaseReader = (path: string) => string | null;

/** What `planPullRequest` needs to know about where it is planning. */
export type PlanOptions = {
  /** The adopted repository's root; carried for symmetry with the other planners. */
  root: string;
  /** The base tree's version of a path — never the working tree. */
  baseFile: BaseReader;
  /** The shipped workflow templates; read from disk when they are not supplied. */
  templates?: Record<string, string>;
  /** What this repository ships; read from disk when it is not supplied. */
  shipped?: Shipped;
};

/** The declaration's path for a record, relative to the repository root. */
export function declarationFor(record: AdoptionRecord): string {
  return `${record.proof.dir}/${ADOPTION_SLUG}.json`;
}

/** The deliberate red test's path for a record, relative to the repository root. */
export function proofTestFor(record: AdoptionRecord): string {
  return `${record.proof.dir}/${ADOPTION_SLUG}.test.mjs`;
}

/**
 * The deliberate red. It asserts what adoption generated — the record and the
 * jobs of the generated workflow — so it fails on the base, where none of it
 * exists, and passes at head. Every assertion is a runtime one over a file it
 * reads: nothing here imports a generated module, because a red that is a
 * missing import is `structural` and says only that the file could not run.
 */
export function renderProofTest(record: AdoptionRecord, checks: string[]): string {
  return [
    `// ${MARKER} — the deliberate red of the adoption pull request.`,
    '// It fails on the base, where none of the adoption exists, and passes here.',
    '// `ci/negative-control.mts` copies it onto a checkout of the base and requires',
    '// that run to be red: a pull request whose generated checks cannot prove',
    '// themselves is an adoption nobody should trust. Regenerate it with',
    '// `node scripts/adopt.mts --pr`; it is a normal test file once this is merged.',
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { existsSync, readFileSync } from 'node:fs';",
    '',
    `const RECORD = ${JSON.stringify(RECORD_FILE)};`,
    `const WORKFLOW = ${JSON.stringify(`${WORKFLOW_DIR}/${CHECKS_WORKFLOW}`)};`,
    `const CHECKS = ${JSON.stringify(checks)};`,
    `const TEST_COMMAND = ${JSON.stringify(record.commands.test)};`,
    `const GENERATED_BY = ${JSON.stringify(record.generatedBy)};`,
    '',
    "test('the adoption record every generated step reads is there', () => {",
    '  assert.ok(existsSync(RECORD), RECORD + " is missing: the adoption record is what the generated steps read.");',
    "  const record = JSON.parse(readFileSync(RECORD, 'utf8'));",
    '  assert.equal(record.generatedBy, GENERATED_BY);',
    '  assert.equal(record.commands.test, TEST_COMMAND);',
    '});',
    '',
    "test('the generated workflow runs every check the adoption records', () => {",
    '  assert.ok(existsSync(WORKFLOW), WORKFLOW + " is missing: nothing would run the checks the merge gate requires.");',
    "  const workflow = readFileSync(WORKFLOW, 'utf8');",
    '  for (const name of CHECKS) {',
    '    assert.ok(workflow.includes("\\n  " + name + ":"), WORKFLOW + " declares no `" + name + "` job.");',
    '  }',
    '});',
    '',
  ].join('\n');
}

/**
 * The proof declaration the slug carries: the files that prove this branch,
 * and nothing else. It names no `command`, so `scripts/proof.mts` falls back
 * to the adoption record's `commands.test` — one answer rather than two.
 */
export function renderDeclaration(record: AdoptionRecord): string {
  return `${JSON.stringify(
    {
      describes: 'the checks `node scripts/adopt.mts --pr` generated for this repository, proved by failing without them',
      tests: [proofTestFor(record)],
    },
    null,
    2,
  )}\n`;
}

/** One planned file, decided against the base tree and never against the disk. */
function planFile(path: string, content: string, commit: CommitName, base: string | null): PlannedFile {
  if (base === null) return { path, content, outcome: 'created', reason: 'absent', commit };
  if (base === content) return { path, content: null, outcome: 'skipped', reason: 'unchanged', commit };
  return { path, content, outcome: 'updated', reason: 'regenerated', commit };
}

/** The workflow entries, with the marker keeping a hand-written file safe. */
function planWorkflow(rendered: RenderedWorkflow, base: string | null): PlannedFile {
  const path = `${WORKFLOW_DIR}/${rendered.name}`;
  if (base !== null && !isGenerated(base)) {
    return { path, content: null, outcome: 'skipped', reason: 'not-generated', commit: 'adopt' };
  }
  return planFile(path, rendered.content, 'adopt', base);
}

/** The permission file, merged from the base tree's deny list rather than the disk's. */
function planSettings(base: string | null, shipped: Shipped): PlannedFile {
  let settings: Record<string, unknown> | null = null;
  if (base !== null) {
    try {
      const parsed: unknown = JSON.parse(base);
      settings = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      // A settings file at the base that is not JSON is left exactly as it is:
      // the remedy is to read it, as it is for a hand-written hook.
      return { path: SETTINGS_FILE, content: null, outcome: 'skipped', reason: 'not-parsable', commit: 'adopt' };
    }
  }
  const currentDeny = settings === null ? [] : ((settings.permissions as { deny?: unknown } | undefined)?.deny ?? []);
  // A deny list this module cannot read is one it must not rewrite. Filtering
  // the entries that are not strings and writing the rest back would delete a
  // rule the adopter wrote, silently, in a pull request about adopting a
  // *protection* (#302). It is reported and skipped, like a settings file that
  // is not JSON at all; `scripts/adopt.mts --hooks` refuses on the same shape.
  if (!Array.isArray(currentDeny) || currentDeny.some((rule) => typeof rule !== 'string')) {
    return { path: SETTINGS_FILE, content: null, outcome: 'skipped', reason: 'deny-not-strings', commit: 'adopt' };
  }
  const current = currentDeny as string[];
  const { deny, merge } = mergeDeny(current, shipped.deny);

  if (settings !== null && merge.added.length === 0 && merge.replaced.length === 0) {
    return { path: SETTINGS_FILE, content: null, outcome: 'skipped', reason: 'unchanged', commit: 'adopt', deny: merge };
  }
  const merged = { ...(settings ?? {}), permissions: { ...((settings?.permissions as Record<string, unknown> | undefined) ?? {}), deny } };
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  return settings === null
    ? { path: SETTINGS_FILE, content, outcome: 'created', reason: 'absent', commit: 'adopt', deny: merge }
    : { path: SETTINGS_FILE, content, outcome: 'updated', reason: 'merged', commit: 'adopt', deny: merge };
}

/**
 * The branch an adoption record implies, as a value. Reads the base tree
 * through `options.baseFile` to decide `created` from `updated` from
 * `skipped`, and **writes nothing**: `buildBranch` is what commits, and
 * `scripts/adopt.mts --pr` is what pushes.
 */
export function planPullRequest(record: AdoptionRecord, options: PlanOptions): PullRequestPlan {
  // Refused before a single file is planned: a generated test the adopted
  // repository's runner would never discover proves nothing, and a
  // `negative-control` that reports `no-tests` reads as a pull request that
  // forgot its test rather than as an adoption that cannot be proved here.
  if (record.stack !== SUPPORTED_STACK) {
    throw new PrError(
      'pr:stack-not-supported',
      `the deliberate red is a \`node:test\` file, and this repository's stack is \`${record.stack}\`; its test runner would never discover one. ` +
        'Adopt the generated workflows and hooks by hand, or open the pull request with a test your own runner finds.',
      'stack',
    );
  }
  const command = record.commands.test;
  if (command === null || command.trim() === '') {
    throw new PrError(
      'pr:no-test-command',
      'the adoption record holds no test command, so there is nothing for the deliberate red to be red in. ' +
        'Set AGENTIC_TEST_CMD, or add a test command detection can find, and regenerate the record.',
      'commands.test',
    );
  }

  const shipped = options.shipped ?? readShipped();
  const rendering = renderWorkflows(record, options.templates ?? readTemplates());

  const test = proofTestFor(record);
  const declaration = declarationFor(record);
  const files: PlannedFile[] = [
    // The red first, so the plan reads in the order the commits land.
    planFile(test, renderProofTest(record, rendering.checks), 'red', options.baseFile(test)),
    planFile(declaration, renderDeclaration(record), 'red', options.baseFile(declaration)),
    planFile(RECORD_FILE, `${JSON.stringify(record, null, 2)}\n`, 'adopt', options.baseFile(RECORD_FILE)),
    ...rendering.files.map((rendered) => planWorkflow(rendered, options.baseFile(`${WORKFLOW_DIR}/${rendered.name}`))),
    planSettings(options.baseFile(SETTINGS_FILE), shipped),
  ];

  return {
    branch: ADOPTION_BRANCH,
    slug: ADOPTION_SLUG,
    files,
    globs: [...ADOPTION_GLOBS],
    checks: rendering.checks,
    proof: { slug: ADOPTION_SLUG, command, source: 'record', declaration },
  };
}

/** What one git plumbing call answered. */
export type GitResult = { status: number; stdout: string; stderr: string };

/** A git runner that can be handed stdin and an environment; injected, never imported. */
export type GitRunner = (args: string[], options?: { input?: string; env?: Record<string, string> }) => GitResult;

/** What `buildBranch` needs: a runner, the base commit, and an index of its own. */
export type BuildOptions = {
  git: GitRunner;
  /** The commit the branch is assembled from — the default branch at origin. */
  base: string;
  /** A temporary `GIT_INDEX_FILE`; the repository's own index is never touched. */
  indexFile: string;
};

/** One commit the branch carries: its subject, and the paths it writes. */
export type BuiltCommit = { commit: CommitName; subject: string; sha: string; paths: string[] };

/** What `buildBranch` answers with. `head` is what gets pushed. */
export type Branch = { head: string; commits: BuiltCommit[] };

/** The subject of each commit, in the order they are made. */
const COMMITS: Array<{ commit: CommitName; subject: string }> = [
  { commit: 'red', subject: RED_COMMIT },
  { commit: 'adopt', subject: ADOPT_COMMIT },
];

/** The mode a generated file carries; none of them is executable. */
const FILE_MODE = '100644';

/**
 * The branch's commits, built through git's plumbing against a temporary
 * index. Nothing is checked out, nothing is staged in the repository's own
 * index, and no file is written into the working tree — the only thing that
 * changes is the object database, which a branch that is never pushed leaves
 * unreachable.
 */
export function buildBranch(plan: PullRequestPlan, options: BuildOptions): Branch {
  const env = { GIT_INDEX_FILE: options.indexFile };
  const run = (args: string[], input?: string): string => {
    const r = options.git(args, { env, ...(input === undefined ? {} : { input }) });
    if (r.status !== 0) {
      throw new PrError('pr:git-failed', `git ${args[0]} could not answer: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`, args[0] ?? null);
    }
    return r.stdout.trim();
  };

  const writing = plan.files.filter((file) => file.content !== null);
  if (writing.length === 0) {
    throw new PrError(
      'pr:nothing-to-commit',
      `the base already carries every file this adoption would write; there is nothing to open a pull request about. ` +
        `Delete \`${plan.branch}\` and run again only if the base has moved.`,
    );
  }

  run(['read-tree', options.base]);
  const commits: BuiltCommit[] = [];
  let parent = options.base;

  for (const { commit, subject } of COMMITS) {
    const group = writing.filter((file) => file.commit === commit);
    if (group.length === 0) continue;
    for (const file of group) {
      const blob = run(['hash-object', '-w', '--stdin'], file.content ?? '');
      run(['update-index', '--add', '--cacheinfo', `${FILE_MODE},${blob},${file.path}`]);
    }
    const tree = run(['write-tree']);
    const sha = run(['commit-tree', tree, '-p', parent, '-m', subject]);
    commits.push({ commit, subject, sha, paths: group.map((file) => file.path) });
    parent = sha;
  }

  return { head: parent, commits };
}

/** What `renderBody` needs beyond the plan itself. */
export type BodyContext = {
  /** The plan issue the pull request closes, as a plain-text closing keyword. */
  issue: number;
  /** The branch the pull request is opened against. */
  defaultBranch: string;
  /** Where git runs hooks from is a clone's own answer, so the body names the command. */
  record: AdoptionRecord;
};

/** One bullet per planned file: what happened to it, and why. */
const outcomeLine = (file: PlannedFile): string => `- \`${file.path}\` — ${file.outcome} (${file.reason})`;

/**
 * The pull request's body, in the shape `.github/pull_request_template.md`
 * fixes and `ci/scope-check.mts` reads: the closing keyword in plain text on
 * the first line, `## Files` listing exactly the paths this branch carries,
 * and `## Proof` naming the command `scripts/proof.mts` will run.
 */
export function renderBody(plan: PullRequestPlan, context: BodyContext): string {
  const carried = plan.files.filter((file) => file.content !== null);
  const skipped = plan.files.filter((file) => file.content === null);
  const test = proofTestFor(context.record);
  return [
    `Closes #${context.issue}`,
    '',
    '## What changed',
    '',
    '`node scripts/adopt.mts --pr` assembled this branch. Nothing in it was written by',
    'hand: the adoption record is generated from what this repository has, and the',
    'workflows and the deny list are generated from the record, so the checks the',
    'workflow runs and the checks the merge gate requires are one list rather than two.',
    '',
    carried.map(outcomeLine).join('\n'),
    ...(skipped.length === 0
      ? []
      : ['', 'Left exactly as they are, and not in this diff:', '', skipped.map(outcomeLine).join('\n')]),
    '',
    'The `pre-push` hook is deliberately not here: git hooks live under the directory',
    'git runs hooks from, which is not tracked and which no pull request can carry.',
    'Run `node scripts/adopt.mts --hooks` once in each clone.',
    '',
    '## Proof',
    '',
    `\`node scripts/proof.mts ${plan.slug}\` runs \`${plan.proof.command}\` — the command the`,
    `adoption record holds — over the declaration \`${plan.proof.declaration}\`.`,
    '',
    `This pull request proves itself: \`${test}\` is a deliberate red. It asserts the`,
    `adoption record and the \`${plan.checks.join('`, `')}\` job(s) of the generated`,
    'workflow, so it fails on the base, where none of them exists, and passes here.',
    '`ci/negative-control.mts` copies it onto a checkout of the base and requires that',
    'run to fail; an adoption whose own checks cannot go green is one nobody should',
    'trust. The red is committed on its own, first, as `test(red):`.',
    '',
    // The two checks the generated workflow declares but cannot run *here*,
    // stated the way `skills/init/SKILL.md` states the bootstrap pull
    // request's two reds. `agentic-checks.yml` runs them out of
    // `.github/scripts/agentic/`, which `node scripts/init.mts` copies and
    // this branch does not carry, so they fail on the pull request that
    // introduces them and pass on every one after it (#302).
    '**`scope` and `negative-control` are expected red on this pull request, and only your',
    "own test job is expected green on it.** The generated `agentic-checks.yml` runs them",
    'with `node .github/scripts/agentic/scope-check.mts` and `…/negative-control.mts`, which',
    '`node scripts/init.mts` copies into the repository and this branch does not carry: the',
    'two checks it installs cannot run on the pull request that installs them. Both reds are',
    'correct here — nothing is wrong with the adoption, so do not debug it over them — and',
    'they stop at the first pull request opened after this one is merged. Until then, do not',
    'make them required checks on the default branch, or this pull request cannot land.',
    '',
    '## Files',
    '',
    carried.map((file) => `- \`${file.path}\``).join('\n'),
    '',
    '## Risks',
    '',
    `- The deliberate red is a \`node:test\` file under \`${context.record.proof.dir}/\`. It is discovered by a`,
    `  test command that walks the repository (\`${plan.proof.command}\` here); a runner configured`,
    '  with an explicit list of test paths has to be told about it, or `negative-control`',
    '  will report `no-tests` rather than `pass`.',
    `- \`adopt\` never merges. \`scripts/land.mts\` is the only thing that queues a merge, and`,
    `  it does so against \`${context.defaultBranch}\`'s own rules — review this diff before it lands.`,
    '- Every generated file carries a marker. A file without one was written by a person',
    '  and was skipped rather than overwritten; the list above says which.',
    '',
  ].join('\n');
}
