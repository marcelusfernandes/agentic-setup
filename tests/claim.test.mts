#!/usr/bin/env node
// Cases for scripts/claim.mts: it locks an issue in one step (push, then
// assign + relabel) and refuses whatever is not claimable. `gh` is a fake
// script put first on PATH that also logs every invocation's argv, so a
// case can assert not just the JSON result but which gh calls did or did
// not happen (a refusal must not touch labels; a held claim must not
// either). Branch creation is exercised for real against a temporary git
// repository with a real (bare, local) "origin" remote.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, finish, git, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

// --- a fake `gh` on PATH, logging its argv to $GH_LOG -----------------------
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "repo view")
    name="\${DEFAULT_BRANCH:-main}"
    echo "{\\"defaultBranchRef\\":{\\"name\\":\\"$name\\"}}"
    ;;
  "issue view")
    n="$3"
    case "$n" in
      10) cat <<'JSON'
{"number":10,"title":"feat(ci): add claim script","body":"## Dependencies\\nBlocked by: none\\n\\n## Files\\n- \`scripts/claim.mts\`\\n","labels":[{"name":"state:ready"}],"state":"OPEN"}
JSON
        ;;
      11) cat <<'JSON'
{"number":11,"title":"feat: closed issue","body":"## Dependencies\\nBlocked by: none\\n\\n## Files\\n- \`x\`\\n","labels":[{"name":"state:ready"}],"state":"CLOSED"}
JSON
        ;;
      12) cat <<'JSON'
{"number":12,"title":"feat: not ready","body":"## Dependencies\\nBlocked by: none\\n\\n## Files\\n- \`x\`\\n","labels":[],"state":"OPEN"}
JSON
        ;;
      13) cat <<'JSON'
{"number":13,"title":"feat: blocked","body":"## Dependencies\\nBlocked by: #99\\n\\n## Files\\n- \`x\`\\n","labels":[{"name":"state:ready"}],"state":"OPEN"}
JSON
        ;;
      14) cat <<'JSON'
{"number":14,"title":"feat: no files section","body":"## Dependencies\\nBlocked by: none\\n","labels":[{"name":"state:ready"}],"state":"OPEN"}
JSON
        ;;
      15) cat <<'JSON'
{"number":15,"title":"feat: closed blocker","body":"## Dependencies\\nBlocked by: #98\\n\\n## Files\\n- \`x\`\\n","labels":[{"name":"state:ready"}],"state":"OPEN"}
JSON
        ;;
      16) cat <<'JSON'
{"number":16,"title":"feat: bad default branch","body":"## Dependencies\\nBlocked by: none\\n\\n## Files\\n- \`x\`\\n","labels":[{"name":"state:ready"}],"state":"OPEN"}
JSON
        ;;
      18) cat <<'JSON'
{"number":18,"title":"feat: type override target","body":"## Dependencies\\nBlocked by: none\\n\\n## Files\\n- \`x\`\\n","labels":[{"name":"state:ready"}],"state":"OPEN"}
JSON
        ;;
      19) cat <<'JSON'
{"number":19,"title":"no conventional prefix here","body":"## Dependencies\\nBlocked by: none\\n\\n## Files\\n- \`x\`\\n","labels":[{"name":"state:ready"}],"state":"OPEN"}
JSON
        ;;
      21) cat <<'JSON'
{"number":21,"title":"feat: preexisting ref","body":"## Dependencies\\nBlocked by: none\\n\\n## Files\\n- \`x\`\\n","labels":[{"name":"state:ready"}],"state":"OPEN"}
JSON
        ;;
      22) cat <<'JSON'
{"number":22,"title":"feat: ancestor branch","body":"## Dependencies\\nBlocked by: none\\n\\n## Files\\n- \`x\`\\n","labels":[{"name":"state:ready"}],"state":"OPEN"}
JSON
        ;;
      98) echo '{"state":"CLOSED"}' ;;
      99) echo '{"state":"OPEN"}' ;;
      *) echo "fake-gh: unknown issue $n" >&2; exit 1 ;;
    esac
    ;;
  "issue edit")
    ;;
  *)
    echo "fake-gh: unknown command: $*" >&2
    exit 1
    ;;
esac
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-claim-fakegh-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- a real repo with a real bare "origin" ----------------------------------
const repo = tempRepo();
git(['commit', '-q', '--allow-empty', '-m', 'init'], repo);
const remoteDir = mkdtempSync(join(tmpdir(), 'agentic-claim-remote-'));
cleanup(() => rmSync(remoteDir, { recursive: true, force: true }));
git(['init', '-q', '--bare', remoteDir], repo);
git(['remote', 'add', 'origin', remoteDir], repo);
git(['push', '-q', 'origin', 'main'], repo);

let logCounter = 0;
function claim(args: string[], env: Record<string, string> = {}) {
  const log = join(fakeGhDir, `log-${logCounter++}.txt`);
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'claim.mts'), ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: PATH_WITH_FAKE_GH, GH_LOG: log, ...env },
  });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  let logText = '';
  try {
    logText = readFileSync(log, 'utf8');
  } catch {
    logText = '';
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, log: logText };
}

function remoteBranches(): string[] {
  return git(['ls-remote', '--heads', 'origin'], repo)
    .split('\n')
    .map((l) => l.trim().split('\t')[1])
    .filter((ref): ref is string => Boolean(ref))
    .map((ref) => ref.replace(/^refs\/heads\//, ''));
}

// --- usage errors: no gh call at all ----------------------------------------
const noNumber = claim([]);
check('no issue number -> error, exit 1', noNumber.status === 1 && typeof noNumber.json?.error === 'string', JSON.stringify(noNumber));

const noSlug = claim(['10']);
check('missing --slug -> error, exit 1', noSlug.status === 1 && typeof noSlug.json?.error === 'string', JSON.stringify(noSlug));
check('missing --slug makes no gh call', noSlug.log === '', noSlug.log);

const badSlug = claim(['10', '--slug', 'Bad Slug!']);
check('invalid --slug -> error, exit 1', badSlug.status === 1 && typeof badSlug.json?.error === 'string', JSON.stringify(badSlug));
check('invalid --slug makes no gh call', badSlug.log === '', badSlug.log);

const badType = claim(['10', '--slug', 'x', '--type', 'bogus']);
check('invalid --type -> error, exit 1', badType.status === 1 && typeof badType.json?.error === 'string', JSON.stringify(badType));
check('invalid --type makes no gh call', badType.log === '', badType.log);

// --- type cannot be derived from the title, no --type given -----------------
const noType = claim(['19', '--slug', 'x']);
check('no derivable type and no --type -> error, exit 1', noType.status === 1 && typeof noType.json?.error === 'string', JSON.stringify(noType));
check('no derivable type still reads the issue once', /^issue view 19\b/.test(noType.log.trim()), noType.log);
check('no derivable type never edits the issue', !noType.log.includes('issue edit'), noType.log);

// --- AC1: refusals, before any push, nothing changed ------------------------
const closed = claim(['11', '--slug', 'x']);
check('closed issue -> refused, exit 1', closed.status === 1 && closed.json?.refused === 'issue is closed', JSON.stringify(closed));
check('closed issue: no branch pushed', !remoteBranches().includes('feat/11-x'));
check('closed issue: no assignee/label change', !closed.log.includes('issue edit'), closed.log);

const notReady = claim(['12', '--slug', 'x']);
check('missing state:ready -> refused, exit 1', notReady.status === 1 && notReady.json?.refused === 'missing state:ready label', JSON.stringify(notReady));
check('missing state:ready: no branch pushed', !remoteBranches().includes('feat/12-x'));
check('missing state:ready: no assignee/label change', !notReady.log.includes('issue edit'), notReady.log);

const blocked = claim(['13', '--slug', 'x']);
check('open blocker -> refused, exit 1', blocked.status === 1 && blocked.json?.refused === 'blocked by #99 (still open)', JSON.stringify(blocked));
check('open blocker: no branch pushed', !remoteBranches().includes('feat/13-x'));
check('open blocker: no assignee/label change', !blocked.log.includes('issue edit'), blocked.log);

const noFiles = claim(['14', '--slug', 'x']);
check('no ## Files bullet -> refused, exit 1', noFiles.status === 1 && noFiles.json?.refused === 'missing ## Files section', JSON.stringify(noFiles));
check('no ## Files bullet: no branch pushed', !remoteBranches().includes('feat/14-x'));
check('no ## Files bullet: no assignee/label change', !noFiles.log.includes('issue edit'), noFiles.log);

// --- AC2/AC4/AC5: happy path, type from title, real branch created ----------
const claimed10 = claim(['10', '--slug', 'script']);
check('successful claim exits 0', claimed10.status === 0, `${claimed10.stdout}\n${claimed10.stderr}`);
check(
  'successful claim reports issue/branch/base',
  claimed10.json?.issue === 10 && claimed10.json?.branch === 'feat/10-script' && typeof claimed10.json?.base === 'string' && claimed10.json.base.length > 0,
  JSON.stringify(claimed10.json),
);
check('type came from the title prefix (feat(ci): …)', claimed10.json?.branch === 'feat/10-script');
check('the branch really exists on origin', remoteBranches().includes('feat/10-script'), JSON.stringify(remoteBranches()));
check(
  'gh issue edit assigns and relabels exactly as specified',
  /issue edit 10 --add-assignee @me --add-label state:in-progress --remove-label state:ready/.test(claimed10.log),
  claimed10.log,
);

// --- AC3: a second claim of the same issue is held, no label change --------
const heldAgain = claim(['10', '--slug', 'script']);
check('second claim of the same issue is held, exit 2', heldAgain.status === 2 && heldAgain.json?.held === 'feat/10-script', JSON.stringify(heldAgain));
check('held claim does not touch labels', !heldAgain.log.includes('issue edit'), heldAgain.log);
check('held claim did not move the remote branch', remoteBranches().filter((b) => b === 'feat/10-script').length === 1);

// --- AC2: explicit --type overrides the title prefix ------------------------
const typeOverride = claim(['18', '--slug', 'x', '--type', 'chore']);
check('successful claim with --type override exits 0', typeOverride.status === 0, `${typeOverride.stdout}\n${typeOverride.stderr}`);
check('branch uses the explicit --type, not the title prefix', typeOverride.json?.branch === 'chore/18-x', JSON.stringify(typeOverride.json));
check('the overridden branch really exists on origin', remoteBranches().includes('chore/18-x'), JSON.stringify(remoteBranches()));

// --- AC3: gh naming a default branch that cannot resolve locally is an -----
// error, not held (fails before the push is even attempted).
const badDefault = claim(['16', '--slug', 'x'], { DEFAULT_BRANCH: 'does-not-exist-branch' });
check('an unresolvable default branch is an error, not held', badDefault.status === 1 && typeof badDefault.json?.error === 'string', JSON.stringify(badDefault));
check('an unresolvable default branch does not touch labels', !badDefault.log.includes('issue edit'), badDefault.log);
check('an unresolvable default branch does not create a branch', !remoteBranches().includes('feat/16-x'), JSON.stringify(remoteBranches()));

// --- AC3: a real push rejection that is NOT "ref already exists" (a ------
// pre-receive hook decline: "! [remote rejected] ... (pre-receive hook
// declined)") is a generic error, not held — proves the "[rejected]"
// fallback regex does not also match "[remote rejected]".
writeFileSync(join(remoteDir, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n');
chmodSync(join(remoteDir, 'hooks', 'pre-receive'), 0o755);
const hookDeclined = claim(['16', '--slug', 'y']);
unlinkSync(join(remoteDir, 'hooks', 'pre-receive'));
check('a pre-receive hook decline is an error, not held', hookDeclined.status === 1 && typeof hookDeclined.json?.error === 'string', JSON.stringify(hookDeclined));
check('a pre-receive hook decline does not touch labels', !hookDeclined.log.includes('issue edit'), hookDeclined.log);
check('a pre-receive hook decline does not create a branch', !remoteBranches().includes('feat/16-y'), JSON.stringify(remoteBranches()));

// --- AC1: a closed blocker gates nothing — parseBlockedBy must allow, ------
// not just block.
const closedBlocker = claim(['15', '--slug', 'x']);
check('a closed blocker does not refuse the claim, exit 0', closedBlocker.status === 0, `${closedBlocker.stdout}\n${closedBlocker.stderr}`);
check('a closed blocker still creates the branch on origin', remoteBranches().includes('feat/15-x'), JSON.stringify(remoteBranches()));

// --- AC3: a ref that already exists at the exact commit claim.mts would ----
// push (the "Everything up-to-date" case) is held via the porcelain "="
// line, not silently reported as a successful claim. A *separate* clone
// (standing in for another agent/process) creates the branch directly on
// the shared bare origin — `repo` itself never pushes it, so its own
// tracking ref for it is never opportunistically created. `repo`'s fetch
// refspec is then narrowed to `main` only, so the `git fetch origin` that
// claim.mts runs itself cannot discover the branch either — a local
// pre-check keyed on refs/remotes/origin/<branch> would miss it entirely,
// exactly like the real race (two claims of the same issue landing before
// either has committed anything beyond the shared base). Only the push's
// own protocol exchange with the remote — which --porcelain surfaces as
// "=" (up to date) — catches it.
const pusherDir = mkdtempSync(join(tmpdir(), 'agentic-claim-pusher-'));
cleanup(() => rmSync(pusherDir, { recursive: true, force: true }));
git(['clone', '-q', remoteDir, pusherDir], repo);
const preexistingSha = git(['rev-parse', 'origin/main'], repo);
git(['push', 'origin', `${preexistingSha}:refs/heads/feat/21-preclaimed`], pusherDir);
git(['config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main'], repo);
const upToDate = claim(['21', '--slug', 'preclaimed']);
check('an up-to-date push is held, exit 2', upToDate.status === 2 && upToDate.json?.held === 'feat/21-preclaimed', JSON.stringify(upToDate));
check('an up-to-date held claim does not touch labels', !upToDate.log.includes('issue edit'), upToDate.log);

// --- AC3: a branch that already exists at an ANCESTOR of the current base --
// (claimed earlier; the default branch has advanced since, the loop's
// normal state) must not be moved by the lock's own push. Without a
// create-only push this is a fast-forward — porcelain flag " ", `old..new`,
// exit 0 — so the script correctly reports { held } (the flag isn't "*"),
// but the push itself already re-based the other agent's branch, staling
// the { base } their own claim reported. Reusing pusherDir: it pushes the
// ancestor branch directly onto the shared bare origin, then `repo`
// advances the default branch past it.
git(['push', 'origin', `${preexistingSha}:refs/heads/feat/22-anc`], pusherDir);
git(['commit', '-q', '--allow-empty', '-m', 'advance main'], repo);
git(['push', '-q', 'origin', 'main'], repo);
const ancestorHeld = claim(['22', '--slug', 'anc']);
check('a branch at an ancestor of the base is held, exit 2', ancestorHeld.status === 2 && ancestorHeld.json?.held === 'feat/22-anc', JSON.stringify(ancestorHeld));
check('a branch at an ancestor of the base is held without touching labels', !ancestorHeld.log.includes('issue edit'), ancestorHeld.log);
check(
  'a branch at an ancestor of the base is NOT moved by the lock push (create-only)',
  git(['rev-parse', 'refs/heads/feat/22-anc'], remoteDir) === preexistingSha,
  `${git(['rev-parse', 'refs/heads/feat/22-anc'], remoteDir)} !== ${preexistingSha}`,
);

finish();
