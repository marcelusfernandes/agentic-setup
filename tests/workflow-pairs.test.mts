#!/usr/bin/env node
// Cases for the agentic-checks workflow pair: this repository's own
// `.github/workflows/agentic-checks.yml` and the copy `init` ships to
// adopting repositories, `templates/.github/workflows/agentic-checks.yml`.
// Nothing compared the two before this file; `tests/guard-main.test.mts`
// does the same shape for `guard-main.yml` and is where this one's
// `firstDifference` report comes from.
//
// The pair is **not** byte-identical and is not meant to be: the two `run:`
// lines name the script paths, which differ because `scripts/init.mts`
// copies this repository's `ci/` into an adopting repository's
// `.github/scripts/agentic/`. So the pin holds them equal *modulo an
// enumerated set*, and the set is written out line for line below rather
// than matched by a pattern. A pattern — "a line containing a path", "a
// line starting with `run:`" — would silently absorb the third difference
// somebody introduces, which is the whole failure mode this file exists to
// close. The duplication is the point (invariant 10): the expected shape is
// written here, not imported from the files it checks.
//
// It also pins what the trigger list and the header say, because those are
// what changed when the pair stopped re-running on a label edit. A label
// cannot move either check's verdict — `scope` reads no label at all and
// `negative-control` reads one only to print a `note:` — so `labeled` and
// `unlabeled` are not in `types:`, and the header states what each check
// reads separately instead of claiming both read the same two things.
//
// Negative control, measured on `d698b56` by restoring both copies to their
// base contents and running this file: 21 passed, 10 failed. The ten are the
// six header cases and the four trigger cases — the base's header says "Both
// read the PR body and labels, so they re-run when the PR is edited or
// relabelled", and `types:` carries `labeled, unlabeled` in each copy. The
// equality cases pass on the base on purpose: the copies agree there today,
// as they do for `guard-main.yml`, and the case is here to keep them
// agreeing.
//
// The eight cases at the foot, over five synthetic scenarios, pass on the
// base too, and are meant to. They are regression guards on the comparison
// itself — an allowed difference is not a stray; a header edit and a job-body
// edit each are one; a third `run:` line naming a script path is one as well,
// which is what a pattern-based pin would have swallowed; and a copy shorter
// than the other is reported rather than read past the end. They assert
// nothing about the two real files, so nothing about them is red anywhere.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finish, ROOT } from './lib/harness.mts';

const OWN_PATH = join('.github', 'workflows', 'agentic-checks.yml');
const SHIPPED_PATH = join('templates', '.github', 'workflows', 'agentic-checks.yml');
const own = readFileSync(join(ROOT, OWN_PATH), 'utf8');
const shipped = readFileSync(join(ROOT, SHIPPED_PATH), 'utf8');

// --- the comparison ---------------------------------------------------------

/** One line at which the two copies differ, 1-based, with both sides. */
type Difference = { line: number; own: string; shipped: string };

const MISSING = '<missing>';

/** Every line at which two texts differ, in order. */
function differences(a: string, b: string): Difference[] {
  const left = a.split('\n');
  const right = b.split('\n');
  const found: Difference[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) found.push({ line: i + 1, own: left[i] ?? MISSING, shipped: right[i] ?? MISSING });
  }
  return found;
}

/** A difference as a failure message names it: the line, then both sides. */
function describe(d: Difference): string {
  return `line ${d.line}: ${d.own} | ${d.shipped}`;
}

/**
 * The two differences the pair is allowed, written out whole. Two, measured
 * with `diff` — not the four an earlier reading of this pair guessed — and
 * both of them `run:` lines. Line numbers are deliberately absent: the
 * header above these lines is edited by ordinary work, which moves them,
 * and a pin keyed on an index breaks on the pull request that edits the
 * comment. The text is the identity.
 */
const ALLOWED: ReadonlyArray<{ own: string; shipped: string }> = [
  {
    own: '        run: node ci/scope-check.mts',
    shipped: '        run: node .github/scripts/agentic/scope-check.mts',
  },
  {
    own: '        run: node ci/negative-control.mts --base "$BASE_SHA" --head "$HEAD_SHA" --branch "$GITHUB_HEAD_REF"',
    shipped: '        run: node .github/scripts/agentic/negative-control.mts --base "$BASE_SHA" --head "$HEAD_SHA" --branch "$GITHUB_HEAD_REF"',
  },
];

/** True when `d` is one of the differences the pair is allowed. */
function isAllowed(d: Difference): boolean {
  return ALLOWED.some((a) => a.own === d.own && a.shipped === d.shipped);
}

/** The differences that are not in `ALLOWED`, in order. */
function unexpected(a: string, b: string): Difference[] {
  return differences(a, b).filter((d) => !isAllowed(d));
}

// --- the pair, held equal modulo the enumerated set -------------------------

const live = differences(own, shipped);
const strays = unexpected(own, shipped);

check(
  `${OWN_PATH} and ${SHIPPED_PATH} differ only on the lines this file enumerates`,
  strays.length === 0,
  strays.map(describe).join('\n      '),
);

// A set that stops matching is a set that permits everything. Each entry has
// to be a difference the files really have, or the enumeration has rotted
// into a wildcard and the case above would pass over a changed `run:` line.
for (const allowed of ALLOWED) {
  check(
    `the enumerated difference is really in the pair: ${allowed.own.trim()}`,
    live.some((d) => d.own === allowed.own && d.shipped === allowed.shipped),
    live.map(describe).join('\n      '),
  );
}

check(
  `the pair differs on exactly ${ALLOWED.length} line(s)`,
  live.length === ALLOWED.length,
  `${live.length} difference(s):\n      ${live.map(describe).join('\n      ')}`,
);

// --- the header says what each check reads, separately ----------------------
// The two copies share this header, so reading one reads both: a header
// difference is a stray above.

const header = own.slice(0, own.indexOf('\nname:'));
check('the workflow has a header above `name:` to read', header.length > 0, own.slice(0, 200));

check(
  'the header says `scope` reads the PR body, naming it as that check\'s input',
  /`scope` reads the PR body/.test(header.replace(/\n#\s*/g, ' ')),
  header,
);
check(
  'the header says `negative-control` reads the diff\'s path classes',
  /`negative-control` reads the diff's path classes/.test(header.replace(/\n#\s*/g, ' ')),
  header,
);
check(
  'the header says the labels `negative-control` reads only annotate',
  /annotat/i.test(header) && /label/.test(header),
  header,
);
check(
  'the header no longer claims both checks read the PR body and labels',
  !/Both read the PR body and labels/.test(header),
  header,
);
check(
  'the header no longer claims the two re-run when the PR is relabelled',
  !/re-run when the PR is edited or\s*#?\s*relabelled/.test(header.replace(/\n#/g, '\n#')),
  header,
);
check(
  'the header states the two copies are pinned by tests/workflow-pairs.test.mts, modulo the two `run:` lines',
  /identical/.test(header) && header.includes('tests/workflow-pairs.test.mts') && /`run:`/.test(header),
  header,
);

// --- the trigger -----------------------------------------------------------
// `labeled`/`unlabeled` are gone because neither check's verdict can depend
// on a label. `edited` stays because `scope` reads the PR body for its
// `Closes #N` links, and those decide which issues' globs it audits, so a
// body edit genuinely can change its verdict.

/** The `types:` list of the file's one `pull_request` trigger, as names. */
function triggerTypes(yaml: string): string[] {
  const m = /^\s*types:\s*\[([^\]]*)\]\s*$/m.exec(yaml);
  if (m === null) return [];
  return (m[1] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

for (const [path, text] of [[OWN_PATH, own], [SHIPPED_PATH, shipped]] as const) {
  const types = triggerTypes(text);
  check(`${path} declares a pull_request types: list`, types.length > 0, text);
  check(`${path} does not run on \`labeled\``, !types.includes('labeled'), types.join(', '));
  check(`${path} does not run on \`unlabeled\``, !types.includes('unlabeled'), types.join(', '));
  check(`${path} still runs on \`synchronize\``, types.includes('synchronize'), types.join(', '));
  check(`${path} still runs on \`edited\``, types.includes('edited'), types.join(', '));
  check(`${path} still runs on \`opened\` and \`reopened\``, types.includes('opened') && types.includes('reopened'), types.join(', '));
}

// --- broken both ways, on texts written here --------------------------------
// The two breaks the pair's own criteria name — a header edited in one copy
// only, and a job body edited in one copy only — plus the one a pattern-based
// pin would miss: a third difference that looks exactly like the two allowed
// ones. Done on synthetic text rather than by editing the real files, so the
// case is repeatable and leaves nothing behind; the same two breaks were made
// on the real files by hand before this landed, and each reds the case above.

const A = [
  '# a header line',
  'name: agentic-checks',
  '      - name: scope',
  '        run: node ci/scope-check.mts',
].join('\n');
const B = [
  '# a header line',
  'name: agentic-checks',
  '      - name: scope',
  '        run: node .github/scripts/agentic/scope-check.mts',
].join('\n');

check('the allowed `run:` difference alone is reported as no stray', unexpected(A, B).length === 0, unexpected(A, B).map(describe).join('; '));

const headerEdited = B.replace('# a header line', '# a header line, edited in one copy only');
const headerStrays = unexpected(A, headerEdited);
check('a header edited in one copy only is a stray', headerStrays.length === 1, headerStrays.map(describe).join('; '));
check(
  'the header stray names its line and both sides, rather than reporting inequality',
  describe(headerStrays[0] ?? { line: 0, own: '', shipped: '' }) ===
    'line 1: # a header line | # a header line, edited in one copy only',
  headerStrays.map(describe).join('; '),
);

const bodyEdited = B.replace('      - name: scope', '      - name: scope-renamed');
const bodyStrays = unexpected(A, bodyEdited);
check('a job body edited in one copy only is a stray', bodyStrays.length === 1, bodyStrays.map(describe).join('; '));
check(
  'the job-body stray names its line and both sides',
  describe(bodyStrays[0] ?? { line: 0, own: '', shipped: '' }) === 'line 3:       - name: scope |       - name: scope-renamed',
  bodyStrays.map(describe).join('; '),
);

// The one a pattern would swallow: another `run:` line naming another path.
const thirdPath = [A, '        run: node ci/issue-lint.mts'].join('\n');
const thirdPathShipped = [B, '        run: node .github/scripts/agentic/issue-lint.mts'].join('\n');
const thirdStrays = unexpected(thirdPath, thirdPathShipped);
check(
  'a third `run:` line naming a script path is a stray, not absorbed by the shape of the two allowed ones',
  thirdStrays.length === 1,
  thirdStrays.map(describe).join('; '),
);
check(
  'the third-path stray names its line',
  (thirdStrays[0]?.line ?? 0) === 5,
  thirdStrays.map(describe).join('; '),
);

// A copy that is shorter than the other is a difference, not a crash.
const truncated = B.split('\n').slice(0, 2).join('\n');
const truncStrays = unexpected(A, truncated);
check('a truncated copy is reported line by line, naming <missing>', truncStrays.length === 2 && truncStrays.every((d) => d.shipped === MISSING), truncStrays.map(describe).join('; '));

finish();
