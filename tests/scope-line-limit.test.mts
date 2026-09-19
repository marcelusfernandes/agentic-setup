#!/usr/bin/env node
// Cases for the line-limit rules of ci/scope-check.mts: a pull request may
// not add a file over 800 lines or grow one past 800 (`@generated` on the
// first line exempt, #134), and a file that was already over at the base and
// was not lengthened here is *reported* in a section of its own rather than
// silently exempt (#310). Split out of tests/scope.test.mts (#352): scope
// proper — the globs, the grants, the linked issues, the dangling
// references, the summary's verdict line, the two nudges — stayed there, and
// every case about the 800-line limit is here. That is the subject this
// repository has changed twice in two days, so it is the one given room to
// keep accumulating.
//
// The script is spawned for real against throwaway git repositories, because
// the growth check runs `git show base:path` / `git show head:path`
// (invariant 6); the pure `fileGrowth` and `lengthOutcome` are imported
// directly, which invariant 6 allows for `ci/lib/`. The names those two
// answer with are written out here rather than read back from the classifier
// they pin (invariant 10).
//
// Negative control: there is no red for this file. The moved cases pass on
// the base because `ci/scope-check.mts` is unchanged by this pull request,
// and the one case added at the end passes there too, because the sentence
// it names landed in #385 — which is the point: it is a positive assertion
// standing where only a negative stood, so the next rewording of that
// sentence turns this case red instead of leaving the negative matching
// nothing forever. A diff confined to the test globs is `test-only`
// (docs/workflow.md), and that verdict passes.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, ci, cleanup, commit, finish, git, tempRepo } from './lib/harness.mts';
import { fileGrowth } from '../ci/lib/scope.mts';
import type { FileLinesEntry } from '../ci/lib/scope.mts';
// `lengthOutcome` comes in through the namespace, not a named import: a
// named import of an export the base checkout does not have kills the whole
// file at load time, which reads as a structural red rather than an
// assertion — the same reason tests/scope.test.mts imports this way.
import * as scopeLib from '../ci/lib/scope.mts';

const dir = mkdtempSync(join(tmpdir(), 'agentic-scope-limit-'));
cleanup(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, content: string): string => {
  writeFileSync(join(dir, name), content);
  return join(dir, name);
};
const files = file('files.txt', 'src/a.ts\nsrc/lib/b.ts\n');
const issueSrc = file('issue-src.md', '## Goal\nx\n\n## Files\nGlobs this issue may touch:\n- `src/**`\n\n## Dependencies\nnone\n');
const prPlain = file('pr-plain.md', 'Closes #1\n\n## Files\nGlobs touched (must match the issue).\n');
const scope = (f: string, i: string | null, p: string) => ci('scope-check.mts', ['--files-file', f, ...(i ? ['--issue-body-file', i] : []), '--pr-body-file', p]);
// The script's stdout is the JSON block (indented, so its top-level closing
// `}` is the first line that is exactly `}`) followed by the job summary
// text; this pulls out just the JSON so a case can assert on individual
// keys instead of pattern-matching the whole combined output.
const scopeJson = (out: string): any => {
  const m = out.match(/^\{[\s\S]*?\n\}\n/);
  if (!m) throw new Error(`no top-level JSON object found in: ${out}`);
  return JSON.parse(m[0]);
};

// #134: `scope` fails a PR that adds a file over 800 lines or grows a file
// past 800 lines, `@generated` first line exempt. Real repos: the growth
// check runs `git show base:path` / `git show head:path`.
const linesOf = (n: number, fill = 'line'): string => `${Array.from({ length: n }, (_, i) => `${fill} ${i}`).join('\n')}\n`;
const issueSrcStar = file('issue-src-star.md', '## Files\n- `src/**`\n');
const prClosesOnlyGeneric = file('pr-closes-only-generic.md', 'Closes #1\n\n## Files\nGlobs touched.\n');
const scopeGrowth = (base: string, head: string, root: string) =>
  ci('scope-check.mts', ['--base', base, '--head', head, '--issue-body-file', issueSrcStar, '--pr-body-file', prClosesOnlyGeneric, '--root', root]);

const growthRepo = tempRepo();
const growthBase = commit(growthRepo, { 'src/big.ts': linesOf(700) }, 'chore: base at 700 lines');
git(['checkout', '-q', '-b', 'feat/134-grow'], growthRepo);
const growthHead = commit(growthRepo, { 'src/big.ts': linesOf(900) }, 'feat: grow src/big.ts to 900 lines');
const rGrowth = scopeGrowth(growthBase, growthHead, growthRepo);
check(
  'scope fails when a file grows from 700 to 900 lines, naming the file',
  rGrowth.status === 1 && /src\/big\.ts/.test(rGrowth.out) && /### File growth/.test(rGrowth.out),
  rGrowth.out,
);
check(
  "scope JSON's growth key names the one file that grew past the limit",
  (() => {
    const growth = scopeJson(rGrowth.out).growth;
    return Array.isArray(growth) && growth.length === 1 && growth[0].path === 'src/big.ts';
  })(),
  rGrowth.out,
);

// #134 round 2: `misplacedAuthorised` must stay tied to a glob failure —
// `result.ok` — and not to the overall `ok`, which also folds in growth
// and dangling-reference failures. Globs here cover every changed file
// (issueSrcStar matches src/**), so the glob check passes even though the
// growth check still fails the run; a stray authorised: line outside
// ## Files must not be reported as misplacedAuthorised in that case.
const prGrowthMisplaced = file(
  'pr-growth-misplaced.md',
  'Closes #1\n\n- authorised: `src/other.ts`\n  (stray grant outside ## Files; globs already cover everything)\n\n## Files\nGlobs touched.\n',
);
const rGrowthMisplaced = ci('scope-check.mts', [
  '--base', growthBase, '--head', growthHead,
  '--issue-body-file', issueSrcStar, '--pr-body-file', prGrowthMisplaced,
  '--root', growthRepo,
]);
check(
  'scope does not report misplacedAuthorised when only the growth check fails and the glob check passes',
  rGrowthMisplaced.status === 1 && !('misplacedAuthorised' in scopeJson(rGrowthMisplaced.out)),
  rGrowthMisplaced.out,
);

// Already over 800 and edited, without growing further, is not a violation.
git(['checkout', '-q', '-b', 'feat/134-already-900', growthHead], growthRepo);
const growthEditedHead = commit(growthRepo, { 'src/big.ts': linesOf(900, 'edited') }, 'refactor: edit src/big.ts without changing its line count');
const rGrowthEdited = scopeGrowth(growthHead, growthEditedHead, growthRepo);
check(
  'scope passes editing a file already over 800 lines, when it does not grow further',
  rGrowthEdited.status === 0 && !/### File growth/.test(rGrowthEdited.out),
  rGrowthEdited.out,
);
// #310: the same run *reports* that file — over the limit at the base, not
// lengthened here — in a section of its own, and still exits 0. The two
// sentences read differently on purpose: "added or lengthened them" blames
// this diff, "was already over at the base" does not.
check(
  'scope reports an inherited over-limit file in a section of its own, without failing and without blaming this diff',
  rGrowthEdited.status === 0
    && /### Already over the line limit/.test(rGrowthEdited.out)
    && /`src\/big\.ts` was already over at the base: 900 line\(s\) there, 900 at the head/.test(rGrowthEdited.out)
    && /brings the file back under 800 lines/.test(rGrowthEdited.out)
    && !/this pull request added or lengthened them/.test(rGrowthEdited.out)
    && JSON.stringify(scopeJson(rGrowthEdited.out).inherited) === JSON.stringify([{ path: 'src/big.ts', baseLines: 900, headLines: 900 }]),
  rGrowthEdited.out,
);

// A new file over 800 lines marked `@generated` on its first line is exempt.
git(['checkout', '-q', '-b', 'feat/134-generated', growthBase], growthRepo);
const generatedHead = commit(growthRepo, { 'src/generated.ts': `// @generated\n${linesOf(900)}` }, 'feat: add generated src/generated.ts');
const rGenerated = scopeGrowth(growthBase, generatedHead, growthRepo);
check(
  'scope passes a new file over 800 lines whose first line marks it @generated',
  rGenerated.status === 0 && !/### File growth/.test(rGenerated.out),
  rGenerated.out,
);

// A --files-file run (no base/head) is unaffected by the growth check.
const rFilesFileOnly = scope(files, issueSrc, prPlain);
check(
  'scope --files-file run without base/head has no File growth section',
  rFilesFileOnly.status === 0 && !/### File growth/.test(rFilesFileOnly.out),
  rFilesFileOnly.out,
);

// Direct unit test of the pure fileGrowth: growth past the limit fails,
// already-over-the-limit-but-not-growing does not, @generated is exempt.
check(
  'fileGrowth: a file growing past 800 lines is a violation',
  JSON.stringify(fileGrowth([{ path: 'a.ts', baseLines: 700, headLines: 900, generated: false }])) ===
    JSON.stringify([{ path: 'a.ts', baseLines: 700, headLines: 900 }]),
);
check('fileGrowth: a new file over 800 lines is a violation', fileGrowth([{ path: 'a.ts', baseLines: null, headLines: 900, generated: false }]).length === 1);
check(
  'fileGrowth: a new file under 800 lines is not a violation',
  fileGrowth([{ path: 'a.ts', baseLines: null, headLines: 700, generated: false }]).length === 0,
);
check(
  'fileGrowth: already over 800 lines and shrinking is not a violation',
  fileGrowth([{ path: 'a.ts', baseLines: 900, headLines: 850, generated: false }]).length === 0,
);
check(
  'fileGrowth: already over 800 lines and unchanged is not a violation',
  fileGrowth([{ path: 'a.ts', baseLines: 900, headLines: 900, generated: false }]).length === 0,
);
check(
  'fileGrowth: a file that grows but stays under 800 lines is not a violation',
  fileGrowth([{ path: 'a.ts', baseLines: 500, headLines: 700, generated: false }]).length === 0,
);
check(
  'fileGrowth: @generated on the first line exempts a file that would otherwise violate',
  fileGrowth([{ path: 'a.ts', baseLines: 700, headLines: 900, generated: true }]).length === 0,
);

// #310: every length relation answers with a name of its own, so a change to
// either half of the old two-part condition moves a case rather than widening
// the exemption in silence. The names are written out here, not read back from
// the classifier they pin (invariant 10). Equal-to-base and shorter-than-base
// both answer `inherited-over`: neither is length this pull request added.
const lengthOutcome = scopeLib.lengthOutcome as ((entry: FileLinesEntry) => string) | undefined;
check('ci/lib/scope.mts exports lengthOutcome', typeof lengthOutcome === 'function');
const outcome = (baseLines: number | null, headLines: number): string =>
  lengthOutcome ? lengthOutcome({ path: 'a.ts', baseLines, headLines, generated: false }) : 'not exported';
check('lengthOutcome: over the limit and longer than the base is pushed-over', outcome(798, 808) === 'pushed-over', outcome(798, 808));
check('lengthOutcome: over the limit and equal to the base is inherited-over', outcome(808, 808) === 'inherited-over', outcome(808, 808));
check('lengthOutcome: over the limit and shorter than the base is inherited-over', outcome(900, 850) === 'inherited-over', outcome(900, 850));
check('lengthOutcome: under the limit is under-limit', outcome(500, 700) === 'under-limit', outcome(500, 700));

finish();
