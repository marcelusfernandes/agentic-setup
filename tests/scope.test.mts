#!/usr/bin/env node
// Cases for ci/scope-check.mts: the PR diff must stay inside the issue's
// `## Files` globs, unless the PR body grants extra files with `authorised:`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, ci, cleanup, finish } from './lib/harness.mts';

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

finish();
