#!/usr/bin/env node
// Cases for ci/negative-control.mts: the tests a PR adds must fail on the
// base without the PR's change, unless the PR is labelled to skip it.
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
const nc = (h: string, labels = '') => ci('negative-control.mts', ['--base', base, '--head', h, ...(labels ? ['--labels', labels] : [])], { cwd: repo });

let r = nc(head);
check('negative-control passes when the new test fails on the base', r.status === 0 && /\bpass\b/.test(r.out), r.out);
for (const label of ['type:docs', 'type:deps', 'type:infra', 'type:refactor', 'type:spec']) {
  const skipped = nc(noTestsHead, label);
  check(`negative-control skips ${label} PRs by label`, skipped.status === 0 && /skipped/.test(skipped.out), skipped.out);
}
check('negative-control does not skip type:feature', /no-tests/.test(nc(noTestsHead, 'type:feature').out));

git(['checkout', '-q', '-b', 'feat/2-vacuous', base], repo);
const vacuous = commit(repo, { 'lib.mts': 'export const v = 3;\n', 'tests/check.mts': "console.log('looks tested');\nprocess.exit(0);\n" }, 'feat: vacuous');
r = nc(vacuous);
check('negative-control fails a vacuous test', r.status === 1 && /vacuous/.test(r.out), r.out);

r = nc(noTestsHead);
check('negative-control fails when no test file changed', r.status === 1 && /no-tests/.test(r.out), r.out);
check('negative-control leaves no worktree behind', !/negative-control-/.test(git(['worktree', 'list'], repo)));

finish();
