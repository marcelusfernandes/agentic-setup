#!/usr/bin/env node
// close-milestone — the only way a milestone closes (#172).
//
//   node scripts/close-milestone.mts <milestone> --evidence docs/closeout/M<k>.md
//
// Closing a milestone used to be the orchestrator typing `gh api -X PATCH
// repos/{owner}/{repo}/milestones/<n> -f state=closed` after looking the
// number up by title. That is the exact shape `docs/decisions.md` item 11 was
// written against — a mutating GitHub step with no refusal path — and it was
// the last one left on this route after `claim.mts`, `land.mts` and
// `issue-lint`. It also checked nothing: not that the phase met a criterion,
// not that what shipped was written down anywhere.
//
// `<milestone>` is the number **GitHub** gives the milestone, the one the
// PATCH below needs. The evidence file is named after the **phase** in the
// milestone's title (`M14 Closure with evidence` → `docs/closeout/M14.md`);
// in this repository the two are not the same number, so the expected path
// is derived from the title, not from the argument. A title with no `M<k>`
// prefix falls back to the milestone number.
//
// **Crash policy: fail closed, because nothing runs after it.** Every check
// runs before anything is written, and one write happens or none does: the
// single PATCH below carries both the appended description and
// `state=closed`. A `gh` or `git` call that fails for any reason other than
// a 404 on the milestone — a network error, a rate limit, a token problem, a
// missing remote — prints `{ error }` and exits 1 without writing; it is
// never reported as a refusal, because it is not a verdict on the close. A
// response that does not parse is treated the same way. This script never
// opens the next milestone or any issue: that stays the orchestrator's job
// after the close returns.
//
// Exit 1 with `{ refused, milestone, missing }`, having written nothing,
// when:
//   milestone:state        the milestone does not exist, or is not open (so a
//                          second run can never append a second closing block)
//   milestone:open-issues  the milestone still has an open issue
//   milestone:exit-criteria the description has no `Exit criteria:` checklist,
//                          or leaves one of its items unchecked
//   evidence:missing       `--evidence` is absent, names another path than
//                          `docs/closeout/M<k>.md`, or names a file that is
//                          not on `origin/main` — the closeout is the
//                          evidence, so it counts only once it has landed
//   evidence:format        the evidence file does not parse against the
//                          grammar in `docs/closeout/README.md`, or is still
//                          the unfilled template
//   evidence:sha           the evidence file's `main SHA`, or a row's merge
//                          commit, is not an ancestor of `origin/main`
//   evidence:issue-missing a closed issue of the milestone appears neither as
//                          a row in the evidence table nor as `#N` in a
//                          `## Left out` bullet (the README's own rule: an
//                          issue that closed without a PR did not ship — which
//                          the parent spec issue and the closeout issue itself
//                          always are). *Any* `#N` in a `## Left out` bullet
//                          counts, including the "where it went" trailer, so
//                          the check is deliberately generous: it catches an
//                          issue nobody wrote down, not a bullet worded
//                          loosely.
// Every determinable code is collected, so one run names everything that is
// wrong instead of one thing per run.
//
// Exit 0 with `{ closed, milestone, sha, evidence }` after appending a dated
// closing block to the milestone's description —
// `Closed <UTC ISO-8601>, main <sha>, evidence docs/closeout/M<k>.md` — and
// patching it to `state: closed` in the same call. `sha` is the tip of
// `origin/main` at the close, read after a fetch, so the reader can check out
// exactly what was true when the phase ended.
//
// The closeout grammar is restated here rather than imported: the pin that
// enforces it lives in `tests/provenance.test.mts` (invariant 6 — nothing
// under `scripts/` implements it) and a script may not import from `tests/`.
// `docs/closeout/README.md` is the one statement of the format both parsers
// are written from. The exit-criteria rules are likewise a copy of
// `scripts/reconcile.mts`'s, which cannot be imported (it runs a whole pass
// on load); both are written from `.github/MILESTONE_TEMPLATE.md`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USAGE = 'usage: node scripts/close-milestone.mts <milestone> --evidence docs/closeout/M<n>.md';
// Fully qualified, same reason as `reconcile.mts`'s #48 note: a local branch
// literally named `origin/main` would otherwise shadow the remote-tracking ref.
const MAIN = 'refs/remotes/origin/main';

// --- the closeout grammar (docs/closeout/README.md, "Format") ---------------
const HEADING = /^# Closeout M(\d+) — (.+)$/;
const META_DATE = /^- Closed \(UTC\): (.+)$/;
const META_SHA = /^- main SHA: (.+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{40}$/;
const ISSUE_CELL = /^#(\d+)$/;
const ISSUE_REF = /#(\d+)/g;
const DELIMITER = /^:?-{3,}:?$/;
const TABLE_HEADER = ['issue', 'title', 'PR', 'merge commit'];
const SECTIONS = ['## Issues', '## Left out', '## Dogfood'];

// --- the milestone description format (.github/MILESTONE_TEMPLATE.md) -------
const MILESTONE_LABELS = [
  { key: 'out-of-phase', label: 'out of this phase' },
  { key: 'exit-criteria', label: 'exit criteria' },
  { key: 'depends-on', label: 'depends on' },
];
const CHECKBOX_ITEM = /^\s*[-*+]\s*\[([ xX])\]/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s/;

type Row = { issue: number; sha: string };
type Closeout = { errors: string[]; phase: string; sha: string; rows: Row[]; leftOut: number[] };

function out(shape: Record<string, unknown>, code: number): never {
  console.log(JSON.stringify(shape));
  process.exit(code);
}
function fail(shape: Record<string, unknown>): never {
  out(shape, 1);
}

type Run = { status: number; stdout: string; stderr: string };
function spawn(cmd: string, args: string[]): Run {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const gh = (args: string[]): Run => spawn('gh', args);
const git = (args: string[]): Run => spawn('git', args);

/** The message a failed `gh`/`git` call left, for `{ error }`. */
const why = (r: Run, what: string): string => (r.stderr || r.stdout || what).trim().split('\n')[0];

/** JSON.parse that answers null instead of throwing, so every caller fails closed the same way. */
function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** gh's own wording when the resource is not there, as opposed to any other failure. */
const isNotFound = (r: Run): boolean => /HTTP 404|Not Found \(HTTP/.test(r.stderr);

/** Splits one markdown table line into trimmed cells, or null if it is not one. */
function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null;
  return t.slice(1, -1).split('|').map((c) => c.trim());
}

/**
 * Parses one closeout document against `docs/closeout/README.md`. Collects
 * every error instead of throwing on the first. HTML comments are stripped
 * first, so a commented-out row is not a row — which is also what makes the
 * unfilled template parse as "no rows" and fail below rather than sliding
 * through.
 */
function parseCloseout(raw: string): Closeout {
  const errors: string[] = [];
  const lines = raw.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const parsed: Closeout = { errors, phase: '', sha: '', rows: [], leftOut: [] };

  const headingIndex = lines.findIndex((l) => l.trim() !== '');
  const heading = headingIndex === -1 ? '' : lines[headingIndex].trim();
  const h = HEADING.exec(heading);
  if (!h) errors.push('the first line must be `# Closeout M<n> — <milestone title>` with a filled-in number');
  else parsed.phase = h[1];

  const at = SECTIONS.map((section) => {
    const found = lines.map((l, i) => (l.trim() === section ? i : -1)).filter((i) => i !== -1);
    if (found.length !== 1) errors.push(`\`${section}\` must appear exactly once (found ${found.length})`);
    return found[0] ?? -1;
  });
  if (at.some((i) => i === -1)) return parsed;
  if (!(at[0] < at[1] && at[1] < at[2])) errors.push(`sections must be in the order ${SECTIONS.join(', ')}`);

  const meta = lines.slice(headingIndex + 1, at[0]).filter((l) => l.trim().startsWith('- '));
  if (meta.length !== 2) {
    errors.push(`expected exactly 2 metadata bullets before \`## Issues\`, found ${meta.length}`);
  } else {
    const date = META_DATE.exec(meta[0].trim());
    const sha = META_SHA.exec(meta[1].trim());
    if (!date || !DATE.test(date[1].trim())) errors.push('the first metadata bullet must be `- Closed (UTC): <YYYY-MM-DD>`');
    if (!sha || !SHA.test(sha[1].trim())) errors.push('the second metadata bullet must be `- main SHA: <40-character sha>`');
    else parsed.sha = sha[1].trim();
  }

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
      const issue = c && c.length === TABLE_HEADER.length ? ISSUE_CELL.exec(c[0]) : null;
      if (!c || c.length !== TABLE_HEADER.length || !issue || c[1] === '' || !ISSUE_CELL.test(c[2]) || !SHA.test(c[3])) {
        errors.push(`row is not \`| #N | title | #PR | <40-character sha> |\`: ${line.trim()}`);
        continue;
      }
      parsed.rows.push({ issue: Number(issue[1]), sha: c[3] });
    }
  }

  const leftOut = lines.slice(at[1] + 1, at[2]).filter((l) => l.trim().startsWith('- '));
  const dogfood = lines.slice(at[2] + 1).filter((l) => l.trim().startsWith('- '));
  if (leftOut.length === 0) errors.push('`## Left out` needs at least one bullet (`- None — <why>` when nothing was left out)');
  if (dogfood.length === 0) errors.push('`## Dogfood` needs at least one bullet (`- None needed — <why>` when no report was)');
  for (const bullet of leftOut) {
    for (const ref of bullet.matchAll(ISSUE_REF)) parsed.leftOut.push(Number(ref[1]));
  }

  if (parsed.rows.length === 0 && errors.length === 0) {
    errors.push('a closeout must be filled in: no row in `## Issues` means it is still the empty template');
  }
  return parsed;
}

/**
 * The milestone-description section a line labels, or null. Copied from
 * `scripts/reconcile.mts`: the label must be followed by its colon unless the
 * line is a markdown heading, so prose that merely opens with a label's words
 * stays prose.
 */
function sectionOf(line: string): string | null {
  const bare = line.replace(/^[\s>#*_]+/, '').toLowerCase();
  const section = MILESTONE_LABELS.find((s) => bare.startsWith(s.label));
  if (!section) return null;
  const afterLabel = bare.slice(section.label.length).replace(/^[*_\s]+/, '');
  return afterLabel.startsWith(':') || HEADING_LINE.test(line) ? section.key : null;
}

/** True when `Exit criteria:` carries at least one item of its own and none of them is unchecked. */
function exitCriteriaMet(description: string): boolean {
  let section: string | null = null;
  let items = 0;
  let unchecked = 0;
  for (const line of description.split('\n')) {
    const label = sectionOf(line);
    if (label !== null) {
      section = label;
      continue;
    }
    if (section !== 'exit-criteria') continue;
    const item = CHECKBOX_ITEM.exec(line);
    if (!item) continue;
    items++;
    if (item[1] === ' ') unchecked++;
  }
  return items > 0 && unchecked === 0;
}

type Args = { milestone: number; evidence: string | null };

/** Splits argv into the milestone number and `--evidence`, or null on a usage problem. */
function parseArgs(argv: string[]): Args | null {
  const positional: string[] = [];
  let evidence: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--evidence') {
      const value = argv[i + 1];
      if (value === undefined) return null;
      evidence = value;
      i++;
      continue;
    }
    if (a.startsWith('--')) return null;
    positional.push(a);
  }
  if (positional.length !== 1) return null;
  const milestone = Number(positional[0]);
  if (!Number.isInteger(milestone) || milestone <= 0) return null;
  return { milestone, evidence };
}

/** `./docs/x.md`, `docs/x.md` and `/docs/x.md` all name the same repository path. */
const normalisePath = (path: string): string => path.trim().replace(/^\.\//, '').replace(/^\/+/, '');

/** `git merge-base --is-ancestor <sha> origin/main`, with "not a commit here" folded into false. */
const isAncestor = (sha: string): boolean => git(['merge-base', '--is-ancestor', sha, MAIN]).status === 0;

// --- 1. arguments ------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
if (!args) fail({ error: USAGE });

// --- 2. the milestone, read before anything is written -----------------------
const read = gh(['api', `repos/{owner}/{repo}/milestones/${args.milestone}`]);
if (read.status !== 0) {
  if (!isNotFound(read)) fail({ error: why(read, 'gh api failed') });
  fail({
    refused: `milestone #${args.milestone} does not exist.`,
    milestone: args.milestone,
    missing: ['milestone:state'],
  });
}
type Milestone = { title?: unknown; state?: unknown; description?: unknown };
const milestone = safeParse<Milestone>(read.stdout);
if (!milestone || typeof milestone.title !== 'string') {
  fail({ error: `could not parse gh's answer for milestone #${args.milestone}.` });
}
const title = String(milestone.title);
const description = typeof milestone.description === 'string' ? milestone.description : '';
const phase = /^\s*M(\d+)\b/.exec(title)?.[1] ?? String(args.milestone);
const expectedEvidence = `docs/closeout/M${phase}.md`;

const missing: string[] = [];
const reasons: string[] = [];
function refuse(code: string, reason: string): void {
  missing.push(code);
  reasons.push(reason);
}

if (milestone.state !== 'open') {
  refuse('milestone:state', `milestone #${args.milestone} is ${String(milestone.state ?? 'in an unknown state')}, not open`);
}

// --- 3. the milestone is empty -----------------------------------------------
function issueNumbers(state: string): number[] {
  const r = gh(['issue', 'list', '--milestone', title, '--state', state, '--json', 'number', '--limit', '200']);
  if (r.status !== 0) fail({ error: why(r, `gh issue list --state ${state} failed`) });
  const list = safeParse<Array<{ number?: unknown }>>(r.stdout);
  if (!Array.isArray(list)) fail({ error: `could not parse gh's ${state} issue list for "${title}".` });
  return list.map((i) => Number(i.number)).filter((n) => Number.isInteger(n));
}

const open = issueNumbers('open');
if (open.length > 0) {
  refuse('milestone:open-issues', `${open.length} issue(s) still open in "${title}": ${open.map((n) => `#${n}`).join(', ')}`);
}

// --- 4. the exit criteria ----------------------------------------------------
if (!exitCriteriaMet(description)) {
  refuse('milestone:exit-criteria', `"${title}" has no \`Exit criteria:\` checklist of its own, or leaves an item unchecked`);
}

// --- 5. the evidence ---------------------------------------------------------
// `git fetch` first: the closing block records where `main` is now, and the
// ancestry checks below are only as honest as the ref they run against.
const fetched = git(['fetch', '--quiet', '--prune', 'origin']);
if (fetched.status !== 0) fail({ error: why(fetched, 'git fetch origin failed') });
const tip = git(['rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`]);
if (tip.status !== 0 || !SHA.test(tip.stdout.trim())) {
  fail({ error: `no ${MAIN} to check the evidence against — fetch the remote first.` });
}
const mainSha = tip.stdout.trim();

const evidence = args.evidence === null ? null : normalisePath(args.evidence);
let closeout: Closeout | null = null;
if (evidence === null) {
  refuse('evidence:missing', `--evidence is absent; pass --evidence ${expectedEvidence}`);
} else if (evidence !== expectedEvidence) {
  refuse('evidence:missing', `--evidence names ${evidence}, but milestone #${args.milestone} is phase M${phase}: ${expectedEvidence}`);
} else {
  // From `origin/main`, never the working tree: the closeout is what the
  // close is checked against, so it counts only once it has landed.
  const shown = git(['show', `${MAIN}:${evidence}`]);
  if (shown.status !== 0) {
    refuse('evidence:missing', `${evidence} is not on ${MAIN} — the closeout lands before the close, never after it`);
  } else {
    closeout = parseCloseout(shown.stdout);
    if (closeout.errors.length > 0) {
      refuse('evidence:format', `${evidence} does not parse: ${closeout.errors[0]}`);
    } else if (closeout.phase !== phase) {
      refuse('evidence:format', `${evidence} is headed \`# Closeout M${closeout.phase}\`, but milestone #${args.milestone} is phase M${phase}`);
    }
  }
}

if (closeout && closeout.errors.length === 0) {
  const strays = [
    ...(isAncestor(closeout.sha) ? [] : [`main SHA ${closeout.sha}`]),
    ...closeout.rows.filter((r) => !isAncestor(r.sha)).map((r) => `merge commit ${r.sha} for #${r.issue}`),
  ];
  if (strays.length > 0) refuse('evidence:sha', `${evidence}: ${strays.join(', ')} is not an ancestor of ${MAIN}`);

  // Every closed issue of the milestone is accounted for: a row when it
  // shipped, a `## Left out` bullet when it did not.
  const accounted = new Set([...closeout.rows.map((r) => r.issue), ...closeout.leftOut]);
  const unaccounted = issueNumbers('closed').filter((n) => !accounted.has(n));
  if (unaccounted.length > 0) {
    refuse(
      'evidence:issue-missing',
      `${evidence} does not account for ${unaccounted.map((n) => `#${n}`).join(', ')} — ` +
        'every closed issue of the milestone is a row in `## Issues` or a bullet in `## Left out`',
    );
  }
}

if (missing.length > 0) {
  fail({ refused: `milestone #${args.milestone} was not closed: ${reasons.join('; ')}.`, milestone: args.milestone, missing });
}

// --- 6. the one write --------------------------------------------------------
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const block = `Closed ${stamp}, main ${mainSha}, evidence ${expectedEvidence}`;
const body = `${description.replace(/\s+$/, '')}\n\n${block}\n`;

// `-F description=@<file>` rather than an inline value: the description
// carries newlines, which an argument does not survive cleanly. The state
// change rides the same call, so the milestone is never left described as
// closed but still open.
const dir = mkdtempSync(join(tmpdir(), 'agentic-close-milestone-'));
const bodyFile = join(dir, 'description.md');
try {
  writeFileSync(bodyFile, body);
} catch (e) {
  rmSync(dir, { recursive: true, force: true });
  fail({ error: `could not stage the milestone description: ${(e as Error).message}` });
}
const patched = gh([
  'api',
  '-X',
  'PATCH',
  `repos/{owner}/{repo}/milestones/${args.milestone}`,
  '-F',
  `description=@${bodyFile}`,
  '-f',
  'state=closed',
]);
rmSync(dir, { recursive: true, force: true });
if (patched.status !== 0) fail({ error: why(patched, 'gh api -X PATCH failed') });

out({ closed: title, milestone: args.milestone, sha: mainSha, evidence: expectedEvidence }, 0);
