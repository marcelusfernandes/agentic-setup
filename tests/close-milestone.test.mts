#!/usr/bin/env node
// Cases for scripts/close-milestone.mts: a milestone closes through one
// script that refuses without evidence, or it does not close at all (#172).
// The script is spawned for real, from inside a throwaway git repository
// that has a bare repository as its `origin`, with a fake `gh` first on
// PATH.
//
// Why a real `origin`: the script proves the closeout *landed* before the
// close. It reads the evidence with `git show refs/remotes/origin/main:<path>`
// and holds every sha in it to `git merge-base --is-ancestor <sha>
// refs/remotes/origin/main`, so a file that only exists in the working tree,
// and a sha that only exists on a side branch, both have to fail here. A
// bare repository pushed to is the cheapest way to make that real.
//
// The fake `gh` is a small Node program (a bash wrapper execs it with the
// same runtime that launched this file) rather than a bash script, because
// these cases need state in both directions: the milestone and the issue
// lists are read from JSON the case wrote, and the PATCH payload is written
// back so the happy path can assert the closing block and `state=closed`.
// It logs every argv line it is called with, so every refusal case can
// assert that nothing ever reached a write.
//
// Fixture numbers: milestone 15 is the open milestone titled "M14 Closure
// with evidence" — the number GitHub gives it and the phase number in its
// title are deliberately different, because they are in this repository
// (milestone 15 is M14), and the evidence file is named after the phase.
// Milestone 404 does not exist; milestone 500 fails for a reason that is not
// a 404 at all.
//
// Negative control: on the base (before this PR) scripts/close-milestone.mts
// does not exist, so every run below prints nothing on stdout and each case
// fails on its own JSON assertion — a runtime red, not a structural one.
// That is why the failure detail passed to check() is the child's *stdout*
// only: the child's ERR_MODULE_NOT_FOUND on stderr stays in a captured
// variable and never reaches the suite's output, where
// `ci/negative-control.mts`'s structural-red warning would read it as a
// structural red (skill `safe-worktree` §B7).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, git, tempRepo, RUNTIME, ROOT } from './lib/harness.mts';

const MILESTONE = 15;
const TITLE = 'M14 Closure with evidence';
const PHASE = 'M14';
const EVIDENCE = `docs/closeout/${PHASE}.md`;
const CLOSING_BLOCK = /^Closed \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z, main ([0-9a-f]{40}), evidence docs\/closeout\/M14\.md$/m;

const DESCRIPTION_OK = `Closure with evidence: every phase states its exit criteria in its own description.

Out of this phase:
- migrating the descriptions of already-closed milestones

Exit criteria:
- [x] the closeout lands before the close
- [x] the milestone closes through a script

Depends on: none`;

const DESCRIPTION_UNCHECKED = DESCRIPTION_OK.replace('- [x] the milestone closes through a script', '- [ ] the milestone closes through a script');
const DESCRIPTION_NO_CRITERIA = DESCRIPTION_OK.replace(/Exit criteria:\n(- \[.\].*\n)+/, '');

// --- a fake `gh` on PATH ----------------------------------------------------
const FAKE_GH_IMPL = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const state = process.env.FAKE_GH_STATE_DIR;
appendFileSync(join(state, 'gh-argv.log'), args.join(' ') + '\n');

const read = (name, fallback) => {
  const path = join(state, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
};
const out = (text) => { process.stdout.write(text + '\n'); process.exit(0); };
const die = (message) => { process.stderr.write(message + '\n'); process.exit(1); };

// gh issue list --milestone "<title>" --state open|closed --json number --limit 200
if (args[0] === 'issue' && args[1] === 'list') {
  const at = args.indexOf('--state');
  const wanted = at === -1 ? 'open' : args[at + 1];
  const issues = read('issues.json', { open: [], closed: [] });
  out(JSON.stringify((issues[wanted] ?? []).map((n) => ({ number: n }))));
}

if (args[0] !== 'api') die('fake-gh: unknown command: ' + args.join(' '));

let method = 'GET';
let path = null;
const fields = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '-X' || a === '--method') { method = args[++i]; continue; }
  if (a === '-F' || a === '--field' || a === '-f' || a === '--raw-field') {
    const field = args[++i] ?? '';
    const eq = field.indexOf('=');
    if (eq === -1) continue;
    const key = field.slice(0, eq);
    const value = field.slice(eq + 1);
    // Only -F reads @file; -f sends the @ literally, and the script only
    // ever pairs @file with -F.
    fields[key] = value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value;
    continue;
  }
  if (a === '--jq' || a === '-q') { i++; continue; }
  if (a.startsWith('-')) continue;
  if (path === null) path = a;
}
if (path === null) die('fake-gh: no path in: ' + args.join(' '));

const milestone = path.match(/^repos\/\{owner\}\/\{repo\}\/milestones\/(\d+)$/);
if (milestone) {
  const n = Number(milestone[1]);
  if (n === 404) { process.stdout.write('{"message":"Not Found","status":"404"}'); die('gh: Not Found (HTTP 404)'); }
  if (n === 500) die('gh: HTTP 403: API rate limit exceeded for installation');
  if (method === 'GET') out(JSON.stringify(read('milestone.json', null)));
  if (method === 'PATCH') {
    writeFileSync(join(state, 'patch.json'), JSON.stringify(fields));
    out(JSON.stringify({ ...read('milestone.json', {}), ...fields }));
  }
}

die('fake-gh: unhandled: ' + method + ' ' + path);
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-close-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
const FAKE_GH_JS = join(fakeGhDir, 'gh-impl.mjs');
writeFileSync(FAKE_GH_JS, FAKE_GH_IMPL);
writeFileSync(join(fakeGhDir, 'gh'), '#!/usr/bin/env bash\nexec "$FAKE_GH_NODE" "$FAKE_GH_JS" "$@"\n');
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- repositories -----------------------------------------------------------
type Fixture = { repo: string; landed: string; side: string };

/** A repository with a bare `origin`, one landed commit on main and one commit never merged. */
function fixture(): Fixture {
  const origin = mkdtempSync(join(tmpdir(), 'agentic-origin-'));
  cleanup(() => rmSync(origin, { recursive: true, force: true }));
  git(['init', '-q', '--bare', '-b', 'main'], origin);
  const repo = tempRepo();
  commit(repo, { 'README.md': 'base\n' }, 'chore: base');
  const landed = commit(repo, { 'a.txt': 'a\n' }, 'feat(a): land (#1)');
  git(['checkout', '-q', '-b', 'side'], repo);
  const side = commit(repo, { 'b.txt': 'b\n' }, 'feat(b): never merged (#2)');
  git(['checkout', '-q', 'main'], repo);
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-q', '-u', 'origin', 'main'], repo);
  return { repo, landed, side };
}

/** Commits files on main and pushes them to the bare origin; returns the new tip. */
function land(repo: string, files: Record<string, string>, message: string): string {
  const sha = commit(repo, files, message);
  git(['push', '-q', 'origin', 'main'], repo);
  return sha;
}

/** A filled closeout document over the given rows. */
function closeout(
  phase: string,
  sha: string,
  rows: Array<[number, number, string]>,
  leftOut = '- None — every issue shipped.',
  dogfood = '- None needed — no report was required.',
): string {
  const table = rows.map(([issue, pr, rowSha]) => `| #${issue} | feat(x): a thing | #${pr} | ${rowSha} |`).join('\n');
  return `# Closeout M${phase} — ${TITLE}

- Closed (UTC): 2026-09-17
- main SHA: ${sha}

## Issues

| issue | title | PR | merge commit |
| --- | --- | --- | --- |
${table}

## Left out

${leftOut}

## Dogfood

${dogfood}
`;
}

/** The repository used by most cases: a landed closeout naming the one shipped issue. */
function goodRepo(): Fixture {
  const f = fixture();
  land(f.repo, { [EVIDENCE]: closeout('14', f.landed, [[1, 11, f.landed]]) }, 'docs(docs): closeout M14 (#174)');
  return f;
}

// --- runner ------------------------------------------------------------------
type State = { milestone?: unknown; open?: number[]; closed?: number[] };

function stateDir(state: State = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-close-state-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh-argv.log'), '');
  writeFileSync(
    join(dir, 'milestone.json'),
    JSON.stringify(state.milestone ?? { number: MILESTONE, title: TITLE, state: 'open', description: DESCRIPTION_OK }),
  );
  writeFileSync(join(dir, 'issues.json'), JSON.stringify({ open: state.open ?? [], closed: state.closed ?? [1] }));
  return dir;
}

function close(repo: string, args: string[], dir: string) {
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'close-milestone.mts'), ...args], {
    encoding: 'utf8',
    cwd: repo,
    env: { ...process.env, PATH: PATH_WITH_FAKE_GH, FAKE_GH_STATE_DIR: dir, FAKE_GH_NODE: RUNTIME, FAKE_GH_JS },
  });
  const patchPath = join(dir, 'patch.json');
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    log: existsSync(join(dir, 'gh-argv.log')) ? readFileSync(join(dir, 'gh-argv.log'), 'utf8') : '',
    patch: existsSync(patchPath) ? (JSON.parse(readFileSync(patchPath, 'utf8')) as Record<string, string>) : null,
  };
}

function parse(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** The whole run, for a case that only needs the default milestone and one evidence path. */
function run(repo: string, args: string[], state: State = {}) {
  return close(repo, args, stateDir(state));
}

const missingOf = (stdout: string): string[] => parse(stdout)?.missing ?? [];
/** True when the fake `gh` was never asked to change the milestone. */
const noWrite = (log: string): boolean => !/-X PATCH/.test(log);

/** Asserts the shared shape of every refusal: exit 1, { refused, milestone, missing }, nothing written. */
function refuses(name: string, result: ReturnType<typeof close>, code: string): void {
  const out = parse(result.stdout);
  check(`${name} exits 1`, result.status === 1, result.stdout);
  check(
    `${name} reports { refused, milestone: ${MILESTONE}, missing: [${code}] }`,
    typeof out?.refused === 'string' && out?.milestone === MILESTONE && (out?.missing ?? []).includes(code),
    result.stdout,
  );
  check(`${name} never patched the milestone`, noWrite(result.log) && result.patch === null, result.log);
}

// --- A: the milestone still has an open issue --------------------------------
const a = run(goodRepo().repo, [String(MILESTONE), '--evidence', EVIDENCE], { open: [200], closed: [1] });
refuses('an open issue left in the milestone', a, 'milestone:open-issues');

// --- B: --evidence absent ----------------------------------------------------
const b = run(goodRepo().repo, [String(MILESTONE)]);
refuses('no --evidence', b, 'evidence:missing');

// --- C: --evidence names the milestone number instead of the phase ----------
// Milestone 15 is phase M14: the file is named after the phase in its title,
// never after the number GitHub gave the milestone.
const c = run(goodRepo().repo, [String(MILESTONE), '--evidence', 'docs/closeout/M15.md']);
refuses('--evidence naming another file than the milestone\'s phase', c, 'evidence:missing');

// --- D: the evidence file exists in the working tree but never landed -------
// The closeout is the evidence the close is checked against, so it counts
// only once it is on `main` — an uncommitted file proves nothing.
const dFixture = fixture();
mkdirSync(join(dFixture.repo, 'docs', 'closeout'), { recursive: true });
writeFileSync(join(dFixture.repo, EVIDENCE), closeout('14', dFixture.landed, [[1, 11, dFixture.landed]]));
const d = run(dFixture.repo, [String(MILESTONE), '--evidence', EVIDENCE]);
refuses('an evidence file that is not on origin/main', d, 'evidence:missing');

// --- E: a merge sha that is not an ancestor of origin/main ------------------
const eFixture = fixture();
land(eFixture.repo, { [EVIDENCE]: closeout('14', eFixture.landed, [[1, 11, eFixture.side]]) }, 'docs(docs): closeout M14 (#174)');
const e = run(eFixture.repo, [String(MILESTONE), '--evidence', EVIDENCE]);
refuses('a merge sha that is only on a side branch', e, 'evidence:sha');

// --- E2: the header main SHA is held to the same rule -----------------------
const e2Fixture = fixture();
land(e2Fixture.repo, { [EVIDENCE]: closeout('14', e2Fixture.side, [[1, 11, e2Fixture.landed]]) }, 'docs(docs): closeout M14 (#174)');
const e2 = run(e2Fixture.repo, [String(MILESTONE), '--evidence', EVIDENCE]);
refuses('a header main SHA that is only on a side branch', e2, 'evidence:sha');

// --- F: a closed issue with no row and no mention in `## Left out` ----------
const f = run(goodRepo().repo, [String(MILESTONE), '--evidence', EVIDENCE], { closed: [1, 7] });
refuses('a closed issue with no row in the evidence table', f, 'evidence:issue-missing');
check(
  'the refusal names the issue that has no row',
  /#7/.test(parse(f.stdout)?.refused ?? ''),
  f.stdout,
);

// --- G: a closed issue that shipped nothing belongs in `## Left out` --------
// The README's own rule: "an issue that closed without a PR did not ship — it
// belongs in `## Left out`, not in the table". The parent spec issue and the
// closeout issue itself are always in that position.
const gFixture = fixture();
land(
  gFixture.repo,
  { [EVIDENCE]: closeout('14', gFixture.landed, [[1, 11, gFixture.landed]], '- #7 — the spec issue, closed with the phase, shipped no file.') },
  'docs(docs): closeout M14 (#174)',
);
const g = run(gFixture.repo, [String(MILESTONE), '--evidence', EVIDENCE], { closed: [1, 7] });
check('a closed issue named in `## Left out` is accounted for', g.status === 0, g.stdout);
check('a closed issue named in `## Left out` is not reported missing', !missingOf(g.stdout).includes('evidence:issue-missing'), g.stdout);

// --- H: the milestone description's exit criteria ---------------------------
const h = run(goodRepo().repo, [String(MILESTONE), '--evidence', EVIDENCE], {
  milestone: { number: MILESTONE, title: TITLE, state: 'open', description: DESCRIPTION_UNCHECKED },
});
refuses('an unchecked exit criterion', h, 'milestone:exit-criteria');

const h2 = run(goodRepo().repo, [String(MILESTONE), '--evidence', EVIDENCE], {
  milestone: { number: MILESTONE, title: TITLE, state: 'open', description: DESCRIPTION_NO_CRITERIA },
});
refuses('no `Exit criteria:` checklist at all', h2, 'milestone:exit-criteria');

// --- I: a milestone that is already closed, or does not exist ---------------
const i = run(goodRepo().repo, [String(MILESTONE), '--evidence', EVIDENCE], {
  milestone: { number: MILESTONE, title: TITLE, state: 'closed', description: DESCRIPTION_OK },
});
refuses('a milestone that is already closed', i, 'milestone:state');

const i2 = close(goodRepo().repo, ['404', '--evidence', EVIDENCE], stateDir());
check('a milestone that does not exist exits 1', i2.status === 1, i2.stdout);
const i2Out = parse(i2.stdout);
check(
  'a milestone that does not exist reports milestone:state, not an error',
  (i2Out?.missing ?? []).includes('milestone:state') && i2Out?.error === undefined,
  i2.stdout,
);
check('a milestone that does not exist wrote nothing', noWrite(i2.log) && i2.patch === null, i2.log);

// --- J: the evidence file is still the unfilled template --------------------
const jFixture = fixture();
land(jFixture.repo, { [EVIDENCE]: readFileSync(join(ROOT, 'docs', 'closeout', 'TEMPLATE.md'), 'utf8') }, 'docs(docs): closeout M14 (#174)');
const j = run(jFixture.repo, [String(MILESTONE), '--evidence', EVIDENCE]);
check('an evidence file left as the template exits 1', j.status === 1, j.stdout);
check(
  'an evidence file left as the template refuses on its format',
  missingOf(j.stdout).includes('evidence:format') && parse(j.stdout)?.error === undefined,
  j.stdout,
);
check('an evidence file left as the template wrote nothing', noWrite(j.log) && j.patch === null, j.log);

// --- K: the happy path -------------------------------------------------------
const kFixture = goodRepo();
const kTip = git(['rev-parse', 'HEAD'], kFixture.repo);
const k = run(kFixture.repo, [String(MILESTONE), '--evidence', EVIDENCE]);
check('the happy path exits 0', k.status === 0, k.stdout);
const kOut = parse(k.stdout);
check(
  'the happy path reports { closed, milestone, sha, evidence }',
  kOut?.closed === TITLE && kOut?.milestone === MILESTONE && kOut?.sha === kTip && kOut?.evidence === EVIDENCE,
  k.stdout,
);
check('the happy path patched the milestone exactly once', (k.log.match(/-X PATCH/g) ?? []).length === 1, k.log);
check('the happy path set state=closed', k.patch?.state === 'closed', JSON.stringify(k.patch));
const kDescription = k.patch?.description ?? '';
check('the happy path kept the existing description', kDescription.startsWith(DESCRIPTION_OK.trimEnd()), kDescription);
const kBlock = CLOSING_BLOCK.exec(kDescription);
check('the happy path appended a dated closing block naming main and the evidence', kBlock !== null, kDescription);
check('the closing block names the tip of origin/main', kBlock?.[1] === kTip, `${kBlock?.[1]} != ${kTip}`);
check('the closing block is the last thing in the description', kDescription.trimEnd().endsWith(kBlock?.[0] ?? ' '), kDescription);

// --- L: closing never opens anything ----------------------------------------
check(
  'closing the milestone never created an issue or a milestone',
  !/issue create/.test(k.log) && !/-X POST/.test(k.log),
  k.log,
);

// --- M: a gh failure is an { error }, never a refusal -----------------------
const m = close(goodRepo().repo, ['500', '--evidence', EVIDENCE], stateDir());
check('a gh failure exits 1', m.status === 1, m.stdout);
const mOut = parse(m.stdout);
check(
  'a gh failure reports { error }, never { refused }',
  typeof mOut?.error === 'string' && mOut?.refused === undefined,
  m.stdout,
);
check('a gh failure wrote nothing', noWrite(m.log) && m.patch === null, m.log);

// --- N: a usage problem is an { error }, not a refusal ----------------------
const n = close(goodRepo().repo, [], stateDir());
check('no arguments exits 1', n.status === 1, n.stdout);
check('no arguments reports { error } with the usage line', /close-milestone\.mts/.test(parse(n.stdout)?.error ?? ''), n.stdout);
check('no arguments never called gh at all', n.log.trim() === '', n.log);

const n2 = close(goodRepo().repo, ['not-a-number', '--evidence', EVIDENCE], stateDir());
check('a milestone that is not a number reports { error }', typeof parse(n2.stdout)?.error === 'string', n2.stdout);

// --- O: the dogfood refusal (#182) ------------------------------------------
// The binding half of the dogfood nudge. `scope` only warns per PR, because a
// required check cannot judge from a file name whether a run was owed; the
// phase close can, because by then the whole phase is visible. A milestone
// that merged a PR touching `hooks/`, `ci/`, `scripts/` or a
// `skills/**/SKILL.md` does not close while its `## Dogfood` section names no
// `docs/dogfood/<date>.md`.
//
// The rows of `## Issues` carry the squash commit of each merged PR, so the
// files of a phase are `git diff --name-only <sha>^1 <sha>` over those rows —
// the same local git the sha ancestry checks already run against.

/** A fixture whose one merged PR changed a mechanism file. */
function sensitiveRepo(dogfood?: string): Fixture {
  const f = fixture();
  const merged = land(f.repo, { 'ci/scope-check.mts': '// a mechanism change\n' }, 'feat(ci): change the mechanism (#1)');
  land(f.repo, { [EVIDENCE]: closeout('14', merged, [[1, 11, merged]], undefined, dogfood) }, 'docs(docs): closeout M14 (#174)');
  return { ...f, landed: merged };
}

const o = run(sensitiveRepo().repo, [String(MILESTONE), '--evidence', EVIDENCE]);
refuses('a phase that changed the mechanism and names no dogfood report', o, 'dogfood');
check(
  'the dogfood refusal names the mechanism file and the issue that carried it',
  /ci\/scope-check\.mts/.test(parse(o.stdout)?.refused ?? '') && /#1\b/.test(parse(o.stdout)?.refused ?? ''),
  o.stdout,
);

// --- O2: the same phase closes once the closeout names a report -------------
const o2 = run(
  sensitiveRepo('- `docs/dogfood/2026-09-17.md` — one pass against a disposable repository.').repo,
  [String(MILESTONE), '--evidence', EVIDENCE],
);
check('a phase that names a dated dogfood report closes', o2.status === 0, o2.stdout);
check('a phase that names a dated dogfood report is not refused on dogfood', !missingOf(o2.stdout).includes('dogfood'), o2.stdout);

// --- O3: a phase that touched nothing sensitive closes without a report -----
const o3 = run(goodRepo().repo, [String(MILESTONE), '--evidence', EVIDENCE]);
check('a phase with no mechanism change closes without a dogfood report', o3.status === 0, o3.stdout);
check('a phase with no mechanism change is not refused on dogfood', !missingOf(o3.stdout).includes('dogfood'), o3.stdout);

// --- O4: `docs/dogfood/` without a dated report is not a report -------------
const o4 = run(
  sensitiveRepo('- None needed — see `docs/dogfood/README.md` for the format.').repo,
  [String(MILESTONE), '--evidence', EVIDENCE],
);
refuses('a `## Dogfood` bullet naming no dated report', o4, 'dogfood');

// --- O5: a stray header `main SHA` still leaves the dogfood question answerable
// The guard is on the **rows**, which are the only shas the dogfood check
// reads. A header `main SHA` off `origin/main` is its own refusal and leaves
// every row readable, so one run names both codes instead of one per run.
const o5Fixture = fixture();
const o5Merged = land(o5Fixture.repo, { 'ci/scope-check.mts': '// a mechanism change\n' }, 'feat(ci): change the mechanism (#1)');
land(
  o5Fixture.repo,
  { [EVIDENCE]: closeout('14', o5Fixture.side, [[1, 11, o5Merged]]) },
  'docs(docs): closeout M14 (#174)',
);
const o5 = run(o5Fixture.repo, [String(MILESTONE), '--evidence', EVIDENCE]);
check(
  'a stray header main SHA is reported together with the missing dogfood report',
  missingOf(o5.stdout).includes('evidence:sha') && missingOf(o5.stdout).includes('dogfood'),
  o5.stdout,
);

// --- O6: a row sha off origin/main leaves it undeterminable ------------------
// Nothing can be said about the files of a commit that is not on the branch,
// so the run refuses on the sha alone rather than guessing.
const o6Fixture = fixture();
land(o6Fixture.repo, { [EVIDENCE]: closeout('14', o6Fixture.landed, [[1, 11, o6Fixture.side]]) }, 'docs(docs): closeout M14 (#174)');
const o6 = run(o6Fixture.repo, [String(MILESTONE), '--evidence', EVIDENCE]);
check(
  'a row sha off origin/main refuses on the sha and claims nothing about dogfood',
  missingOf(o6.stdout).includes('evidence:sha') && !missingOf(o6.stdout).includes('dogfood'),
  o6.stdout,
);

finish();
