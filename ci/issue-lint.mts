#!/usr/bin/env node
// issue-lint — validates an issue's contract before it is dispatched:
// sections present, globs that parse and match something (or are `new`),
// globs disjoint from the issues already in flight in the same milestone,
// and every `Blocked by: #N` number in the issue actually exists. It never
// reads a diff — the mechanical form of the #3 guard (a rename that drops a
// path without updating the file that referenced it) moved to PR time,
// `scope`'s dangling-reference rule (#51), where a diff exists to check it
// against. issue-lint used to also warn about entry-point references — a
// `git grep` across every covered path/basename that would have caught #3
// at issue time — but it could not tell a rename from an in-place edit, so
// it fired on every ordinary import, doc, or workflow mention of a covered
// path (audit finding 3); that check, and its `--strict` flag (already
// retired from the card by #45 for the same reason), are gone.
//
//   node ci/issue-lint.mts <n> [--markdown] [--root <path>]
//   node ci/issue-lint.mts --issue <n> --issue-body-file <path> \
//     [--milestone-issues-file <path>] [--markdown] [--root <path>]
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
// Output: JSON `{ issue, ok, failures, globs, sequenced }` on stdout by
// default — no `warnings` key any more. `globs`/`sequenced` are additive to
// the four keys the contract names, reporting AC2's `new` status and AC3's
// blocked-by exception. `failures` entries are either a plain string or,
// for AC3 (glob overlap), the object shape the issue's acceptance criteria
// name. --markdown prints a Markdown rendering instead (for the workflow's
// issue comment), starting with the `<!-- agentic-issue-lint -->` marker
// the workflow greps for; it no longer has a Warnings section. Exit 0 when
// `ok`, 1 otherwise; `{ "error": "..." }` (still exit 1) when `gh` cannot
// answer for the issue/milestone lookups themselves (not for a single
// missing `Blocked by:` number, which is a normal failure entry). Any flag
// this script does not know is ignored, with a one-line note on stderr —
// `scripts/claim.mts` no longer passes `--strict` (removed with this
// change), but any other caller's unknown flag never changes stdout or the
// exit code either, so it keeps working.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from './lib/args.mts';
import { globToRegExp, matchesAny } from './lib/globs.mts';
import { parseIssueGlobs } from './lib/scope.mts';
import { blockedBy, checkboxes, PROOF_HEADINGS, REQUIRED_SECTIONS, sections } from './lib/issue.mts';

const MARKER = '<!-- agentic-issue-lint -->';
const RELEVANT_STATES = ['state:ready', 'state:in-progress', 'state:in-review'];

const GH_LIST_LIMIT = '500'; // gh defaults to 30; a milestone can hold more in-flight issues

type Failure = string | { issue: number; files: string[] };
type GlobReport = { glob: string; status: 'matched' | 'new'; matches: number };
type Sequenced = { issue: number; files: string[] };
type Result = {
  issue: number | null;
  ok: boolean;
  failures: Failure[];
  globs: GlobReport[];
  sequenced: Sequenced[];
};

const args = parseArgs(process.argv.slice(2));
const rawArgv = process.argv.slice(2);
const root = typeof args.root === 'string' ? args.root : process.cwd();
const markdown = args.markdown === true || args.markdown === 'true';

// Flags this version reads. Anything else on argv — most notably a caller
// still passing --strict — is ignored rather than rejected; see the header.
const KNOWN_FLAGS = new Set(['root', 'markdown', 'issue', 'issue-body-file', 'milestone-issues-file']);
for (const key of Object.keys(args)) {
  if (!KNOWN_FLAGS.has(key)) console.error(`issue-lint: ignoring unknown flag --${key}`);
}

function output(result: Result): never {
  console.log(markdown ? renderMarkdown(result) : JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

function fail(message: string): never {
  // Always starts with MARKER under --markdown, same as a normal result: a
  // workflow run that dies here (bad milestone-issues.json, git ls-files
  // failure, gh unreachable) still leaves a comment the next run's
  // `startswith` lookup finds, instead of posting a marker-less orphan that
  // duplicates on the next run.
  console.log(markdown ? `${MARKER}\n### issue-lint: ERROR\n\n${message}\n` : JSON.stringify({ error: message }));
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

// --- AC1: sections present, with the per-section minimum content ----------
const sec = sections(body);
for (const heading of REQUIRED_SECTIONS) {
  const text = sec[heading];
  if (text === null || text.trim() === '') {
    const [name, ...aliases] = heading === 'Proof' ? PROOF_HEADINGS : [heading];
    failures.push(`missing or empty section: ## ${name}${aliases.map((alias) => ` (or ## ${alias})`).join('')}`);
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

/** The index of the first wildcard token (`*` or `?`) in a glob, or -1 when
 * it has none. */
function firstWildcardIndex(glob: string): number {
  const indices = [glob.indexOf('*'), glob.indexOf('?')].filter((i) => i !== -1);
  return indices.length === 0 ? -1 : Math.min(...indices);
}

/** Whether a glob is a literal path — no `*` or `?` (no `*` also rules out
 * `**`). */
function isLiteralPath(glob: string): boolean {
  return firstWildcardIndex(glob) === -1;
}

/** For a wildcard glob, the directory its fixed prefix (the part before the
 * first wildcard token, `*` or `?`) is rooted in — e.g. `src/newmod/**` →
 * `src/newmod/`, `src/**\/*.zig` → `src/`. Empty when the glob has no fixed
 * directory prefix at all (e.g. `**\/*.foo` or `?abc`, both of which start
 * with a wildcard token). */
function fixedDirPrefix(glob: string): string {
  const wildcardIndex = firstWildcardIndex(glob);
  const prefix = wildcardIndex === -1 ? glob : glob.slice(0, wildcardIndex);
  const slash = prefix.lastIndexOf('/');
  return slash === -1 ? '' : prefix.slice(0, slash + 1);
}

const globs: GlobReport[] = [];
for (const glob of issueGlobs) {
  // globToRegExp never throws (ci/lib/globs.mts): every character it sees is
  // either one of its wildcard tokens (`**`, `*`, `?`) or gets escaped before
  // reaching `new RegExp` (#42), so there is no "glob does not parse" case.
  const regex = globToRegExp(glob);
  const matches = trackedFiles.filter((f) => regex.test(f));
  if (matches.length > 0) {
    globs.push({ glob, status: 'matched', matches: matches.length });
  } else if (isLiteralPath(glob)) {
    // A literal path names a file the issue creates. Its parent directory
    // may not exist yet on disk — that is exactly what "new" means when the
    // issue also introduces a new directory (#37) — so only a wildcard that
    // matches nothing is treated as a mistake.
    globs.push({ glob, status: 'new', matches: 0 });
  } else {
    // A wildcard that matches nothing is "new" too, but only when its fixed
    // prefix names a directory that does not exist anywhere in the tracked
    // tree — the natural way to declare a whole new directory (#41). A
    // wildcard whose prefix directory does exist, or that has no fixed
    // directory prefix at all, matching nothing is still a mistake.
    const dirPrefix = fixedDirPrefix(glob);
    const dirExists = dirPrefix !== '' && trackedFiles.some((f) => f.startsWith(dirPrefix));
    if (dirPrefix !== '' && !dirExists) {
      globs.push({ glob, status: 'new', matches: 0 });
    } else {
      failures.push(`wildcard glob matches no tracked file: ${glob}`);
    }
  }
}

/** Literal (non-wildcard) globs from `list` that name no tracked file — the
 * "new" paths an issue declares. Comparing these (in addition to matched
 * tracked files) is what lets two issues both declaring the same new path
 * overlap, even though neither path is tracked yet. */
function newLiteralPaths(list: string[]): string[] {
  return list.filter((g) => isLiteralPath(g) && !trackedFiles.includes(g));
}

/** The directory-level counterpart of `newLiteralPaths`: each wildcard
 * glob's fixed directory prefix, kept only when that directory has no
 * tracked file anywhere (the same "new" test the per-glob AC2 check above
 * makes). A literal-path-vs-full-glob comparison (`newLiteralPaths` against
 * `matchesAny`) already catches a literal new path landing inside another
 * issue's wildcard, because the regex for e.g. `newmod/**` matches any path
 * under it — but it has nothing to compare when *both* sides are wildcards
 * over the same brand-new directory, since neither side declares a literal
 * path and `newLiteralPaths` collects only those. Comparing fixed prefixes
 * closes that hole (round 2 of #41). */
function newWildcardPrefixes(list: string[]): string[] {
  const prefixes = list
    .filter((g) => !isLiteralPath(g))
    .map(fixedDirPrefix)
    .filter((p) => p !== '' && !trackedFiles.some((f) => f.startsWith(p)));
  return [...new Set(prefixes)];
}

/** Whether two new (untracked) paths — a literal path or a wildcard's fixed
 * directory prefix — claim overlapping territory: the same path, or one a
 * directory prefix of the other (`newmod/` and `newmod/sub/`, in either
 * order). */
function newPathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

// --- AC3: disjointness against issues in flight in the same milestone -----
const selfMatchedFiles = trackedFiles.filter((f) => matchesAny(f, issueGlobs));
const selfNewPaths = newLiteralPaths(issueGlobs);
const selfNewPrefixes = newWildcardPrefixes(issueGlobs);
const sequenced: Sequenced[] = [];
for (const other of others) {
  if (!other.labels.some((l) => RELEVANT_STATES.includes(l))) continue;
  const otherGlobs = parseIssueGlobs(other.body);
  if (otherGlobs.length === 0) continue;
  const otherNewPaths = newLiteralPaths(otherGlobs);
  const otherNewPrefixes = newWildcardPrefixes(otherGlobs);
  const overlapTrackedFiles = selfMatchedFiles.filter((f) => matchesAny(f, otherGlobs));
  const overlapNewPaths = [
    ...selfNewPaths.filter((p) => matchesAny(p, otherGlobs)),
    ...otherNewPaths.filter((p) => matchesAny(p, issueGlobs)),
  ];
  // Wildcard-vs-wildcard (and literal-vs-wildcard-prefix) new-directory
  // overlap: the fixed-prefix comparison the regex-based check above can't
  // make, since neither wildcard's pattern necessarily matches the other's
  // literal shape. Mirrors both legs `newLiteralPaths` gets above: a new
  // prefix against the other side's own new prefixes/paths (`newPathsOverlap`),
  // *and* a new prefix against the other side's full glob list (`matchesAny`)
  // — the second leg is what catches a brand-new directory nested under an
  // *existing* tracked directory the other issue's wildcard already covers
  // (`tests/newsub/**`, new, under `tests/**`, matched — `tests/**` never
  // lands in `otherNewPrefixes` since `tests/` is tracked).
  const overlapNewPrefixes = [
    ...selfNewPrefixes.filter((p) => matchesAny(p, otherGlobs)),
    ...otherNewPrefixes.filter((p) => matchesAny(p, issueGlobs)),
    ...selfNewPrefixes.filter((p) => [...otherNewPrefixes, ...otherNewPaths].some((q) => newPathsOverlap(p, q))),
    ...otherNewPrefixes.filter((p) => [...selfNewPrefixes, ...selfNewPaths].some((q) => newPathsOverlap(p, q))),
  ];
  const overlapFiles = [...new Set([...overlapTrackedFiles, ...overlapNewPaths, ...overlapNewPrefixes])];
  if (overlapFiles.length === 0) continue;
  const otherBlockedBy = blockedBy(other.body) ?? [];
  const isSequenced = (selfBlockedBy ?? []).includes(other.number) || otherBlockedBy.includes(issueNumber);
  if (isSequenced) sequenced.push({ issue: other.number, files: overlapFiles });
  else failures.push({ issue: other.number, files: overlapFiles });
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
  if (result.sequenced.length > 0) {
    lines.push('**Sequenced** (overlap accepted — a Blocked-by relation orders these issues):', '');
    for (const s of result.sequenced) lines.push(`- #${s.issue}: ${s.files.map((x) => `\`${x}\``).join(', ')}`);
    lines.push('');
  }
  const newGlobs = result.globs.filter((g) => g.status === 'new');
  if (newGlobs.length > 0) {
    lines.push('**New** (literal path the issue creates; no tracked file matches it yet):', '');
    for (const g of newGlobs) lines.push(`- \`${g.glob}\``);
    lines.push('');
  }
  return lines.join('\n');
}

const ok = failures.length === 0;
output({ issue: issueNumber, ok, failures, globs, sequenced });
