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
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, ci, commit, finish, git, tempRepo } from './lib/harness.mts';

const repo = tempRepo();
const pkg = JSON.stringify({ name: 'x', private: true, scripts: { test: 'node tests/check.mts' } });
const base = commit(repo, {
  'package.json': pkg,
  'lib.mts': 'export const v = 1;\n',
  'tests/check.mts': 'process.exit(0);\n',
}, 'chore: base');

// Every fixture red below throws rather than exiting 1 in silence. That is
// the shape safe-worktree §B7 tells implementers to write, and it is also the
// shape a negative control can attribute: a thrown error prints the overlaid
// file as a source location in its stack, which is the evidence `pass` now
// requires (#354). A command that fails without reporting what failed is
// `unattributed`, and has a case of its own at the end of this file.
git(['checkout', '-q', '-b', 'feat/1-x'], repo);
const head = commit(repo, {
  'lib.mts': 'export const v = 2;\n',
  'tests/check.mts': "import { v } from '../lib.mts';\nif (v !== 2) throw new Error('v is not 2');\n",
}, 'feat: v2');
git(['checkout', '-q', '-b', 'feat/3-notests', base], repo);
const noTestsHead = commit(repo, { 'lib.mts': 'export const v = 4;\n' }, 'feat: no tests');
git(['checkout', '-q', 'feat/1-x'], repo);
const nc = (h: string, labels = '', b = base, env: Record<string, string> = {}) =>
  ci('negative-control.mts', ['--base', b, '--head', h, ...(labels ? ['--labels', labels] : [])], { cwd: repo, env });

let r = nc(head);
check('negative-control passes when the new test fails on the base', r.status === 0 && /\bpass\b/.test(r.out) && !/warning:/.test(r.out), r.out);

// --- the skip is by path class, not by the PR's own `type:` label ----------
// A diff entirely inside the skipped classes — docs, workflows, templates,
// session configuration and Markdown anywhere in the tree — owes no negative
// control; a `type:` label alone no longer buys the exemption, because the
// implementer applies its own PR's labels. This case covers four of them;
// the nested Markdown and `.claude/**` classes have cases of their own below.
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
    // The red stays an exit-code red, not a throw, so the case keeps testing
    // the shape it was written for; the report goes to stderr, which
    // `runTests` keeps in a diagnostic block of its own, so the FAIL line
    // cannot share a block with the `Cannot find module` noise on stdout.
    "if (v !== 6) { console.error('FAIL tests/check.mts: v is not 6'); process.exit(1); }\n",
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
  'checks/pin.mts': "import { v } from '../lib.mts';\nif (v !== 2) throw new Error('v is not 2');\n",
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
  'checks/pin.mts': "import { v } from '../lib.mts';\nif (v !== 2) throw new Error('v is not 2');\n",
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
  'checks/pin.mts': "import { v } from '../lib.mts';\nif (v !== 3) throw new Error('v is not 3');\n",
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
    'checks/pin.mts': `import { v } from '../lib.mts';\nif (v !== ${v}) throw new Error('v is not ${v}');\n`,
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
// The cause sentence, not the bare word: `tests` and `command` both occur in
// these declarations' own slugs, so pinning either one alone would pass on
// any `cannot-run` at all and discriminate nothing.
check(
  'a declaration with no `tests` array is cannot-run, and says that is why',
  r.status === 1 && /cannot-run/.test(r.out) && /proof\/no-tests-key\.json/.test(r.out)
    && /has no `"tests"` array of file paths/.test(r.out),
  r.out,
);

const badCommandHead = declaringBranch('feat/21-bad-command', 'bad-command', 13, {
  tests: ['checks/pin.mts'],
  command: 42,
});
r = declRun('feat/21-bad-command', badCommandHead);
check(
  'a declaration whose `command` is not a non-empty string is cannot-run, and says that is why',
  r.status === 1 && /cannot-run/.test(r.out) && /proof\/bad-command\.json/.test(r.out)
    && /has a `"command"` that is not a non-empty string/.test(r.out),
  r.out,
);

// Last in this repository: the declaration is in the head tree and `git show`
// cannot read it, so `git show` fails for a reason that is not "the file is
// absent at head". Presence has to come from the tree (`git ls-tree`), because
// a non-zero `git show` read alike for a corrupt object, an unreadable head
// and a branch that simply declares nothing — and the last of the three fell
// back to the diff's globs.
//
// The unreadable entry is a gitlink: a tree entry recording a commit id no
// object store has, which `git update-index --cacheinfo 160000` writes without
// checking. `git ls-tree` lists the path (it reads the tree, which holds the
// id); `git show <head>:<path>` fails with `bad object`. The case used to
// delete the loose object behind a blob instead, which left the outcome to
// whether the object was still loose at that moment: it passed 35/0 in three
// plain runs, under `CI=1`, and under a PR-shaped `GITHUB_EVENT_PATH`, and
// failed only inside the run `ci/negative-control.mts` itself spawns in CI,
// where an unrelated red is what a false `pass` is made of (#354). A tree
// entry is not object-store state, so nothing outside this file can repack,
// repair or garbage-collect the condition away.
git(['checkout', '-q', '-b', 'feat/22-unreadable', cmdBase], cmdRepo);
writeFileSync(join(cmdRepo, 'lib.mts'), 'export const v = 14;\n');
writeFileSync(join(cmdRepo, 'checks', 'pin.mts'), "import { v } from '../lib.mts';\nif (v !== 14) throw new Error('v is not 14');\n");
git(['add', '-A'], cmdRepo);
git(['update-index', '--add', '--cacheinfo', '160000,0123456789abcdef0123456789abcdef01234567,proof/unreadable.json'], cmdRepo);
git(['commit', '-q', '-m', 'feat: declare unreadable'], cmdRepo);
const unreadableHead = git(['rev-parse', 'HEAD'], cmdRepo);
// The precondition this case rests on, asserted rather than assumed: the path
// is in the head tree and its content cannot be read.
check(
  'the unreadable declaration is present in the head tree',
  git(['ls-tree', '--name-only', unreadableHead, '--', 'proof/unreadable.json'], cmdRepo) === 'proof/unreadable.json',
);
check(
  'the unreadable declaration cannot be read out of the head commit',
  spawnSync('git', ['show', `${unreadableHead}:proof/unreadable.json`], { cwd: cmdRepo, encoding: 'utf8' }).status !== 0,
);
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
  'tests/check.mts': "import { v } from '../lib.mts';\nif (v !== 2) throw new Error('v is not 2');\n",
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

// --- a red the overlay did not cause is not the overlay's red (#354) -------
// The false pass this section exists for: run `35405433899`, job
// `105794181719`, on pull request #349 at head `594481b`. The pristine base
// was green (`2398 passed, 0 failed`); the overlaid run was red
// (`2397 passed, 1 failed`) — and the one failure was in
// `tests/negative-control.test.mts`, named by neither overlaid file, while
// both overlaid files reported `0 failed`. The control printed `pass`.
//
// The runner below reproduces the shape of that log literally: one
// `<file>: N passed, M failed` line per test file, consecutive and with no
// blank line between them, so the whole listing is a single diagnostic block.
// That is why the block mechanism `structuralInOverlay` uses cannot decide
// this one on its own — inside that block every overlaid name sits next to
// every unrelated red — and why attribution is read per failure line, with
// the block reserved for the stack-trace shape, where the overlaid file
// appears as a source location.
const attrRepo = tempRepo();
const RUNNER = [
  "import { readdirSync } from 'node:fs';",
  "import { spawnSync } from 'node:child_process';",
  "import { dirname, join } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'const dir = dirname(fileURLToPath(import.meta.url));',
  'let failed = 0;',
  "for (const f of readdirSync(dir).filter((n) => n.endsWith('.case.mts')).sort()) {",
  '  const bad = spawnSync(process.argv[0], [join(dir, f)]).status === 0 ? 0 : 1;',
  '  failed += bad;',
  '  console.log(`${f}: ${1 - bad} passed, ${bad} failed`);',
  '}',
  'process.exit(failed ? 1 : 0);',
  '',
].join('\n');
// Green on the pristine base and red in the overlaid run, deterministically:
// it fails exactly when the overlay has put `breaker.case.mts` beside it. The
// trigger is a stand-in for whatever made the real one red — a flake, a
// regression already on the base, a rate limit. What the cases pin is *which*
// file the run reports as failing, never why it failed.
const UNRELATED = [
  "import { existsSync } from 'node:fs';",
  "import { dirname, join } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'const dir = dirname(fileURLToPath(import.meta.url));',
  "process.exit(existsSync(join(dir, 'breaker.case.mts')) ? 1 : 0);",
  '',
].join('\n');
const attrBase = commit(attrRepo, {
  'package.json': JSON.stringify({ name: 'a', private: true, scripts: { test: 'node tests/run-all.mts' } }),
  'lib.mts': 'export const v = 1;\n',
  'tests/run-all.mts': RUNNER,
  'tests/unrelated.case.mts': UNRELATED,
}, 'chore: base');

const attrRun = (head: string) =>
  ci('negative-control.mts', ['--base', attrBase, '--head', head], { cwd: attrRepo });

// 1. Red only on a file the overlay did not place. The overlaid file is in
//    the run and reports `0 failed`; the red belongs to a file neither
//    overlay named. That is not this control's red.
git(['checkout', '-q', '-b', 'feat/30-unrelated-red', attrBase], attrRepo);
const unrelatedRedHead = commit(attrRepo, {
  'lib.mts': 'export const v = 2;\n',
  'tests/breaker.case.mts': 'process.exit(0);\n',
}, 'feat: a test that passes on the base, beside a change nothing tests');
git(['checkout', '-q', 'main'], attrRepo);
r = attrRun(unrelatedRedHead);
check(
  'an overlaid run red only on a non-overlaid file is `unattributed`, not `pass`',
  r.status === 1 && /unattributed/.test(r.out) && !/negative-control: pass/.test(r.out),
  r.out,
);
check(
  'the `unattributed` verdict is its own, not folded into `vacuous`',
  /negative-control: unattributed/.test(r.out) && !/negative-control: vacuous/.test(r.out),
  r.out,
);
check(
  'the `unattributed` detail names the failures it did see, so the reader can act on them',
  /unattributed/.test(r.out) && /unrelated\.case\.mts: 0 passed, 1 failed/.test(r.out),
  r.out,
);
check(
  'the `unattributed` detail names the overlaid files it looked for and found nothing about',
  /unattributed/.test(r.out) && /tests\/breaker\.case\.mts/.test(r.out),
  r.out,
);
check(
  'the `unattributed` detail gives the two-argument invocation that reproduces it by hand',
  /unattributed/.test(r.out) && /--base/.test(r.out) && /--head/.test(r.out),
  r.out,
);

// 2. One red on a file the overlay did place: the tests bite, and the verdict
//    is the unchanged `pass` with no warning.
git(['checkout', '-q', '-b', 'feat/31-overlay-red', attrBase], attrRepo);
const overlayRedHead = commit(attrRepo, {
  'lib.mts': 'export const v = 3;\n',
  'tests/bites.case.mts': 'process.exit(1);\n',
}, 'feat: a test that fails on the base');
git(['checkout', '-q', 'main'], attrRepo);
r = attrRun(overlayRedHead);
check(
  'a red on a file the overlay placed is still `pass`',
  r.status === 0 && /\bpass\b/.test(r.out) && !/unattributed/.test(r.out),
  r.out,
);
check(
  'a clean pass carries no warning about an unrelated red',
  !/warning:/.test(r.out),
  r.out,
);

// 3. One of each. The overlay's own red is there, so the verdict stays
//    `pass` — but the unrelated red is real and the operator is told, rather
//    than left to find it in the log.
git(['checkout', '-q', '-b', 'feat/32-both-reds', attrBase], attrRepo);
const bothRedsHead = commit(attrRepo, {
  'lib.mts': 'export const v = 4;\n',
  'tests/breaker.case.mts': 'process.exit(0);\n',
  'tests/bites.case.mts': 'process.exit(1);\n',
}, 'feat: a test that fails on the base, beside one that trips an unrelated file');
git(['checkout', '-q', 'main'], attrRepo);
r = attrRun(bothRedsHead);
check(
  'a run red on both an overlaid and a non-overlaid file is `pass`',
  r.status === 0 && /\bpass\b/.test(r.out) && !/unattributed/.test(r.out),
  r.out,
);
check(
  'that pass warns about the unrelated red and names the file it was in',
  /warning:/.test(r.out) && /unrelated\.case\.mts/.test(r.out),
  r.out,
);

// The wording the issue's comment asked for: the run the control calls "the
// base" in a `pass` is the base *with the overlay applied*, and a reader who
// misses that misdiagnoses the next occurrence the way this one nearly was.
check(
  'the pass detail says the overlay was applied, not just "failed on the base"',
  /from head overlaid/.test(r.out) && !/failed on the base \(exit/.test(r.out),
  r.out,
);

// A command that fails without reporting any failure at all cannot be
// attributed either: there is nothing to read. It is the same verdict, and
// the detail says the run reported no failure of its own rather than naming
// failures that do not exist.
const silentRepo = tempRepo();
const silentBase = commit(silentRepo, {
  'package.json': JSON.stringify({ name: 's', private: true, scripts: { test: 'node tests/check.mts' } }),
  'lib.mts': 'export const v = 1;\n',
  'tests/check.mts': 'process.exit(0);\n',
}, 'chore: base');
git(['checkout', '-q', '-b', 'feat/33-silent'], silentRepo);
const silentHead = commit(silentRepo, {
  'lib.mts': 'export const v = 2;\n',
  'tests/check.mts': "import { v } from '../lib.mts';\nprocess.exit(v === 2 ? 0 : 1);\n",
}, 'feat: a red that reports nothing');
r = ci('negative-control.mts', ['--base', silentBase, '--head', silentHead], { cwd: silentRepo });
check(
  'a red that reports no failure at all is `unattributed`, not `pass`',
  r.status === 1 && /unattributed/.test(r.out),
  r.out,
);
check(
  'its detail says the run reported no failure of its own',
  /reported no failure of its own/.test(r.out),
  r.out,
);

check(
  'negative-control leaves no worktree behind in the attribution repo',
  !/negative-control-/.test(git(['worktree', 'list'], attrRepo)),
);

finish();
