#!/usr/bin/env node
// Cases for ci/negative-control.mts: the tests a PR adds must fail on the
// base without the PR's change, unless the PR's whole diff sits in a skipped
// path class (docs, workflows, templates, Markdown anywhere in the tree,
// session configuration, or whatever AGENTIC_SKIP_GLOBS adds). A `type:`
// label no longer skips by itself.
//
// The declaration cases at the end are the fail-closed half: a
// `proof/<slug>.json` the check cannot read, or that names a path the head
// does not have or a path outside the checkout, is `cannot-run` — never a
// silent fall back to the diff's globs, which would report "we could not
// verify this" as "this passed".
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { check, ci, commit, finish, git, tempRepo } from './lib/harness.mts';

const repo = tempRepo();
const pkg = JSON.stringify({ name: 'x', private: true, scripts: { test: 'node tests/check.mts' } });
const base = commit(repo, {
  'package.json': pkg,
  'lib.mts': 'export const v = 1;\n',
  'tests/check.mts': 'process.exit(0);\n',
}, 'chore: base');

git(['checkout', '-q', '-b', 'feat/1-x'], repo);
const head = commit(repo, {
  'lib.mts': 'export const v = 2;\n',
  'tests/check.mts': "import { v } from '../lib.mts';\nprocess.exit(v === 2 ? 0 : 1);\n",
}, 'feat: v2');
git(['checkout', '-q', '-b', 'feat/3-notests', base], repo);
const noTestsHead = commit(repo, { 'lib.mts': 'export const v = 4;\n' }, 'feat: no tests');
git(['checkout', '-q', 'feat/1-x'], repo);
const nc = (h: string, labels = '', b = base, env: Record<string, string> = {}) =>
  ci('negative-control.mts', ['--base', b, '--head', h, ...(labels ? ['--labels', labels] : [])], { cwd: repo, env });

let r = nc(head);
check('negative-control passes when the new test fails on the base', r.status === 0 && /\bpass\b/.test(r.out) && !/warning:/.test(r.out), r.out);

// --- the skip is by path class, not by the PR's own `type:` label ----------
// A diff that is entirely docs, workflows, templates or root Markdown owes
// no negative control; a `type:` label alone no longer buys the exemption,
// because the implementer applies its own PR's labels.
git(['checkout', '-q', '-b', 'docs/4-docs-only', base], repo);
const docsHead = commit(repo, {
  'docs/guide.md': '# guide\n',
  'README.md': '# x\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'templates/sample.txt': 'sample\n',
}, 'docs: docs, workflow, template and root markdown only');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(docsHead);
check('negative-control skips a diff entirely in the skipped path classes', r.status === 0 && /skipped/.test(r.out), r.out);

r = nc(noTestsHead, 'type:docs');
check('a type:docs label alone no longer skips a diff outside the path classes', r.status === 1 && /no-tests/.test(r.out), r.out);
check('the deprecated label read is reported as a note', /note:/.test(r.out) && /type:docs/.test(r.out), r.out);
check('negative-control does not skip type:feature', /no-tests/.test(nc(noTestsHead, 'type:feature').out));

r = nc(noTestsHead, '', base, { AGENTIC_SKIP_GLOBS: 'lib.mts' });
check('AGENTIC_SKIP_GLOBS extends the skipped path classes', r.status === 0 && /skipped/.test(r.out), r.out);

// Markdown is a skipped class wherever it lives, and so is session
// configuration. `*` never crosses a `/` (ci/lib/globs.mts), so `*.md` alone
// covered root-level Markdown only: a pull request touching nothing but
// `skills/x/SKILL.md` or `agents/y.md` failed as `no-tests` although there
// was nothing to test. `.claude/**` is session configuration, which no test
// covers either.
git(['checkout', '-q', '-b', 'docs/16-nested-markdown', base], repo);
const nestedMarkdownHead = commit(repo, {
  'skills/x/SKILL.md': '# skill\n',
  'agents/y.md': '# agent\n',
}, 'docs: a skill card and an agent card, both outside docs/**');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(nestedMarkdownHead);
check(
  'Markdown outside docs/** is a skipped path class, not no-tests',
  r.status === 0 && /skipped/.test(r.out),
  r.out,
);

git(['checkout', '-q', '-b', 'chore/17-session-config', base], repo);
const sessionConfigHead = commit(repo, {
  '.claude/settings.json': '{"permissions":{}}\n',
}, 'chore: session configuration only');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(sessionConfigHead);
check(
  'a diff confined to .claude/** is a skipped path class, not no-tests',
  r.status === 0 && /skipped/.test(r.out),
  r.out,
);

// --- the gate may not exempt a change to its own code ----------------------
// `scripts/init.mts` copies this repository's `ci/` into an adopting
// repository's `.github/scripts/agentic/`, which the `.github/**` class would
// otherwise swallow whole: a pull request rewriting the negative control
// itself would be skipped by the negative control. That one path is carved
// out of every skipped class, AGENTIC_SKIP_GLOBS included.
git(['checkout', '-q', '-b', 'fix/5-gate-code', base], repo);
const gateCodeHead = commit(repo, {
  '.github/scripts/agentic/negative-control.mts': 'process.exit(0);\n',
}, "fix: rewrite the adopting repository's copy of the gate");
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(gateCodeHead);
check(
  'a diff confined to .github/scripts/agentic/** is not skipped by path class',
  r.status === 1 && /no-tests/.test(r.out),
  r.out,
);
r = nc(gateCodeHead, '', base, { AGENTIC_SKIP_GLOBS: '.github/scripts/agentic/**' });
check(
  "AGENTIC_SKIP_GLOBS cannot re-admit the gate's own code to a skipped class",
  r.status === 1 && /no-tests/.test(r.out),
  r.out,
);

// A docs-only diff that also carries one file of the gate's own code is not a
// docs-only diff: the skip is `every`, and that one file is never in a class.
git(['checkout', '-q', '-b', 'docs/6-docs-plus-gate', base], repo);
const docsPlusGateHead = commit(repo, {
  'docs/guide.md': '# guide\n',
  '.github/scripts/agentic/negative-control.mts': 'process.exit(0);\n',
}, 'docs: a doc and one file of the gate');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(docsPlusGateHead);
check(
  'one gate-code file keeps an otherwise docs-only diff out of the skip',
  r.status === 1 && /no-tests/.test(r.out),
  r.out,
);

git(['checkout', '-q', '-b', 'feat/2-vacuous', base], repo);
const vacuous = commit(repo, { 'lib.mts': 'export const v = 3;\n', 'tests/check.mts': "console.log('looks tested');\nprocess.exit(0);\n" }, 'feat: vacuous');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(vacuous);
check('negative-control fails a vacuous test', r.status === 1 && /vacuous/.test(r.out), r.out);
// A `vacuous` verdict on a brand-new test tree is the costliest one to read
// wrong: a test command that enumerates its test directories keeps running
// the base's own list and stays green. The detail names that trap and states
// the real overlay rule — the entry point is overlaid when a test glob
// matches it or a declaration's `tests` names it, which is what lets the fix
// prove itself in the same PR — rather than leaving the next run to
// rediscover it. The pins below match a stem plus its object, so rewording
// the sentence is free and dropping the hint is not.
check(
  'the vacuous detail names the enumerating entry point that hides a new test tree',
  /entry point/.test(r.out) && /enumerat/.test(r.out) && /test director/.test(r.out) && /discover/.test(r.out),
  r.out,
);
check(
  'the vacuous detail states when the entry point is overlaid, naming both the test globs and a declaration `tests`',
  /overlaid only when/.test(r.out) && /AGENTIC_TEST_GLOBS/.test(r.out) && /proof\/<slug>\.json/.test(r.out) && /`tests`/.test(r.out),
  r.out,
);

r = nc(noTestsHead);
check('negative-control fails when no test file changed', r.status === 1 && /no-tests/.test(r.out), r.out);

// A base that cannot run its own test command (a structural failure, not the
// negative control biting) must not be reported as `pass`: it must be
// `inconclusive`, before the head's test files are ever overlaid.
git(['checkout', '-q', '-b', 'chore/badbase', base], repo);
const badBase = commit(repo, {
  'package.json': JSON.stringify({ name: 'x', private: true, scripts: { test: 'exit 1' } }),
}, 'chore: base whose own test script already fails');
const badBaseHead = commit(repo, { 'tests/other.test.mts': 'process.exit(0);\n' }, 'feat: add a test file');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(badBaseHead, '', badBase);
check(
  'negative-control is inconclusive when the base does not pass its own tests',
  r.status === 1 && /inconclusive/.test(r.out) && /does not pass its own tests/.test(r.out),
  r.out,
);

// A red on the base that is a structural failure (a missing export) rather
// than a runtime assertion proves nothing on its own: an opaque test command
// cannot tell a crashing file apart from a real failure. It is accepted only
// when a `test(red):` commit in base..head touches one of the overlaid test
// files — the PR then shows the red was written first, on purpose.
git(['checkout', '-q', '-b', 'feat/7-structural', base], repo);
const structuralHead = commit(repo, {
  'tests/check.mts': "import { nope } from '../lib.mts';\nprocess.exit(nope ? 0 : 1);\n",
}, 'feat: import a symbol missing on the base');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(structuralHead);
check(
  'a structural red with no test(red): commit fails as `structural`',
  r.status === 1 && /structural/.test(r.out),
  r.out,
);

git(['checkout', '-q', '-b', 'test/8-structural-red', base], repo);
const structuralRedHead = commit(repo, {
  'tests/check.mts': "import { nope } from '../lib.mts';\nprocess.exit(nope ? 0 : 1);\n",
}, 'test(red): import a symbol missing on the base');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(structuralRedHead);
check(
  'a structural red declared by a test(red): commit passes with the warning',
  r.status === 0 && /\bpass\b/.test(r.out) && /warning:/.test(r.out),
  r.out,
);

// The `test(red):` commit must touch one of the overlaid test files: a
// `test(red):` subject on a commit that only moves production code does not
// vouch for a structural red introduced by a later commit.
git(['checkout', '-q', '-b', 'feat/9-red-elsewhere', base], repo);
commit(repo, { 'lib.mts': 'export const v = 5;\n' }, 'test(red): touches no test file');
const redElsewhereHead = commit(repo, {
  'tests/check.mts': "import { nope } from '../lib.mts';\nprocess.exit(nope ? 0 : 1);\n",
}, 'feat: import a symbol missing on the base');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(redElsewhereHead);
check(
  'a test(red): commit touching no overlaid test file does not vouch for the structural red',
  r.status === 1 && /structural/.test(r.out),
  r.out,
);

// A structural signature somewhere else in the output is not this pull
// request's structural red. A dependency that logs `Cannot find module` and
// carries on prints that line in a diagnostic block of its own, and says
// nothing about whether the overlaid test file could run; the signature
// counts only when its own block also names an overlaid test file or a file
// the diff touches. Here the red is an honest assertion red — `v === 6`
// fails on the base — and must stay `pass`.
git(['checkout', '-q', '-b', 'feat/14-noisy-red', base], repo);
const noisyRedHead = commit(repo, {
  'lib.mts': 'export const v = 6;\n',
  'tests/check.mts':
    "import { v } from '../lib.mts';\n" +
    'console.log("vendor/dep: Cannot find module \'optional-extra\' — ignored");\n' +
    'process.exit(v === 6 ? 0 : 1);\n',
}, 'feat: a runtime red whose output also carries an unrelated structural line');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(noisyRedHead);
check(
  "a structural line outside the overlaid files' own diagnostic block leaves the red a pass",
  r.status === 0 && /\bpass\b/.test(r.out) && !/structural/.test(r.out) && !/warning:/.test(r.out),
  r.out,
);

// The same shape across the stream boundary: the noise goes to stdout and the
// runtime writes its own diagnostic to stderr, so concatenating the two
// without a blank line put the logged `Cannot find module` in the same block
// as the stack header naming the overlaid file. The red here is a thrown
// `Error`, which carries no structural signature of its own.
git(['checkout', '-q', '-b', 'feat/15-noisy-throw', base], repo);
const noisyThrowHead = commit(repo, {
  'lib.mts': 'export const v = 7;\n',
  'tests/check.mts':
    "import { v } from '../lib.mts';\n" +
    'console.log("vendor/dep: Cannot find module \'optional-extra\' — ignored");\n' +
    "if (v !== 7) throw new Error('v is not 7');\n",
}, 'feat: a thrown red whose stdout carries an unrelated structural line');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(noisyThrowHead);
check(
  'a structural line on stdout does not borrow the file name from the stderr diagnostic',
  r.status === 0 && /\bpass\b/.test(r.out) && !/structural/.test(r.out) && !/warning:/.test(r.out),
  r.out,
);

check('negative-control leaves no worktree behind', !/negative-control-/.test(git(['worktree', 'list'], repo)));

// --- `proof/<slug>.json`: the overlay a branch declares (#136) -------------
// `--branch <ref>` names the head branch (`<type>/<n>-<slug>`); when
// `proof/<slug>.json` exists at head, the overlay is exactly the files it
// names — no test glob involved — and its optional `command` replaces the
// detected test command. Without `--branch`, nothing changes.
//
// Repository A: the detected test command already runs the declared file, so
// the case isolates the overlay. `checks/pin.mts` matches no test glob, so
// the same diff is `no-tests` when the declaration is not read.
const declRepo = tempRepo();
const declBase = commit(declRepo, {
  'package.json': JSON.stringify({ name: 'd', private: true, scripts: { test: 'node checks/pin.mts' } }),
  'lib.mts': 'export const v = 1;\n',
  'checks/pin.mts': 'process.exit(0);\n',
}, 'chore: base');
git(['checkout', '-q', '-b', 'feat/10-declared'], declRepo);
const declHead = commit(declRepo, {
  'lib.mts': 'export const v = 2;\n',
  'checks/pin.mts': "import { v } from '../lib.mts';\nprocess.exit(v === 2 ? 0 : 1);\n",
  'proof/declared.json': JSON.stringify({ tests: ['checks/pin.mts'] }),
}, 'feat: declare the proof of this slug');

const declNc = (args: string[], cwd: string) => ci('negative-control.mts', args, { cwd });

r = declNc(['--base', declBase, '--head', declHead], declRepo);
check(
  'without --branch a declared non-glob test file is still no-tests',
  r.status === 1 && /no-tests/.test(r.out),
  r.out,
);

r = declNc(['--base', declBase, '--head', declHead, '--branch', 'feat/10-declared'], declRepo);
check(
  'a declaration overlays a file no test glob matches, and the control passes',
  r.status === 0 && /\bpass\b/.test(r.out) && /checks\/pin\.mts/.test(r.out),
  r.out,
);

// Repository B: the detected command (`node checks/green.mts`) cannot see the
// change; the declaration's `command` is what runs on the base, both for the
// baseline and for the overlaid run.
const cmdRepo = tempRepo();
const cmdBase = commit(cmdRepo, {
  'package.json': JSON.stringify({ name: 'c', private: true, scripts: { test: 'node checks/green.mts' } }),
  'lib.mts': 'export const v = 1;\n',
  'checks/green.mts': 'process.exit(0);\n',
  'checks/pin.mts': 'process.exit(0);\n',
}, 'chore: base');
git(['checkout', '-q', '-b', 'feat/11-command'], cmdRepo);
const cmdHead = commit(cmdRepo, {
  'lib.mts': 'export const v = 2;\n',
  'checks/pin.mts': "import { v } from '../lib.mts';\nprocess.exit(v === 2 ? 0 : 1);\n",
  'proof/command.json': JSON.stringify({ tests: ['checks/pin.mts'], command: 'node checks/pin.mts' }),
}, 'feat: declare the command that proves this slug');

r = declNc(['--base', cmdBase, '--head', cmdHead, '--branch', 'feat/11-command'], cmdRepo);
check(
  "a declaration's command replaces the detected test command on the base",
  r.status === 0 && /\bpass\b/.test(r.out) && /node checks\/pin\.mts/.test(r.out) && !/node checks\/green\.mts/.test(r.out),
  r.out,
);

// A declaration that cannot be read is not silently ignored: it would narrow
// the control to nothing.
git(['checkout', '-q', '-b', 'feat/12-broken', cmdBase], cmdRepo);
const brokenHead = commit(cmdRepo, {
  'lib.mts': 'export const v = 3;\n',
  'checks/pin.mts': "import { v } from '../lib.mts';\nprocess.exit(v === 3 ? 0 : 1);\n",
  'proof/broken.json': '{ not json at all\n',
}, 'feat: a declaration that does not parse');
r = declNc(['--base', cmdBase, '--head', brokenHead, '--branch', 'feat/12-broken'], cmdRepo);
check(
  'a declaration that does not parse is cannot-run, not a silent skip',
  r.status === 1 && /cannot-run/.test(r.out) && /proof\/broken\.json/.test(r.out),
  r.out,
);

// --- the declaration fails closed ------------------------------------------
// Every case below builds a branch off `cmdBase` whose `checks/pin.mts` is an
// honest red on the base, so the only thing that decides the outcome is what
// the declaration says. If the declaration were ignored the run would report
// `pass` or `no-tests` — a verdict about a tree nobody described.
const declaringBranch = (branch: string, slug: string, v: number, decl: unknown): string => {
  git(['checkout', '-q', '-b', branch, cmdBase], cmdRepo);
  return commit(cmdRepo, {
    'lib.mts': `export const v = ${v};\n`,
    'checks/pin.mts': `import { v } from '../lib.mts';\nprocess.exit(v === ${v} ? 0 : 1);\n`,
    [`proof/${slug}.json`]: JSON.stringify(decl),
  }, `feat: declare ${slug}`);
};
const declRun = (branch: string, head: string) =>
  declNc(['--base', cmdBase, '--head', head, '--branch', branch], cmdRepo);

// A `tests` entry the head commit does not have is a typo, not a deletion to
// replay on the base: the overlay would `rmSync` an unrelated base file and
// the control would then run on a tree nobody described.
const missingPathHead = declaringBranch('feat/17-missing-path', 'missing-path', 9, {
  tests: ['checks/pin.mts', 'checks/typo.mts'],
  command: 'node checks/pin.mts',
});
r = declRun('feat/17-missing-path', missingPathHead);
check(
  'a declared test path the head does not have is cannot-run naming it, not a deletion replayed on the base',
  r.status === 1 && /cannot-run/.test(r.out) && /checks\/typo\.mts/.test(r.out),
  r.out,
);

// The declaration is written by the implementer, and `join(tmp, file)` follows
// wherever it points: a `..` entry reads and removes outside the temporary
// worktree. Both shapes are refused before any file is written or removed.
const escapingHead = declaringBranch('feat/18-escaping-path', 'escaping-path', 10, {
  tests: ['checks/pin.mts', '../negcontrol-escape-probe-7f3a.txt'],
  command: 'node checks/pin.mts',
});
r = declRun('feat/18-escaping-path', escapingHead);
check(
  'a declared path that escapes the repository root once normalised is cannot-run naming it',
  r.status === 1 && /cannot-run/.test(r.out) && /negcontrol-escape-probe-7f3a/.test(r.out),
  r.out,
);

const absoluteHead = declaringBranch('feat/19-absolute-path', 'absolute-path', 11, {
  tests: ['checks/pin.mts', '/negcontrol-absolute-probe-7f3a.txt'],
  command: 'node checks/pin.mts',
});
r = declRun('feat/19-absolute-path', absoluteHead);
check(
  'a declared absolute path is cannot-run naming it',
  r.status === 1 && /cannot-run/.test(r.out) && /negcontrol-absolute-probe-7f3a/.test(r.out),
  r.out,
);

// The two shapes the reader already refused and nothing pinned: a declaration
// with no `tests` array, and one whose `command` is not a non-empty string.
const noTestsKeyHead = declaringBranch('feat/20-no-tests-key', 'no-tests-key', 12, {
  command: 'node checks/pin.mts',
});
r = declRun('feat/20-no-tests-key', noTestsKeyHead);
check(
  'a declaration with no `tests` array is cannot-run',
  r.status === 1 && /cannot-run/.test(r.out) && /proof\/no-tests-key\.json/.test(r.out) && /tests/.test(r.out),
  r.out,
);

const badCommandHead = declaringBranch('feat/21-bad-command', 'bad-command', 13, {
  tests: ['checks/pin.mts'],
  command: 42,
});
r = declRun('feat/21-bad-command', badCommandHead);
check(
  'a declaration whose `command` is not a non-empty string is cannot-run',
  r.status === 1 && /cannot-run/.test(r.out) && /proof\/bad-command\.json/.test(r.out) && /command/.test(r.out),
  r.out,
);

// Last in this repository: the blob is removed from the object store, so
// `git show` fails for a reason that is not "the file is absent at head".
// Presence has to come from the tree (`git ls-tree`), because a non-zero
// `git show` read alike for a corrupt object, an unreadable head and a branch
// that simply declares nothing — and the last of the three fell back to the
// diff's globs.
const unreadableHead = declaringBranch('feat/22-unreadable', 'unreadable', 14, {
  tests: ['checks/pin.mts'],
  command: 'node checks/pin.mts',
});
const blob = git(['rev-parse', `${unreadableHead}:proof/unreadable.json`], cmdRepo);
rmSync(join(cmdRepo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });
r = declRun('feat/22-unreadable', unreadableHead);
check(
  'a declaration present at head that cannot be read is cannot-run, not a fallback to the diff globs',
  r.status === 1 && /cannot-run/.test(r.out) && /proof\/unreadable\.json/.test(r.out),
  r.out,
);

check('negative-control leaves no worktree behind in the declaration repos', !/negative-control-/.test(git(['worktree', 'list'], cmdRepo)));

// --- a stack `ci/lib/detect.mts` does not detect ---------------------------
// No Makefile, no package.json, no stack marker at all: the run is
// `cannot-run` before any worktree is made. The detail names the escape a
// repository with an undetected stack actually has — a `Makefile` with a
// `test:` target, which the detector reads before every other marker.
const undetectedRepo = tempRepo();
const undetectedBase = commit(undetectedRepo, {
  'lib.mts': 'export const v = 1;\n',
  'tests/check.mts': 'process.exit(0);\n',
}, 'chore: base with no detectable test command');
git(['checkout', '-q', '-b', 'feat/13-undetected'], undetectedRepo);
const undetectedHead = commit(undetectedRepo, {
  'lib.mts': 'export const v = 2;\n',
  'tests/check.mts': "import { v } from '../lib.mts';\nprocess.exit(v === 2 ? 0 : 1);\n",
}, 'feat: v2');

r = ci('negative-control.mts', ['--base', undetectedBase, '--head', undetectedHead], { cwd: undetectedRepo });
check(
  'a stack with no detected test command is cannot-run',
  r.status === 1 && /cannot-run/.test(r.out),
  r.out,
);
check(
  'the cannot-run detail names the `Makefile` with a `test:` target as the escape',
  /Makefile/.test(r.out) && /`test:` target/.test(r.out) && /ci\/lib\/detect\.mts/.test(r.out),
  r.out,
);

finish();
