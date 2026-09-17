#!/usr/bin/env node
// Cases for ci/negative-control.mts: the tests a PR adds must fail on the
// base without the PR's change, unless the PR's whole diff sits in a skipped
// path class (docs, workflows, templates, root Markdown, or whatever
// AGENTIC_SKIP_GLOBS adds). A `type:` label no longer skips by itself.
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

git(['checkout', '-q', '-b', 'feat/2-vacuous', base], repo);
const vacuous = commit(repo, { 'lib.mts': 'export const v = 3;\n', 'tests/check.mts': "console.log('looks tested');\nprocess.exit(0);\n" }, 'feat: vacuous');
git(['checkout', '-q', 'feat/1-x'], repo);
r = nc(vacuous);
check('negative-control fails a vacuous test', r.status === 1 && /vacuous/.test(r.out), r.out);
// A `vacuous` verdict on a brand-new test tree is the costliest one to read
// wrong: the overlay copies test files only, so a test command that
// enumerates its test directories still runs the base's own entry point and
// stays green. The detail names that trap and the two ways out, rather than
// leaving the next run to rediscover it.
check(
  'the vacuous detail names the enumerating entry point that hides a new test tree',
  /entry point/.test(r.out) && /enumerates/.test(r.out) && /discover/.test(r.out),
  r.out,
);
check(
  'the vacuous detail says the entry point is never overlaid, so the fix lands on the base or in the declaration',
  /never overlaid/.test(r.out) && /proof\/<slug>\.json/.test(r.out),
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
