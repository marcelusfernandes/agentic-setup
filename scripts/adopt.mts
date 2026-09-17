#!/usr/bin/env node
// adopt — reports what a repository has, and asks before writing anything
// (#162). `scripts/init.mts` writes first and reports afterwards, which is
// the wrong order for a repository that is not yours; this script reverses
// it. Run from inside the repository being looked at.
//
//   node scripts/adopt.mts --inventory
//   node scripts/adopt.mts --plan-issue
//
// `--inventory` prints the report of `scripts/lib/adopt/inventory.mts` as
// JSON on stdout and performs **no write of any kind**: no file is created
// or touched, and the only `gh` calls are reads (`api repos/{owner}/{repo}`,
// the default branch's effective rules, `label list`).
//
// `--plan-issue` is the one mutation, and it is a question rather than a
// change: it opens a single `human:pending` issue whose body renders the
// inventory and lists, as checkboxes, exactly the gaps found and what
// adoption would do about each. The pattern is this repository's own —
// `.github/workflows/guard-main.yml` opens exactly such an issue,
// deduplicated by title — and the three readers that honour the label
// (`scripts/reconcile.mts`, `scripts/claim.mts` and the Codex route's
// `github.mts`) are already in place. A second run never opens a second
// issue: it refuses with `{ refused, reason: 'plan-issue:already-open' }`.
// Nothing here reads or writes an adoption record; that is a later issue,
// behind the owner's decision on invariant 4.
//
// **Crash policy: fail closed.** Any `git` or `gh` read that cannot answer
// prints `{ error: <named reason> }` and exits 1. No field is ever reported
// as absent because the read for it failed — "there is no ruleset" and "the
// ruleset could not be read" are different answers, and a caller acting on
// the first when the second is true would delete a protection it never saw.
// A usage problem is reported the same way, before any call is made.
//
// Node built-ins only.
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../ci/lib/args.mts';
import {
  OWNED_WORKFLOWS,
  SEEDED_LABELS,
  isFailure,
  takeInventory,
  type CommandResult,
  type Gap,
  type Inventory,
} from './lib/adopt/inventory.mts';

const USAGE = 'usage: node scripts/adopt.mts --inventory | --plan-issue';

/** The title the plan issue is deduplicated by; one per repository. */
const PLAN_ISSUE_TITLE = 'Adoption plan: what this repository is missing';

/** The label the plan issue carries, with the colour scripts/init.mts seeds. */
const PENDING_LABEL = 'human:pending';
const PENDING_COLOR = 'f9d0c4';
const PENDING_DESCRIPTION = 'A human decision is required; affected work is paused';

function fail(reason: string): never {
  console.log(JSON.stringify({ error: reason }));
  process.exit(1);
}

function gh(args: string[]): CommandResult {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `git` inside the repository being described; `cwd` is bound in step 2. */
function gitIn(cwd: string) {
  return (args: string[]): CommandResult => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

// --- 1. the flags, before anything is read ----------------------------------
const flags = parseArgs(process.argv.slice(2));
const wantInventory = flags.inventory === true;
const wantPlanIssue = flags['plan-issue'] === true;
if (wantInventory === wantPlanIssue) fail(USAGE);

// --- 2. the repository root -------------------------------------------------
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0 || !(top.stdout ?? '').trim()) fail('root:not-a-git-repository');
const root = top.stdout.trim();

// --- 3. the report ----------------------------------------------------------
const inventory = takeInventory(root, gh, gitIn(root));
if (isFailure(inventory)) fail(inventory.error);

if (wantInventory) {
  console.log(JSON.stringify(inventory));
  process.exit(0);
}

// --- 4. --plan-issue: render the plan ---------------------------------------
const show = (value: string | null): string => (value === null ? 'none' : `\`${value}\``);

/** What adoption would do about each gap, in the gap's own words. */
const REMEDIES: Record<Gap, (report: Inventory) => string> = {
  'ruleset:absent': (r) =>
    `create the \`agentic-setup\` branch ruleset on \`${r.defaultBranch}\` (\`node scripts/init.mts --rules\`), ` +
    'requiring a pull request and the checks the merge gate reads',
  'ruleset:review-not-required': () =>
    "raise the ruleset's `required_approving_review_count` to 1, so an approval is what merges a pull request " +
    'rather than a label anyone can apply',
  'labels:missing': (r) => {
    const missing = SEEDED_LABELS.filter((name) => !r.labels.includes(name));
    return `create the ${missing.length} missing label(s) of the loop's vocabulary (\`${missing.join('`, `')}\`)`;
  },
  'hooks:not-installed': () =>
    `install the \`pre-push\` hook that keeps commits off the default branch (\`node scripts/init.mts\`)`,
  'workflows:missing': (r) => {
    const missing = OWNED_WORKFLOWS.filter((name) => !r.workflows.includes(name));
    return `copy the missing workflow(s) (\`${missing.join('`, `')}\`) into \`.github/workflows\``;
  },
  'test-command:none': () =>
    'set `AGENTIC_TEST_CMD`, or add a test command detection can find — `negative-control` proves nothing without one',
};

function renderPlan(report: Inventory): string {
  const ruleset =
    report.ruleset === null
      ? 'absent'
      : `\`${report.ruleset.rules.join('`, `')}\` — ${report.ruleset.requiredApprovingReviewCount} approving review(s) required`;
  const labelsPresent = SEEDED_LABELS.filter((name) => report.labels.includes(name)).length;
  const workflowsPresent = OWNED_WORKFLOWS.filter((name) => report.workflows.includes(name)).length;
  const has = [
    `- Stack: \`${report.stack}\` (${report.source})`,
    `- Test command: ${show(report.test)}`,
    `- Check command: ${show(report.check)}`,
    `- Default branch: \`${report.defaultBranch}\``,
    `- Ruleset on \`${report.defaultBranch}\`: ${ruleset}`,
    `- Labels: ${labelsPresent}/${SEEDED_LABELS.length} of the loop's vocabulary present`,
    `- Hooks: ${report.hooks.length === 0 ? 'none installed' : `\`${report.hooks.join('`, `')}\``}`,
    `- Workflows: ${workflowsPresent}/${OWNED_WORKFLOWS.length} of the loop's workflows present`,
    `- Auto-merge: ${report.autoMerge ? 'enabled' : 'disabled'}`,
    `- Delete branch on merge: ${report.deleteBranchOnMerge ? 'enabled' : 'disabled'}`,
  ].join('\n');
  const plan =
    report.gaps.length === 0
      ? 'Nothing: this repository already has everything the loop reads.'
      : report.gaps.map((gap) => `- [ ] \`${gap}\` — ${REMEDIES[gap](report)}`).join('\n');
  return [
    'The agent loop reads a repository, it does not assume one. This is what it reads here today;',
    'nothing has been changed to produce it (`node scripts/adopt.mts --inventory`).',
    '',
    '## What this repository has',
    '',
    has,
    '',
    '## What adoption would do',
    '',
    plan,
    '',
    'Tick what should happen, then move this issue to `human:decided`.',
    '',
    '## Inventory',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
  ].join('\n');
}

// --- 5. --plan-issue: refuse when one is already open -----------------------
const search = gh(['issue', 'list', '--search', `"${PLAN_ISSUE_TITLE}" in:title`, '--state', 'open', '--json', 'number,title']);
if (search.status !== 0 || !search.stdout.trim()) fail('plan-issue:unreadable');
let open: Array<{ number?: number; title?: string }>;
try {
  open = JSON.parse(search.stdout);
} catch {
  fail('plan-issue:unreadable');
}
if (!Array.isArray(open)) fail('plan-issue:unreadable');
const already = open.find((issue) => issue?.title === PLAN_ISSUE_TITLE);
if (already) {
  console.log(
    JSON.stringify({
      refused: `an adoption plan issue is already open (#${already.number}); read it, or close it and run again.`,
      reason: 'plan-issue:already-open',
      issue: already.number ?? null,
    }),
  );
  process.exit(1);
}

// --- 6. --plan-issue: the one mutation --------------------------------------
// The label has to exist before it can be applied; the inventory already
// says whether it does, so this costs no extra read.
if (!inventory.labels.includes(PENDING_LABEL)) {
  const label = gh(['label', 'create', PENDING_LABEL, '--color', PENDING_COLOR, '--description', PENDING_DESCRIPTION, '--force']);
  if (label.status !== 0) fail(`label:${PENDING_LABEL}:not-created`);
}

const created = gh(['issue', 'create', '--title', PLAN_ISSUE_TITLE, '--label', PENDING_LABEL, '--body', renderPlan(inventory)]);
if (created.status !== 0) fail((created.stderr || created.stdout || 'plan-issue:not-created').trim().split('\n')[0]);
const url = created.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
const number = Number(url.match(/\/(\d+)\s*$/)?.[1]);
if (!Number.isInteger(number)) fail('plan-issue:unreadable');
console.log(JSON.stringify({ issue: number, url, gaps: inventory.gaps }));
