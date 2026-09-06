#!/usr/bin/env node
// issue-lint — validates an issue's contract before it is dispatched:
// sections present, globs that parse and match something, globs disjoint
// from the issues already in flight in the same milestone, and every file
// the issue's globs cover checked for other tracked files that reference it
// by path or basename (the check that would have caught #3: an issue that
// renames an entry point without naming the file that references it).
//
//   node ci/issue-lint.mts <n> [--strict] [--markdown] [--root <path>]
//   node ci/issue-lint.mts --issue <n> --issue-body-file <path> \
//     [--milestone-issues-file <path>] [--strict] [--markdown] [--root <path>]
//
// <n> (or --issue) is the issue number. Without --issue-body-file, the
// issue's body and milestone come from `gh issue view`, and the other
// issues in the same open milestone from `gh issue list --milestone
// <title> --state open`. --issue-body-file/--milestone-issues-file (a JSON
// array of `{ number, labels, body }` for the *other* issues) let the whole
// lint run without `gh` — used by the workflow (which already has the data
// from the `issues` event and one `gh issue list` call) and by tests.
// AC5 (`Blocked by:` numbers exist) always calls `gh issue view` for each
// number, in both modes — a fake `gh` on PATH covers it in tests.
//
// Output: JSON `{ issue, ok, failures, warnings, globs, sequenced }` on
// stdout by default — `globs`/`sequenced` are additive to the four keys
// AC6 names, reporting AC2's `new` status and AC3's blocked-by exception.
// `failures`/`warnings` entries are either a plain string or, for AC3
// (glob overlap) and AC4 (entry-point reference), the object shape the
// issue's acceptance criteria name. --markdown prints a Markdown rendering
// instead (for the workflow's issue comment), starting with the
// `<!-- agentic-issue-lint -->` marker the workflow greps for. --strict
// makes AC4 warnings count toward `ok`/exit code. Exit 0 when `ok`, 1
// otherwise; `{ "error": "..." }` (still exit 1) when `gh` cannot answer
// for the issue/milestone lookups themselves (not for a single missing
// `Blocked by:` number, which is a normal failure entry).
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from './lib/args.mts';
import { globToRegExp, matchesAny } from './lib/globs.mts';
import { parseIssueGlobs } from './lib/scope.mts';
import { blockedBy, checkboxes, REQUIRED_SECTIONS, sections } from './lib/issue.mts';

const MARKER = '<!-- agentic-issue-lint -->';
const RELEVANT_STATES = ['state:ready', 'state:in-progress', 'state:in-review'];
const EXCLUDE_GLOBS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock*', 'docs/research/**'];

const GH_LIST_LIMIT = '500'; // gh defaults to 30; a milestone can hold more in-flight issues

type Failure = string | { issue: number; files: string[] };
type Warning = { file: string; referencedBy: string };
type GlobReport = { glob: string; status: 'matched' | 'new'; matches: number };
type Sequenced = { issue: number; files: string[] };
type Result = {
  issue: number | null;
  ok: boolean;
  failures: Failure[];
  warnings: Warning[];
  globs: GlobReport[];
  sequenced: Sequenced[];
};

const args = parseArgs(process.argv.slice(2));
const rawArgv = process.argv.slice(2);
const root = typeof args.root === 'string' ? args.root : process.cwd();
const strict = args.strict === true || args.strict === 'true';
const markdown = args.markdown === true || args.markdown === 'true';

function output(result: Result): never {
  console.log(markdown ? renderMarkdown(result) : JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

function fail(message: string): never {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

function gh(ghArgs: string[]): string {
  const r = spawnSync('gh', ghArgs, { encoding: 'utf8' });
  if (r.status !== 0) fail(`gh ${ghArgs.join(' ')} failed: ${(r.stderr || r.stdout || 'failed').trim().split('\n')[0]}`);
  return r.stdout;
}

function git(gitArgs: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// --- gather: this issue's number/body, and the other issues in its milestone
const positionalNumber = /^\d+$/.test(rawArgv[0] ?? '') ? Number(rawArgv[0]) : null;
const issueNumber = positionalNumber ?? (typeof args.issue === 'string' && /^\d+$/.test(args.issue) ? Number(args.issue) : null);
if (issueNumber === null) fail('no issue number given (positional <n>, or --issue <n> with --issue-body-file).');

type OtherIssue = { number: number; labels: string[]; body: string };

let body: string;
let others: OtherIssue[];

if (typeof args['issue-body-file'] === 'string') {
  body = readFileSync(args['issue-body-file'], 'utf8');
  others = [];
  if (typeof args['milestone-issues-file'] === 'string') {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(args['milestone-issues-file'], 'utf8'));
    } catch {
      fail(`--milestone-issues-file is not valid JSON.`);
    }
    if (!Array.isArray(raw)) fail('--milestone-issues-file must contain a JSON array.');
    others = raw
      .filter((i: any) => Number(i?.number) !== issueNumber)
      .map((i: any) => ({
        number: Number(i.number),
        labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
        body: String(i.body ?? ''),
      }));
  }
} else {
  const raw = gh(['issue', 'view', String(issueNumber), '--json', 'body,milestone']);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('gh issue view returned invalid JSON.');
  }
  body = String(parsed.body ?? '');
  const milestoneTitle = parsed.milestone?.title;
  if (!milestoneTitle) {
    others = [];
  } else {
    const listRaw = gh(['issue', 'list', '--milestone', milestoneTitle, '--state', 'open', '--limit', GH_LIST_LIMIT, '--json', 'number,labels,body']);
    let list: any[];
    try {
      list = JSON.parse(listRaw);
    } catch {
      fail('gh issue list returned invalid JSON.');
    }
    others = list
      .filter((i) => Number(i.number) !== issueNumber)
      .map((i) => ({ number: Number(i.number), labels: (i.labels ?? []).map((l: any) => l.name), body: String(i.body ?? '') }));
  }
}

const failures: Failure[] = [];
const warnings: Warning[] = [];

// --- AC1: sections present, with the per-section minimum content ----------
const sec = sections(body);
for (const heading of REQUIRED_SECTIONS) {
  const text = sec[heading];
  if (text === null || text.trim() === '') {
    failures.push(`missing or empty section: ## ${heading}`);
  }
}
if (sec['Acceptance criteria'] && checkboxes(sec['Acceptance criteria']).length === 0) {
  failures.push('## Acceptance criteria has no "- [ ]" item');
}
const issueGlobs = parseIssueGlobs(body);
if (sec['Files'] && issueGlobs.length === 0) {
  failures.push('## Files has no bullet glob');
}
const selfBlockedBy = blockedBy(body);
if (sec['Dependencies'] && selfBlockedBy === null) {
  failures.push('## Dependencies has no "Blocked by:" line');
}

// --- AC2: each glob parses and matches something (tracked, or new) --------
const lsFiles = git(['ls-files']);
if (lsFiles.status !== 0) fail(`git ls-files failed: ${lsFiles.stderr.trim()}`);
const trackedFiles = lsFiles.stdout.split('\n').map((l) => l.trim()).filter(Boolean);

/** The literal (non-wildcard) path segment a glob names, wildcard stripped. */
function globNamedPath(glob: string): string {
  const idx = glob.indexOf('*');
  const literal = idx === -1 ? glob : glob.slice(0, idx);
  return literal.endsWith('/') ? literal.slice(0, -1) : literal;
}

/** Whether the directory *above* the path a glob names exists on disk. */
function parentExists(glob: string): boolean {
  const named = globNamedPath(glob);
  const parent = dirname(named);
  if (parent === '.' || parent === '') return true;
  try {
    return statSync(join(root, parent)).isDirectory();
  } catch {
    return false;
  }
}

const globs: GlobReport[] = [];
for (const glob of issueGlobs) {
  let regex: RegExp;
  try {
    regex = globToRegExp(glob);
  } catch {
    failures.push(`glob does not parse: ${glob}`);
    continue;
  }
  const matches = trackedFiles.filter((f) => regex.test(f));
  if (matches.length > 0) {
    globs.push({ glob, status: 'matched', matches: matches.length });
  } else if (parentExists(glob)) {
    globs.push({ glob, status: 'new', matches: 0 });
  } else {
    failures.push(`glob matches no tracked file and has no existing parent directory: ${glob}`);
  }
}

// --- AC3: disjointness against issues in flight in the same milestone -----
const selfMatchedFiles = trackedFiles.filter((f) => matchesAny(f, issueGlobs));
const sequenced: Sequenced[] = [];
for (const other of others) {
  if (!other.labels.some((l) => RELEVANT_STATES.includes(l))) continue;
  const otherGlobs = parseIssueGlobs(other.body);
  if (otherGlobs.length === 0) continue;
  const overlapFiles = selfMatchedFiles.filter((f) => matchesAny(f, otherGlobs));
  if (overlapFiles.length === 0) continue;
  const otherBlockedBy = blockedBy(other.body) ?? [];
  const isSequenced = (selfBlockedBy ?? []).includes(other.number) || otherBlockedBy.includes(issueNumber);
  if (isSequenced) sequenced.push({ issue: other.number, files: overlapFiles });
  else failures.push({ issue: other.number, files: overlapFiles });
}

// --- AC4: entry-point references — files outside the issue's globs that
// mention a covered file's path or basename. `git grep` runs with no
// pathspec (it only ever searches tracked files) so the argument list stays
// small even in a large repository; the outside/exclude filtering happens
// here in Node against the hit list instead. -------------------------------
const coveredSet = new Set(selfMatchedFiles);
const outsideFiles = new Set(trackedFiles.filter((f) => !coveredSet.has(f) && !matchesAny(f, EXCLUDE_GLOBS)));
if (outsideFiles.size > 0) {
  for (const covered of selfMatchedFiles) {
    const base = basename(covered);
    const patterns = ['-e', covered];
    if (!(base.length < 4 || /^index\./i.test(base) || base === 'README.md')) {
      patterns.push('-e', base);
    }
    const r = spawnSync('git', ['grep', '-I', '-l', '-F', ...patterns], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status === 0) {
      for (const hit of r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
        if (outsideFiles.has(hit)) warnings.push({ file: covered, referencedBy: hit });
      }
    } else if (r.status !== 1 && r.status !== null) {
      failures.push(`git grep failed while checking references to ${covered}: ${r.stderr.trim().split('\n')[0]}`);
    }
  }
}

// --- AC5: every "Blocked by: #N" number must exist -------------------------
if (selfBlockedBy) {
  for (const n of selfBlockedBy) {
    const r = spawnSync('gh', ['issue', 'view', String(n), '--json', 'number'], { encoding: 'utf8' });
    if (r.status !== 0) {
      failures.push(`Blocked by references #${n}, which gh cannot find: ${(r.stderr || r.stdout || 'failed').trim().split('\n')[0]}`);
    }
  }
}

function renderMarkdown(result: Result): string {
  const lines = [MARKER, `### issue-lint for #${result.issue}: ${result.ok ? 'PASS' : 'FAIL'}`, ''];
  if (result.failures.length === 0) {
    lines.push('No failures.');
  } else {
    lines.push('**Failures:**', '');
    for (const f of result.failures) {
      lines.push(typeof f === 'string' ? `- ${f}` : `- overlaps #${f.issue}: ${f.files.map((x) => `\`${x}\``).join(', ')}`);
    }
  }
  lines.push('');
  if (result.warnings.length > 0) {
    lines.push('**Warnings** (entry-point references outside `## Files`):', '');
    for (const w of result.warnings) lines.push(`- \`${w.file}\` is referenced by \`${w.referencedBy}\``);
    lines.push('');
  }
  if (result.sequenced.length > 0) {
    lines.push('**Sequenced** (overlap accepted — a Blocked-by relation orders these issues):', '');
    for (const s of result.sequenced) lines.push(`- #${s.issue}: ${s.files.map((x) => `\`${x}\``).join(', ')}`);
    lines.push('');
  }
  const newGlobs = result.globs.filter((g) => g.status === 'new');
  if (newGlobs.length > 0) {
    lines.push('**New** (glob names no tracked file yet, but its parent directory exists):', '');
    for (const g of newGlobs) lines.push(`- \`${g.glob}\``);
    lines.push('');
  }
  return lines.join('\n');
}

const ok = failures.length === 0 && (!strict || warnings.length === 0);
output({ issue: issueNumber, ok, failures, warnings, globs, sequenced });
