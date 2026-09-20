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
// This file asks nothing of GitHub. What it holds is the format, the ancestry
// and the prose: a closeout's own text, and `git merge-base --is-ancestor`,
// which needs no credentials, only history -- hence `fetch-depth: 0` in
// test.yml. The half that needs an answer from outside the checkout -- whether
// #123 is closed, and whether a `## Left out` bullet accounts for something
// that shipped -- is `tests/provenance-issues.test.mts`, split out of this file
// by #422 and opt-in behind `AGENTIC_PROVENANCE_LIVE_GH` (#356). The two files
// parse a closeout separately and on purpose: invariant 10, a pin that imports
// what it pins cannot catch it drifting.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

/**
 * The bullets of a prose section: each `- ` line joined with the indented
 * continuation lines under it. Mirrors `bulletsOf` in
 * `scripts/close-milestone.mts`, written out rather than imported because a
 * pin that reuses the thing it pins cannot catch that thing drifting
 * (invariant 10), and because a script may not import from `tests/`
 * (invariant 6). `docs/closeout/README.md`, "Format", is the one statement
 * both are written from. Until #341 both read a bullet's first line only,
 * while the README and the script's own header said "any `#N` in a bullet".
 */
function bulletsOf(lines: string[]): string[] {
  const bullets: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (text === '') continue;
    // An indented line continues the bullet above it whatever it opens with,
    // `- ` included: `- Deferred:` / `  - #12 ...` is one bullet about the
    // deferral, not two, so #12 is mentioned and not claimed. A bullet begins
    // at the left margin; anything else ends the one above and is ignored.
    if (/^\s/.test(line) && bullets.length > 0) bullets[bullets.length - 1] += ` ${text}`;
    else if (text.startsWith('- ')) bullets.push(text);
  }
  return bullets;
}

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
  const leftOut = bulletsOf(lines.slice(at[1] + 1, at[2]));
  const dogfood = bulletsOf(lines.slice(at[2] + 1));
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
 * Whether the issues it names are closed is not asked here: that needs GitHub,
 * and `tests/provenance-issues.test.mts` is where it is asked (#422).
 */
function audit(repo: string, env: Env = process.env): Audit {
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

  // #356: this document says the issue-closed half is opt-in, and these three
  // are also the negative control's red -- it copies the diff's test files
  // onto the base and not this README.
  check('README.md names the opt-in that runs the issue-closed check', /AGENTIC_PROVENANCE_LIVE_GH/.test(honest), honest);
  check('README.md says that check is opt-in and skipped by default', /opt-in/.test(honest) && /skipped by default/.test(honest), honest);
  check('README.md separates the API declining from the record being wrong', /declining to answer/.test(honest) && /different answers/.test(honest), honest);
  check(
    'README.md states that rows are in ascending issue order',
    /issue order/.test(readme) && /ascending/.test(readme),
    readme.slice(-600),
  );

  // #422. The grammar gained the three sentences the sweep turns on, and the
  // README is where both parsers are written from, so the pin reads them here
  // rather than trusting either parser to agree with itself.
  check(
    'README.md says a `#N` anywhere in a `## Left out` bullet counts, continuation lines included',
    /continuation line/.test(readme) && /anywhere in (a|the) .?## Left out/.test(readme),
    readme.slice(-2400),
  );
  check(
    'README.md separates a bullet mentioning an issue from a bullet accounting for it',
    /accounts for/.test(readme) && /cross-reference/.test(readme) && /opens the bullet/.test(readme),
    readme.slice(-2400),
  );
  check(
    'README.md states the shipped rule and the snapshot clause that bounds it',
    /snapshot/.test(readme) && /merged pull request/.test(readme) && /main SHA/.test(readme),
    readme.slice(-2400),
  );
  check(
    'README.md names the three refusal codes the close raises over a closeout',
    ['evidence:issue-missing', 'evidence:left-out-shipped', 'evidence:row-open'].every((code) => readme.includes(code)),
    readme.slice(-2400),
  );
  check(
    'README.md names the split file that asks GitHub',
    /tests\/provenance-issues\.test\.mts/.test(readme),
    readme.slice(0, 400),
  );
  check(
    'README.md says when a closeout may cite a dogfood report older than its own phase',
    /dogfood/i.test(readme) && /predates|older than|earlier than/.test(readme),
    readme.slice(-2400),
  );
  check(
    'README.md says why a closeout file carries no dated filename',
    /dated filename|no date in (its|the) filename/.test(readme),
    readme.slice(-2400),
  );
}

// #298, sharpened by #422: the empty-template refusal had three wordings, two
// of which say the same thing in two files. They are one sentence now, written
// out in both places because neither may import the other (invariants 6 and
// 10) -- so this pin reads the script's source and holds it to the string
// above. The third wording, the half-filled error, is a different fact and
// keeps its own words.
// Held to the refusal, not to the file: a whole-file `includes` would pass if
// the sentence survived only in a comment while the code said something else,
// which is the drift this pin exists to catch.
const closeMilestoneSource = readFileSync(join(ROOT, 'scripts', 'close-milestone.mts'), 'utf8');
check(
  'scripts/close-milestone.mts refuses the unfilled template in the pin\'s own words',
  closeMilestoneSource.includes(`errors.push("${EMPTY_TEMPLATE_MESSAGE}")`),
  EMPTY_TEMPLATE_MESSAGE,
);

// AC2: the real tree is clean; with no closeout file yet it passes with a note.
const real = audit(ROOT);
check(`docs/closeout/M*.md is clean (${real.files.length} file(s))`, real.errors.length === 0, real.errors.join('\n'));
for (const note of real.notes) console.error(`note  provenance: ${note}`);

// --- synthetic repositories ------------------------------------------------
// Every case here is offline: a real git repository, a written closeout and the
// parser above. Nothing spawns `gh`.
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
const goodAudit = audit(good.repo);
check('a closeout whose sha is on main and whose issue is closed passes', goodAudit.errors.length === 0, goodAudit.errors.join('\n'));
check('a passing closeout leaves no note', goodAudit.notes.length === 0, goodAudit.notes.join('\n'));
check('the passing closeout was actually read', goodAudit.files.join(',') === 'M1.md', goodAudit.files.join(','));

const sideBranch = fixtureRepo();
writeCloseout(sideBranch.repo, 'M1.md', closeout('1', sideBranch.mainSha, [[2, 12, sideBranch.sideSha]]));
const sideAudit = audit(sideBranch.repo);
check(
  'a merge sha that is only on a side branch fails as not an ancestor',
  sideAudit.errors.some((e) => e.includes(sideBranch.sideSha) && e.includes('not an ancestor')),
  sideAudit.errors.join('\n'),
);

const invented = fixtureRepo();
const INVENTED_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
writeCloseout(invented.repo, 'M1.md', closeout('1', invented.mainSha, [[1, 11, INVENTED_SHA]]));
const inventedAudit = audit(invented.repo);
check(
  'an invented merge sha fails as not a commit in this repository',
  inventedAudit.errors.some((e) => e.includes(INVENTED_SHA) && e.includes('not a commit')),
  inventedAudit.errors.join('\n'),
);

const anchor = fixtureRepo();
writeCloseout(anchor.repo, 'M1.md', closeout('1', anchor.sideSha, [[1, 11, anchor.mainSha]]));
const anchorAudit = audit(anchor.repo);
check(
  'the header main SHA is held to the same ancestry rule as the rows',
  anchorAudit.errors.some((e) => e.includes('main SHA') && e.includes('not an ancestor')),
  anchorAudit.errors.join('\n'),
);

const headOnly = fixtureRepo();
git(['checkout', '-q', '-b', 'trunk'], headOnly.repo);
git(['branch', '-D', 'main'], headOnly.repo);
writeCloseout(headOnly.repo, 'M1.md', closeout('1', headOnly.mainSha, [[1, 11, headOnly.mainSha]]));
const headOnlyAudit = audit(headOnly.repo);
check(
  'a checkout with neither origin/main nor main falls back to HEAD',
  headOnlyAudit.errors.length === 0,
  headOnlyAudit.errors.join('\n'),
);

// #341: a bullet is the `- ` line and the indented lines under it, so a
// `## Left out` entry written over three lines is one bullet, not one bullet
// and two stray lines -- and a section whose only bullet wraps is not empty.
const wrapped = parseCloseout(
  closeout('1', 'a'.repeat(40), [[1, 11, 'b'.repeat(40)]]).replace(
    '- Nothing \u2014 every issue shipped.',
    '- The phase cut work that had no owner, and the list it was checked\n  against names #2 and #3 among them.',
  ),
);
check('a `## Left out` bullet wrapped over three lines parses as one bullet', wrapped.errors.length === 0, wrapped.errors.join('\n'));

const outOfOrder = fixtureRepo();
writeCloseout(
  outOfOrder.repo,
  'M1.md',
  closeout('1', outOfOrder.mainSha, [[2, 12, outOfOrder.mainSha], [1, 11, outOfOrder.mainSha]]),
);
const outOfOrderAudit = audit(outOfOrder.repo);
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
const duplicateAudit = audit(duplicateRow.repo);
check(
  'the same issue listed twice fails the ascending order rule',
  duplicateAudit.errors.some((e) => e.includes(outOfOrderMessage(1, 1))),
  duplicateAudit.errors.join('\n'),
);

const empty = fixtureRepo();
const emptyAudit = audit(empty.repo);
check('a tree with no closeout file passes', emptyAudit.errors.length === 0, emptyAudit.errors.join('\n'));
check(
  'a tree with no closeout file leaves a note on stderr',
  emptyAudit.notes.includes(NO_CLOSEOUT_MESSAGE),
  emptyAudit.notes.join('\n'),
);

const unparsed = fixtureRepo();
writeCloseout(unparsed.repo, 'M1.md', closeout('1', unparsed.mainSha, [[1, 11, unparsed.mainSha]]).replace('## Dogfood', '## Reports'));
const unparsedAudit = audit(unparsed.repo);
check(
  'a closeout missing a required section fails to parse',
  unparsedAudit.errors.some((e) => e.includes('## Dogfood')),
  unparsedAudit.errors.join('\n'),
);

const mismatch = fixtureRepo();
writeCloseout(mismatch.repo, 'M2.md', closeout('3', mismatch.mainSha, [[1, 11, mismatch.mainSha]]));
const mismatchAudit = audit(mismatch.repo);
check(
  'a heading that names another milestone than the filename fails',
  mismatchAudit.errors.some((e) => e.includes('M3') && e.includes('M2.md')),
  mismatchAudit.errors.join('\n'),
);

const halfFilled = fixtureRepo();
writeCloseout(halfFilled.repo, 'M1.md', closeout('1', halfFilled.mainSha, [[1, 11, halfFilled.mainSha]]).replace('- Closed (UTC): 2026-09-17', '- Closed (UTC): <YYYY-MM-DD>'));
const halfAudit = audit(halfFilled.repo);
check(
  'a half-filled closeout (a placeholder left among real rows) fails',
  halfAudit.errors.some((e) => e.includes('placeholder')),
  halfAudit.errors.join('\n'),
);

const stillTemplate = fixtureRepo();
writeCloseout(stillTemplate.repo, 'M1.md', existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : '# Closeout M<n> — <milestone title>\n');
const templateAudit = audit(stillTemplate.repo);
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
  const shallowAudit = audit(join(shallowDir, 'repo'));
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
