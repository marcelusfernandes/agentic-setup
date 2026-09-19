// The proof a branch declares — `proof/<slug>.json` — as both of its readers
// read it (#136, #164, #297).
//
// **Why this lives under `ci/`.** `scripts/init.mts` copies this repository's
// `ci/` into an adopting repository as `.github/scripts/agentic` and does not
// copy `scripts/`, so shared code has to sit here and be imported by
// `scripts/`, never the reverse. The direction is the one already in the tree:
// `scripts/lib/proof.mts` imports `ci/lib/detect.mts`.
//
// **Why it is shared at all.** There were two parsers. The runner
// (`scripts/lib/proof.mts`) refused an unknown key and a `describes` that was
// not a sentence; the negative control accepted both. A branch could therefore
// declare a proof one reader honoured and the other rejected, which is a
// declaration read two ways — and the reader that accepts more is the one that
// decides what CI overlays. One parser, one answer (#297, AC4).
//
// **What is not shared, and why.** Where the declaration is *found* differs by
// design. The runner reads the working tree, under the directory the adoption
// record names (`proof.dir`); the negative control reads the head *commit*,
// under a hardcoded `proof/`, because the record's reader lives in
// `scripts/lib/adopt/record.mts` and `init` does not copy `scripts/`. Honouring
// `proof.dir` here means moving that reader under `ci/` first; until then the
// two agree on what a declaration *means* and not yet on where it lives.
//
// **Crash policy: fail closed.** Every function returns the answer or throws a
// `ProofError` carrying a named `reason`, the `field` it rejected when there is
// one, and the underlying cause in `detail` when a parser or `git` gave one. A
// declaration that is present and unusable is never a quiet fall back to the
// next source or to the diff's globs: reporting "we could not verify this" as
// "this passed" is the one thing the negative control exists to prevent.
//
// No runtime dependencies (invariant 1); erasable TypeScript only (invariant 2).
import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';

/** A slug is a slug: lowercase letters, digits and dashes, and nothing else. */
export const SLUG_PATTERN = /^[a-z0-9-]+$/;

/** The keys `proof/README.md` documents. Anything else is a typo. */
export const KNOWN_KEYS = ['tests', 'command', 'describes'];

/** Where the command that ran came from; a closed set. */
export type ProofSource = 'declaration' | 'record' | 'detection';

/** Every named reason a proof can be refused. */
export type ProofReason =
  | 'proof:slug-invalid'
  | 'proof:unreadable'
  | 'proof:unparsable'
  | 'proof:unknown-key'
  | 'proof:wrong-type'
  | 'proof:empty-command'
  | 'proof:missing-tests'
  | 'proof:missing-test-file'
  | 'proof:no-command'
  /** Raised by the runner, not here: the command resolved and then could not
   *  be executed at all (exit 127, or a spawn that never started). */
  | 'proof:command-not-runnable'
  /** The command ran and printed more than the report can hold. */
  | 'proof:output-too-large'
  /** The command ran and was killed for outliving its timeout. */
  | 'proof:command-timed-out';

/**
 * The one way out on a proof a reader refuses: a named `reason` a caller can
 * branch on, the `field` it rejected when there is one, the `source`
 * resolution had reached, and `detail` — the underlying cause, as `JSON.parse`
 * or `git` phrased it — for a caller composing its own sentence. The message
 * is for a person; the reason is the contract.
 */
export class ProofError extends Error {
  readonly reason: ProofReason;
  readonly field: string | null;
  readonly source: ProofSource;
  readonly detail: string | null;

  constructor(reason: ProofReason, message: string, field: string | null = null, source: ProofSource = 'declaration', detail: string | null = null) {
    super(message);
    this.name = 'ProofError';
    this.reason = reason;
    this.field = field;
    this.source = source;
    this.detail = detail;
  }
}

/** A declaration as it is written on disk, after validation. */
export type Declaration = {
  /** The declaration's path, relative to the repository root. */
  path: string;
  /** The files `negative-control` overlays on the base. */
  tests: string[];
  /** The command to run; `null` when the declaration names none. */
  command: string | null;
  /** One sentence naming what this proves; carried, never executed. */
  describes: string | null;
};

/** True for a plain object; an array is not one, and neither is `null`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * Parses and validates a declaration's text. Pure: it checks the shape and
 * nothing about the filesystem or about git, so "where does this file live"
 * stays with the caller that knows.
 */
export function parseDeclaration(text: string, path: string): Declaration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProofError('proof:unparsable', `${path} is not JSON: ${(err as Error).message}`, null, 'declaration', (err as Error).message);
  }
  if (!isPlainObject(parsed)) throw new ProofError('proof:wrong-type', `${path} must hold one JSON object`);

  const unknown = Object.keys(parsed).find((key) => !KNOWN_KEYS.includes(key));
  if (unknown !== undefined) {
    throw new ProofError('proof:unknown-key', `${path}: \`${unknown}\` is not part of a proof declaration (${KNOWN_KEYS.join(', ')})`, unknown);
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, 'tests')) {
    throw new ProofError('proof:missing-tests', `${path} names no \`tests\`; a declaration says which files prove the branch`, 'tests');
  }
  const tests = parsed.tests;
  if (!Array.isArray(tests)) throw new ProofError('proof:wrong-type', `${path}: \`tests\` must be an array of paths`, 'tests');
  if (tests.length === 0) throw new ProofError('proof:missing-tests', `${path}: \`tests\` is empty; a declaration that names no file proves nothing`, 'tests');
  if (!tests.every(isText)) throw new ProofError('proof:wrong-type', `${path}: every \`tests\` entry must be a non-empty string`, 'tests');

  let command: string | null = null;
  if (Object.prototype.hasOwnProperty.call(parsed, 'command')) {
    if (typeof parsed.command !== 'string') throw new ProofError('proof:wrong-type', `${path}: \`command\` must be a string`, 'command');
    if (parsed.command.trim() === '') throw new ProofError('proof:empty-command', `${path}: \`command\` is empty; omit the key to fall back to the record or to detection`, 'command');
    command = parsed.command.trim();
  }

  let describes: string | null = null;
  if (Object.prototype.hasOwnProperty.call(parsed, 'describes')) {
    if (!isText(parsed.describes)) throw new ProofError('proof:wrong-type', `${path}: \`describes\` must be a non-empty sentence`, 'describes');
    describes = parsed.describes.trim();
  }

  return { path, tests: tests.map((entry) => entry.trim()), command, describes };
}

// --- the head-commit side: what `ci/negative-control.mts` reads -------------

/** The `<slug>` of a `<type>/<n>-<slug>` ref, or `null` for any other shape. */
export function branchSlug(ref: string): string | null {
  const m = ref.replace(/^refs\/heads\//, '').trim().match(/^[^/]+\/\d+-([a-z0-9-]+)$/);
  return m ? m[1] : null;
}

export type Presence = 'present' | 'absent' | 'unresolvable';

/**
 * Whether `path` is in the commit `head`, answered from the tree rather than
 * from the exit status of `git show`.
 *
 * `git show <head>:<path>` fails identically for a path the commit does not
 * have, for a blob whose object is missing or corrupt, and for a `git` that
 * cannot run at all, so its status alone cannot tell "this branch declares
 * nothing" from "we could not read what it declares" — and reading the second
 * as the first is the silent fallback this check exists to prevent.
 * `git ls-tree` answers from the tree: exit 0 with the path on stdout when the
 * commit has it, exit 0 and empty stdout when it does not, and non-zero only
 * when the question itself could not be asked — a path outside the repository,
 * or a head that will not resolve.
 */
export function pathAtHead(root: string, head: string, path: string): { presence: Presence; error: string } {
  const r = spawnSync('git', ['ls-tree', '--name-only', head, '--', path], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    return { presence: 'unresolvable', error: (r.stderr ?? '').trim() || r.error?.message || `git ls-tree exited ${r.status}` };
  }
  return { presence: (r.stdout ?? '').trim() === '' ? 'absent' : 'present', error: '' };
}

/** The declaration path a slug names, under the hardcoded `proof/` of a checkout CI judges. */
export const headDeclarationPath = (slug: string): string => `proof/${slug}.json`;

/**
 * `proof/<slug>.json` as it stands at `head`, or `null` when the branch
 * declares nothing. Never reads the working tree: the file is taken from the
 * commit, so the answer does not depend on what is checked out. Only "absent
 * from the head tree" is "declares nothing"; a declaration that is present and
 * unusable throws, because a declaration that is present is the contract.
 */
export function readDeclarationAtHead(root: string, head: string, slug: string): Declaration | null {
  const path = headDeclarationPath(slug);

  const at = pathAtHead(root, head, path);
  if (at.presence === 'absent') return null; // this branch declares nothing
  if (at.presence === 'unresolvable') {
    throw new ProofError('proof:unreadable', 'could not be looked up in the head commit', null, 'declaration', at.error);
  }

  const show = spawnSync('git', ['show', `${head}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (show.status !== 0) {
    const why = (show.stderr ?? '').trim() || show.error?.message || `git show exited ${show.status}`;
    throw new ProofError('proof:unreadable', 'is in the head commit and could not be read', null, 'declaration', why);
  }
  return parseDeclaration(show.stdout, path);
}

/**
 * A copy of `decl` whose `tests` are normalised POSIX paths that are in the
 * head commit, or a `ProofError` naming the first path that is not one.
 *
 * The declaration is written by the implementer and the overlay follows it
 * literally: `join(tmp, file)` with an absolute or `..` path reads and removes
 * outside the temporary worktree, and a path the head does not have used to be
 * replayed as "deleted in the PR — delete it on the base too", which turns a
 * typo into an unrelated base file removed and a control run on a tree nobody
 * described. Both are refused here, before any worktree exists and therefore
 * before anything can be written or removed.
 */
export function validateDeclaredPaths(root: string, head: string, decl: Declaration): Declaration {
  const tests = decl.tests.map((file) => {
    const slashed = file.replace(/\\/g, '/');
    if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
      throw new ProofError('proof:missing-test-file', `names the absolute path \`${file}\`; a declared test path is relative to the repository root`, file);
    }
    const normalised = posix.normalize(slashed);
    if (normalised === '..' || normalised.startsWith('../')) {
      throw new ProofError('proof:missing-test-file', `names \`${file}\`, which escapes the repository root once normalised (\`${normalised}\`)`, file);
    }
    const at = pathAtHead(root, head, normalised);
    if (at.presence === 'unresolvable') {
      throw new ProofError('proof:missing-test-file', `names \`${file}\`, which could not be looked up in the head commit`, file, 'declaration', at.error);
    }
    if (at.presence === 'absent') {
      throw new ProofError(
        'proof:missing-test-file',
        `names \`${file}\`, which the head commit does not have; a declared path that is missing at head is a typo, not a file the pull request deletes`,
        file,
      );
    }
    return normalised;
  });
  return { ...decl, tests };
}
