// The proof a branch slug declares, resolved (#164). An issue's `## Proof`
// section is prose; `proof/<slug>.json` is the one file that turns a sentence
// of it into something a script can run, and this module is the reader both
// consumers go through — `scripts/proof.mts` today, `doctor` (#168) next.
//
// **The format itself lives in `ci/lib/proof.mts`.** The declaration's shape,
// its named reasons and the error that carries them are parsed there and
// re-exported here, because `ci/negative-control.mts` reads the same file and
// two parsers meant a branch could declare a proof one reader honoured and the
// other rejected (#297). `scripts/init.mts` copies `ci/` into an adopting
// repository and does not copy `scripts/`, so the shared half has to sit under
// `ci/` — the direction `ci/lib/detect.mts` is already imported in.
//
// What stays here is *resolution*: where the declaration lives in a working
// tree, and what runs when it names no command.
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
import { KNOWN_KEYS, parseDeclaration, ProofError, SLUG_PATTERN } from '../../ci/lib/proof.mts';
import type { Declaration, ProofReason, ProofSource } from '../../ci/lib/proof.mts';
import { PROOF_DIR, readRecord, type AdoptionRecord } from './adopt/record.mts';

// The format, re-exported so this module stays the runner's one import.
export { KNOWN_KEYS, parseDeclaration, ProofError, SLUG_PATTERN };
export type { Declaration, ProofReason, ProofSource };

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
