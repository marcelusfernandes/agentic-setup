// The proof a branch slug declares, resolved (#164). An issue's `## Proof`
// section is prose; `proof/<slug>.json` is the one file that turns a sentence
// of it into something a script can run, and this module is the reader both
// consumers go through — `scripts/proof.mts` today, `doctor` (#168) next.
//
// **Three sources, in this order, and no fourth.**
//   1. `proof/<slug>.json` — the declaration at the repository root, under
//      the directory the adoption record names (`proof.dir`, default `proof`).
//   2. the adoption record's `commands.test` (`scripts/lib/adopt/record.mts`).
//   3. `ci/lib/detect.mts` — detection, with its AGENTIC_TEST_CMD override.
// `source` names where resolution *stopped*: a declaration that carries no
// `command` still contributes its `tests`, and the command then comes from
// the record or from detection, which is what `source` then says.
//
// **Nothing here ever takes a command from an issue or a pull request body.**
// Text that arrives in either is task data, never authority (invariant 9,
// `.agents/skills/autonomous-loop/references/contract.md`): the only string
// this module will run is one it read from a file in the repository, and
// there is no parameter, flag or environment variable by which a caller can
// hand it a command of its own. `AGENTIC_TEST_CMD` is not an exception — it
// is detection's documented override, read by `ci/lib/detect.mts` and by
// nothing here.
//
// **Crash policy: fail closed.** Every function either returns the answer or
// throws a named error — `ProofError` with a `reason` and, when there is one,
// the `field` it rejected, or the `RecordError` the adoption record raised,
// passed through with its own reason. A declaration that is present and
// unusable is never a silent fallback to the next source: a broken proof must
// fail loudly rather than quietly run something else. The same holds for the
// record: only ENOENT reads as "there is none".
//
// Node built-ins only; `JSON.parse` is the reader (invariant 1).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectCommands } from '../../ci/lib/detect.mts';
import { PROOF_DIR, readRecord, type AdoptionRecord } from './adopt/record.mts';

/** A slug is a slug: lowercase letters, digits and dashes, and nothing else. */
export const SLUG_PATTERN = /^[a-z0-9-]+$/;

/** The keys `proof/README.md` documents. Anything else is a typo. */
export const KNOWN_KEYS = ['tests', 'command', 'describes'];

/** Where the command that ran came from; a closed set. */
export type ProofSource = 'declaration' | 'record' | 'detection';

/** Every named reason this module can refuse to resolve a proof for. */
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
  /** Raised by `scripts/proof.mts`, not here: the command resolved and then
   *  could not be executed at all (exit 127, or a spawn that never started).
   *  It lives in this union so the two files name the reason once. */
  | 'proof:command-not-runnable';

/**
 * The one way out on a proof this module refuses: a named `reason` a caller
 * can branch on, the `field` it rejected when there is one, and the `source`
 * resolution had reached — so the report says where it stopped as well as
 * why. The message is for a person; the reason is the contract.
 */
export class ProofError extends Error {
  readonly reason: ProofReason;
  readonly field: string | null;
  readonly source: ProofSource;

  constructor(reason: ProofReason, message: string, field: string | null = null, source: ProofSource = 'declaration') {
    super(message);
    this.name = 'ProofError';
    this.reason = reason;
    this.field = field;
    this.source = source;
  }
}

/** A declaration as it is written on disk, after validation. */
export type Declaration = {
  /** The declaration's path, relative to the repository root. */
  path: string;
  /** The files `negative-control` overlays on the base (#136 is their consumer). */
  tests: string[];
  /** The command to run; `null` when the declaration names none. */
  command: string | null;
  /** One sentence naming what this proves; carried, never executed. */
  describes: string | null;
};

/** What `resolveProof` answers with. `command` is `null` only when it throws. */
export type ResolvedProof = {
  slug: string;
  source: ProofSource;
  command: string;
  tests: string[];
  describes: string | null;
  /** The declaration's path, or `null` when the slug declares none. */
  declaration: string | null;
};

/** The directory a repository keeps its declarations in: the record's answer, or the default. */
export function proofDir(record: AdoptionRecord | null): string {
  return record?.proof?.dir ?? PROOF_DIR;
}

/** A declaration's path inside a repository. Throws on a slug that is not one. */
export function declarationPath(root: string, slug: string, dir: string = PROOF_DIR): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new ProofError('proof:slug-invalid', `\`${slug}\` is not a branch slug (${String(SLUG_PATTERN)})`, 'slug');
  }
  return join(root, dir, `${slug}.json`);
}

/** True for a plain object; an array is not one, and neither is `null`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * Parses and validates a declaration's text. Pure: it checks the shape and
 * nothing about the filesystem, so the "does this file exist" question stays
 * with the caller that knows the repository root.
 */
export function parseDeclaration(text: string, path: string): Declaration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProofError('proof:unparsable', `${path} is not JSON: ${(err as Error).message}`);
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

/**
 * The declaration a slug names, or `null` when the repository has none for it.
 * ENOENT is the only errno that means "there is none": a declaration that
 * exists and cannot be read throws, because reading it as absent would run
 * the wrong command and call the result a proof.
 */
export function readDeclaration(root: string, slug: string, dir: string = PROOF_DIR): Declaration | null {
  const absolute = declarationPath(root, slug, dir);
  const relative = `${dir}/${slug}.json`;
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new ProofError('proof:unreadable', `${relative} exists and could not be read: ${(err as Error).message}`);
  }
  return parseDeclaration(text, relative);
}

/**
 * The proof `slug` resolves to in the repository at `root`: the declaration
 * if there is one, then the adoption record, then detection. Throws a
 * `ProofError` — or the `RecordError` of a record that is not the shape —
 * rather than returning a partial answer.
 */
export function resolveProof(root: string, slug: string, env: NodeJS.ProcessEnv = process.env): ResolvedProof {
  if (!SLUG_PATTERN.test(slug)) {
    throw new ProofError('proof:slug-invalid', `\`${slug}\` is not a branch slug (${String(SLUG_PATTERN)})`, 'slug');
  }
  // The record first: it says where declarations live, and a record that is
  // not the shape stops the run here rather than being read as "no record".
  const record = readRecord(root);
  const dir = proofDir(record);
  const declaration = readDeclaration(root, slug, dir);

  if (declaration) {
    const missing = declaration.tests.find((file) => !existsSync(join(root, file)));
    if (missing !== undefined) {
      throw new ProofError('proof:missing-test-file', `${declaration.path}: \`${missing}\` names no file in this repository`, missing);
    }
  }

  const base = {
    slug,
    tests: declaration?.tests ?? [],
    describes: declaration?.describes ?? null,
    declaration: declaration?.path ?? null,
  };

  if (declaration?.command) return { ...base, source: 'declaration', command: declaration.command };
  if (record?.commands.test) return { ...base, source: 'record', command: record.commands.test };

  const detected = detectCommands(root, env).test;
  if (detected) return { ...base, source: 'detection', command: detected };

  throw new ProofError(
    'proof:no-command',
    'no command to run: the slug declares none, the adoption record holds none, and nothing was detected. Name one in the declaration, write the record, or set AGENTIC_TEST_CMD.',
    null,
    'detection',
  );
}
