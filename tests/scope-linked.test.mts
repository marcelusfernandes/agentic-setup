#!/usr/bin/env node
// Cases for what `scope` audits and where it learned it: which linked issue
// contributed each glob, how many globs were audited from how many issues,
// and the warning for an issue linked by prose that was never meant as a
// declaration (#359, absorbed into #413).
//
// Split out of tests/scope.test.mts, which is declared at 704 of 800 lines
// and has no room for the outcomes below. Scope proper — the globs, the
// grants, the dangling references, the summary's verdict line, the two
// nudges — stays there; the 800-line rules are in
// tests/scope-line-limit.test.mts; this file is the linked-issue question.
//
// The script is spawned for real (invariant 6); the pure parsers in
// `ci/lib/scope.mts` are imported directly, which invariant 6 allows for
// `ci/lib/`. Every expected sentence is written out here rather than read
// back from `ci/scope-check.mts` (invariant 10).
//
// Negative control: every case here is red on the base. The parsers
// `findLinkedIssueMatches` and `incidentalLinkedIssues` do not exist there,
// and `ci/scope-check.mts` prints neither an audited-glob count with its
// sources nor a warning for an incidentally linked issue. The new exports
// come in through the namespace, not a named import: a named import of an
// export the base checkout does not have kills the whole file at load time,
// which reads as a structural red rather than an assertion.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, ci, cleanup, finish } from './lib/harness.mts';
import { parseLinkedIssues } from '../ci/lib/scope.mts';
import * as scopeLib from '../ci/lib/scope.mts';

const dir = mkdtempSync(join(tmpdir(), 'agentic-scope-linked-'));
cleanup(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, content: string): string => {
  writeFileSync(join(dir, name), content);
  return join(dir, name);
};
const scopeJson = (out: string): any => {
  const m = out.match(/^\{[\s\S]*?\n\}\n/);
  if (!m) throw new Error(`no top-level JSON object found in: ${out}`);
  return JSON.parse(m[0]);
};

type LinkedIssueMatch = { issue: number; line: number; phrase: string; declared: boolean };
const findLinkedIssueMatches = (scopeLib as Record<string, unknown>).findLinkedIssueMatches as
  ((body: string | null | undefined) => LinkedIssueMatch[]) | undefined;
const incidentalLinkedIssues = (scopeLib as Record<string, unknown>).incidentalLinkedIssues as
  ((body: string | null | undefined) => LinkedIssueMatch[]) | undefined;
check('ci/lib/scope.mts exports findLinkedIssueMatches', typeof findLinkedIssueMatches === 'function');
check('ci/lib/scope.mts exports incidentalLinkedIssues', typeof incidentalLinkedIssues === 'function');
const matches = (body: string): LinkedIssueMatch[] => (findLinkedIssueMatches ? findLinkedIssueMatches(body) : []);
const incidental = (body: string): LinkedIssueMatch[] => (incidentalLinkedIssues ? incidentalLinkedIssues(body) : []);

// --- the four outcomes, each named -------------------------------------------
// The declaration is the run of lines at the top of the body that carry
// nothing but closing-keyword links. `docs/workflow.md` and
// `skills/issue-and-pr/SKILL.md` have always asked for `Closes #N` there and
// have always allowed several issues, so the form is the one every well-formed
// body in this repository already has — which is why it cannot be produced by
// accident halfway down a paragraph.

// 1. A first-line `Closes #N` alone: declared, nothing incidental.
const oneLine = 'Closes #1\n\nWhat changed: the parser.\n';
check(
  'a first-line Closes #N is the declaration and nothing is incidental',
  JSON.stringify(matches(oneLine).map((m) => [m.issue, m.line, m.declared])) === JSON.stringify([[1, 0, true]])
    && incidental(oneLine).length === 0,
  JSON.stringify(matches(oneLine)),
);

// The documented multi-issue form: consecutive keyword-only lines at the top
// are all declaration. CLAUDE.md and skills/issue-and-pr/SKILL.md both say
// several issues may be linked, so a rule that warned on the second line would
// warn on a body written exactly as the card asks.
const twoLines = 'Closes #1\nFixes #2\n\nWhat changed: the parser.\n';
check(
  'consecutive keyword-only lines at the top are all declaration, none incidental',
  JSON.stringify(matches(twoLines).map((m) => m.declared)) === JSON.stringify([true, true])
    && incidental(twoLines).length === 0,
  JSON.stringify(matches(twoLines)),
);

// 2. A second link in prose: incidental, and the warning names the phrase.
// The sentence is the real one from PR #440, which is the live occurrence of
// this shape in this repository's merged pull requests.
const inProse = 'Closes #1\n\nThe body said this:\n\nPR #426 (which closed #2) made both sentences false.\n';
check(
  'a linking keyword in prose below the declaration is incidental, with its line and phrase',
  JSON.stringify(incidental(inProse).map((m) => [m.issue, m.line, m.phrase]))
    === JSON.stringify([[2, 4, 'PR #426 (which closed #2) made both sentences false.']]),
  JSON.stringify(incidental(inProse)),
);
check(
  'the incidental issue is still a linked issue — the parser is not narrowed',
  JSON.stringify(parseLinkedIssues(inProse)) === JSON.stringify([1, 2]),
  JSON.stringify(parseLinkedIssues(inProse)),
);

// 3. A second link inside backticks: not linked at all, so not incidental.
const inBackticks = 'Closes #1\n\nThe rule is that a body saying `closed #2` links nothing.\n';
check(
  'a linking keyword inside an inline code span is neither linked nor incidental',
  JSON.stringify(parseLinkedIssues(inBackticks)) === JSON.stringify([1]) && incidental(inBackticks).length === 0,
  JSON.stringify(incidental(inBackticks)),
);

// 4. A second link inside a fenced block: the same, by the same rule.
const inFence = 'Closes #1\n\n```\nCloses #2\n```\n\nEnd.\n';
check(
  'a linking keyword inside a fenced block is neither linked nor incidental',
  JSON.stringify(parseLinkedIssues(inFence)) === JSON.stringify([1]) && incidental(inFence).length === 0,
  JSON.stringify(incidental(inFence)),
);

// An issue named in prose that the declaration already carries adds no globs,
// so it is not reported: the warning exists for scope that was widened, not
// for every repetition of a number.
const repeated = 'Closes #1\n\nThis is the change that closed #1 for good.\n';
check(
  'an issue repeated in prose but already declared is not incidental',
  incidental(repeated).length === 0,
  JSON.stringify(incidental(repeated)),
);

// Invariant 5, the exact prose: stripping a code span used to splice the text
// either side of it together, so `clos`e`s #1` read as `closes #1` and linked
// an issue nobody wrote. Code is now blanked in place, keeping every offset,
// which is what makes a line number reportable at all — and the splice goes
// with it. This is the parser getting stricter, and this is the prose.
check(
  'a keyword split by an inline code span does not link an issue',
  parseLinkedIssues('clos`e`s #1\n').length === 0,
  JSON.stringify(parseLinkedIssues('clos`e`s #1\n')),
);
check(
  'blanking code in place does not move a line number',
  JSON.stringify(matches('`a`\n\nCloses #1\n').map((m) => m.line)) === JSON.stringify([2]),
  JSON.stringify(matches('`a`\n\nCloses #1\n')),
);

// --- spawned: what the check says it audited ---------------------------------
// Both incidents #359 records were invisible because the audited total was
// never stated against the declared one. The count and its sources are printed
// on every run, passing or failing.
const files = file('files.txt', 'src/a.ts\n');
const issueOne = file('issue-1.md', '## Goal\nx\n\n## Files\n- `src/**`\n\n## Dependencies\nnone\n');
// #2 re-declares `src/**`, which #1 already granted, and adds `docs/**`. The
// warning reports one added glob, not two: the reviewer of #359 corrected its
// own wording on exactly this point — the accidental issue contributed six
// globs but five distinct new paths, because one was already granted.
const issueTwo = file('issue-2.md', '## Goal\nx\n\n## Files\n- `src/**`\n- `docs/**`\n\n## Dependencies\nnone\n');
const prProse = file(
  'pr-prose.md',
  'Closes #1\n\nWhat changed: the parser.\n\nPR #426 (which closed #2) made both sentences false.\n\n## Files\nGlobs touched.\n',
);
const rProse = ci('scope-check.mts', [
  '--files-file', files,
  '--issue-body-file', `${issueOne},${issueTwo}`,
  '--pr-body-file', prProse,
]);
check(
  'a widened run still passes — the incidental link is a warning, never a verdict',
  rProse.status === 0,
  rProse.out,
);
check(
  'the summary states the audited glob count with its sources, declared and incidental',
  /Audited 3 glob\(s\) from 2 linked issue\(s\): #1 \(declared\), #2 \(from prose\)/.test(rProse.out),
  rProse.out,
);
check(
  'the summary warns, naming the phrase, the issue and the globs it would add',
  /> warning: .*#2 is linked from prose rather than from the declaration/.test(rProse.out)
    && rProse.out.includes('PR #426 (which closed #2) made both sentences false.')
    && /adds 1 glob\(s\) the declaration did not: `docs\/\*\*`/.test(rProse.out),
  rProse.out,
);
check(
  "scope JSON carries the audit and the incidental links",
  (() => {
    const j = scopeJson(rProse.out);
    return j.audited && j.audited.globs === 3 && j.audited.issues === 2
      && Array.isArray(j.incidentalLinks) && j.incidentalLinks.length === 1
      && j.incidentalLinks[0].issue === 2
      && JSON.stringify(j.incidentalLinks[0].adds) === JSON.stringify(['docs/**']);
  })(),
  rProse.out,
);

// The same two issues, both declared at the top: the audited count is the
// same, and there is no warning. A correct run and a widened run stop
// producing identical output, which is what made both incidents invisible.
const prDeclared = file(
  'pr-declared.md',
  'Closes #1\nCloses #2\n\nWhat changed: the parser.\n\n## Files\nGlobs touched.\n',
);
const rDeclared = ci('scope-check.mts', [
  '--files-file', files,
  '--issue-body-file', `${issueOne},${issueTwo}`,
  '--pr-body-file', prDeclared,
]);
check(
  'a body that declares both issues audits the same globs and warns about nothing',
  rDeclared.status === 0
    && /Audited 3 glob\(s\) from 2 linked issue\(s\): #1 \(declared\), #2 \(declared\)/.test(rDeclared.out)
    && !/linked from prose/.test(rDeclared.out),
  rDeclared.out,
);
check(
  'the two runs differ in their output, which is what made both incidents invisible',
  rProse.out !== rDeclared.out,
  rProse.out,
);

finish();
