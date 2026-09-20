#!/usr/bin/env node
// The half of the closeout pin that needs an answer from outside the checkout
// (#422): whether a row's issue is closed, and whether a `## Left out` bullet
// accounts for something that shipped. Split out of
// `tests/provenance.test.mts`, which stands at the 800-line limit and holds
// the format and the ancestry — everything a closeout's own text and `git`
// can settle.
//
// Two questions, and the whole point of the sweep is that they are not one:
//
//   row → state      a row of `## Issues` says the issue shipped, so the issue
//                    is closed (#381). Nothing asked this before: the
//                    milestone → table direction was checked twice and the
//                    reverse nowhere.
//   bullet → state   a `## Left out` bullet that *accounts for* an issue —
//                    its `#N` opens the bullet — says it did not ship, so no
//                    merged pull request of it may already be in the history
//                    the file snapshots (#298, findings D22 and D27).
//
// "Accounts for" is narrower than "mentions", and that separation is the
// sweep's own criterion rather than a convenience. Measured at `3ce7f47`:
// widening the parser to read a bullet's continuation lines (#341) makes
// `docs/closeout/M17.md` collect 55 references where the old parser saw 2, and
// 26 of the 55 name issues that are rows in that same file's `## Issues`
// table. Under the literal rule #298 was filed with — "an issue named in
// `## Left out` that is closed by a merged pull request" — that is 65
// references across 13 of the 17 closeouts, all of them red, including the
// closeout issue of each phase, which the grammar *requires* to sit there. The
// rule that discriminates is stated in `docs/closeout/README.md` and
// implemented identically here and in `scripts/close-milestone.mts`.
//
// Crash policy, and the three fail-opens:
//
//   - The whole file is opt-in. Unset, `AGENTIC_PROVENANCE_LIVE_GH` leaves one
//     note on stderr naming itself and the real tree is not read (#356: this
//     check used to spend 129 calls of a shared quota per suite run, and
//     exhausting it failed the pin as though a closeout were wrong).
//   - A `gh` that cannot authenticate is a note, not a failure.
//   - A `gh` that cannot answer — a rate limit, a 5xx, no network — is a note,
//     not a failure. A number that resolves to nothing stays red and says so
//     in words that cannot be read as a rate limit: the API declining to
//     answer and the record being wrong are different facts.
//
// The reads are batched: one `gh api graphql` call carries every issue of
// every closeout, up to `GRAPHQL_BATCH` at a time, against the one
// `gh issue view` per row this replaces (#298).
//
// The parser below is a third copy of the closeout grammar, next to
// `tests/provenance.test.mts`'s and `scripts/close-milestone.mts`'s, and that
// is deliberate: invariant 10 — a pin that imports the thing it pins cannot
// catch that thing drifting — and invariant 6, which forbids a script from
// importing `tests/`. `docs/closeout/README.md` is the one statement all three
// are written from.
//
// Negative control: the real-tree counts below assert on files outside this
// one, and the synthetic cases carry their own repositories and fixture, so
// this file is red on the base — the base parser reads a bullet's first line
// only, and no reader anywhere asks either question above.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, ROOT, tempRepo, RUNTIME } from './lib/harness.mts';

// --- the closeout grammar, the half this file reads -------------------------
const SECTIONS = ['## Issues', '## Left out', '## Dogfood'];
const META_SHA = /^- main SHA: ([0-9a-f]{40})$/;
const ISSUE_REF = /#(\d+)/g;
const SHA = /^[0-9a-f]{40}$/;
const ISSUE_CELL = /^#(\d+)$/;
/**
 * The run of `#N` that opens a `## Left out` bullet, separated by nothing but
 * `,`, `and` or `&`. `docs/closeout/README.md` states this as a sentence and
 * this is that sentence. Unbroken on purpose: `- #125 (a) and #126 (b)` claims
 * #125 only, because the parenthesis ends the run.
 */
const LEFT_OUT_CLAIM = /^-\s+((?:#\d+(?:\s*(?:,|and|&)\s*)?)+)/;

type Row = { issue: number; sha: string };
type Closeout = { sha: string; rows: Row[]; leftOut: number[]; claims: number[] };

/** Each `- ` line joined with the indented continuation lines under it. */
function bulletsOf(lines: string[]): string[] {
  const bullets: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (text === '') continue;
    // An indented line continues the bullet above it whatever it opens with,
    // `- ` included: `- Deferred:` / `  - #12 ...` is one bullet about the
    // deferral, not two, so #12 is mentioned and not claimed. A bullet begins
    // at the left margin; anything else ends the one above and is ignored.
    if (/^\s/.test(line) && bullets.length > 0) bullets[bullets.length - 1] += ` ${text}`;
    else if (text.startsWith('- ')) bullets.push(text);
  }
  return bullets;
}

/**
 * The rows, the mentions and the claims of one closeout, or null when the file
 * does not parse far enough to ask anything of it. Whether it parses at all is
 * `tests/provenance.test.mts`'s question, not this file's, so a null is
 * skipped rather than reported twice.
 */
function parseCloseout(raw: string): Closeout | null {
  const lines = raw.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const at = SECTIONS.map((section) => lines.findIndex((l) => l.trim() === section));
  if (at.some((i) => i === -1) || !(at[0] < at[1] && at[1] < at[2])) return null;
  const sha = lines.slice(0, at[0]).map((l) => META_SHA.exec(l.trim())).find((m) => m !== null);
  if (!sha) return null;

  const rows: Row[] = [];
  for (const line of lines.slice(at[0] + 1, at[1])) {
    const text = line.trim();
    if (!text.startsWith('|') || !text.endsWith('|')) continue;
    const cells = text.slice(1, -1).split('|').map((c) => c.trim());
    const issue = cells.length === 4 ? ISSUE_CELL.exec(cells[0]) : null;
    if (issue && SHA.test(cells[3])) rows.push({ issue: Number(issue[1]), sha: cells[3] });
  }

  const leftOut: number[] = [];
  const claims: number[] = [];
  for (const bullet of bulletsOf(lines.slice(at[1] + 1, at[2]))) {
    for (const ref of bullet.matchAll(ISSUE_REF)) leftOut.push(Number(ref[1]));
    const claim = LEFT_OUT_CLAIM.exec(bullet);
    if (claim) for (const ref of claim[1].matchAll(ISSUE_REF)) claims.push(Number(ref[1]));
  }
  return { sha: sha[1], rows, leftOut: [...new Set(leftOut)], claims: [...new Set(claims)] };
}

// --- the issue source -------------------------------------------------------
type Env = Record<string, string | undefined>;

/** The environment variable that opts a run into asking GitHub at all. */
export const LIVE_GH_ENV = 'AGENTIC_PROVENANCE_LIVE_GH';
/** The note the default (offline) source leaves, once, naming the opt-in. */
export const OFFLINE_MESSAGE =
  `the issue-state checks were skipped — they ask GitHub, and the required suite does not: set ${LIVE_GH_ENV}=1 to run them`;
/** The note a `gh` that cannot authenticate leaves, once. */
export const UNAUTHENTICATED_MESSAGE = 'gh is absent or unauthenticated — the issue-state checks were skipped';
/** At most this many issues per `gh api graphql` call, so a long phase cannot hit GraphQL's node budget. */
const GRAPHQL_BATCH = 50;

/**
 * `gh`'s own wording when a number resolves to nothing, taken from the real
 * CLI against this repository — `GraphQL: Could not resolve to an issue or
 * pull request with the number of N.` — and the same sentence GraphQL returns
 * in its `errors` array. Everything else it can fail with is the API declining
 * to answer, so this is a list of one: a wording that drifts costs a skip,
 * never a false red.
 */
const NO_SUCH_ISSUE = /could not resolve to an? (issue|pull ?request)/i;

/** Reads one failed `gh` call and says which of the two failures it is. */
export function classifyGhFailure(stderr: string): { kind: 'no-such-issue' | 'unavailable'; detail: string } {
  const detail = stderr.trim().split('\n')[0] || 'no output';
  return { kind: NO_SUCH_ISSUE.test(stderr) ? 'no-such-issue' : 'unavailable', detail };
}

/** What one issue lookup answers. `prSha` is the merge commit of the pull request that closed it. */
type Facts = { state: string; pr: number | null; prSha: string | null };
type Answer = Facts | 'no-such-issue';
type Lookup =
  | { kind: 'answers'; answers: Map<number, Answer> }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'forbidden'; detail: string };
type IssueSource =
  | { kind: 'lookup'; lookup: (numbers: number[]) => Lookup }
  | { kind: 'skipped'; reason: string };

const ISSUE_FIELDS =
  '__typename ... on Issue { state closedByPullRequestsReferences(first: 1, includeClosedPrs: true) ' +
  '{ nodes { number state mergeCommit { oid } } } }';

/** Runs a command in a repository without throwing. */
function run(cmd: string, args: string[], cwd: string, env: Env) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env as NodeJS.ProcessEnv });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * A source backed by whatever `gh` is on PATH, batching every number into
 * `ceil(n / GRAPHQL_BATCH)` calls. The exit status is not read: a number that
 * resolves to nothing makes `gh` exit 1 while still printing every other
 * alias's answer, so the body is what is read. A body that does not parse, or
 * an error that is not a `NOT_FOUND`, is the API declining to answer.
 */
function ghIssueSource(repo: string, env: Env): IssueSource {
  if (run('gh', ['auth', 'status'], repo, env).status !== 0) return { kind: 'skipped', reason: UNAUTHENTICATED_MESSAGE };
  return {
    kind: 'lookup',
    lookup: (numbers: number[]): Lookup => {
      const answers = new Map<number, Answer>();
      for (let i = 0; i < numbers.length; i += GRAPHQL_BATCH) {
        const chunk = numbers.slice(i, i + GRAPHQL_BATCH);
        const aliases = chunk.map((n) => `i${n}: issueOrPullRequest(number: ${n}) { ${ISSUE_FIELDS} }`).join(' ');
        const r = run(
          'gh',
          [
            'api',
            'graphql',
            '-F',
            'owner={owner}',
            '-F',
            'name={repo}',
            '-f',
            `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases} } }`,
          ],
          repo,
          env,
        );
        let body: any = null;
        try {
          body = JSON.parse(r.stdout);
        } catch {
          body = null;
        }
        // `FORBIDDEN` is read before anything else, because it is the one
        // refusal that is a *configuration* fact: a token without the scope
        // the query needs, which never fixes itself and whose whole symptom is
        // a green run that checked nothing. A rate limit, a 5xx or a dropped
        // network passes on its own, so those stay notes — reddening them is
        // #356's false red coming back. A type that drifts falls through into
        // `unavailable` and costs a skip, never a false red.
        const reported = (body?.errors ?? []) as any[];
        const forbidden = reported.filter((e) => e?.type === 'FORBIDDEN');
        if (forbidden.length > 0) return { kind: 'forbidden', detail: String(forbidden[0]?.message ?? 'no message') };
        const repository = body?.data?.repository;
        if (!repository) return { kind: 'unavailable', detail: classifyGhFailure(r.stderr || r.stdout).detail };
        const declined = reported.filter((e) => e?.type !== 'NOT_FOUND');
        if (declined.length > 0) return { kind: 'unavailable', detail: String(declined[0]?.message ?? 'no message') };
        for (const n of chunk) {
          const node = repository[`i${n}`];
          if (!node || node.__typename !== 'Issue') {
            answers.set(n, 'no-such-issue');
            continue;
          }
          const merged = (node.closedByPullRequestsReferences?.nodes ?? []).find((p: any) => p?.state === 'MERGED');
          answers.set(n, {
            state: String(node.state ?? ''),
            pr: merged ? Number(merged.number) : null,
            prSha: typeof merged?.mergeCommit?.oid === 'string' ? merged.mergeCommit.oid : null,
          });
        }
      }
      return { kind: 'answers', answers };
    },
  };
}

/** The source the real tree gets: offline unless `LIVE_GH_ENV` asks otherwise. */
export function issueSourceFor(repo: string, env: Env): IssueSource {
  if ((env[LIVE_GH_ENV] ?? '') !== '1') return { kind: 'skipped', reason: OFFLINE_MESSAGE };
  return ghIssueSource(repo, env);
}

// --- the audit --------------------------------------------------------------
type Audit = { errors: string[]; notes: string[]; files: string[]; asked: number };

/**
 * Asks both questions of every `docs/closeout/M<n>.md` under repo, in one
 * batch. A claim that is also a row is the file cross-referencing its own
 * table — `## Issues` is the stronger statement and wins — and a claim whose
 * pull request merged after the file's `main SHA` is outside the history the
 * file snapshots, which is what lets the closeout issue of a phase head a
 * bullet in its own closeout.
 */
function audit(repo: string, env: Env, source: IssueSource): Audit {
  const errors: string[] = [];
  const notes: string[] = [];
  const dir = join(repo, 'docs', 'closeout');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^M\d+\.md$/.test(f)).sort() : [];
  if (source.kind === 'skipped') {
    notes.push(source.reason);
    return { errors, notes, files, asked: 0 };
  }

  const parsed = new Map<string, Closeout>();
  for (const file of files) {
    const p = parseCloseout(readFileSync(join(dir, file), 'utf8'));
    if (p) parsed.set(file, p);
  }
  const wanted = new Set<number>();
  for (const [, p] of parsed) {
    const rows = new Set(p.rows.map((r) => r.issue));
    for (const n of rows) wanted.add(n);
    for (const n of p.claims) if (!rows.has(n)) wanted.add(n);
  }
  const numbers = [...wanted].sort((a, b) => a - b);
  if (numbers.length === 0) return { errors, notes, files, asked: 0 };

  const answer = source.lookup(numbers);
  if (answer.kind === 'forbidden') {
    errors.push(
      `the token cannot read what this check asks for, so ${numbers.length} issue(s) went unchecked — ${answer.detail}. ` +
        'That is a permission, not a rate limit: the query reads pull-request data, and a workflow with an explicit ' +
        '`permissions:` block grants `none` to every scope it does not list.',
    );
    return { errors, notes, files, asked: 0 };
  }
  if (answer.kind === 'unavailable') {
    notes.push(`the issue-state checks were skipped for ${numbers.length} issue(s) — ${answer.detail}`);
    // `asked` is what was *answered*, never what the run wanted to ask, so a
    // caller cannot read a skipped batch as a batch that reported clean.
    return { errors, notes, files, asked: 0 };
  }
  const answers = answer.answers;

  for (const [file, p] of parsed) {
    const rows = new Set(p.rows.map((r) => r.issue));
    for (const row of p.rows) {
      const fact = answers.get(row.issue);
      if (fact === 'no-such-issue') {
        errors.push(`${file}: #${row.issue} resolves to no issue or pull request — the row is wrong, not the API`);
      } else if (fact && fact.state !== 'CLOSED') {
        errors.push(`${file}: #${row.issue} is listed as shipped but is ${fact.state}`);
      }
    }
    for (const claim of p.claims) {
      if (rows.has(claim)) continue;
      const fact = answers.get(claim);
      if (!fact || fact === 'no-such-issue' || fact.prSha === null) continue;
      if (run('git', ['merge-base', '--is-ancestor', fact.prSha, p.sha], repo, env).status !== 0) continue;
      errors.push(
        `${file}: \`## Left out\` accounts for #${claim}, but it shipped in PR #${fact.pr}, ` +
          `already in the history this closeout snapshots (main SHA ${p.sha.slice(0, 8)})`,
      );
    }
  }
  return { errors, notes, files, asked: numbers.length };
}

// --- the real tree ----------------------------------------------------------
// Offline, and measured rather than derived: #422's drafting pass reported
// that `docs/closeout/M17.md` holds 55 distinct `#N` in `## Left out` where
// the parser saw 2, and this reproduces it. M17 is a closed phase and its file
// is history, so the numbers are fixed; a file that changes is a file whose
// count was re-measured on purpose.
const closeoutDir = join(ROOT, 'docs', 'closeout');
const m17 = parseCloseout(readFileSync(join(closeoutDir, 'M17.md'), 'utf8'));
check(
  'the widened parser collects 55 distinct references from M17.md `## Left out`',
  m17?.leftOut.length === 55,
  String(m17?.leftOut.length),
);
check(
  'only 2 of them open a bullet, so only 2 are claims about what did not ship',
  m17?.claims.join(',') === '201,401',
  String(m17?.claims.join(',')),
);

// The 26 of those 55 that name a row of M17's own `## Issues` table: the
// measurement the separation exists for. Widen the parser without separating
// "mentions" from "accounts for" and every one of these becomes a bullet
// claiming that an issue with a merge commit two sections above did not ship.
const M17_ROW_CROSS_REFERENCES = [
  203, 205, 206, 209, 212, 214, 229, 230, 231, 232, 237, 238, 239, 297, 308,
  310, 316, 324, 326, 336, 339, 352, 354, 355, 356, 357,
];
check(
  'the 26 references that name a row of M17.md\'s own table are mentions, and none of them is a claim',
  M17_ROW_CROSS_REFERENCES.every((n) => m17?.leftOut.includes(n) && !m17.claims.includes(n)),
  M17_ROW_CROSS_REFERENCES.filter((n) => !m17?.leftOut.includes(n) || m17.claims.includes(n)).join(','),
);

const tracked = readdirSync(closeoutDir).filter((f) => /^M\d+\.md$/.test(f)).sort();
check(`all ${tracked.length} tracked closeouts parse far enough to be asked about`, tracked.every((f) => parseCloseout(readFileSync(join(closeoutDir, f), 'utf8')) !== null), tracked.join(','));

const real = audit(ROOT, process.env, issueSourceFor(ROOT, process.env));
check(`docs/closeout/M*.md holds up against GitHub (${real.files.length} file(s))`, real.errors.length === 0, real.errors.join('\n'));
for (const note of real.notes) console.error(`note  provenance-issues: ${note}`);
if ((process.env[LIVE_GH_ENV] ?? '') === '1') {
  check(`the real-tree audit asks GitHub when ${LIVE_GH_ENV}=1`, !real.notes.includes(OFFLINE_MESSAGE), real.notes.join('\n'));
} else {
  check(
    'the real-tree audit does not call GitHub by default, and the note names the opt-in',
    real.notes.includes(OFFLINE_MESSAGE) && OFFLINE_MESSAGE.includes(LIVE_GH_ENV),
    real.notes.join('\n'),
  );
  check(
    'without the opt-in the source is skipped, so nothing is spawned to ask',
    issueSourceFor(ROOT, { ...process.env, [LIVE_GH_ENV]: '' }).kind === 'skipped',
    issueSourceFor(ROOT, { ...process.env, [LIVE_GH_ENV]: '' }).kind,
  );
}

// --- a controlled `gh` ------------------------------------------------------
// A node program behind a bash wrapper, the shape `tests/close-milestone.test.mts`
// uses: these cases need per-issue state and an argv log, which a bash script
// answers badly. `facts.json` is keyed by issue number — "none" resolves to
// nothing, otherwise `{ state, pr, sha }` — and a number not named there is a
// closed issue with no pull request.
const FAKE_GH_IMPL = String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const state = process.env.FAKE_GH_STATE_DIR;
appendFileSync(join(state, 'gh-argv.log'), args.join(' ') + '\n');
const die = (m) => { process.stderr.write(m + '\n'); process.exit(1); };
if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.FAKE_GH_AUTH === 'fail') die('not logged in');
  process.exit(0);
}
if (args[0] !== 'api' || args[1] !== 'graphql') die('fake-gh: unexpected call: ' + args.join(' '));
if (process.env.FAKE_GH_FAIL) die(process.env.FAKE_GH_FAIL);
if (process.env.FAKE_GH_FORBIDDEN) {
  // What GitHub answers a token whose permissions block omits a scope the
  // query needs: the data comes back null, alongside a FORBIDDEN error, and
  // gh exits 1. (No backticks in here: this is a template literal.)
  process.stdout.write(JSON.stringify({ data: { repository: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }) + '\n');
  process.stderr.write('gh: Resource not accessible by integration\n');
  process.exit(1);
}
const query = args.find((a) => a.startsWith('query=')) ?? '';
const numbers = [...query.matchAll(/i(\d+): issueOrPullRequest\(number: (\d+)\)/g)].map((m) => Number(m[2]));
if (numbers.length === 0) die('fake-gh: graphql query names no issue');
const factsPath = join(state, 'facts.json');
const facts = existsSync(factsPath) ? JSON.parse(readFileSync(factsPath, 'utf8')) : {};
const data = {};
const errors = [];
for (const n of numbers) {
  const fact = facts[String(n)];
  if (fact === 'none') {
    data['i' + n] = null;
    errors.push({ type: 'NOT_FOUND', message: 'Could not resolve to an issue or pull request with the number of ' + n + '.' });
    continue;
  }
  const nodes = fact && fact.pr ? [{ number: fact.pr, state: 'MERGED', mergeCommit: { oid: fact.sha } }] : [];
  data['i' + n] = { __typename: 'Issue', state: (fact && fact.state) || 'CLOSED', closedByPullRequestsReferences: { nodes } };
}
const body = JSON.stringify(errors.length > 0 ? { data: { repository: data }, errors } : { data: { repository: data } });
process.stdout.write(body + '\n');
process.exit(errors.length > 0 ? 1 : 0);
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-gh-issues-'));
cleanup(() => spawnSync('rm', ['-rf', fakeGhDir]));
const FAKE_GH_JS = join(fakeGhDir, 'gh-impl.mjs');
writeFileSync(FAKE_GH_JS, FAKE_GH_IMPL);
writeFileSync(join(fakeGhDir, 'gh'), '#!/usr/bin/env bash\nexec "$FAKE_GH_NODE" "$FAKE_GH_JS" "$@"\n');
chmodSync(join(fakeGhDir, 'gh'), 0o755);

/** A state directory for one case, and the environment that points `gh` at it. */
function withFacts(facts: Record<string, unknown> = {}, extra: Env = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-gh-state-'));
  cleanup(() => spawnSync('rm', ['-rf', dir]));
  writeFileSync(join(dir, 'gh-argv.log'), '');
  writeFileSync(join(dir, 'facts.json'), JSON.stringify(facts));
  return {
    ...process.env,
    PATH: `${fakeGhDir}:${process.env.PATH ?? ''}`,
    FAKE_GH_STATE_DIR: dir,
    FAKE_GH_NODE: RUNTIME,
    FAKE_GH_JS,
    ...extra,
  };
}

const callsOf = (env: Env): string[] =>
  readFileSync(join(String(env.FAKE_GH_STATE_DIR), 'gh-argv.log'), 'utf8').split('\n').filter(Boolean);

// --- synthetic repositories -------------------------------------------------
/** A repository with two commits on main, the second landing the closeout. */
function fixtureRepo(): { repo: string; first: string; second: string } {
  const repo = tempRepo();
  commit(repo, { 'README.md': 'base\n' }, 'chore: base');
  const first = commit(repo, { 'a.txt': 'a\n' }, 'feat(a): land (#1)');
  const second = commit(repo, { 'b.txt': 'b\n' }, 'docs(docs): closeout (#2)');
  return { repo, first, second };
}

/** Writes a filled closeout over the given rows and `## Left out` text. */
function writeCloseout(repo: string, sha: string, rows: Array<[number, number, string]>, leftOut: string): void {
  const table = rows.map(([issue, pr, rowSha]) => `| #${issue} | feat(x): a thing | #${pr} | ${rowSha} |`).join('\n');
  mkdirSync(join(repo, 'docs', 'closeout'), { recursive: true });
  writeFileSync(
    join(repo, 'docs', 'closeout', 'M1.md'),
    `# Closeout M1 — A phase

- Closed (UTC): 2026-09-17
- main SHA: ${sha}

## Issues

| issue | title | PR | merge commit |
| --- | --- | --- | --- |
${table}

## Left out

${leftOut}

## Dogfood

- None needed — no report was required.
`,
  );
}

/** A repository whose closeout has one row and the given `## Left out` text. */
function caseRepo(leftOut: string): { repo: string; first: string; second: string } {
  const f = fixtureRepo();
  writeCloseout(f.repo, f.first, [[1, 11, f.first]], leftOut);
  return f;
}

const auditWith = (repo: string, env: Env) => audit(repo, env, ghIssueSource(repo, env));

// --- the real tree, against the fixture -------------------------------------
// "AC4 of #356: determinism must not cost the check its reach." These two came
// across the #422 split from `tests/provenance.test.mts`, where they were the
// only assertions composing a real file, a real row, the audit and a named
// error. Every other fixture-backed case below writes a one-row synthetic
// document, so without these the required suite would hold no issue-state
// assertion over the record it exists to protect. The first is the clean case;
// the second mutates one real row's issue to OPEN, which is the defect the
// live call existed to catch.
const realCleanEnv = withFacts();
const realClean = auditWith(ROOT, realCleanEnv);
check(
  `the real tree's closeout rows pass the issue-state checks against the fixture (${realClean.asked} issue(s))`,
  realClean.errors.length === 0,
  realClean.errors.join('\n'),
);
check('that fixture-backed run actually asked about every row', realClean.asked > 0, String(realClean.asked));

const realRow = (() => {
  for (const file of tracked) {
    const p = parseCloseout(readFileSync(join(closeoutDir, file), 'utf8'));
    if (p && p.rows.length > 0) return { file, issue: p.rows[0].issue };
  }
  return null;
})();
if (!realRow) {
  console.error('note  provenance-issues: no filled closeout row to run the open-issue fixture over, case skipped');
} else {
  const realOpen = auditWith(ROOT, withFacts({ [realRow.issue]: { state: 'OPEN' } }));
  check(
    `a real closeout row whose issue is open fails (${realRow.file} #${realRow.issue})`,
    realOpen.errors.some((e) => e.includes(`#${realRow.issue}`) && e.includes('OPEN')),
    realOpen.errors.join('\n'),
  );
}

// A: the row direction (#381).
const openRow = caseRepo('- None — every issue shipped.');
const openRowAudit = auditWith(openRow.repo, withFacts({ 1: { state: 'OPEN' } }));
check(
  'a row whose issue is still open fails, naming the row and its state',
  openRowAudit.errors.some((e) => e.includes('#1') && e.includes('OPEN')),
  openRowAudit.errors.join('\n'),
);

const goneRow = caseRepo('- None — every issue shipped.');
const goneRowAudit = auditWith(goneRow.repo, withFacts({ 1: 'none' }));
check(
  'a row naming an issue that resolves to nothing is the row being wrong, not the API declining',
  goneRowAudit.errors.some((e) => e.includes('#1') && e.includes('resolves to no issue') && !/rate limit|could not answer/i.test(e)),
  goneRowAudit.errors.join('\n'),
);

// B: the bullet direction (#298), and the two carve-outs that make it honest.
const shipped = caseRepo('- #2 `feat(y): a thing` — did not ship in this phase.');
const shippedEnv = withFacts({ 2: { state: 'CLOSED', pr: 22, sha: shipped.first } });
const shippedAudit = auditWith(shipped.repo, shippedEnv);
check(
  'a `## Left out` bullet accounting for an issue that shipped fails, naming the issue and the pull request',
  shippedAudit.errors.some((e) => e.includes('#2') && e.includes('PR #22') && e.includes('Left out')),
  shippedAudit.errors.join('\n'),
);

const later = caseRepo('- #2 `docs: closeout M1` — the issue this file answers.');
const laterAudit = auditWith(later.repo, withFacts({ 2: { state: 'CLOSED', pr: 22, sha: later.second } }));
check(
  "a bullet naming an issue whose pull request merged after the file's `main SHA` passes",
  laterAudit.errors.length === 0,
  laterAudit.errors.join('\n'),
);

const crossRef = fixtureRepo();
writeCloseout(crossRef.repo, crossRef.first, [[1, 11, crossRef.first], [2, 12, crossRef.first]], '- #1 and #2 are the same defect filed twice, and both shipped.');
const crossRefAudit = auditWith(crossRef.repo, withFacts({
  1: { state: 'CLOSED', pr: 11, sha: crossRef.first },
  2: { state: 'CLOSED', pr: 12, sha: crossRef.first },
}));
check(
  'a number that is both a row and a bullet is a cross-reference, not a claim',
  crossRefAudit.errors.length === 0,
  crossRefAudit.errors.join('\n'),
);

const mention = caseRepo('- The phase cut work that had no owner, and the list it was checked\n  against names #2 among them.');
const mentionAudit = auditWith(mention.repo, withFacts({ 2: { state: 'CLOSED', pr: 22, sha: mention.first } }));
check(
  'a `#N` that does not open its bullet is a mention, and a mention makes no claim',
  mentionAudit.errors.length === 0,
  mentionAudit.errors.join('\n'),
);

// C: the reads are one call, not one per row (#298).
const batched = fixtureRepo();
writeCloseout(
  batched.repo,
  batched.first,
  Array.from({ length: 12 }, (_, i) => [i + 1, i + 101, batched.first] as [number, number, string]),
  '- #50 `a thing` — did not ship.',
);
const batchedEnv = withFacts();
const batchedAudit = auditWith(batched.repo, batchedEnv);
const batchedCalls = callsOf(batchedEnv).filter((line) => line.startsWith('api graphql'));
check('twelve rows and a claim are read in one `gh api graphql` call', batchedCalls.length === 1, batchedCalls.join('\n'));
check('that one call asked about all thirteen issues', batchedAudit.asked === 13, String(batchedAudit.asked));
check('the batched read found nothing wrong with a clean closeout', batchedAudit.errors.length === 0, batchedAudit.errors.join('\n'));

// D: the fail-opens.
const RATE_LIMITED = 'GraphQL: API rate limit already exceeded';
const limited = caseRepo('- None — every issue shipped.');
const limitedAudit = auditWith(limited.repo, withFacts({ 1: { state: 'OPEN' } }, { FAKE_GH_FAIL: RATE_LIMITED }));
check('an API that declines to answer is skipped, not failed', limitedAudit.errors.length === 0, limitedAudit.errors.join('\n'));
check(
  'the skip says how many issues went unchecked and what the API said',
  limitedAudit.notes.some((n) => n.includes(RATE_LIMITED) && n.includes('skipped')),
  limitedAudit.notes.join('\n'),
);
check(
  'a rate limit is classified as the API declining, not as a missing record',
  classifyGhFailure(RATE_LIMITED).kind === 'unavailable',
  classifyGhFailure(RATE_LIMITED).kind,
);
check(
  "gh's own wording for a number that resolves to nothing is classified as the record being wrong",
  classifyGhFailure('GraphQL: Could not resolve to an issue or pull request with the number of 9999999. (repository.issue)').kind === 'no-such-issue',
  'no-such-issue',
);

const unauth = caseRepo('- None — every issue shipped.');
const unauthEnv = withFacts({ 1: { state: 'OPEN' } }, { FAKE_GH_AUTH: 'fail' });
const unauthAudit = audit(unauth.repo, unauthEnv, ghIssueSource(unauth.repo, unauthEnv));
check('an unauthenticated gh skips the checks instead of failing', unauthAudit.errors.length === 0, unauthAudit.errors.join('\n'));
check(
  'an unauthenticated gh says on stderr what was skipped',
  unauthAudit.notes.some((n) => n.includes('unauthenticated')),
  unauthAudit.notes.join('\n'),
);

// D2: a token that cannot read what the query asks for is a configuration
// fact, and the only failure whose symptom is a green run that checked
// nothing. `permissions:` in a workflow grants `none` to every scope it does
// not list, and the query reads pull-request data.
const forbidden = caseRepo('- None — every issue shipped.');
const forbiddenAudit = auditWith(forbidden.repo, withFacts({ 1: { state: 'OPEN' } }, { FAKE_GH_FORBIDDEN: '1' }));
check(
  'a token refused the scope the query needs is red, not a note',
  forbiddenAudit.errors.some((e) => /permission/.test(e) && /not a rate limit/.test(e)),
  forbiddenAudit.errors.join('\n'),
);
check(
  'a refused token reports nothing as asked, so a skipped batch cannot read as a clean one',
  forbiddenAudit.asked === 0,
  String(forbiddenAudit.asked),
);

// D3: an indented line continues the bullet above it whatever it opens with.
// `- Deferred:` / `  - #12 ...` is one bullet about the deferral, so #12 is
// mentioned and not claimed — the false-red direction, and the reading
// `docs/closeout/README.md` has always described.
const nested = caseRepo('- Deferred to the next phase:\n  - #2 `feat(y): a thing` — moved, not dropped.');
const nestedAudit = auditWith(nested.repo, withFacts({ 2: { state: 'CLOSED', pr: 22, sha: nested.first } }));
check(
  'a `#N` on an indented sub-bullet is a mention of the bullet above, not a claim of its own',
  nestedAudit.errors.length === 0,
  nestedAudit.errors.join('\n'),
);

// E: the scheduled run that exists so a closeout cannot rot after the close (#381).
// Read defensively: a missing workflow is an assertion red naming the path,
// never an exception out of the process, which the negative control would
// read as the overlay failing to run rather than as this pin failing.
const scheduledPath = join(ROOT, '.github', 'workflows', 'provenance-live.yml');
const scheduled = existsSync(scheduledPath) ? readFileSync(scheduledPath, 'utf8') : '';
check('.github/workflows/provenance-live.yml exists', scheduled !== '', scheduledPath);
check('provenance-live.yml runs on a schedule', /on:\s*[\s\S]*schedule:/.test(scheduled), scheduled.slice(0, 400));
check(
  'provenance-live.yml is off the pull-request path, so it can never gate a merge',
  !/\bpull_request\b/.test(scheduled) && !/\bpush\b/.test(scheduled),
  scheduled.slice(0, 400),
);
check('provenance-live.yml sets the opt-in that runs these checks', scheduled.includes(`${LIVE_GH_ENV}: '1'`), scheduled);
check('provenance-live.yml checks out enough history for the ancestry it needs', /fetch-depth:\s*0/.test(scheduled), scheduled);
check('provenance-live.yml gives the job a token to read issues with', /GH_TOKEN:/.test(scheduled), scheduled);
// The line between this workflow working and this workflow being green and
// empty: an explicit `permissions:` block grants `none` to every scope it does
// not list, and the query reads pull-request data.
check(
  'provenance-live.yml grants the pull-request scope the query needs',
  /^\s*pull-requests:\s*read\s*$/m.test(scheduled),
  scheduled,
);

finish();
