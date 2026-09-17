#!/usr/bin/env node
// Cases for scripts/create-subissue.mts: one command that creates a
// sub-issue, links it to its parent by **id**, inherits the parent's
// milestone and only then — once ci/issue-lint.mts reports `ok: true` —
// applies `state:ready`. The script is spawned for real, from inside a
// throwaway git repository, with a fake `gh` first on PATH.
//
// The fake `gh` is a small Node program (a bash wrapper execs it with the
// same runtime that launched this file), as in tests/log-decision.test.mts,
// because these cases need durable state: the issue a run creates has to
// still be readable when ci/issue-lint.mts (spawned for real by the script,
// not mocked) asks `gh issue view` for its body and milestone. It stores
// the created issues and the sub-issue links as JSON under
// FAKE_GH_STATE_DIR and logs every argv line it is called with, so a case
// can assert that a refusal never reached a creation, that the link POST
// carried the id and not the number, and that `state:ready` was added
// after the link and never at creation time.
//
// A created issue's REST `id` is deliberately unequal to its number
// (`700000 + number`), which is what makes "carries the id, not the number"
// assertable at all.
//
// Negative control: on the base (before this PR) scripts/create-subissue.mts
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

const MILESTONE = 'M14 Closure with evidence';

/** A body that satisfies every section ci/issue-lint.mts requires. */
function body(overrides: { goal?: boolean } = {}): string {
  const goal = overrides.goal === false ? '' : '## Goal\nDo the one thing.\n\n';
  return [
    '## Context\n',
    'Some context, with a reference to `scripts/create-subissue.mts`.\n\n',
    goal,
    '## Acceptance criteria\n- [ ] AC1 does it\n\n',
    '## Proof\n`npm test` covers it.\n\n',
    '## Files\n- `scripts/example.mts`\n\n',
    '## Dependencies\nBlocked by: none\n',
  ].join('');
}

// --- a fake `gh` on PATH ----------------------------------------------------
// Parent fixtures: 100 is open and carries a milestone, 101 is closed, 102
// is open with no milestone, 404 does not exist (gh's own 404 wording on
// stderr), 500 fails for a reason that is not a 404 at all (the { error }
// case). Created sub-issues get numbers from 200 up.
const FAKE_GH_IMPL = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MILESTONE = ${JSON.stringify(MILESTONE)};
const args = process.argv.slice(2);
const state = process.env.FAKE_GH_STATE_DIR;
appendFileSync(join(state, 'gh-argv.log'), args.join(' ') + '\n');

const path = (name) => join(state, name);
const load = (name, fallback) => (existsSync(path(name)) ? JSON.parse(readFileSync(path(name), 'utf8')) : fallback);
const save = (name, value) => writeFileSync(path(name), JSON.stringify(value));
const out = (text) => { process.stdout.write(text + '\n'); process.exit(0); };
const die = (message) => { process.stderr.write(message + '\n'); process.exit(1); };

/** The REST id of an issue: never equal to its number. */
const idOf = (n) => 700000 + n;

const PARENTS = {
  100: { state: 'open', milestone: { title: MILESTONE } },
  101: { state: 'closed', milestone: { title: MILESTONE } },
  102: { state: 'open', milestone: null },
};

const created = () => load('issues.json', {});

function issueOf(n) {
  if (PARENTS[n]) return { id: idOf(n), number: n, ...PARENTS[n] };
  const hit = created()[String(n)];
  if (!hit) return null;
  return { id: idOf(n), number: n, state: 'open', milestone: hit.milestone ? { title: hit.milestone } : null, ...hit };
}

function api() {
  let method = 'GET';
  let route = null;
  let jq = null;
  const fields = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--method') { method = args[++i]; continue; }
    if (a === '-q' || a === '--jq') { jq = args[++i]; continue; }
    if (a === '-F' || a === '--field' || a === '-f' || a === '--raw-field') {
      const field = args[++i] ?? '';
      const eq = field.indexOf('=');
      if (eq !== -1) fields[field.slice(0, eq)] = field.slice(eq + 1);
      continue;
    }
    if (a.startsWith('-')) continue;
    if (route === null) route = a;
  }
  if (route === null) die('fake-gh: no path in: ' + args.join(' '));

  const one = route.match(/^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)$/);
  if (method === 'GET' && one) {
    const n = Number(one[1]);
    if (n === 404) die('gh: Not Found (HTTP 404)');
    if (n === 500) die('gh: HTTP 403: API rate limit exceeded for installation');
    const issue = issueOf(n);
    if (!issue) die('gh: Not Found (HTTP 404)');
    out(jq === '.id' ? String(issue.id) : JSON.stringify(issue));
  }

  const sub = route.match(/^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)\/sub_issues$/);
  if (method === 'POST' && sub) {
    const parent = Number(sub[1]);
    const subIssueId = Number(fields.sub_issue_id);
    if (!Number.isInteger(subIssueId)) die('gh: HTTP 422: Invalid sub_issue_id');
    save('links.json', [...load('links.json', []), { parent, sub_issue_id: subIssueId }]);
    out(JSON.stringify({ id: subIssueId, number: subIssueId - 700000 }));
  }

  die('fake-gh: unhandled api call: ' + method + ' ' + route);
}

function issue() {
  const sub = args[1];

  if (sub === 'create') {
    let title = '';
    let bodyFile = null;
    let milestone = null;
    const labels = [];
    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (a === '--title' || a === '-t') { title = args[++i]; continue; }
      if (a === '--body-file' || a === '-F') { bodyFile = args[++i]; continue; }
      if (a === '--milestone' || a === '-m') { milestone = args[++i]; continue; }
      if (a === '--label' || a === '-l') { labels.push(args[++i]); continue; }
    }
    if (!bodyFile || !existsSync(bodyFile)) die('gh: could not read body file');
    const list = created();
    const number = 200 + Object.keys(list).length;
    list[String(number)] = { number, title, body: readFileSync(bodyFile, 'utf8'), milestone, labels, state: 'open' };
    save('issues.json', list);
    out('https://github.com/owner/repo/issues/' + number);
  }

  if (sub === 'view') {
    const n = Number(args[2]);
    const found = issueOf(n);
    if (!found) die('gh: Not Found (HTTP 404)');
    out(JSON.stringify({
      number: n,
      title: found.title ?? '',
      body: found.body ?? '',
      state: (found.state ?? 'open').toUpperCase(),
      labels: (found.labels ?? []).map((name) => ({ name })),
      milestone: found.milestone ?? null,
    }));
  }

  if (sub === 'list') out('[]');

  if (sub === 'edit') {
    const n = Number(args[2]);
    const list = created();
    const hit = list[String(n)];
    if (!hit) die('gh: Not Found (HTTP 404)');
    for (let i = 3; i < args.length; i++) {
      if (args[i] === '--add-label') hit.labels = [...(hit.labels ?? []), args[++i]];
    }
    save('issues.json', list);
    out('');
  }

  die('fake-gh: unhandled issue call: ' + args.join(' '));
}

if (args[0] === 'api') api();
if (args[0] === 'issue') issue();
die('fake-gh: unknown command: ' + args.join(' '));
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-subissue-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
const FAKE_GH_JS = join(fakeGhDir, 'gh-impl.mjs');
writeFileSync(FAKE_GH_JS, FAKE_GH_IMPL);
writeFileSync(join(fakeGhDir, 'gh'), '#!/usr/bin/env bash\nexec "$FAKE_GH_NODE" "$FAKE_GH_JS" "$@"\n');
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- the repository the script (and the lint it spawns) run from ------------
const repo = tempRepo();
writeFileSync(join(repo, 'README.md'), '# fixture\n');
git(['add', 'README.md'], repo);
git(['commit', '-q', '-m', 'init'], repo);
git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], repo);

// --- runner ------------------------------------------------------------------
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-subissue-state-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh-argv.log'), '');
  return dir;
}

function bodyFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-subissue-body-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'issue.md');
  writeFileSync(file, text);
  return file;
}

type Issue = { number: number; title: string; body: string; milestone: string | null; labels: string[] };
type Link = { parent: number; sub_issue_id: number };

function create(args: string[], dir: string = stateDir()) {
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'create-subissue.mts'), ...args], {
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
  const read = <T,>(name: string, fallback: T): T =>
    existsSync(join(dir, name)) ? (JSON.parse(readFileSync(join(dir, name), 'utf8')) as T) : fallback;
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    log: existsSync(join(dir, 'gh-argv.log')) ? readFileSync(join(dir, 'gh-argv.log'), 'utf8') : '',
    issues: Object.values(read<Record<string, Issue>>('issues.json', {})),
    links: read<Link[]>('links.json', []),
  };
}

function parse(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** True when the fake `gh` was never asked to create an issue. */
const noCreate = (argvLog: string): boolean => !/^issue create/m.test(argvLog);

const TITLE = 'feat(scripts): create and link a sub-issue';
const GOOD = bodyFile(body());

// --- A: a title outside the conventional set refuses, before gh is called ---
const a = create(['100', '--title', 'add a script', '--body-file', GOOD]);
check('a malformed title refuses (exit 1)', a.status === 1, a.stdout);
const aOut = parse(a.stdout);
check(
  'a malformed title reports { refused, parent, missing: [title:format] }',
  typeof aOut?.refused === 'string' && aOut?.parent === 100 && (aOut?.missing ?? []).includes('title:format'),
  a.stdout,
);
check('a malformed title never called gh at all', a.log.trim() === '', a.log);

const aScope = create(['100', '--title', 'feat: no scope', '--body-file', GOOD]);
check(
  'a title with no (scope) reports title:format',
  (parse(aScope.stdout)?.missing ?? []).includes('title:format'),
  aScope.stdout,
);

const aType = create(['100', '--title', 'wip(scripts): unknown type', '--body-file', GOOD]);
check(
  'a title with a type outside feat|fix|refactor|chore|docs|test|ci|deps reports title:format',
  (parse(aType.stdout)?.missing ?? []).includes('title:format'),
  aType.stdout,
);

// --- B: --body-file missing or unreadable refuses ---------------------------
const b = create(['100', '--title', TITLE]);
check('a missing --body-file refuses (exit 1)', b.status === 1, b.stdout);
check('a missing --body-file reports body:missing', (parse(b.stdout)?.missing ?? []).includes('body:missing'), b.stdout);
check('a missing --body-file never called gh at all', b.log.trim() === '', b.log);

const bUnreadable = create(['100', '--title', TITLE, '--body-file', join(tmpdir(), 'agentic-no-such-issue-body.md')]);
check('an unreadable --body-file reports body:missing', (parse(bUnreadable.stdout)?.missing ?? []).includes('body:missing'), bUnreadable.stdout);
check('an unreadable --body-file never called gh at all', bUnreadable.log.trim() === '', bUnreadable.log);

// --- C: the parent is closed -> refused, nothing created --------------------
const c = create(['101', '--title', TITLE, '--body-file', GOOD]);
check('a closed parent refuses (exit 1)', c.status === 1, c.stdout);
const cOut = parse(c.stdout);
check(
  'a closed parent reports { refused, parent, missing: [parent:state] }',
  typeof cOut?.refused === 'string' && cOut?.parent === 101 && (cOut?.missing ?? []).includes('parent:state'),
  c.stdout,
);
check('a closed parent created nothing', noCreate(c.log) && c.issues.length === 0, c.log);

// --- D: the parent does not exist -> refused, nothing created ---------------
const d = create(['404', '--title', TITLE, '--body-file', GOOD]);
check('a parent that does not exist refuses (exit 1)', d.status === 1, d.stdout);
check('a parent that does not exist reports parent:state', (parse(d.stdout)?.missing ?? []).includes('parent:state'), d.stdout);
check('a parent that does not exist created nothing', noCreate(d.log) && d.issues.length === 0, d.log);

// --- E: the parent carries no milestone -> refused, nothing created ---------
const e = create(['102', '--title', TITLE, '--body-file', GOOD]);
check('a parent with no milestone refuses (exit 1)', e.status === 1, e.stdout);
const eOut = parse(e.stdout);
check(
  'a parent with no milestone reports { refused, parent, missing: [parent:milestone] }',
  typeof eOut?.refused === 'string' && eOut?.parent === 102 && (eOut?.missing ?? []).includes('parent:milestone'),
  e.stdout,
);
check('a parent with no milestone created nothing', noCreate(e.log) && e.issues.length === 0, e.log);

// --- F: the happy path -------------------------------------------------------
const f = create(['100', '--title', TITLE, '--body-file', GOOD, '--label', 'scope:scripts', '--label', 'type:feature', '--label', 'state:ready']);
check('the happy path succeeds (exit 0)', f.status === 0, f.stdout);
const fOut = parse(f.stdout);
check(
  'the happy path reports { issue, parent, milestone, linked: true, lint }',
  Number.isInteger(fOut?.issue)
    && fOut?.parent === 100
    && fOut?.milestone === MILESTONE
    && fOut?.linked === true
    && fOut?.lint?.ok === true,
  f.stdout,
);
check('the happy path created exactly one issue', f.issues.length === 1, JSON.stringify(f.issues.map((i) => i.number)));

const child = f.issues[0];
check('the created issue inherits the parent\'s milestone', child?.milestone === MILESTONE, JSON.stringify(child));
check(
  'the created issue carries the --label values given',
  (child?.labels ?? []).includes('scope:scripts') && (child?.labels ?? []).includes('type:feature'),
  JSON.stringify(child?.labels),
);

const createLine = f.log.split(/\r?\n/).find((l) => l.startsWith('issue create')) ?? '';
check('the create call carries the milestone', createLine.includes(`--milestone ${MILESTONE}`), createLine);
check('the create call never passes state:ready', !/--label state:ready/.test(createLine), createLine);

// The link carries the REST id (700000 + number), never the number itself.
check('exactly one sub-issue link was posted', f.links.length === 1, JSON.stringify(f.links));
check('the link names the parent', f.links[0]?.parent === 100, JSON.stringify(f.links));
check(
  'the sub_issues POST carries the child\'s id, not its number',
  f.links[0]?.sub_issue_id === 700000 + Number(child?.number) && f.links[0]?.sub_issue_id !== Number(child?.number),
  `${JSON.stringify(f.links)} child=${child?.number}`,
);
check(
  'the link was posted to the parent\'s sub_issues endpoint',
  new RegExp(`-X POST repos/\\{owner\\}/\\{repo\\}/issues/100/sub_issues`).test(f.log),
  f.log,
);

// state:ready is added last: after the link, by `gh issue edit`.
const lines = f.log.split(/\r?\n/);
const linkAt = lines.findIndex((l) => /sub_issues/.test(l));
const readyAt = lines.findIndex((l) => /^issue edit .*--add-label state:ready/.test(l));
check('state:ready is added by gh issue edit', readyAt !== -1, f.log);
check('state:ready is added after the link, never before', linkAt !== -1 && readyAt > linkAt, f.log);
check('the created issue ends up with state:ready', (child?.labels ?? []).includes('state:ready'), JSON.stringify(child?.labels));

// --- G: a body that fails the lint stays created, linked and not ready ------
const g = create(['100', '--title', TITLE, '--body-file', bodyFile(body({ goal: false })), '--label', 'scope:scripts']);
check('a lint failure exits 1', g.status === 1, g.stdout);
const gOut = parse(g.stdout);
check(
  'a lint failure reports { issue, parent, milestone, linked: true, lint } with the lint result',
  Number.isInteger(gOut?.issue) && gOut?.parent === 100 && gOut?.linked === true && gOut?.lint?.ok === false,
  g.stdout,
);
check('a lint failure still created the issue', g.issues.length === 1, JSON.stringify(g.issues.map((i) => i.number)));
check('a lint failure still linked it to the parent', g.links.length === 1 && g.links[0]?.parent === 100, JSON.stringify(g.links));
check(
  'a lint failure never adds state:ready',
  !(g.issues[0]?.labels ?? []).includes('state:ready') && !/--add-label state:ready/.test(g.log),
  `${JSON.stringify(g.issues[0]?.labels)} ${g.log}`,
);

// --- H: gh failing for a reason that is not a 404 is an { error } -----------
const h = create(['500', '--title', TITLE, '--body-file', GOOD]);
check('a gh failure exits 1', h.status === 1, h.stdout);
const hOut = parse(h.stdout);
check(
  'a gh failure reports { error }, never { refused }',
  typeof hOut?.error === 'string' && hOut?.refused === undefined,
  h.stdout,
);
check('a gh failure created nothing', noCreate(h.log) && h.issues.length === 0, h.log);

// --- I: a usage problem is an { error }, not a refusal ----------------------
const i = create([]);
check('no arguments exits 1', i.status === 1, i.stdout);
check('no arguments reports { error } with the usage line', /create-subissue\.mts/.test(parse(i.stdout)?.error ?? ''), i.stdout);

finish();
