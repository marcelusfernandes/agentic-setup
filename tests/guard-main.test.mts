#!/usr/bin/env node
// Cases for the guard-main workflow: the two copies of the file — this
// repository's own `.github/workflows/guard-main.yml` and the one `init`
// ships to adopting repositories, `templates/.github/workflows/guard-main.yml`
// — are pinned byte-identical here, and the bash step inside the file is
// extracted and run for real against a fake `gh` first on PATH.
//
// A workflow's step is not importable, so the `run: |` block is read out of
// the YAML and executed by bash with the same env vars the workflow sets
// (SHA, REPO, MSG, ACTOR). A no-op `sleep` sits next to the fake `gh` on
// PATH, so the retry loop's four attempts run without its 45 seconds of
// waiting; nothing in the step is otherwise rewritten.
//
// FAKE_GH_SEQ drives one outcome per attempt, comma-separated:
// `error` (non-zero exit, stderr), `empty` (0 PRs), `ok:N` (N PRs),
// `noise:N` / `noise-empty` (the same answers with a warning printed to
// stderr, the case that used to read as "unexpected response"), `garbage`
// (a non-numeric answer, which still is one). FAKE_GH_FAIL=label|issue makes
// the failure path's `gh label create` / `gh issue create` exit non-zero.
//
// Negative control: on the base the step merges stderr into stdout
// (`2>&1`), so the noisy cases below report "unexpected response" and reach
// the failure path instead of exiting 0; the failure path swallows a
// `label create`/`issue create` failure without a `::warning::`; and the
// header says nothing about the two copies being pinned. Those cases fail on
// their own assertions — a runtime red. The byte-identical case passes on
// the base (the copies are identical there today); it is here to keep them
// that way.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, check, cleanup, finish } from './lib/harness.mts';

const OWN = join(ROOT, '.github', 'workflows', 'guard-main.yml');
const SHIPPED = join(ROOT, 'templates', '.github', 'workflows', 'guard-main.yml');
const own = readFileSync(OWN, 'utf8');
const shipped = readFileSync(SHIPPED, 'utf8');

// --- the two copies are one file -------------------------------------------
/** The first line at which two texts differ, as `line N: a | b`, or '' when equal. */
function firstDifference(a: string, b: string): string {
  const left = a.split('\n');
  const right = b.split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) return `line ${i + 1}: ${left[i] ?? '<missing>'} | ${right[i] ?? '<missing>'}`;
  }
  return '';
}

check(
  '.github/workflows/guard-main.yml and templates/.github/workflows/guard-main.yml are byte-identical',
  own === shipped,
  firstDifference(own, shipped),
);

// AC4: the header says the pin is this test, not "copied at init time".
const header = own.slice(0, own.indexOf('\nname:'));
check(
  'the header states the two copies are pinned identical by tests/guard-main.test.mts',
  /identical/.test(header) && header.includes('tests/guard-main.test.mts'),
  header,
);

// --- the step, lifted out of the YAML --------------------------------------
/** Returns the body of the single `run: |` block in a workflow file, dedented. */
function runBlock(yaml: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => /^\s*run:\s*\|\s*$/.test(line));
  if (start < 0) throw new Error('guard-main.yml has no `run: |` block');
  const indent = (/^\s*/.exec(lines[start] ?? '')?.[0] ?? '').length + 2;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if ((/^\s*/.exec(line)?.[0] ?? '').length < indent) break;
    body.push(line.slice(indent));
  }
  return `${body.join('\n')}\n`;
}

const STEP = runBlock(own);
check('the step was extracted from the workflow', STEP.includes('gh api') && STEP.includes('attempts=4'), STEP.slice(0, 200));

// --- a fake `gh` and a no-op `sleep` on PATH --------------------------------
const FAKE_GH = `#!/usr/bin/env bash
set -uo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_STATE_DIR/gh-argv.log"

case "\${1:-}" in
  api)
    n=$(( $(cat "$FAKE_GH_STATE_DIR/attempts" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$n" > "$FAKE_GH_STATE_DIR/attempts"
    step="$(printf '%s' "$FAKE_GH_SEQ" | tr ',' '\\n' | sed -n "\${n}p")"
    case "$step" in
      error) echo "gh: HTTP 502 (bad gateway)" >&2; exit 1 ;;
      empty) echo 0 ;;
      garbage) echo "<html>not an answer</html>" ;;
      noise-empty) echo "gh: warning: this token has limited scopes" >&2; echo 0 ;;
      noise:*) echo "gh: warning: this token has limited scopes" >&2; echo "\${step#noise:}" ;;
      ok:*) echo "\${step#ok:}" ;;
      *) echo "fake-gh: no step $n in FAKE_GH_SEQ=$FAKE_GH_SEQ" >&2; exit 1 ;;
    esac
    ;;
  label)
    if [ "\${FAKE_GH_FAIL:-}" = "label" ]; then echo "fake-gh: label create refused" >&2; exit 1; fi
    echo "fake-gh: label human:pending is in place"
    ;;
  issue)
    case "\${2:-}" in
      list) echo "\${FAKE_GH_OPEN_ISSUES:-0}" ;;
      create)
        if [ "\${FAKE_GH_FAIL:-}" = "issue" ]; then echo "fake-gh: issue create refused" >&2; exit 1; fi
        body=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --body) body="\${2:-}"; shift 2 ;;
            *) shift ;;
          esac
        done
        printf '%s' "$body" > "$FAKE_GH_STATE_DIR/issue-body.txt"
        echo "https://github.com/owner/repo/issues/1"
        ;;
      *) echo "fake-gh: unknown issue command: $*" >&2; exit 1 ;;
    esac
    ;;
  *) echo "fake-gh: unknown command: $*" >&2; exit 1 ;;
esac
`;

const binDir = mkdtempSync(join(tmpdir(), 'agentic-guard-main-bin-'));
cleanup(() => rmSync(binDir, { recursive: true, force: true }));
writeFileSync(join(binDir, 'gh'), FAKE_GH);
chmodSync(join(binDir, 'gh'), 0o755);
writeFileSync(join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
chmodSync(join(binDir, 'sleep'), 0o755);

// --- runner -----------------------------------------------------------------
const SHA = '1234567890abcdef1234567890abcdef12345678';

type Run = { status: number | null; out: string; body: string; log: string };

/** Runs the extracted step with the given per-attempt sequence and env. */
function run(seq: string, env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-guard-main-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh-argv.log'), '');
  const script = join(dir, 'step.sh');
  writeFileSync(script, STEP);
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_GH_STATE_DIR: dir,
      FAKE_GH_SEQ: seq,
      GH_TOKEN: 'fake-token',
      SHA,
      REPO: 'owner/repo',
      MSG: 'fix(ci): a commit that arrived through a PR',
      ACTOR: 'someone',
      ...env,
    },
  });
  const read = (name: string): string => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, body: read('issue-body.txt'), log: read('gh-argv.log') };
}

// --- AC3: the four-attempt sequencing ---------------------------------------
// All four attempts answer "0 PR(s)": a confirmed direct push.
const empty = run('empty,empty,empty,empty');
check('all-empty: fails', empty.status === 1, empty.out);
check('all-empty: the body claims a confirmed direct push', /reached .main. without a PR/.test(empty.body), empty.body || empty.out);
check('all-empty: the body does not claim the lookup failed', !/lookup failed/.test(empty.body), empty.body);
check('all-empty: it reports the direct push as an error', empty.out.includes('::error::direct push to main'), empty.out);

// All four attempts error: not a confirmed direct push, so the body says so.
const errored = run('error,error,error,error');
check('all-error: fails', errored.status === 1, errored.out);
check('all-error: the body says the lookup failed', /the commit-to-PR lookup failed/.test(errored.body), errored.body || errored.out);
check('all-error: the body does not claim a confirmed direct push', /not a confirmed direct push/.test(errored.body), errored.body);

// Alternating: the LAST attempt decides which body is written.
const emptyThenError = run('empty,empty,empty,error');
check('empty-then-error: the last attempt (error) decides the body', /the commit-to-PR lookup failed/.test(emptyThenError.body), emptyThenError.body || emptyThenError.out);
const errorThenEmpty = run('error,error,error,empty');
check('error-then-empty: the last attempt (empty) decides the body', /reached .main. without a PR/.test(errorThenEmpty.body), errorThenEmpty.body || errorThenEmpty.out);

// A non-numeric answer counts as an error, not as an empty list.
const garbage = run('garbage,garbage,garbage,garbage');
check('garbage: reports an unexpected response', garbage.out.includes('unexpected response'), garbage.out);
check('garbage: the body says the lookup failed', /the commit-to-PR lookup failed/.test(garbage.body), garbage.body || garbage.out);

// An error that is followed by a real answer stops the loop, green.
const recovered = run('error,ok:2');
check('error-then-success: exits 0', recovered.status === 0, recovered.out);
check('error-then-success: reports the PR count', recovered.out.includes('belongs to 2 PR(s)'), recovered.out);
check('error-then-success: opens no issue', recovered.body === '' && !/issue create/.test(recovered.log), recovered.log);

// --- AC1: stderr on a successful attempt is not part of the answer ----------
const noisy = run('noise:1,noise:1,noise:1,noise:1');
check('noisy success: exits 0', noisy.status === 0, noisy.out);
check('noisy success: is not read as an unexpected response', !noisy.out.includes('unexpected response'), noisy.out);
check('noisy success: reports the PR count', noisy.out.includes('belongs to 1 PR(s)'), noisy.out);

const noisyEmpty = run('noise-empty,noise-empty,noise-empty,noise-empty');
check('noisy 0 PR(s): fails', noisyEmpty.status === 1, noisyEmpty.out);
check('noisy 0 PR(s): is not read as an unexpected response', !noisyEmpty.out.includes('unexpected response'), noisyEmpty.out);
check(
  'noisy 0 PR(s): the body claims a confirmed direct push, not a failed lookup',
  /reached .main. without a PR/.test(noisyEmpty.body),
  noisyEmpty.body || noisyEmpty.out,
);

// --- AC2: a failure in the failure path is reported -------------------------
const labelFailed = run('empty,empty,empty,empty', { FAKE_GH_FAIL: 'label' });
check('label create failure: warns', labelFailed.out.includes('::warning::label create failed'), labelFailed.out);
check('label create failure: still fails the run with ::error::', labelFailed.status === 1 && labelFailed.out.includes('::error::'), labelFailed.out);

const issueFailed = run('empty,empty,empty,empty', { FAKE_GH_FAIL: 'issue' });
check('issue create failure: warns', issueFailed.out.includes('::warning::issue create failed'), issueFailed.out);
check('issue create failure: still fails the run with ::error::', issueFailed.status === 1 && issueFailed.out.includes('::error::'), issueFailed.out);

// --- the declared exception and the existing-issue short circuit ------------
const bootstrap = run('empty', { MSG: 'chore: bootstrap [allow-push-main]' });
check('a commit declaring [allow-push-main] exits 0 without asking gh', bootstrap.status === 0 && bootstrap.log.trim() === '', bootstrap.out);

const already = run('empty,empty,empty,empty', { FAKE_GH_OPEN_ISSUES: '1' });
check('an open issue for the same commit is not opened twice', already.status === 1 && already.body === '', already.log);

finish();
