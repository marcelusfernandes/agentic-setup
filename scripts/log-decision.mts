#!/usr/bin/env node
// log-decision — one dated line per pointed orchestrator decision, appended
// to a single marked comment on the milestone's parent issue (#178).
//
//   node scripts/log-decision.mts <parent> --kind <k> --ref <#N> "<line>"
//
// The orchestrator takes three kinds of decision that change no file and so
// leave no durable trace: granting an `authorised:` glob on a PR
// (`docs/workflow.md`, "authorised: is written only by the orchestrator"),
// spending the one extra round a purely mechanical rejection earns
// (`skills/orchestrate/SKILL.md` step 5), and applying `human:pending`
// (its "Escalate to a person" section). Each used to land in whichever PR
// or issue comment happened to be open at the time. GitHub is this
// repository's durable state by design (`docs/decisions.md` item 7) and the
// orchestrator cannot push to `main`, so the log is not a tracked file: it
// is one comment on the milestone's parent issue, found by its marker and
// appended to — the same marker-and-upsert shape
// `.github/workflows/issue-lint.yml` uses for its own comment.
//
// **Crash policy: fail closed.** Nothing is written unless every check
// passes first. The three local checks (`--kind`, `--ref`, the text) run
// before `gh` is called at all; the parent issue is then read, and only an
// open issue is written to. A `gh` call that fails for any reason other
// than a 404 on the parent — a network error, a rate limit, a token
// problem — is reported as `{ error }` and exits 1 without writing; it is
// never reported as a refusal, because it is not a verdict on the decision.
// A response that does not parse is treated the same way.
//
// Exit 1 with `{ refused, parent, missing }` when the parent issue does not
// exist or is closed (`parent:state`), `--kind` is outside
// `grant|extra-round|human-pending` (`kind:unknown`), `--ref` is not an
// issue or PR number (`ref:format`), or the text is empty (`text:empty`).
// Exit 1 with `{ error }` on a usage problem or a `gh`/filesystem failure.
// Exit 0 with `{ parent, comment, lines }`: the comment id written and how
// many dated lines it now carries.
//
// The text is a record, not an instruction: it is trimmed, its whitespace
// runs collapsed to single spaces so one decision is one line, and it is
// never interpreted. Appending is literal — the existing body is kept
// byte for byte and the new line added after it — so a line a person
// edited or added by hand is never rewritten or dropped.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The closed set of decisions worth a line. */
const KINDS = ['grant', 'extra-round', 'human-pending'];
/** Identifies the log comment on the parent issue; the body starts with it. */
const MARKER = '<!-- agentic-decision-log -->';
/** One logged line: `<UTC ISO-8601> | <kind> | <ref> | <text>`. */
const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \| \S+ \| #\d+ \| \S/;
const USAGE = 'usage: node scripts/log-decision.mts <parent> --kind grant|extra-round|human-pending --ref <#N> "<line>"';

const HEADER = `${MARKER}
### Orchestrator decision log

\`<UTC ISO-8601> | <kind> | <ref> | <text>\` — one line per pointed decision
(\`grant\`, \`extra-round\`, \`human-pending\`), appended by
\`scripts/log-decision.mts\`. The phase's closeout copies these lines into its
record.
`;

function out(shape: Record<string, unknown>, code: number): never {
  console.log(JSON.stringify(shape));
  process.exit(code);
}
function fail(shape: Record<string, unknown>): never {
  out(shape, 1);
}

type Run = { status: number; stdout: string; stderr: string };
const gh = (args: string[]): Run => {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** JSON.parse that answers null instead of throwing, so every caller fails closed the same way. */
function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** gh's own wording when the resource is not there, as opposed to any other failure. */
const isNotFound = (r: Run): boolean => /HTTP 404|Not Found \(HTTP/.test(r.stderr);

type Args = { parent: number; kind: string; ref: string; text: string };

/** Splits argv into the parent, the two flags and the text, or returns null on a usage problem. */
function parseArgs(argv: string[]): Args | null {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind' || a === '--ref') {
      const value = argv[i + 1];
      if (value === undefined) return null;
      flags.set(a.slice(2), value);
      i++;
      continue;
    }
    if (a.startsWith('--')) return null;
    positional.push(a);
  }
  if (positional.length !== 2) return null;
  const parent = Number(positional[0]);
  if (!Number.isInteger(parent) || parent <= 0) return null;
  return { parent, kind: flags.get('kind') ?? '', ref: flags.get('ref') ?? '', text: positional[1] };
}

/** `#12` and `12` both normalise to `#12`; anything else (including `#0`) is null. */
function normaliseRef(ref: string): string | null {
  const m = ref.trim().match(/^#?(\d+)$/);
  if (!m || Number(m[1]) <= 0) return null;
  return `#${Number(m[1])}`;
}

/** One decision is one line: trimmed, with every whitespace run collapsed to a space. */
const normaliseText = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** Writes the comment body to a staging file; returns the failure message, or null on success. */
function stage(path: string, body: string): string | null {
  try {
    writeFileSync(path, body);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args) fail({ error: USAGE });

const ref = normaliseRef(args.ref);
const text = normaliseText(args.text);

const missing: string[] = [];
if (!KINDS.includes(args.kind)) missing.push('kind:unknown');
if (ref === null) missing.push('ref:format');
if (text === '') missing.push('text:empty');
if (missing.length) {
  fail({ refused: `not logged: ${missing.join(', ')}.`, parent: args.parent, missing });
}

// The parent issue, read before anything is written. REST, not
// `gh issue view`, so `state` and the comment ids below come from the same
// API the PATCH expects.
const parentRead = gh(['api', `repos/{owner}/{repo}/issues/${args.parent}`]);
if (parentRead.status !== 0) {
  if (!isNotFound(parentRead)) fail({ error: (parentRead.stderr || parentRead.stdout || 'gh api failed').trim() });
  fail({
    refused: `issue #${args.parent} does not exist.`,
    parent: args.parent,
    missing: ['parent:state'],
  });
}

const parentJson = safeParse<{ state?: unknown }>(parentRead.stdout);
if (!parentJson) fail({ error: `could not parse gh's answer for issue #${args.parent}.` });
const parentState = String(parentJson.state ?? '');
if (parentState !== 'open') {
  fail({
    refused: `issue #${args.parent} is ${parentState || 'in an unknown state'}, not open.`,
    parent: args.parent,
    missing: ['parent:state'],
  });
}

// The existing log comment, if any. The `--jq` filter keeps `--paginate`
// honest: gh concatenates one JSON array per page, which does not parse as
// a whole, so the filter is what reduces the pages to a single object (or
// to nothing at all when no comment carries the marker).
const found = gh([
  'api',
  `repos/{owner}/{repo}/issues/${args.parent}/comments`,
  '--paginate',
  '--jq',
  `[.[] | select(.body | startswith("${MARKER}"))][0] // empty`,
]);
if (found.status !== 0) fail({ error: (found.stderr || found.stdout || 'gh api failed').trim() });

let existing: { id: number; body: string } | null = null;
if (found.stdout.trim()) {
  const parsed = safeParse<{ id?: unknown; body?: unknown }>(found.stdout);
  if (!parsed || !Number.isInteger(parsed.id) || typeof parsed.body !== 'string') {
    fail({ error: `could not read the existing decision-log comment on issue #${args.parent}.` });
  }
  existing = { id: Number(parsed.id), body: parsed.body };
}

const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const line = `${stamp} | ${args.kind} | ${ref} | ${text}`;
// Literal append: the existing body is preserved as it is, the new line
// separated by a blank line so each entry renders as its own paragraph.
const body = existing ? `${existing.body.replace(/\s+$/, '')}\n\n${line}\n` : `${HEADER}\n${line}\n`;

// `-F body=@<file>` rather than an inline value: the body grows with every
// line and carries newlines, which an argument does not survive cleanly.
const dir = mkdtempSync(join(tmpdir(), 'agentic-decision-'));
const bodyFile = join(dir, 'body.md');
const staging = stage(bodyFile, body);
if (staging) {
  rmSync(dir, { recursive: true, force: true });
  fail({ error: `could not stage the comment body: ${staging}` });
}
const written = existing
  ? gh(['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${existing.id}`, '-F', `body=@${bodyFile}`])
  : gh(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${args.parent}/comments`, '-F', `body=@${bodyFile}`]);
rmSync(dir, { recursive: true, force: true });
if (written.status !== 0) fail({ error: (written.stderr || written.stdout || 'gh api failed').trim() });

const writtenId = safeParse<{ id?: unknown }>(written.stdout)?.id;
if (!Number.isInteger(writtenId) && !existing) {
  fail({ error: `could not read the new comment's id on issue #${args.parent}.` });
}
const comment = Number.isInteger(writtenId) ? Number(writtenId) : Number(existing?.id);

const lines = body.split(/\r?\n/).filter((l) => LINE.test(l)).length;
out({ parent: args.parent, comment, lines }, 0);
