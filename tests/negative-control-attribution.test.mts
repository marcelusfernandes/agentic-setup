#!/usr/bin/env node
// The two ranking functions of `ci/negative-control.mts`, split out into
// `ci/lib/attribution.mts` and tested directly (#412, from #390 and #380).
// Invariant 6 allows that for pure functions under `ci/lib/`: nothing here
// reads a file, spawns the check or touches a repository, so the split is
// what makes the ranking testable at all — before this file the only way to
// ask `structuralInOverlay` a question was to build a git repository and run
// the whole control over it.
//
// **No synthetic diagnostic.** Every structural sample below is output a real
// Node process printed, captured by spawning it. A hand-written
// `Cannot find module` line would pin the rule against the string this file's
// author imagined rather than against the one a runtime emits, which is the
// mistake #297 recorded: the header the check looks for was being truncated
// away and every synthetic pin stayed green.
//
// The companion file `tests/negative-control-structural.test.mts` spawns the
// real check over real repositories for the same two shapes. This one holds
// the cases that are about the ranking itself and would be unreadable as a
// fixture repository.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributeFailures, structuralInOverlay } from '../ci/lib/attribution.mts';
import { check, cleanup, finish, RUNTIME } from './lib/harness.mts';

/** A throwaway directory, removed by `finish()`. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'negctl-attribution-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** What a run printed, as `ci/negative-control.mts` joins the two streams. */
const joined = (r: { stdout?: string | null; stderr?: string | null }): string =>
  `${r.stdout ?? ''}\n\n${r.stderr ?? ''}`.trim();

// --- the real diagnostics -------------------------------------------------

// A missing module: the signature and the overlaid path are on the same line
// (`Error: Cannot find module '/…/scripts/added.mts'`). That is the shape
// #297's fixture produces and the one a structural red has to keep.
const missingRoot = tempDir();
const MISSING = 'scripts/added.mts';
const missingModule = joined(spawnSync(RUNTIME, [join(missingRoot, MISSING)], { encoding: 'utf8' }));

// A missing export: the signature line names the *imported* module and never
// the file that failed to load. Only the `file://` source location two lines
// above it says which file this is, which is why a block-wide source location
// counts as an owner beside a same-line name.
const exportRoot = tempDir();
const IMPORTER = 'src/importer.mts';
mkdirSync(join(exportRoot, 'src'), { recursive: true });
writeFileSync(join(exportRoot, 'src', 'provider.mts'), 'export const there = 1;\n');
writeFileSync(join(exportRoot, IMPORTER), "import { absent } from './provider.mts';\nconsole.log(absent);\n");
const missingExport = joined(spawnSync(RUNTIME, [join(exportRoot, IMPORTER)], { encoding: 'utf8' }));

check('the missing-module sample is real runtime output, not a written string', /Cannot find module/.test(missingModule) && missingModule.includes(MISSING), missingModule);
check('the missing-export sample is real runtime output, not a written string', /does not provide an export named/.test(missingExport), missingExport);

// --- #390: a structural verdict rests on an owner, not on a mention --------

check(
  'a diagnostic naming the overlaid path on its own signature line is structural',
  structuralInOverlay(missingModule, [MISSING]) === true,
  missingModule,
);
check(
  'a diagnostic locating the overlaid file above its signature is structural',
  structuralInOverlay(missingExport, [IMPORTER]) === true,
  missingExport,
);
check(
  'a diagnostic that names no overlaid file at all is not structural',
  structuralInOverlay(missingModule, ['tests/unrelated.test.mts']) === false,
  missingModule,
);
check(
  'no overlaid path at all is never structural',
  structuralInOverlay(missingModule, []) === false,
  missingModule,
);

// The reporter's shape (#390), produced rather than written: a case *name*
// quoting the signature, printed by the real harness into the same diagnostic
// block as the overlaid file's own verdict line, with ordinary assertion
// failures underneath. The block mentions the overlaid file; nothing in it
// owns the signature.
const NAME_QUOTING = 'the detail carries the `Cannot find module` header';
const OVERLAID = 'tests/one.test.mts';
const reporterShape = [
  `${OVERLAID.split('/').pop()}: 0 passed, 2 failed`,
  '0 passed, 2 failed (node)',
  `FAIL  ${NAME_QUOTING}`,
  '      value is 1',
  'FAIL  an ordinary assertion also fails here',
  '      value is 1',
].join('\n');

check(
  "a case name quoting the signature beside the overlaid file's verdict line is not structural",
  structuralInOverlay(reporterShape, [OVERLAID]) === false,
  reporterShape,
);
check(
  'that same run still attributes its red to the overlaid file',
  attributeFailures(reporterShape, [OVERLAID]).owned === true,
  reporterShape,
);
check(
  'that same run names no other file as owning a red',
  attributeFailures(reporterShape, [OVERLAID]).elsewhere.length === 0,
  JSON.stringify(attributeFailures(reporterShape, [OVERLAID])),
);

// A per-file verdict line is an owner of an *assertion* red and says nothing
// about whether the file loaded, which is the one thing the two functions
// disagree about. `ownsFailure` reads it as an owner; the structural ranking
// must not, or the reporter's shape comes straight back.
check(
  'a per-file verdict line owns a failure without owning a structural signature',
  attributeFailures(reporterShape, [OVERLAID]).owned === true
    && structuralInOverlay(reporterShape, [OVERLAID]) === false,
  reporterShape,
);

// --- #380: the mention rule is unchanged by this sweep --------------------
// The corpus #380 asks for could not be produced here (no `go`, and no
// network for `jest`/`vitest`), so the rule that ranks a mention against an
// owner in `attributeFailures` is deliberately left as it stands. These two
// pin what it does today, so a later change to it is visible as a change.
check(
  'a mention with no owner elsewhere is still a mention, not an owner',
  (() => {
    const a = attributeFailures(`FAIL  the pin table lists ${OVERLAID}`, [OVERLAID]);
    return a.mentioned === true && a.owned === false && a.elsewhere.length === 0;
  })(),
  'mention-only attribution changed',
);
check(
  'a failure naming another file as the owner of a count is reported as elsewhere',
  (() => {
    const a = attributeFailures(`FAIL  the pin table lists ${OVERLAID}\n\nother.test.mts: 3 passed, 1 failed`, [OVERLAID]);
    return a.mentioned === true && a.owned === false && a.elsewhere.length === 1;
  })(),
  'contradicting-owner attribution changed',
);

finish();
