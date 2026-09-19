// The one fake `gh`, the one throwaway repository and the one issue-body
// builder that `ci/issue-lint.mts`'s cases are spawned against. Extracted
// from tests/issue-lint.test.mts (#352), when that file was split by
// subject, so tests/issue-lint.test.mts and
// tests/issue-lint-disjointness.test.mts read the same fixtures: two copies
// of a fake of one command drift apart, and a case that passes against a
// fake the real command no longer matches proves nothing. That is the
// reason tests/lib/init-gh.mts exists (#229), and the reason this file does.
//
// Nothing here is a pin. Invariant 10 governs a test over prose or data,
// which writes the expected shape out itself rather than importing the thing
// it checks; this is a fixture standing in for an external command, and the
// script under test is still spawned for real, against a real temporary git
// repository, by every case that imports this (invariant 6).
//
// This file is deliberately not named `*.test.mts`: tests/run.mts discovers
// `tests/*.test.mts` only, so it runs the two test files and never this one.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ci, cleanup, commit, tempRepo } from './harness.mts';

// --- a fake `gh` on PATH, for AC5 only: `gh issue view <n> --json number` -
// succeeds for any number except 999 (simulates "issue does not exist"). --
const FAKE_GH = `#!/usr/bin/env bash
if [ "\${1:-}" = "issue" ] && [ "\${2:-}" = "view" ]; then
  n="\${3:-}"
  if [ "$n" = "999" ]; then
    echo "gh: issue #999 not found" >&2
    exit 1
  fi
  echo "{\\"number\\": $n}"
  exit 0
fi
echo "fake-gh: unexpected args: $*" >&2
exit 1
`;
const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-issuelint-fakegh-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
export const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- a real repo with tracked files the globs exercise for real ------------
export const repo = tempRepo();
commit(repo, {
  'package.json': '{"name":"x"}\n',
  'tests/smoke.mts': 'export {};\n',
  'tests/other.test.mts': 'export {};\n',
  'scripts/reconcile.mts': 'export {};\n',
  '.github/workflows/test.yml': 'name: test\non: push\njobs:\n  test:\n    steps:\n      - run: node tests/smoke.mts\n',
}, 'chore: base');

// --- issue body builder: six valid sections by default, one override at a
// time so each case isolates exactly one failure ---------------------------
export type Parts = { context: string; goal: string; ac: string; proof: string; files: string; deps: string };
const DEFAULT_PARTS: Parts = {
  context: '## Context\nSome context.\n',
  goal: '## Goal\nDo the thing.\n',
  ac: '## Acceptance criteria\n- [ ] AC1 does the thing\n',
  proof: '## Proof\nnpm test covers it.\n',
  files: '## Files\n- `tests/**`\n',
  deps: '## Dependencies\nBlocked by: none\n',
};
export function issueBody(overrides: Partial<Record<keyof Parts, string | null>> = {}): string {
  const keys: (keyof Parts)[] = ['context', 'goal', 'ac', 'proof', 'files', 'deps'];
  const parts = keys
    .map((k) => (k in overrides ? overrides[k] : DEFAULT_PARTS[k]))
    .filter((v): v is string => v !== null);
  return parts.join('\n');
}

let seq = 0;
export function bodyFile(body: string): string {
  const p = join(repo, `issue-body-${seq++}.md`);
  writeFileSync(p, body);
  return p;
}
export function milestoneFile(issues: Array<{ number: number; labels: string[]; body: string }>): string {
  const p = join(repo, `milestone-${seq++}.json`);
  writeFileSync(p, JSON.stringify(issues));
  return p;
}
// The same counter, for a case that writes its own fixture into `repo` and
// needs a name no other fixture takes. An imported binding is read-only, so
// `seq++` cannot be spelled at the call site the way it was when this
// counter and that case lived in one file.
export function nextSeq(): number {
  return seq++;
}

export function lint(n: number, body: string, opts: { milestone?: string; markdown?: boolean } = {}) {
  const args = ['--issue', String(n), '--issue-body-file', bodyFile(body)];
  if (opts.milestone) args.push('--milestone-issues-file', opts.milestone);
  if (opts.markdown) args.push('--markdown');
  return ci('issue-lint.mts', args, { cwd: repo, env: { PATH: PATH_WITH_FAKE_GH } });
}

export function parse(out: string): any {
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
