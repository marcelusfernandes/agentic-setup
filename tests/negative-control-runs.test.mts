#!/usr/bin/env node
// How `ci/negative-control.mts` runs the test command, and what the verdict
// says it read (#297, AC3, AC4 and AC5). `tests/run.mts` discovers every
// `tests/*.test.mts` in this directory, so this file needs listing nowhere.
//
// Three subjects, all about the run rather than about the diff:
//
//   the limits      `spawnSync` defaults to a 1 MiB buffer and to no timeout
//                   at all, so a noisy suite came back as a command that
//                   could not be executed and a hanging one hung the job
//                   until the workflow's own limit. Both are explicit named
//                   constants now, each with an env override — which is also
//                   the only way a case can reach either path without
//                   printing tens of megabytes or waiting out half an hour
//   the parser      the declaration is read by `ci/lib/proof.mts`, the same
//                   module `scripts/lib/proof.mts` reads it with, so a
//                   declaration cannot be accepted by one reader and
//                   refused by the other. The two shapes that used to pass
//                   here and fail there are an unknown key and a
//                   `describes` that is not a non-empty sentence
//   the detail      a `vacuous` verdict names what would put the entry point
//                   in the overlay. With a declaration that is the
//                   declaration's own `tests` and nothing else: the globs
//                   are inert, because `proof/<slug>.json` suppresses them
//                   entirely
//
// Every case spawns `ci/negative-control.mts` for real against a throwaway
// git repository (CLAUDE.md invariant 6).
import { check, ci, commit, finish, git, tempRepo } from './lib/harness.mts';

// The command is named rather than detected: `npm test` prints a banner of
// its own, and the buffer case below measures bytes.
const TEST_CMD = 'node tests/check.mts';

/**
 * The verdict line alone. Every assertion about what a *detail* says reads
 * this rather than the whole output: the check also prints a `note:` naming
 * the declaration and echoes both runs' tails, so a match anywhere in `out`
 * would pass on the note while the detail said nothing of the kind.
 */
const verdict = (out: string): string =>
  out.split('\n').find((line) => line.startsWith('negative-control: ')) ?? '(no verdict line)';

// --- AC3: the two limits ---------------------------------------------------
// The baseline has to stay green, or the verdict is `inconclusive` before
// either limit is ever reached: the base's own test file is silent and
// instant, and only the overlaid one is noisy or slow.
const limits = tempRepo();
const limitsBase = commit(limits, {
  'package.json': JSON.stringify({ name: 'x', private: true }),
  'lib.mts': 'export const v = 1;\n',
  'tests/check.mts': 'process.exit(0);\n',
}, 'chore: a base whose suite prints nothing and returns at once');

const limitsRun = (head: string, env: Record<string, string>) =>
  ci('negative-control.mts', ['--base', limitsBase, '--head', head], {
    cwd: limits,
    env: { AGENTIC_TEST_CMD: TEST_CMD, ...env },
  });

// Twenty thousand characters, printed as lines: past the 4096-byte override
// below and well short of `spawnSync`'s own 1 MiB default, so the only thing
// that makes this run overrun is the constant the fix introduces.
git(['checkout', '-q', '-b', 'fix/1-noisy', limitsBase], limits);
const noisyHead = commit(limits, {
  'lib.mts': 'export const v = 2;\n',
  'tests/check.mts':
    "import { v } from '../lib.mts';\n" +
    "for (let i = 0; i < 200; i++) console.log('x'.repeat(100));\n" +
    "if (v !== 2) throw new Error('v is not 2');\n",
}, 'fix: a suite that prints more than the buffer holds');

let r = limitsRun(noisyHead, { AGENTIC_RUN_MAX_BUFFER: '4096' });
check(
  'a run that printed more than the buffer holds is cannot-run, never a red the overlay earned',
  r.status === 1 && /negative-control: cannot-run/.test(r.out),
  r.out,
);
check(
  'the exceeded-buffer detail names the buffer and the variable that raises it',
  /AGENTIC_RUN_MAX_BUFFER/.test(verdict(r.out)) && /buffer/.test(verdict(r.out)),
  verdict(r.out),
);
check(
  'the exceeded-buffer detail is not the one for a command that never started',
  !/could not be executed/.test(verdict(r.out)),
  verdict(r.out),
);

// The same diff with a buffer the output fits in is the ordinary `pass`: the
// limit is what decided the verdict above, not the fixture.
r = limitsRun(noisyHead, { AGENTIC_RUN_MAX_BUFFER: String(8 * 1024 * 1024) });
check(
  'the same noisy run inside the buffer is judged on its red as before',
  r.status === 0 && /negative-control: pass/.test(r.out),
  r.out,
);

git(['checkout', '-q', '-b', 'fix/2-hanging', limitsBase], limits);
const hangingHead = commit(limits, {
  'lib.mts': 'export const v = 3;\n',
  // Red on the base, but only after ten seconds of it: without a timeout the
  // check waits and then reports `pass`, so the timeout is the only thing
  // that separates the two verdicts.
  'tests/check.mts':
    "import { v } from '../lib.mts';\n" +
    "if (v !== 3) { const t = Date.now(); while (Date.now() - t < 10000); throw new Error('v is not 3'); }\n",
}, 'fix: a suite that hangs on the base before it fails');

r = limitsRun(hangingHead, { AGENTIC_RUN_TIMEOUT_MS: '1500' });
check(
  'a run that outran the timeout is cannot-run rather than a job that never ends',
  r.status === 1 && /negative-control: cannot-run/.test(r.out),
  r.out,
);
check(
  'the timed-out detail names the timeout and the variable that raises it',
  /AGENTIC_RUN_TIMEOUT_MS/.test(verdict(r.out)) && /timed out|timeout/.test(verdict(r.out)),
  verdict(r.out),
);
check(
  'the timed-out detail is not the one for a command that never started',
  !/could not be executed/.test(verdict(r.out)),
  verdict(r.out),
);

// --- AC4: one declaration parser, so one answer ----------------------------
// Both shapes below are refused by `scripts/proof.mts` and used to be
// accepted here, which is a declaration read two ways. Each branch's own red
// is honest, so the declaration is the only thing deciding the outcome: if it
// were accepted the run would report `pass`.
const decl = tempRepo();
const declBase = commit(decl, {
  'package.json': JSON.stringify({ name: 'x', private: true, scripts: { test: 'node checks/pin.mts' } }),
  'lib.mts': 'export const v = 1;\n',
  'checks/pin.mts': "import { v } from '../lib.mts';\nif (v !== 1) throw new Error('v is not 1');\n",
}, 'chore: base');

const declaring = (branch: string, slug: string, v: number, declaration: unknown): string => {
  git(['checkout', '-q', '-b', branch, declBase], decl);
  return commit(decl, {
    'lib.mts': `export const v = ${v};\n`,
    'checks/pin.mts': `import { v } from '../lib.mts';\nif (v !== ${v}) throw new Error('v is not ${v}');\n`,
    [`proof/${slug}.json`]: JSON.stringify(declaration),
  }, `feat: declare ${slug}`);
};
const declRun = (branch: string, head: string) =>
  ci('negative-control.mts', ['--base', declBase, '--head', head, '--branch', branch], { cwd: decl });

const unknownKeyHead = declaring('feat/3-unknown-key', 'unknown-key', 4, {
  tests: ['checks/pin.mts'],
  comand: 'node checks/pin.mts',
});
r = declRun('feat/3-unknown-key', unknownKeyHead);
check(
  'a declaration carrying a key the format does not define is cannot-run here too',
  r.status === 1 && /cannot-run/.test(verdict(r.out)) && /proof\/unknown-key\.json/.test(verdict(r.out)),
  verdict(r.out),
);
check('the unknown key is named rather than ignored', /comand/.test(verdict(r.out)), verdict(r.out));

const badDescribesHead = declaring('feat/4-bad-describes', 'bad-describes', 5, {
  tests: ['checks/pin.mts'],
  describes: '   ',
});
r = declRun('feat/4-bad-describes', badDescribesHead);
check(
  'a declaration whose `describes` is not a non-empty sentence is cannot-run here too',
  r.status === 1 && /cannot-run/.test(verdict(r.out)) && /proof\/bad-describes\.json/.test(verdict(r.out)),
  verdict(r.out),
);
check('the rejected `describes` is named rather than ignored', /describes/.test(verdict(r.out)), verdict(r.out));

// The shared parser did not loosen anything: a declaration that is the shape
// is still read, overlaid and run exactly as before.
const goodHead = declaring('feat/5-good', 'good', 6, {
  tests: ['checks/pin.mts'],
  command: 'node checks/pin.mts',
  describes: 'the pin bites when v moves',
});
r = declRun('feat/5-good', goodHead);
check(
  'a declaration that is the shape is still read and still decides the overlay',
  r.status === 0 && /negative-control: pass/.test(r.out) && /proof\/good\.json/.test(r.out),
  r.out,
);

// --- AC5: the `vacuous` detail names the route that is actually open -------
// With a declaration, `proof/<slug>.json` replaces the diff's test files
// outright and no test glob is consulted at all, so half of the sentence the
// detail used to print — the globs, and AGENTIC_TEST_GLOBS extending them —
// was advice that could not be acted on. `tests/negative-control.test.mts`
// pins the other shape, where there is no declaration and the globs are the
// live route.
const vacuousHead = declaring('feat/6-vacuous', 'vacuous', 7, {
  tests: ['checks/pin.mts'],
  command: 'node -e "process.exit(0)"',
});
r = declRun('feat/6-vacuous', vacuousHead);
check(
  'a declared overlay that proves nothing is still `vacuous`',
  r.status === 1 && /negative-control: vacuous/.test(r.out),
  r.out,
);
check(
  "the vacuous detail names the declaration's own `tests` as the route that is open",
  /proof\/vacuous\.json/.test(verdict(r.out)) && /`tests`/.test(verdict(r.out)) && /checks\/pin\.mts/.test(verdict(r.out)),
  verdict(r.out),
);
check(
  'the vacuous detail does not offer the test globs, which a declaration suppresses',
  !/AGENTIC_TEST_GLOBS/.test(verdict(r.out)) && /no test glob/.test(verdict(r.out)),
  verdict(r.out),
);
check(
  'the vacuous detail still says why the diff is not `test-only`',
  /test-only/.test(verdict(r.out)) && /`lib\.mts`/.test(verdict(r.out)),
  verdict(r.out),
);

check('negative-control leaves no worktree behind', !/negative-control-/.test(git(['worktree', 'list'], limits)));
check('negative-control leaves no worktree behind in the declaration repo', !/negative-control-/.test(git(['worktree', 'list'], decl)));

finish();
