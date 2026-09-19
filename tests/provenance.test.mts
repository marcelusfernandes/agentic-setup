#!/usr/bin/env node
// Cases for the milestone closeout format and its provenance pin (#170).
//
// `docs/closeout/M<n>.md` is the only record a finished milestone leaves --
// `scripts/reconcile.mts` recomputes the loop's state and never persists it --
// so the record has to be checked mechanically or it rots. This file is that
// check, and it runs inside the already-required `test` job: it parses every
// `docs/closeout/M*.md` against the one format `docs/closeout/TEMPLATE.md`
// fixes, and fails when a row names a merge commit that is not reachable from
// `main` or an issue that is still open.
//
// Crash policy: this file never throws on a missing or malformed closeout --
// every refusal is an assertion failure with the offending file named, so the
// red reads as "the record is wrong", not "the checker could not run".
//
// There is no script to spawn: the pin is the test (invariant 6 -- nothing
// under ci/, hooks/ or scripts/ implements it), so the parser and the auditor
// live here and both the real tree and the synthetic repositories below go
// through the same two functions.
//
// GitHub is a controlled `gh` fixture (a bash script first on PATH) for every
// issue-closed case, the real tree's rows included. Nothing here calls the
// live API unless it is asked to: set `AGENTIC_PROVENANCE_LIVE_GH=1` and the
// real tree's check runs against the `gh` on PATH; unset, it is skipped with a
// note naming the variable. Ancestry is never opportunistic; it needs no
// credentials, only history, hence `fetch-depth: 0` in test.yml.
//
// That default is #356: the check used to shell out once per row of every
// closeout -- 129 calls per run -- to a shared quota, and exhausting it failed
// this file as `docs/closeout/M*.md is clean`, naming a file when the cause was
// an HTTP status elsewhere. `docs/closeout/README.md` carries the rest, and the
// cases below hold it to it.
//
// Third fail-open, with the other two below: with the opt-in set, a `gh` that
// cannot answer -- a rate limit, a 5xx, no network -- is a note per row, not a
// failure; a number that resolves to nothing stays red. `classifyGhFailure`
// tells them apart, since the CLI gives both the same exit and stderr shape.
//
// One more fail-open, stated here so it is not discovered in a log: the
// shallow-checkout case below needs `git clone --depth 1` to work in the
// environment running the suite. Where it does not (no file:// transport, a
// sandbox that refuses the clone), that one case skips itself with a note on
// stderr rather than failing -- the environment could not run it, which is not
// the same as the pin being wrong. Every other case builds its repository with
// plain `git init` and never skips.
//
// Negative control: the TEMPLATE, README and workflow cases below assert on
// files outside this one, so prose or format this file pins and the base does
// not carry is a red the overlay reproduces. The synthetic cases carry their
// own parser and repositories, so they prove the parser, not the base.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, git, ROOT, tempRepo } from './lib/harness.mts';

// --- the format ------------------------------------------------------------
// One grammar, restated in docs/closeout/README.md for scripts/close-milestone.mts
// (#172), which re-parses these files and cannot import from tests/.
const HEADING = /^# Closeout M(\d+|<n>) — (.+)$/;
const META_DATE = /^- Closed \(UTC\): (.+)$/;
const META_SHA = /^- main SHA: (.+)$/;
const PLACEHOLDER = /^<[^<>]+>$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{40}$/;
const ISSUE = /^#(\d+)$/;
const DELIMITER = /^:?-{3,}:?$/;
const TABLE_HEADER = ['issue', 'title', 'PR', 'merge commit'];
const SECTIONS = ['## Issues', '## Left out', '## Dogfood'];

/**
 * The refusal for two rows that are not in ascending issue order, naming both.
 * Exported with the two pin messages below so a case -- here or in another
 * file -- asserts on the one string instead of retyping it and drifting.
 */
export function outOfOrderMessage(before: number, after: number): string {
  return `rows must be in ascending issue order: #${before} is listed before #${after}`;
}

type Row = { issue: number; title: string; pr: number; sha: string };
type Parsed = {
  errors: string[];
  empty: boolean;
  milestone: string;
  title: string;
  date: string;
  sha: string;
  rows: Row[];
};

/** Splits one markdown table line into trimmed cells, or null if it is not one. */
function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null;
  return t.slice(1, -1).split('|').map((c) => c.trim());
}

/** True when every field of the document is an unfilled `<...>` placeholder. */
function allPlaceholders(p: Pick<Parsed, 'milestone' | 'title' | 'date' | 'sha'>): boolean {
  return [p.milestone, p.title, p.date, p.sha].every((v) => PLACEHOLDER.test(v));
}

/** True when no field of the document is a placeholder. */
function noPlaceholders(p: Pick<Parsed, 'milestone' | 'title' | 'date' | 'sha'>): boolean {
  return [p.milestone, p.title, p.date, p.sha].every((v) => !PLACEHOLDER.test(v));
}

/**
 * Parses one closeout document. Collects every format error instead of
 * throwing on the first, so a malformed file reports all of what is wrong.
 * HTML comments are stripped first, so a commented-out row is not a row.
 */
function parseCloseout(raw: string): Parsed {
  const errors: string[] = [];
  const lines = raw.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out: Parsed = { errors, empty: false, milestone: '', title: '', date: '', sha: '', rows: [] };

  const headingIndex = lines.findIndex((l) => l.trim() !== '');
  const heading = headingIndex === -1 ? '' : lines[headingIndex].trim();
  const h = HEADING.exec(heading);
  if (!h) {
    errors.push('first line must be `# Closeout M<n> — <milestone title>`');
  } else {
    out.milestone = h[1];
    out.title = h[2].trim();
  }

  // The three sections, each exactly once and in order.
  const at: number[] = [];
  for (const section of SECTIONS) {
    const found = lines.map((l, i) => (l.trim() === section ? i : -1)).filter((i) => i !== -1);
    if (found.length !== 1) errors.push(`\`${section}\` must appear exactly once (found ${found.length})`);
    at.push(found[0] ?? -1);
  }
  if (at.every((i) => i !== -1) && !(at[0] < at[1] && at[1] < at[2])) {
    errors.push(`sections must be in the order ${SECTIONS.join(', ')}`);
  }
  if (at.some((i) => i === -1)) return out;

  // The two metadata bullets, the only bullets between the heading and `## Issues`.
  const meta = lines.slice(headingIndex + 1, at[0]).filter((l) => l.trim().startsWith('- '));
  if (meta.length !== 2) {
    errors.push(`expected exactly 2 metadata bullets before \`## Issues\`, found ${meta.length}`);
  } else {
    const d = META_DATE.exec(meta[0].trim());
    const s = META_SHA.exec(meta[1].trim());
    if (!d) errors.push('the first metadata bullet must be `- Closed (UTC): <YYYY-MM-DD>`');
    else {
      out.date = d[1].trim();
      if (!DATE.test(out.date) && !PLACEHOLDER.test(out.date)) errors.push(`\`Closed (UTC)\` is not a YYYY-MM-DD date: ${out.date}`);
    }
    if (!s) errors.push('the second metadata bullet must be `- main SHA: <40-character sha>`');
    else {
      out.sha = s[1].trim();
      if (!SHA.test(out.sha) && !PLACEHOLDER.test(out.sha)) errors.push(`\`main SHA\` is not a 40-character sha: ${out.sha}`);
    }
  }

  // The issue table: header, delimiter, then zero or more rows.
  const table = lines.slice(at[0] + 1, at[1]).filter((l) => l.trim() !== '');
  const header = table.length > 0 ? cells(table[0]) : null;
  const delimiter = table.length > 1 ? cells(table[1]) : null;
  if (!header || header.join('|') !== TABLE_HEADER.join('|')) {
    errors.push(`the \`## Issues\` table header must be \`| ${TABLE_HEADER.join(' | ')} |\``);
  } else if (!delimiter || delimiter.length !== TABLE_HEADER.length || !delimiter.every((c) => DELIMITER.test(c))) {
    errors.push('the `## Issues` table header must be followed by a delimiter row');
  } else {
    for (const line of table.slice(2)) {
      const c = cells(line);
      if (!c || c.length !== TABLE_HEADER.length) {
        errors.push(`row is not \`| #N | title | #PR | <sha> |\`: ${line.trim()}`);
        continue;
      }
      const [issue, title, pr, sha] = c;
      const i = ISSUE.exec(issue);
      const p = ISSUE.exec(pr);
      if (!i) errors.push(`row issue cell must be \`#N\`: ${issue}`);
      if (title === '') errors.push(`row title cell is empty: ${line.trim()}`);
      if (!p) errors.push(`row PR cell must be \`#N\`: ${pr}`);
      if (!SHA.test(sha)) errors.push(`row merge commit cell must be a 40-character sha: ${sha}`);
      if (i && p && title !== '' && SHA.test(sha)) out.rows.push({ issue: Number(i[1]), title, pr: Number(p[1]), sha });
    }
    // "One row per issue, in issue order" (docs/closeout/README.md and
    // TEMPLATE.md): strictly ascending, so a repeated issue fails too.
    for (let i = 1; i < out.rows.length; i++) {
      const before = out.rows[i - 1].issue;
      const after = out.rows[i].issue;
      if (after <= before) errors.push(outOfOrderMessage(before, after));
    }
  }

  // Both prose sections carry at least one bullet; "none" is written out, not omitted.
  const leftOut = lines.slice(at[1] + 1, at[2]).filter((l) => l.trim().startsWith('- '));
  const dogfood = lines.slice(at[2] + 1).filter((l) => l.trim().startsWith('- '));
  if (leftOut.length === 0) errors.push('`## Left out` needs at least one bullet (`- None — <why>` when nothing was left out)');
  if (dogfood.length === 0) errors.push('`## Dogfood` needs at least one bullet (`- None needed — <why>` when no report was)');

  // Empty (the template) or filled, never half of each.
  const empty = allPlaceholders(out) && out.rows.length === 0;
  const filled = noPlaceholders(out) && out.rows.length > 0;
  if (!empty && !filled && errors.length === 0) {
    errors.push('a closeout is either the empty template (every field a `<...>` placeholder, no rows) or filled in (no placeholder, at least one row)');
  }
  out.empty = empty;
  return out;
}

// --- the pin ---------------------------------------------------------------
type Env = Record<string, string | undefined>;
type Audit = { errors: string[]; notes: string[]; files: string[] };

/** The pin's refusal for an `M<n>.md` still left as the template; `audit` prefixes the filename. */
export const EMPTY_TEMPLATE_MESSAGE = "still the empty template — a milestone's closeout must be filled in";
/** The pin's note when there is no closeout file to check at all. */
export const NO_CLOSEOUT_MESSAGE = 'no docs/closeout/M<n>.md yet — the provenance pin has nothing to check';

// --- the issue-closed check's source ---------------------------------------
// The one half of this pin that needs an answer from outside the checkout:
// ancestry is git, and git is here, but whether #123 is closed is not. Since
// #356 that answer is a value, chosen once and passed in, so the default run
// asks nothing and the synthetic cases below keep the controlled fixture they
// already had.

/** The environment variable that opts the real tree back into a live `gh`. */
export const LIVE_GH_ENV = 'AGENTIC_PROVENANCE_LIVE_GH';
/** The note the default (offline) source leaves, once, naming the opt-in. */
export const OFFLINE_MESSAGE =
  `the issue-closed check was skipped — it asks GitHub, and the required suite does not: set ${LIVE_GH_ENV}=1 to run it`;
/** The note a `gh` that cannot authenticate leaves, once. */
export const UNAUTHENTICATED_MESSAGE = 'gh is absent or unauthenticated — the issue-closed check was skipped';

/**
 * What one issue lookup can answer, and the distinction that is the point of
 * #356: `state` is the record being checked, `no-such-issue` is the record
 * being wrong, and `unavailable` is the API declining to answer — which says
 * nothing about the record and must never be reported as if it did. `gh` gives
 * the last two the same shape (exit 1, one `GraphQL: ...` line on stderr).
 */
type IssueLookup =
  | { kind: 'state'; state: string }
  | { kind: 'no-such-issue'; detail: string }
  | { kind: 'unavailable'; detail: string };

/** Either a working lookup, or the whole check skipped once with a reason. */
type IssueSource =
  | { kind: 'lookup'; lookup: (issue: number) => IssueLookup }
  | { kind: 'skipped'; reason: string };

/**
 * `gh`'s wording when a number resolves to nothing, taken from the real CLI:
 * `GraphQL: Could not resolve to an issue or pull request with the number of
 * N. (repository.issue)`. Everything else it can fail with — a rate limit, a
 * 5xx, no network, a timeout — is the API declining to answer, so this is a
 * list of one and the default is `unavailable`: a wording that drifts costs a
 * skip, never a false red naming a closeout file.
 */
const NO_SUCH_ISSUE = /could not resolve to an? (issue|pull ?request)/i;

/** Reads one failed `gh issue view` and says which of the two failures it is. */
export function classifyGhFailure(stderr: string): { kind: 'no-such-issue' | 'unavailable'; detail: string } {
  const detail = stderr.trim().split('\n')[0] || 'no output';
  return { kind: NO_SUCH_ISSUE.test(stderr) ? 'no-such-issue' : 'unavailable', detail };
}

/** A source that answers nothing and says why, without spawning anything. */
const skippedIssueSource = (reason: string): IssueSource => ({ kind: 'skipped', reason });

/**
 * A source backed by whatever `gh` is on PATH — the controlled fixture in the
 * synthetic cases below, the real CLI only where the opt-in asked for it. The
 * `gh auth status` probe happens here, so a skipped source spawns nothing.
 */
function ghIssueSource(repo: string, env: Env): IssueSource {
  if (run('gh', ['auth', 'status'], repo, env).status !== 0) return skippedIssueSource(UNAUTHENTICATED_MESSAGE);
  return {
    kind: 'lookup',
    lookup: (issue: number): IssueLookup => {
      const r = run('gh', ['issue', 'view', String(issue), '--json', 'state'], repo, env);
      if (r.status !== 0) return classifyGhFailure(r.stderr);
      try {
        return { kind: 'state', state: String(JSON.parse(r.stdout).state ?? '') };
      } catch {
        // An exit of 0 carrying no JSON is the CLI failing to answer, not the
        // record failing: `unavailable`, like a rate limit.
        return { kind: 'unavailable', detail: 'gh exited 0 but returned no JSON state' };
      }
    },
  };
}

/** The source the real tree gets: offline unless `LIVE_GH_ENV` asks otherwise. */
export function issueSourceFor(repo: string, env: Env): IssueSource {
  if ((env[LIVE_GH_ENV] ?? '') !== '1') return skippedIssueSource(OFFLINE_MESSAGE);
  return ghIssueSource(repo, env);
}

/** Runs git in a repository without throwing: returns its status and output. */
function run(cmd: string, args: string[], cwd: string, env: Env) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env as NodeJS.ProcessEnv });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The first of origin/main, main, HEAD that resolves to a commit here. */
function resolveMainRef(repo: string, env: Env): string | null {
  for (const ref of ['origin/main', 'main', 'HEAD']) {
    if (run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo, env).status === 0) return ref;
  }
  return null;
}

/** ancestor | not-ancestor | unknown (the sha is not a commit in this repository). */
function ancestry(repo: string, sha: string, ref: string, env: Env): 'ancestor' | 'not-ancestor' | 'unknown' {
  const r = run('git', ['merge-base', '--is-ancestor', sha, ref], repo, env);
  if (r.status === 0) return 'ancestor';
  if (r.status === 1) return 'not-ancestor';
  return 'unknown';
}

/**
 * Reads every docs/closeout/M<n>.md under repo and reports what does not hold.
 * Errors fail the build; notes say what could not be checked and why.
 *
 * `issues` is where the issue-closed half gets its answers. Left out, it is a
 * `gh` on PATH — the controlled fixture for every synthetic case below, which
 * is why they read unchanged. The real tree passes one explicitly (#356),
 * because there `gh` would be the live CLI.
 */
function audit(repo: string, env: Env = process.env, issues?: IssueSource): Audit {
  const errors: string[] = [];
  const notes: string[] = [];
  const dir = join(repo, 'docs', 'closeout');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^M\d+\.md$/.test(f)).sort() : [];

  if (files.length === 0) {
    notes.push(NO_CLOSEOUT_MESSAGE);
    return { errors, notes, files };
  }

  if (run('git', ['rev-parse', '--is-shallow-repository'], repo, env).stdout.trim() === 'true') {
    errors.push('the repository is shallow, so no ancestry can be proved — check out with `fetch-depth: 0` (or `git fetch --unshallow`)');
    return { errors, notes, files };
  }
  const ref = resolveMainRef(repo, env);
  if (!ref) {
    errors.push('no main ref to check ancestry against (tried origin/main, main, HEAD)');
    return { errors, notes, files };
  }

  const source = issues ?? ghIssueSource(repo, env);
  if (source.kind === 'skipped') notes.push(source.reason);

  for (const file of files) {
    const parsed = parseCloseout(readFileSync(join(dir, file), 'utf8'));
    for (const e of parsed.errors) errors.push(`${file}: ${e}`);
    if (parsed.errors.length > 0) continue;
    if (parsed.empty) {
      errors.push(`${file}: ${EMPTY_TEMPLATE_MESSAGE}`);
      continue;
    }
    if (parsed.milestone !== file.slice(1, -3)) {
      errors.push(`${file}: the heading says M${parsed.milestone} but the file is named ${file}`);
    }

    {
      const a = ancestry(repo, parsed.sha, ref, env);
      if (a === 'unknown') errors.push(`${file}: main SHA ${parsed.sha} at the close is not a commit in this repository`);
      else if (a === 'not-ancestor') errors.push(`${file}: main SHA ${parsed.sha} at the close is not an ancestor of ${ref}`);
    }

    for (const row of parsed.rows) {
      const a = ancestry(repo, row.sha, ref, env);
      if (a === 'unknown') errors.push(`${file}: merge commit ${row.sha} for #${row.issue} is not a commit in this repository`);
      else if (a === 'not-ancestor') errors.push(`${file}: merge commit ${row.sha} for #${row.issue} is not an ancestor of ${ref}`);
      if (source.kind !== 'lookup') continue;
      const answer = source.lookup(row.issue);
      // The API declining to answer is not evidence about the record: a note
      // naming the row and what was said, so the run reads as "this was not
      // checked", never as "this closeout is wrong".
      if (answer.kind === 'unavailable') {
        notes.push(`${file}: the issue-closed check was skipped for #${row.issue} — ${answer.detail}`);
        continue;
      }
      if (answer.kind === 'no-such-issue') {
        errors.push(`${file}: gh could not answer for #${row.issue}: ${answer.detail}`);
        continue;
      }
      if (answer.state !== 'CLOSED') errors.push(`${file}: #${row.issue} is listed as shipped but is ${answer.state}`);
    }
  }
  return { errors, notes, files };
}

// --- the real tree ---------------------------------------------------------
const closeoutDir = join(ROOT, 'docs', 'closeout');
const templatePath = join(closeoutDir, 'TEMPLATE.md');
const readmePath = join(closeoutDir, 'README.md');

// AC1: the template is the format, and it parses as the valid-but-empty case.
if (!existsSync(templatePath)) {
  check('docs/closeout/TEMPLATE.md exists', false, `missing: ${templatePath}`);
} else {
  const template = parseCloseout(readFileSync(templatePath, 'utf8'));
  check('TEMPLATE.md parses against the closeout format', template.errors.length === 0, template.errors.join('\n'));
  check('TEMPLATE.md is the valid-but-empty case', template.empty, JSON.stringify({ empty: template.empty, rows: template.rows.length }));
  check('TEMPLATE.md carries the UTC date field', PLACEHOLDER.test(template.date), template.date);
  check('TEMPLATE.md carries the main SHA field', PLACEHOLDER.test(template.sha), template.sha);
}

// AC4: docs equal code -- the README says who writes a closeout, when, and what keeps it honest.
if (!existsSync(readmePath)) {
  check('docs/closeout/README.md exists', false, `missing: ${readmePath}`);
} else {
  const readme = readFileSync(readmePath, 'utf8');
  check('README.md names the `docs: closeout M<n>` issue the orchestrator opens', /docs: closeout M<n>/.test(readme), readme.slice(0, 200));
  check('README.md says the closeout starts from TEMPLATE.md', /TEMPLATE\.md/.test(readme));
  check('README.md says the docs-writer fills it in a `type:docs` PR', /docs-writer/i.test(readme) && /type:docs/.test(readme));
  check('README.md says the milestone closes only after the closeout', /milestone/i.test(readme) && /close/i.test(readme));
  check('README.md names this pin test as the mechanism', /tests\/provenance\.test\.mts/.test(readme));
  check('README.md restates the grammar for scripts that re-parse it', /## Format/.test(readme) && /# Closeout M<n>/.test(readme));

  // AC1 (#208): the ref the ancestry runs against is resolved, not assumed, so
  // "What keeps it honest" has to name the order and the last resort.
  const honestStart = readme.indexOf('## What keeps it honest');
  const honestEnd = readme.indexOf('## Format');
  const honest = honestStart === -1 ? '' : readme.slice(honestStart, honestEnd === -1 ? undefined : honestEnd);
  check(
    'README.md states the ref resolution order origin/main, then main, then HEAD',
    /origin\/main[\s\S]{0,160}?\bmain\b[\s\S]{0,160}?\bHEAD\b/.test(honest),
    honest,
  );
  check(
    'README.md says HEAD is the last resort for a checkout with neither',
    /HEAD[\s\S]{0,200}?(last resort|neither)/i.test(honest),
    honest,
  );

  // #356: the issue-closed half is opt-in now and this is the document that
  // says so. These three are also the negative control's red -- the overlay
  // copies test files onto the base and not this README, so a base still
  // calling the check "authenticated" fails here.
  check('README.md names the opt-in that runs the issue-closed check', /AGENTIC_PROVENANCE_LIVE_GH/.test(honest), honest);
  check('README.md says that check is opt-in and skipped by default', /opt-in/.test(honest) && /skipped by default/.test(honest), honest);
  check('README.md separates the API declining from the record being wrong', /declining to answer/.test(honest) && /different answers/.test(honest), honest);
  check(
    'README.md states that rows are in ascending issue order',
    /issue order/.test(readme) && /ascending/.test(readme),
    readme.slice(-600),
  );
}

// AC2: the real tree is clean; with no closeout file yet it passes with a note.
const real = audit(ROOT, process.env, issueSourceFor(ROOT, process.env));
check(`docs/closeout/M*.md is clean (${real.files.length} file(s))`, real.errors.length === 0, real.errors.join('\n'));
for (const note of real.notes) console.error(`note  provenance: ${note}`);

// #356: the default run asks GitHub nothing. The issue-closed half used to
// shell out once per row of every closeout -- 129 calls against a shared,
// exhaustible quota, from a unit test in the required `test` suite. It is
// opt-in now and the note says so by name, so the case asserts the default --
// and the opposite when the run itself asked for the live check.
if ((process.env[LIVE_GH_ENV] ?? '') === '1') {
  check(
    `the real-tree audit runs the issue-closed check when ${LIVE_GH_ENV}=1`,
    !real.notes.includes(OFFLINE_MESSAGE),
    real.notes.join('\n'),
  );
} else {
  check(
    'the real-tree audit does not call GitHub by default, and the note names the opt-in',
    real.notes.includes(OFFLINE_MESSAGE) && /AGENTIC_PROVENANCE_LIVE_GH/.test(OFFLINE_MESSAGE),
    real.notes.join('\n'),
  );
}
check(
  'without the opt-in the source is skipped, so nothing is spawned to ask',
  issueSourceFor(ROOT, { ...process.env, [LIVE_GH_ENV]: '' }).kind === 'skipped',
  issueSourceFor(ROOT, { ...process.env, [LIVE_GH_ENV]: '' }).kind,
);

// --- synthetic repositories ------------------------------------------------
// A fake `gh` first on PATH: every issue is CLOSED except the numbers in
// FAKE_GH_OPEN; #9999999 does not exist -- a sentinel above every issue this
// repository has, because the real tree's own rows go through this fixture now
// and a low one would collide (M6.md lists #99); FAKE_GH_AUTH=fail is the
// unauthenticated runner; and FAKE_GH_FAIL is the message a refusing API
// answers with -- a rate limit, a 5xx, a network error -- on stderr with a
// non-zero exit, the shape gh gives a missing issue too (#356).
const FAKE_GH = `#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  "auth status")
    [ "\${FAKE_GH_AUTH:-ok}" = "fail" ] && { echo "not logged in" >&2; exit 1; }
    exit 0 ;;
  "issue view")
    n="$3"
    if [ -n "\${FAKE_GH_FAIL:-}" ]; then echo "\$FAKE_GH_FAIL" >&2; exit 1; fi
    if [ "$n" = "9999999" ]; then echo "GraphQL: Could not resolve to an issue or pull request with the number of 9999999. (repository.issue)" >&2; exit 1; fi
    for open in \${FAKE_GH_OPEN:-}; do
      if [ "$open" = "$n" ]; then echo '{"state":"OPEN"}'; exit 0; fi
    done
    echo '{"state":"CLOSED"}'
    exit 0 ;;
esac
echo "unexpected gh call: $*" >&2
exit 1
`;

const bin = mkdtempSync(join(tmpdir(), 'agentic-gh-'));
cleanup(() => spawnSync('rm', ['-rf', bin]));
writeFileSync(join(bin, 'gh'), FAKE_GH);
chmodSync(join(bin, 'gh'), 0o755);
const withGh: Env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };

// The opt-in half of #356, proved against the fixture rather than the network:
// with LIVE_GH_ENV set the source is a lookup against whatever PATH offers --
// the fake above here, the real CLI in a run that asked for it.
check(
  'with the opt-in set, the source is a lookup against the gh on PATH',
  issueSourceFor(ROOT, { ...withGh, [LIVE_GH_ENV]: '1' }).kind === 'lookup',
  issueSourceFor(ROOT, { ...withGh, [LIVE_GH_ENV]: '1' }).kind,
);

// AC4 of #356: determinism must not cost the check its reach. These two run
// the real tree's own closeout rows -- every one of them, the rows the live
// call used to read -- through the issue-closed check with the fixture
// answering, so the real record is exercised and not a one-row synthetic
// document. The first is the clean case; the second picks a real row and has
// the fixture call that issue open, the defect the live call existed to catch.
const realWithFixture = audit(ROOT, withGh);
check(
  "the real tree's closeout rows pass the issue-closed check against the fixture",
  realWithFixture.errors.length === 0,
  realWithFixture.errors.join('\n'),
);

const realRow = (() => {
  for (const file of realWithFixture.files) {
    const parsed = parseCloseout(readFileSync(join(closeoutDir, file), 'utf8'));
    if (parsed.errors.length === 0 && parsed.rows.length > 0) return { file, issue: parsed.rows[0].issue };
  }
  return null;
})();
if (!realRow) {
  console.error('note  provenance: no filled closeout row to run the open-issue fixture over, case skipped');
} else {
  const realOpen = audit(ROOT, { ...withGh, FAKE_GH_OPEN: String(realRow.issue) });
  check(
    `a real closeout row whose issue is open fails (${realRow.file} #${realRow.issue})`,
    realOpen.errors.some((e) => e.includes(`#${realRow.issue}`) && e.includes('OPEN')),
    realOpen.errors.join('\n'),
  );
}

/** A repository with one merged commit on main and one commit on a side branch. */
function fixtureRepo(): { repo: string; mainSha: string; sideSha: string } {
  const repo = tempRepo();
  commit(repo, { 'README.md': 'base\n' }, 'chore: base');
  const mainSha = commit(repo, { 'a.txt': 'a\n' }, 'feat(a): land (#1)');
  git(['checkout', '-q', '-b', 'side'], repo);
  const sideSha = commit(repo, { 'b.txt': 'b\n' }, 'feat(b): never merged (#2)');
  git(['checkout', '-q', 'main'], repo);
  return { repo, mainSha, sideSha };
}

/** Writes docs/closeout/<name> in a repository. */
function writeCloseout(repo: string, name: string, body: string): void {
  mkdirSync(join(repo, 'docs', 'closeout'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'closeout', name), body);
}

/** A filled closeout document over the given rows. */
function closeout(milestone: string, sha: string, rows: Array<[number, number, string]>): string {
  const table = rows.map(([issue, pr, rowSha]) => `| #${issue} | feat(x): a thing | #${pr} | ${rowSha} |`).join('\n');
  return `# Closeout M${milestone} — A phase

- Closed (UTC): 2026-09-17
- main SHA: ${sha}

## Issues

| ${TABLE_HEADER.join(' | ')} |
| --- | --- | --- | --- |
${table}

## Left out

- Nothing — every issue shipped.

## Dogfood

- None needed — no report was required.
`;
}

const good = fixtureRepo();
writeCloseout(good.repo, 'M1.md', closeout('1', good.mainSha, [[1, 11, good.mainSha]]));
const goodAudit = audit(good.repo, withGh);
check('a closeout whose sha is on main and whose issue is closed passes', goodAudit.errors.length === 0, goodAudit.errors.join('\n'));
check('a passing closeout leaves no note', goodAudit.notes.length === 0, goodAudit.notes.join('\n'));
check('the passing closeout was actually read', goodAudit.files.join(',') === 'M1.md', goodAudit.files.join(','));

const sideBranch = fixtureRepo();
writeCloseout(sideBranch.repo, 'M1.md', closeout('1', sideBranch.mainSha, [[2, 12, sideBranch.sideSha]]));
const sideAudit = audit(sideBranch.repo, withGh);
check(
  'a merge sha that is only on a side branch fails as not an ancestor',
  sideAudit.errors.some((e) => e.includes(sideBranch.sideSha) && e.includes('not an ancestor')),
  sideAudit.errors.join('\n'),
);

const invented = fixtureRepo();
const INVENTED_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
writeCloseout(invented.repo, 'M1.md', closeout('1', invented.mainSha, [[1, 11, INVENTED_SHA]]));
const inventedAudit = audit(invented.repo, withGh);
check(
  'an invented merge sha fails as not a commit in this repository',
  inventedAudit.errors.some((e) => e.includes(INVENTED_SHA) && e.includes('not a commit')),
  inventedAudit.errors.join('\n'),
);

const anchor = fixtureRepo();
writeCloseout(anchor.repo, 'M1.md', closeout('1', anchor.sideSha, [[1, 11, anchor.mainSha]]));
const anchorAudit = audit(anchor.repo, withGh);
check(
  'the header main SHA is held to the same ancestry rule as the rows',
  anchorAudit.errors.some((e) => e.includes('main SHA') && e.includes('not an ancestor')),
  anchorAudit.errors.join('\n'),
);

const openIssue = fixtureRepo();
writeCloseout(openIssue.repo, 'M1.md', closeout('1', openIssue.mainSha, [[1, 11, openIssue.mainSha]]));
const openAudit = audit(openIssue.repo, { ...withGh, FAKE_GH_OPEN: '1' });
check(
  'a listed issue that is still open fails',
  openAudit.errors.some((e) => e.includes('#1') && e.includes('OPEN')),
  openAudit.errors.join('\n'),
);

const missingIssue = fixtureRepo();
writeCloseout(missingIssue.repo, 'M1.md', closeout('1', missingIssue.mainSha, [[9999999, 11, missingIssue.mainSha]]));
const missingAudit = audit(missingIssue.repo, withGh);
check(
  'an issue gh cannot resolve fails rather than passing silently',
  missingAudit.errors.some((e) => e.includes('#9999999') && e.includes('gh could not answer')),
  missingAudit.errors.join('\n'),
);

// #356: the two failures gh reports identically -- non-zero, one GraphQL line
// on stderr -- are different answers, and the pin has to say which. A rate
// limit is the API declining to answer and proves nothing about the record, so
// it is a note; a number that resolves to nothing is a defect in the closeout,
// so it stays red.
const RATE_LIMITED = 'GraphQL: API rate limit already exceeded';
const rateLimited = fixtureRepo();
writeCloseout(rateLimited.repo, 'M1.md', closeout('1', rateLimited.mainSha, [[1, 11, rateLimited.mainSha]]));
const rateLimitedAudit = audit(rateLimited.repo, { ...withGh, FAKE_GH_FAIL: RATE_LIMITED });
check(
  'an API that declines to answer is skipped, not failed',
  rateLimitedAudit.errors.length === 0,
  rateLimitedAudit.errors.join('\n'),
);
check(
  'the skip says which issue it could not check and what the API said',
  rateLimitedAudit.notes.some((n) => n.includes('#1') && n.includes(RATE_LIMITED)),
  rateLimitedAudit.notes.join('\n'),
);

// The wording is gh's own, from `gh issue view <missing> --json state` against
// this repository: the classifier is held to what the real CLI prints
// (invariant 10 -- the pin writes the shape out rather than importing it).
const NO_SUCH_ISSUE_STDERR =
  'GraphQL: Could not resolve to an issue or pull request with the number of 9999999. (repository.issue)';
const noSuchIssue = fixtureRepo();
writeCloseout(noSuchIssue.repo, 'M1.md', closeout('1', noSuchIssue.mainSha, [[1, 11, noSuchIssue.mainSha]]));
const noSuchIssueAudit = audit(noSuchIssue.repo, { ...withGh, FAKE_GH_FAIL: NO_SUCH_ISSUE_STDERR });
check(
  'a row naming an issue that resolves to nothing stays a failure, not a skip',
  noSuchIssueAudit.errors.some((e) => e.includes('#1') && e.includes('gh could not answer')),
  noSuchIssueAudit.errors.join('\n'),
);

const noGh = fixtureRepo();
writeCloseout(noGh.repo, 'M1.md', closeout('1', noGh.mainSha, [[1, 11, noGh.mainSha]]));
const noGhAudit = audit(noGh.repo, { ...withGh, FAKE_GH_AUTH: 'fail', FAKE_GH_OPEN: '1' });
check('an unauthenticated gh skips the issue check instead of failing', noGhAudit.errors.length === 0, noGhAudit.errors.join('\n'));
check(
  'an unauthenticated gh says on stderr what was skipped',
  noGhAudit.notes.some((n) => /gh is absent or unauthenticated/.test(n)),
  noGhAudit.notes.join('\n'),
);

// A checkout with neither origin/main nor main still has HEAD, the last of the
// three refs resolveMainRef tries; the pin runs there instead of refusing.
const headOnly = fixtureRepo();
git(['checkout', '-q', '-b', 'trunk'], headOnly.repo);
git(['branch', '-D', 'main'], headOnly.repo);
writeCloseout(headOnly.repo, 'M1.md', closeout('1', headOnly.mainSha, [[1, 11, headOnly.mainSha]]));
const headOnlyAudit = audit(headOnly.repo, withGh);
check(
  'a checkout with neither origin/main nor main falls back to HEAD',
  headOnlyAudit.errors.length === 0,
  headOnlyAudit.errors.join('\n'),
);

const outOfOrder = fixtureRepo();
writeCloseout(
  outOfOrder.repo,
  'M1.md',
  closeout('1', outOfOrder.mainSha, [[2, 12, outOfOrder.mainSha], [1, 11, outOfOrder.mainSha]]),
);
const outOfOrderAudit = audit(outOfOrder.repo, withGh);
check(
  'rows out of ascending issue order fail, naming both rows',
  outOfOrderAudit.errors.some((e) => e.includes(outOfOrderMessage(2, 1))),
  outOfOrderAudit.errors.join('\n'),
);

const duplicateRow = fixtureRepo();
writeCloseout(
  duplicateRow.repo,
  'M1.md',
  closeout('1', duplicateRow.mainSha, [[1, 11, duplicateRow.mainSha], [1, 12, duplicateRow.mainSha]]),
);
const duplicateAudit = audit(duplicateRow.repo, withGh);
check(
  'the same issue listed twice fails the ascending order rule',
  duplicateAudit.errors.some((e) => e.includes(outOfOrderMessage(1, 1))),
  duplicateAudit.errors.join('\n'),
);

const empty = fixtureRepo();
const emptyAudit = audit(empty.repo, withGh);
check('a tree with no closeout file passes', emptyAudit.errors.length === 0, emptyAudit.errors.join('\n'));
check(
  'a tree with no closeout file leaves a note on stderr',
  emptyAudit.notes.includes(NO_CLOSEOUT_MESSAGE),
  emptyAudit.notes.join('\n'),
);

const unparsed = fixtureRepo();
writeCloseout(unparsed.repo, 'M1.md', closeout('1', unparsed.mainSha, [[1, 11, unparsed.mainSha]]).replace('## Dogfood', '## Reports'));
const unparsedAudit = audit(unparsed.repo, withGh);
check(
  'a closeout missing a required section fails to parse',
  unparsedAudit.errors.some((e) => e.includes('## Dogfood')),
  unparsedAudit.errors.join('\n'),
);

const mismatch = fixtureRepo();
writeCloseout(mismatch.repo, 'M2.md', closeout('3', mismatch.mainSha, [[1, 11, mismatch.mainSha]]));
const mismatchAudit = audit(mismatch.repo, withGh);
check(
  'a heading that names another milestone than the filename fails',
  mismatchAudit.errors.some((e) => e.includes('M3') && e.includes('M2.md')),
  mismatchAudit.errors.join('\n'),
);

const halfFilled = fixtureRepo();
writeCloseout(halfFilled.repo, 'M1.md', closeout('1', halfFilled.mainSha, [[1, 11, halfFilled.mainSha]]).replace('- Closed (UTC): 2026-09-17', '- Closed (UTC): <YYYY-MM-DD>'));
const halfAudit = audit(halfFilled.repo, withGh);
check(
  'a half-filled closeout (a placeholder left among real rows) fails',
  halfAudit.errors.some((e) => e.includes('placeholder')),
  halfAudit.errors.join('\n'),
);

const stillTemplate = fixtureRepo();
writeCloseout(stillTemplate.repo, 'M1.md', existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : '# Closeout M<n> — <milestone title>\n');
const templateAudit = audit(stillTemplate.repo, withGh);
check(
  'a milestone file left as the unfilled template fails',
  templateAudit.errors.some((e) => e.includes(EMPTY_TEMPLATE_MESSAGE)),
  templateAudit.errors.join('\n'),
);

// A commented-out row is not a row: the parser strips HTML comments first, so
// TEMPLATE.md may show the row shape without counting as filled.
const commented = parseCloseout(closeout('1', 'a'.repeat(40), []).replace('## Left out', '<!-- | #1 | x | #2 | ' + 'b'.repeat(40) + ' | -->\n\n## Left out'));
check('a commented-out row is not counted as a row', commented.rows.length === 0, JSON.stringify(commented.rows));

const shallow = fixtureRepo();
const shallowDir = mkdtempSync(join(tmpdir(), 'agentic-shallow-'));
cleanup(() => spawnSync('rm', ['-rf', shallowDir]));
const clone = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${shallow.repo}`, join(shallowDir, 'repo')], { encoding: 'utf8' });
if (clone.status !== 0) {
  console.error(`note  provenance: shallow clone unavailable, case skipped: ${clone.stderr.trim().split('\n')[0]}`);
} else {
  writeCloseout(join(shallowDir, 'repo'), 'M1.md', closeout('1', shallow.mainSha, [[1, 11, shallow.mainSha]]));
  const shallowAudit = audit(join(shallowDir, 'repo'), withGh);
  check(
    'a shallow checkout fails with the fetch-depth remedy instead of guessing',
    shallowAudit.errors.some((e) => /shallow/.test(e) && /fetch-depth: 0/.test(e)),
    shallowAudit.errors.join('\n'),
  );
}

// AC3: the workflow that runs this file checks out enough history for the ancestry
// assertion, and says why.
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
check('test.yml checks out with fetch-depth: 0', /fetch-depth:\s*0/.test(workflow), workflow);
check('test.yml says why it needs the history', /ancestry|provenance|closeout/i.test(workflow.split('\n').slice(0, 12).join('\n')), workflow.slice(0, 400));
check('test.yml still runs the same test job', /name:\s*test/.test(workflow) && /node tests\/run\.mts/.test(workflow));

finish();
