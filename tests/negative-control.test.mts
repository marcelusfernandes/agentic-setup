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

finish();
