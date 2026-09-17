#!/usr/bin/env node
// Cases for scripts/log-decision.mts: one dated line per pointed
// orchestrator decision, appended to a single marked comment on the
// milestone's parent issue (#178). The script is spawned for real, from
// inside a throwaway git repository, with a fake `gh` first on PATH.
//
// The fake `gh` is a small Node program (a bash wrapper execs it with the
// same runtime that launched this file) rather than the usual bash script,
// because these cases need durable state: the comment a first run creates
// has to still be there for the second run to append to. It stores the
// issue's comments as JSON under FAKE_GH_STATE_DIR and logs every argv line
// it is called with, so a case can assert that a refusal never reached a
// write. It emulates the one `--jq` filter the script passes (first comment
// whose body starts with the marker, or no output at all) instead of
// running jq.
//
// Negative control: scripts/log-decision.mts exists on the base, so the red
// is an assertion red — cases J, K and L below assert on shapes the base
// script does not produce (`#12` as `<parent>` is a usage error there, a
// pull request as `<parent>` is accepted, and a TMPDIR that cannot be
// written to crashes the process instead of reporting `{ error }`). The
// failure detail passed to check() is the child's *stdout* only, so a stack
// trace on the child's stderr never reaches the suite's output, where
// `ci/negative-control.mts:52-56` would read it as a structural red (skill
// `safe-worktree` §B7).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, finish, git, tempRepo, RUNTIME, ROOT } from './lib/harness.mts';

const MARKER = '<!-- agentic-decision-log -->';
const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \| \S+ \| #\d+ \| \S/;

// --- a fake `gh` on PATH ----------------------------------------------------
// Fixture issue numbers: 101 is closed, 404 does not exist (gh's own 404
// wording on stderr), 500 fails for a reason that is not a 404 at all
// (the { error } case), 600 is an open pull request — the `issues/<n>`
// endpoint answers for one, with the `pull_request` key an issue never
// carries — and every other number is an open issue.
const FAKE_GH_IMPL = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = '<!-- agentic-decision-log -->';
const args = process.argv.slice(2);
const state = process.env.FAKE_GH_STATE_DIR;
appendFileSync(join(state, 'gh-argv.log'), args.join(' ') + '\n');

const commentsPath = join(state, 'comments.json');
const readComments = () => (existsSync(commentsPath) ? JSON.parse(readFileSync(commentsPath, 'utf8')) : []);
const writeComments = (list) => writeFileSync(commentsPath, JSON.stringify(list));
const out = (text) => { process.stdout.write(text + '\n'); process.exit(0); };
const die = (message) => { process.stderr.write(message + '\n'); process.exit(1); };

if (args[0] !== 'api') die('fake-gh: unknown command: ' + args.join(' '));

let method = 'GET';
let path = null;
let bodyFile = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '-X' || a === '--method') { method = args[++i]; continue; }
  if (a === '-F' || a === '--field') {
    const field = args[++i] ?? '';
    if (field.startsWith('body=@')) bodyFile = field.slice(6);
    continue;
  }
  if (a === '--jq' || a === '-q') { i++; continue; }
  if (a.startsWith('-')) continue;
  if (path === null) path = a;
}
if (path === null) die('fake-gh: no path in: ' + args.join(' '));

const issue = path.match(/^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)$/);
if (method === 'GET' && issue) {
  const n = Number(issue[1]);
  if (n === 404) {
    process.stdout.write('{"message":"Not Found","status":"404"}');
    die('gh: Not Found (HTTP 404)');
  }
  if (n === 500) die('gh: HTTP 403: API rate limit exceeded for installation');
  if (n === 600) {
    out(JSON.stringify({
      number: n,
      state: 'open',
      pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/600' },
    }));
  }
  out(JSON.stringify({ number: n, state: n === 101 ? 'closed' : 'open' }));
}

const comments = path.match(/^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)\/comments$/);
if (method === 'GET' && comments) {
  // The script's --jq filter, emulated: the first comment carrying the
  // marker, or no output at all.
  const hit = readComments().find((c) => c.body.startsWith(MARKER));
  out(hit ? JSON.stringify(hit) : '');
}
if (method === 'POST' && comments) {
  const list = readComments();
  const created = { id: 9000 + list.length + 1, body: readFileSync(bodyFile, 'utf8') };
  writeComments([...list, created]);
  out(JSON.stringify({ id: created.id }));
}

const patch = path.match(/^repos\/\{owner\}\/\{repo\}\/issues\/comments\/(\d+)$/);
if (method === 'PATCH' && patch) {
  const id = Number(patch[1]);
  const list = readComments();
  if (!list.some((c) => c.id === id)) die('gh: Not Found (HTTP 404)');
  writeComments(list.map((c) => (c.id === id ? { id: c.id, body: readFileSync(bodyFile, 'utf8') } : c)));
  out(JSON.stringify({ id }));
}

die('fake-gh: unhandled: ' + method + ' ' + path);
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-decision-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
const FAKE_GH_JS = join(fakeGhDir, 'gh-impl.mjs');
writeFileSync(FAKE_GH_JS, FAKE_GH_IMPL);
writeFileSync(join(fakeGhDir, 'gh'), '#!/usr/bin/env bash\nexec "$FAKE_GH_NODE" "$FAKE_GH_JS" "$@"\n');
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- the repository the script runs from ------------------------------------
const repo = tempRepo();
writeFileSync(join(repo, 'README.md'), '# fixture\n');
git(['add', 'README.md'], repo);
git(['commit', '-q', '-m', 'init'], repo);
git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], repo);

// --- runner ------------------------------------------------------------------
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-decision-state-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh-argv.log'), '');
  return dir;
}

type Comment = { id: number; body: string };

function log(args: string[], dir: string = stateDir(), env: Record<string, string> = {}) {
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'log-decision.mts'), ...args], {
    encoding: 'utf8',
    cwd: repo,
    env: {
      ...process.env,
      PATH: PATH_WITH_FAKE_GH,
      FAKE_GH_STATE_DIR: dir,
      FAKE_GH_NODE: RUNTIME,
      FAKE_GH_JS,
      ...env,
    },
  });
  const argvLog = existsSync(join(dir, 'gh-argv.log')) ? readFileSync(join(dir, 'gh-argv.log'), 'utf8') : '';
  const commentsPath = join(dir, 'comments.json');
  const comments: Comment[] = existsSync(commentsPath) ? JSON.parse(readFileSync(commentsPath, 'utf8')) : [];
  return { status: r.status, stdout: r.stdout ?? '', log: argvLog, comments, dir };
}

function parse(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** True when the fake `gh` was never asked to create or edit a comment. */
const noWrite = (argvLog: string): boolean => !/-X (POST|PATCH)/.test(argvLog);

// --- A: an unknown --kind refuses, before gh is called at all ---------------
const a = log(['100', '--kind', 'vibes', '--ref', '#1', 'granted a glob']);
check('unknown kind refuses (exit 1)', a.status === 1, a.stdout);
const aOut = parse(a.stdout);
check(
  'unknown kind reports { refused, parent, missing: [kind:unknown] }',
  typeof aOut?.refused === 'string' && aOut?.parent === 100 && (aOut?.missing ?? []).includes('kind:unknown'),
  a.stdout,
);
check('unknown kind never called gh at all', a.log.trim() === '', a.log);

// --- B: a --ref that is not an issue or PR number refuses --------------------
const b = log(['100', '--kind', 'grant', '--ref', 'PR-12', 'granted a glob']);
check('bad ref refuses (exit 1)', b.status === 1, b.stdout);
check('bad ref reports ref:format in missing[]', (parse(b.stdout)?.missing ?? []).includes('ref:format'), b.stdout);
check('bad ref never called gh at all', b.log.trim() === '', b.log);

const bZero = log(['100', '--kind', 'grant', '--ref', '#0', 'granted a glob']);
check('ref #0 reports ref:format in missing[]', (parse(bZero.stdout)?.missing ?? []).includes('ref:format'), bZero.stdout);

// --- C: empty text refuses ---------------------------------------------------
const c = log(['100', '--kind', 'grant', '--ref', '#12', '   ']);
check('empty text refuses (exit 1)', c.status === 1, c.stdout);
check('empty text reports text:empty in missing[]', (parse(c.stdout)?.missing ?? []).includes('text:empty'), c.stdout);
check('empty text never called gh at all', c.log.trim() === '', c.log);

// --- D: the parent issue is closed -> refused, nothing written --------------
const d = log(['101', '--kind', 'grant', '--ref', '#12', 'granted a glob']);
check('closed parent refuses (exit 1)', d.status === 1, d.stdout);
const dOut = parse(d.stdout);
check(
  'closed parent reports { refused, parent, missing: [parent:state] }',
  typeof dOut?.refused === 'string' && dOut?.parent === 101 && (dOut?.missing ?? []).includes('parent:state'),
  d.stdout,
);
check('closed parent wrote nothing', noWrite(d.log) && d.comments.length === 0, d.log);

// --- E: the parent issue does not exist -> refused, nothing written ---------
const e = log(['404', '--kind', 'human-pending', '--ref', '#12', 'applied human:pending']);
check('missing parent refuses (exit 1)', e.status === 1, e.stdout);
check('missing parent reports parent:state in missing[]', (parse(e.stdout)?.missing ?? []).includes('parent:state'), e.stdout);
check('missing parent wrote nothing', noWrite(e.log) && e.comments.length === 0, e.log);

// --- F: first run creates the marked comment ---------------------------------
const shared = stateDir();
const f = log(['100', '--kind', 'grant', '--ref', '#151', 'granted ci/scope-check.mts for AC2'], shared);
check('first run succeeds (exit 0)', f.status === 0, f.stdout);
const fOut = parse(f.stdout);
check(
  'first run reports { parent, comment, lines: 1 }',
  fOut?.parent === 100 && Number.isInteger(fOut?.comment) && fOut?.lines === 1,
  f.stdout,
);
check('first run created exactly one comment', f.comments.length === 1, JSON.stringify(f.comments.map((x) => x.id)));
const fBody = f.comments[0]?.body ?? '';
check('the comment starts with the marker', fBody.startsWith(MARKER), fBody.slice(0, 80));
const fLines = fBody.split(/\r?\n/).filter((l) => LINE.test(l));
check('the comment carries one dated line', fLines.length === 1, fBody);
check(
  'the line is <UTC ISO-8601> | <kind> | <ref> | <text>',
  fLines[0]?.endsWith(' | grant | #151 | granted ci/scope-check.mts for AC2') === true,
  fLines[0] ?? fBody,
);
check('first run posted the comment, never patched', /-X POST/.test(f.log) && !/-X PATCH/.test(f.log), f.log);

// --- G: a second run appends to the same comment id, never a second comment -
const g = log(['100', '--kind', 'extra-round', '--ref', '#152', 'mechanical defect earns round 3'], shared);
check('second run succeeds (exit 0)', g.status === 0, g.stdout);
const gOut = parse(g.stdout);
check('second run reports the same comment id', gOut?.comment === fOut?.comment, `${f.stdout}${g.stdout}`);
check('second run reports lines: 2', gOut?.lines === 2, g.stdout);
check('second run did not post a second comment', g.comments.length === 1, JSON.stringify(g.comments.map((x) => x.id)));
check('second run patched the existing comment', /-X PATCH/.test(g.log) && !/-X POST[\s\S]*-X POST/.test(g.log), g.log);
const gBody = g.comments[0]?.body ?? '';
const gLines = gBody.split(/\r?\n/).filter((l) => LINE.test(l));
check('both lines are in the one comment, in order', gLines.length === 2
  && gLines[0]?.endsWith(' | grant | #151 | granted ci/scope-check.mts for AC2') === true
  && gLines[1]?.endsWith(' | extra-round | #152 | mechanical defect earns round 3') === true, gBody);
check('the appended comment still starts with the marker', gBody.startsWith(MARKER), gBody.slice(0, 80));

// --- H: `gh` failing for a reason that is not a 404 is an { error } ---------
const h = log(['500', '--kind', 'grant', '--ref', '#12', 'granted a glob']);
check('gh failure exits 1', h.status === 1, h.stdout);
const hOut = parse(h.stdout);
check(
  'gh failure reports { error }, never { refused }',
  typeof hOut?.error === 'string' && hOut?.refused === undefined,
  h.stdout,
);
check('gh failure wrote nothing', noWrite(h.log) && h.comments.length === 0, h.log);

// --- I: a usage problem is an { error }, not a refusal ----------------------
const i = log([]);
check('no arguments exits 1', i.status === 1, i.stdout);
check('no arguments reports { error } with the usage line', /log-decision\.mts/.test(parse(i.stdout)?.error ?? ''), i.stdout);

// --- J: <parent> takes the same #N / N shapes as --ref ----------------------
const j = log(['#100', '--kind', 'grant', '--ref', '#151', 'granted a glob']);
check('#100 as <parent> succeeds (exit 0)', j.status === 0, j.stdout);
const jOut = parse(j.stdout);
check('#100 as <parent> reports parent: 100 and one line', jOut?.parent === 100 && jOut?.lines === 1, j.stdout);
check('#100 as <parent> read issue 100', /issues\/100\b/.test(j.log), j.log);

const jZero = log(['#0', '--kind', 'grant', '--ref', '#151', 'granted a glob']);
check(
  '#0 as <parent> exits 1 with the usage line',
  jZero.status === 1 && /log-decision\.mts/.test(parse(jZero.stdout)?.error ?? ''),
  jZero.stdout,
);
check('#0 as <parent> never called gh at all', jZero.log.trim() === '', jZero.log);

// --- K: <parent> naming a pull request is refused as parent:type ------------
// `repos/{owner}/{repo}/issues/<n>` answers for a pull request too; the log
// lives on the milestone's parent *issue*, so a PR number is a refusal, not
// a comment on a pull request.
const k = log(['600', '--kind', 'grant', '--ref', '#151', 'granted a glob']);
check('a pull request as <parent> refuses (exit 1)', k.status === 1, k.stdout);
const kOut = parse(k.stdout);
check(
  'a pull request as <parent> reports { refused, parent, missing: [parent:type] }',
  typeof kOut?.refused === 'string' && kOut?.parent === 600 && (kOut?.missing ?? []).includes('parent:type'),
  k.stdout,
);
check('a pull request as <parent> wrote nothing', noWrite(k.log) && k.comments.length === 0, k.log);
check('a pull request as <parent> never read the comments', !/issues\/600\/comments/.test(k.log), k.log);

// --- L: a TMPDIR the staging directory cannot be made in is an { error } ----
// mkdtempSync is the one filesystem call the script used to make outside a
// try/catch: a TMPDIR it cannot write to has to be reported like every other
// write failure instead of crashing the process. A mode does not stop root,
// so the case is skipped there (tests/adopt-inventory.test.mts takes the same
// way out).
const IS_ROOT = process.getuid?.() === 0;
if (IS_ROOT) {
  check('read-only TMPDIR case skipped (running as root, which a mode cannot stop)', true);
} else {
  const readOnly = mkdtempSync(join(tmpdir(), 'agentic-decision-ro-'));
  cleanup(() => {
    try {
      chmodSync(readOnly, 0o700);
    } catch {
      /* already restored */
    }
    rmSync(readOnly, { recursive: true, force: true });
  });
  chmodSync(readOnly, 0o500);
  const l = log(['100', '--kind', 'grant', '--ref', '#151', 'granted a glob'], stateDir(), { TMPDIR: readOnly });
  chmodSync(readOnly, 0o700);
  check('a read-only TMPDIR exits 1', l.status === 1, l.stdout);
  const lOut = parse(l.stdout);
  check(
    'a read-only TMPDIR reports { error }, never a crash or a refusal',
    typeof lOut?.error === 'string' && lOut?.refused === undefined,
    l.stdout,
  );
  check('a read-only TMPDIR wrote nothing', noWrite(l.log) && l.comments.length === 0, l.log);
}

finish();
