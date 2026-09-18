#!/usr/bin/env node
// doctor — the read-back the installer never had (#168, parent #160).
// `scripts/init.mts` prints a list of things to do by hand and nothing ever
// read whether any of it happened; this repository merged on a label with no
// binding to the reviewed commit for four milestones and no script said so.
// `scripts/land.mts` refuses at merge time, which is the last possible moment
// and only for what that one call reads. This file asks the same questions
// before there is a pull request to refuse.
//
//   node scripts/doctor.mts [--slug <slug>]
//
// It prints one JSON object on stdout and writes nothing:
//
//   { "ok": …, "mode": "agent" | "approved" | null,
//     "checks": [{ "name", "ok", "found", "expected" }, …],
//     "missing": ["ruleset:required_status_checks", …] }
//
// `missing` names the *field*, never a sentence: one entry per check that is
// false, deduplicated, in the order the checks are printed. Two checks that
// the same fix repairs (a missing record makes the required checks and the
// hooks unknowable) name that one field once, so the output is a list of
// things to do rather than a list of consequences. `docs/adopt.md` documents
// every name and what fixes it.
//
// **It adds no gate.** It reports what is already required: the effective
// rules on the default branch, the label dictionary, the hooks, the adoption
// record, `allow_auto_merge`, and whether a proof can resolve a command.
// `skills/orchestrate/SKILL.md` step 0 runs it once per pass and continues on
// `ok: false` — a fourth reason to stop the loop is not this file's to invent.
//
// **It is read-only, and that is checked rather than claimed.** It makes
// exactly three `gh` reads, all of them through
// `scripts/lib/adopt/inventory.mts`:
//
//   gh api repos/{owner}/{repo}
//   gh api repos/{owner}/{repo}/rules/branches/<default branch>
//   gh label list --json name --limit 200
//
// and two `git` reads (`rev-parse --show-toplevel`, `rev-parse --git-path
// hooks`, plus `--abbrev-ref HEAD` when `--slug` is not given). No `-X`, no
// `-f`, no `gh pr`/`gh issue`/`gh label create`, no write of any kind — not
// even the adoption record it reads. `tests/doctor.test.mts` asserts both
// halves against a fake `gh` that logs every argv it was called with and a
// working tree compared before and after.
//
// **The review mode is read first, because a refusal that cannot name its
// mode says nothing** (`scripts/land.mts` decides it the same way, from the
// same read): a base branch whose effective rules require an approving review
// runs `approved`, everything else runs `agent`. `approved` without a second
// identity in the environment is reported as a freeze risk rather than as
// `ok`, because with `required_approving_review_count: 1` and nobody to cast
// the review, no pull request in that repository can ever be approved — the
// repository freezes at its first merge, and every `land` refuses with no way
// to satisfy it.
//
// **Two judgments, stated so a reviewer can disagree with them explicitly.**
//   1. A record naming no hook at all is a failure (`hooks:not-recorded`),
//      not a vacuous pass. A repository whose record asks for no hook is not
//      a protected repository, and an empty `hooks[]` is the one shape that
//      would let every hook check pass by asking for nothing.
//   2. A repository where no proof command resolves is a failure
//      (`proof:no-command`). Detection answering "no command" is a legitimate
//      *detected* state (#277) — `ci/lib/detect.mts` deliberately says so for
//      a marker-less tree rather than guessing — but a repository that can
//      run no proof cannot satisfy the checks its ruleset requires, and
//      "set AGENTIC_TEST_CMD" is exactly the by-hand step this file exists to
//      read back (#160's last acceptance criterion).
// The deny list `scripts/adopt.mts --hooks` merges is reported inside the
// hooks check's `found` and gates nothing: it is a local permission file, not
// a condition of any merge.
//
// **Crash policy: fail closed.** Exit 0 only on `ok: true`; `ok: false` and
// every usage problem exit 1. Nothing is ever reported as passing because a
// read failed: a `gh` or `git` read that cannot answer becomes that check's
// failure with the named field `read-failed:<what>`, `ok: false` and
// `mode: null` — never the mode left over when a read fails, and never the
// other checks judged on data nobody has. A record that exists and is not
// the shape is reported by the reader's own reason (`record:unknown-key`, …),
// never as absent. A broken installation of *this* plugin — missing
// templates, an unreadable `labels.json`, an unparsable `hooks/hooks.json` —
// throws before the first read of the repository being reported on, because
// it is not a fact about someone else's tree (#233): the templates and the
// shipped hooks are loaded on the first two lines below for that reason.
//
// Node built-ins only (invariant 1); every read of a repository or of this
// plugin's own files goes through the modules #163-#167 left for it.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  isFailure,
  takeInventory,
  SEEDED_LABELS,
  type CommandResult,
  type GhRunner,
  type GitRunner,
  type Inventory,
} from './lib/adopt/inventory.mts';
import { readRecord, staleFields, RecordError, RECORD_FILE, type AdoptionRecord } from './lib/adopt/record.mts';
import { readTemplates, renderWorkflows } from './lib/adopt/workflows.mts';
import { GIT_HOOK, HookError, planHooks, readShipped, DENY_ENTRY } from './lib/adopt/hooks.mts';
import { ProofError, resolveProof, SLUG_PATTERN } from './lib/proof.mts';

const USAGE = 'usage: node scripts/doctor.mts [--slug <slug>]';

/** The env var a second identity lives in, as `agents/reviewer.md` casts its review with. */
const REVIEWER_TOKEN = 'AGENTIC_REVIEWER_TOKEN';

/** A loop branch: `<type>/<n>-<slug>`, the shape `scripts/claim.mts` creates. */
const BRANCH_SHAPE = /^[a-z]+\/\d+-([a-z0-9-]+)$/;

/**
 * The slug the proof is resolved for when HEAD names no branch — a detached
 * checkout. It is a slug no branch of this shape produces, so it declares
 * nothing and resolution starts at the record; `--slug` asks about a real
 * branch instead.
 */
const NO_BRANCH_SLUG = 'no-branch';

/** One check: what it looked at, what it found, and what it wanted. */
type Check = {
  name: string;
  ok: boolean;
  /** What the repository actually says, in one line. */
  found: string;
  /** What would have made it `ok`, in one line. */
  expected: string;
  /** The field to name in `missing`; `null` on a check that passed. */
  field: string | null;
};

/** The review binding a repository runs, as `scripts/land.mts` names them. */
type Mode = 'agent' | 'approved';

// --- 0. this plugin's own files, before anything else ------------------------
// A broken installation of agentic-setup is not a fact about the repository
// being reported on, so it throws here rather than becoming one of its checks
// (`scripts/lib/adopt/inventory.mts` does the same with its two lists).
const TEMPLATES = readTemplates();
const SHIPPED = readShipped();

/** Prints the object and exits with the code its own `ok` implies. */
function print(shape: Record<string, unknown>, ok: boolean): never {
  console.log(JSON.stringify(shape));
  process.exit(ok ? 0 : 1);
}

/** A usage problem: named, printed, and nothing read. */
function fail(error: string): never {
  console.log(JSON.stringify({ error }));
  process.exit(1);
}

/** The report: the checks, the fields they name, and the exit code. */
function report(mode: Mode | null, checks: Check[]): never {
  const missing: string[] = [];
  for (const entry of checks) {
    if (entry.ok || entry.field === null) continue;
    if (!missing.includes(entry.field)) missing.push(entry.field);
  }
  const ok = checks.every((entry) => entry.ok);
  print(
    {
      ok,
      mode,
      checks: checks.map(({ name, ok: passed, found, expected }) => ({ name, ok: passed, found, expected })),
      missing,
    },
    ok,
  );
}

/** A check that holds. */
const held = (name: string, found: string, expected: string): Check => ({ name, ok: true, found, expected, field: null });

/** A check that does not, and the field that names its fix. */
const broken = (name: string, field: string, found: string, expected: string): Check => ({ name, ok: false, found, expected, field });

// --- 1. the arguments, before anything is read -------------------------------
const argv = process.argv.slice(2);
let slugArg: string | null = null;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i] as string;
  if (arg !== '--slug') fail(USAGE);
  const value = argv[i + 1];
  if (value === undefined || !SLUG_PATTERN.test(value)) fail(`${USAGE} — \`--slug\` takes a branch slug (${String(SLUG_PATTERN)})`);
  slugArg = value;
  i += 1;
}

// --- 2. the repository ---------------------------------------------------------
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0 || !top.stdout.trim()) fail('root:not-a-git-repository');
const root = top.stdout.trim();

/** One command, run inside the repository being reported on. */
function run(command: string, args: string[]): CommandResult {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const gh: GhRunner = (args) => run('gh', args);
const gitRunner: GitRunner = (args) => run('git', args);

/** The slug the proof is resolved for: the flag, the branch, or neither. */
function slugOf(): string {
  if (slugArg !== null) return slugArg;
  const head = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const named = BRANCH_SHAPE.exec(head);
  if (named) return named[1] as string;
  return SLUG_PATTERN.test(head) ? head : NO_BRANCH_SLUG;
}

// --- 3. the reads --------------------------------------------------------------
// One inventory: the three `gh` reads and the filesystem, already fail-closed.
// A read that cannot answer is that read's own check and nothing else — the
// remaining checks would be judged on data nobody has, and reporting them as
// passing is exactly what this file exists to prevent.
const inventory = takeInventory(root, gh, gitRunner);
if (isFailure(inventory)) {
  const what = inventory.error.split(':')[0] as string;
  report(null, [
    broken(
      what,
      `read-failed:${what}`,
      `the ${what} read could not answer (${inventory.error})`,
      `a readable ${what}: check that \`gh\` is authenticated for this repository and run again`,
    ),
  ]);
}

const facts: Inventory = inventory;

// --- 4. the adoption record ----------------------------------------------------
// Read once, and its own check; every later check that needs it names the
// same field, so a record-less repository gets one fix instead of a list.
let record: AdoptionRecord | null = null;
let recordCheck: Check;
try {
  record = readRecord(root);
  if (record === null) {
    recordCheck = broken(
      'record',
      'record:absent',
      `${RECORD_FILE} is not there`,
      `${RECORD_FILE}, written by \`node scripts/adopt.mts --record\``,
    );
  } else {
    const stale = staleFields(record, { stack: facts.stack, test: facts.test, check: facts.check });
    recordCheck =
      stale.length === 0
        ? held('record', `${RECORD_FILE} pins stack ${record.stack}, generated by ${record.generatedBy}`, `${RECORD_FILE} agreeing with detection`)
        : broken(
            'record',
            'record:stale',
            `${RECORD_FILE} disagrees with detection at ${stale.join(', ')}`,
            `${RECORD_FILE} agreeing with detection; rewrite it with \`node scripts/adopt.mts --record\``,
          );
  }
} catch (err) {
  if (!(err instanceof RecordError)) throw err;
  recordCheck = broken('record', err.reason, `${RECORD_FILE} was rejected: ${err.message}`, `a ${RECORD_FILE} of the shape its reader knows`);
}

/** The field a check that needs the record names when there is none to read. */
const recordField: string | null = recordCheck.ok ? null : recordCheck.field;

/** A check that cannot be judged because the record could not be: the record's own field. */
const needsRecord = (name: string, expected: string): Check =>
  broken(name, recordField as string, `unknown: ${RECORD_FILE} could not be read, so this cannot be judged`, expected);

// --- 5. the review mode --------------------------------------------------------
const mode: Mode = facts.ruleset !== null && facts.ruleset.requiredApprovingReviewCount > 0 ? 'approved' : 'agent';
const secondIdentity = typeof process.env[REVIEWER_TOKEN] === 'string' && process.env[REVIEWER_TOKEN] !== '';
const modeCheck: Check =
  mode === 'agent' || secondIdentity
    ? held(
        'review-mode',
        mode === 'agent' ? 'mode agent: the review is the label and the reviewed-SHA marker' : `mode approved: ${REVIEWER_TOKEN} is set`,
        `mode agent, or mode approved with ${REVIEWER_TOKEN} set`,
      )
    : broken(
        'review-mode',
        'review:no-second-identity',
        `mode approved (required_approving_review_count=${facts.ruleset?.requiredApprovingReviewCount ?? 0}) and no ${REVIEWER_TOKEN}`,
        `${REVIEWER_TOKEN} for a second identity, or \`node scripts/init.mts --rules\`, which resets the count to 0`,
      );

// --- 6. the effective ruleset --------------------------------------------------
const rulesetCheck: Check =
  facts.ruleset === null
    ? broken(
        'ruleset',
        'ruleset:absent',
        `the default branch ${facts.defaultBranch} has no effective rules`,
        'a ruleset on the default branch, from `node scripts/init.mts --rules`',
      )
    : held('ruleset', `${facts.defaultBranch} is governed by ${facts.ruleset.rules.join(', ')}`, 'effective rules on the default branch');

// --- 7. the required status checks ---------------------------------------------
// The generated checks are computed from the record by the same function
// `scripts/adopt.mts --workflows` writes the workflow with (#165), so the
// list the ruleset is compared against is the list those files produce.
function requiredChecks(): Check {
  const expected = 'every check the generated `agentic-checks.yml` produces, required on the default branch';
  if (record === null) return needsRecord('required-checks', expected);
  const generated = renderWorkflows(record, TEMPLATES).checks;
  const wanted = `required: ${generated.join(', ')}`;
  if (facts.ruleset === null) {
    return broken('required-checks', 'ruleset:absent', `the default branch ${facts.defaultBranch} requires no check at all`, wanted);
  }
  const absent = generated.filter((name) => !facts.ruleset?.requiredStatusChecks.includes(name));
  if (absent.length > 0) {
    const found = facts.ruleset.requiredStatusChecks.length === 0 ? 'the ruleset has no required_status_checks rule' : `the ruleset requires ${facts.ruleset.requiredStatusChecks.join(', ')}`;
    return broken('required-checks', 'ruleset:required_status_checks', `${found}, and not ${absent.join(', ')}`, wanted);
  }
  return held('required-checks', `the ruleset requires ${facts.ruleset.requiredStatusChecks.join(', ')}`, wanted);
}

// --- 8. the label dictionary ----------------------------------------------------
// `SEEDED_LABELS` is derived from `labels.json` through the same module
// `scripts/init.mts` seeds from, so the installer and this report cannot
// disagree about what a complete repository has.
function labelCheck(): Check {
  const expected = `every label the dictionary seeds: ${SEEDED_LABELS.join(', ')}`;
  const absent = SEEDED_LABELS.filter((name) => !facts.labels.includes(name));
  // A label page that came back full may be hiding more, which makes an
  // absence a guess drawn from a page; the report says so rather than letting
  // the reader infer it.
  const page = facts.labelsTruncated ? ' (the label read filled its page, so it may not have seen them all)' : '';
  if (absent.length === 0) return held('labels', `all ${SEEDED_LABELS.length} seeded labels are there${page}`, expected);
  return broken('labels', 'labels:missing', `${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not in this repository${page}`, expected);
}

// --- 9. the hooks the record names ----------------------------------------------
function hookCheck(): Check {
  const expected = `the \`${GIT_HOOK}\` hook this setup ships, installed and unedited, and named by the record`;
  if (record === null) return needsRecord('hooks', expected);
  const path = gitRunner(['rev-parse', '--git-path', 'hooks']);
  if (path.status !== 0 || path.stdout.trim() === '') {
    return broken('hooks', 'read-failed:hooks', 'git could not say where it runs hooks from', expected);
  }
  let entries;
  try {
    entries = planHooks(record, { root, hooksDir: resolve(root, path.stdout.trim()), shipped: SHIPPED }).entries;
  } catch (err) {
    if (!(err instanceof HookError)) throw err;
    return broken('hooks', err.reason, err.message, expected);
  }
  const hook = entries.find((entry) => entry.hook === GIT_HOOK);
  const deny = entries.find((entry) => entry.hook === DENY_ENTRY);
  const denyNote = deny ? `; the deny list would be ${deny.action}d (${deny.reason})` : '';
  // `planHooks` writes nothing; every action other than "already what we
  // would install" is a different repository with a different fix, so each
  // one gets its own field rather than one "hooks" verdict.
  const field =
    hook === undefined
      ? 'hooks:not-installed'
      : hook.reason === 'not-recorded'
        ? 'hooks:not-recorded'
        : hook.reason === 'absent'
          ? 'hooks:not-installed'
          : hook.reason === 'not-ours'
            ? 'hooks:not-ours'
            : hook.reason === 'unchanged'
              ? null
              : 'hooks:drifted';
  const found = hook === undefined ? `no plan entry for \`${GIT_HOOK}\`` : `\`${GIT_HOOK}\`: ${hook.reason}${denyNote}`;
  return field === null ? held('hooks', found, expected) : broken('hooks', field, found, expected);
}

// --- 10. auto-merge --------------------------------------------------------------
// `land.mts` queues `gh pr merge --squash --auto`, which the server refuses
// outright when the repository does not allow auto-merge.
const autoMergeCheck: Check = facts.autoMerge
  ? held('auto-merge', 'allow_auto_merge is on', 'allow_auto_merge on, so `land.mts` can queue a merge')
  : broken(
      'auto-merge',
      'repository:allow_auto_merge',
      'allow_auto_merge is off, so every `land.mts` queue is refused by the server',
      'allow_auto_merge on; `node scripts/init.mts` turns it on',
    );

// --- 11. the proof ----------------------------------------------------------------
function proofCheck(): Check {
  const slug = slugOf();
  const expected = `a command for \`${slug}\`, from its declaration, the record's \`commands.test\`, or detection`;
  try {
    const resolved = resolveProof(root, slug);
    return held('proof', `slug=${slug} source=${resolved.source} command=${resolved.command}`, expected);
  } catch (err) {
    // A record the resolver rejected is the record's own failure, named once:
    // it is read there too, and one file has one fix.
    if (err instanceof RecordError) return needsRecord('proof', expected);
    if (err instanceof ProofError) return broken('proof', err.reason, `slug=${slug}: ${err.message}`, expected);
    throw err;
  }
}

report(mode, [modeCheck, recordCheck, rulesetCheck, requiredChecks(), labelCheck(), hookCheck(), autoMergeCheck, proofCheck()]);
