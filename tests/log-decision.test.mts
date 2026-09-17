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
// Negative control: on the base (before this PR) scripts/log-decision.mts
// does not exist, so every run below prints nothing on stdout and each case
// fails on its own JSON assertion ("no refusal JSON", "no success JSON") —
// a runtime red, not a structural one. That is why the failure detail
// passed to check() is the child's *stdout* only: the child's
// ERR_MODULE_NOT_FOUND on stderr stays in a captured variable and never
// reaches the suite's output, where `ci/negative-control.mts:52-56` would
// read it as a structural red (skill `safe-worktree` §B7).
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
// (the { error } case), every other number is an open issue.
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

function log(args: string[], dir: string = stateDir()) {
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'log-decision.mts'), ...args], {
    encoding: 'utf8',
    cwd: repo,
    env: {
      ...process.env,
      PATH: PATH_WITH_FAKE_GH,
      FAKE_GH_STATE_DIR: dir,
      FAKE_GH_NODE: RUNTIME,
      FAKE_GH_JS,
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

finish();
