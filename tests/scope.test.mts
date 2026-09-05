#!/usr/bin/env node
// Cases for ci/scope-check.mts: the PR diff must stay inside the issue's
// `## Files` globs, unless the PR body grants extra files with `authorised:`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, ci, cleanup, finish } from './lib/harness.mts';
import { parseLinkedIssues } from '../ci/lib/scope.mts';

const dir = mkdtempSync(join(tmpdir(), 'agentic-scope-'));
cleanup(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, content: string): string => {
  writeFileSync(join(dir, name), content);
  return join(dir, name);
};
const files = file('files.txt', 'src/a.ts\nsrc/lib/b.ts\n');
const issueSrc = file('issue-src.md', '## Goal\nx\n\n## Files\nGlobs this issue may touch:\n- `src/**`\n\n## Dependencies\nnone\n');
const issueLib = file('issue-lib.md', '## Files\n- `lib/**`, `docs/*.md`\n');
const issueBare = file('issue-bare.md', '## Files\n- src/**\n');
const prPlain = file('pr-plain.md', 'Closes #1\n\n## Files\nGlobs touched (must match the issue).\n');
const prGrant = file('pr-grant.md', 'Closes #1\n\n## Files\n- authorised: `src/a.ts`\n  (orchestrator: needed for AC3)\n- authorised: `src/lib/b.ts` — see issue comment\n');
const prNoClose = file('pr-noclose.md', '## What changed\nstuff\n');
const scope = (f: string, i: string | null, p: string) => ci('scope-check.mts', ['--files-file', f, ...(i ? ['--issue-body-file', i] : []), '--pr-body-file', p]);

check('scope passes inside the issue globs', scope(files, issueSrc, prPlain).status === 0);
check('scope passes with bare (unquoted) globs', scope(files, issueBare, prPlain).status === 0);
check('scope fails outside the issue globs', scope(files, issueLib, prPlain).status === 1);
check('scope passes when the PR grants the files with authorised:', scope(files, issueLib, prGrant).status === 0);
check('scope fails without Closes #N', scope(files, null, prNoClose).status === 1);
const r = scope(files, issueLib, prPlain);
check('scope names the violations', /src\/a\.ts/.test(r.out) && /src\/lib\/b\.ts/.test(r.out), r.out);

// AC1: parseLinkedIssues accepts Closes/Fixes/Resolves and their forms,
// in order, deduplicated, and ignores a bare #N with no keyword before it.
const linkedBody = [
  'Closes #1',
  'Fixes #2',
  'Resolves #3',
  'this closed #4 already',
  'fixes: #5',
  'see also #6 for context',
  'Closes #1 again',
].join('\n');
check(
  'parseLinkedIssues finds Closes/Fixes/Resolves + closed/fixes: forms, ordered and deduped, ignoring bare #N',
  JSON.stringify(parseLinkedIssues(linkedBody)) === JSON.stringify([1, 2, 3, 4, 5]),
  JSON.stringify(parseLinkedIssues(linkedBody)),
);
check('parseLinkedIssues returns nothing for a body with no linking keyword', parseLinkedIssues('## What changed\nstuff\n#6\n').length === 0);

// AC2: several linked issues (Closes #1, Fixes #2) union their `## Files`
// globs, and the job summary attributes each glob to its issue.
const issueA = file('issue-a.md', '## Files\n- `src/**`\n');
const issueB = file('issue-b.md', '## Files\n- `lib/**`\n');
const prTwo = file('pr-two.md', 'Closes #1\nFixes #2\n\n## Files\nGlobs touched.\n');
const filesTwo = file('files-two.txt', 'src/a.ts\nlib/b.ts\n');
const scopeTwo = (f: string) => ci('scope-check.mts', ['--files-file', f, '--issue-body-file', `${issueA},${issueB}`, '--pr-body-file', prTwo]);

const r2 = scopeTwo(filesTwo);
check('scope unions the globs of several linked issues', r2.status === 0, r2.out);
check(
  'scope summary attributes each glob to its linked issue',
  /#1/.test(r2.out) && /#2/.test(r2.out) && /src\/\*\*/.test(r2.out) && /lib\/\*\*/.test(r2.out),
  r2.out,
);

const filesOutsideUnion = file('files-outside-union.txt', 'other/x.ts\n');
const r3 = scopeTwo(filesOutsideUnion);
check('scope fails on a file outside the union of the linked issues\' globs', r3.status === 1, r3.out);

// AC3: zero linked issues still fails, naming the three keywords.
const rZero = scope(files, null, prNoClose);
check(
  'scope names Closes/Fixes/Resolves when no issue is linked',
  /closes/i.test(rZero.out) && /fixes/i.test(rZero.out) && /resolves/i.test(rZero.out),
  rZero.out,
);

finish();
