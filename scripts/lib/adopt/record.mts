// The adoption record: the one file that says what an adopting repository
// decided, so the generated workflows (#165), the hooks (#166), the proof
// runner (#164) and `doctor` (#168) read one answer instead of detecting
// four times (`docs/decisions.md` item 15).
//
// It is `agentic.config.json` at the adopted repository's root, and this
// file is the only thing that produces it: `writeRecord` is the single
// writer, `scripts/adopt.mts --record` its single caller. No person edits
// it — and because someone eventually will, nothing here trusts it.
// `readRecord` validates every key and every type and throws a named
// `RecordError`; an unknown key, a missing required field or a wrong type
// is never a silent default.
//
// **The record pins, it does not replace.** Detection remains the default:
// `ci/lib/detect.mts` still runs on every read, and `staleFields` names
// every field where the two now disagree so the file cannot quietly outlive
// the repository it describes.
//
// **It copies nothing that already has an owner.** `checks` comes from the
// default branch's effective ruleset as the inventory read it, `hooks` from
// the hooks the inventory found installed, and `labels.source` is a
// *pointer* to where the label vocabulary lives, not a copy of it — the
// review of #193 noted that `SEEDED_LABELS` and `OWNED_WORKFLOWS` already
// restate `scripts/init.mts`, and this file deliberately adds no third
// restatement.
//
// **Crash policy: fail closed.** Every function here either returns the
// answer or throws a `RecordError` carrying a named `reason`; none of them
// returns a partial or defaulted record. Only ENOENT — the file genuinely is
// not there — reads as absent (`readRecord` returns `null`); every other
// errno, and every shape problem, throws. The recovery from a record this
// file rejects is to delete it, or to rewrite it with `--record --force`
// when only its `generatedBy` is wrong.
//
// Node built-ins only; `JSON.parse` is the reader, since there is no YAML
// reader among them (invariant 1).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The record's name, at the adopted repository's root. One per repository. */
export const RECORD_FILE = 'agentic.config.json';

/** The shape's version. A reader that does not know it refuses the file. */
export const RECORD_VERSION = 1;

/** The only value of `generatedBy` this tool will overwrite without `--force`. */
export const GENERATED_BY = 'agentic-setup/adopt';

/**
 * Where a branch slug declares its proof (`proof/<slug>.json`, #164). Recorded
 * rather than assumed, so the proof runner reads one answer.
 */
export const PROOF_DIR = 'proof';

/**
 * Where the label vocabulary this setup seeds is defined today. A pointer,
 * never a copy: the record names the file so `doctor` can say which
 * dictionary a record was generated from, and it moves to `labels.json` when
 * #145 makes that the one source.
 */
export const LABELS_SOURCE = 'scripts/init.mts';

export type AdoptionRecord = {
  /** The shape's version; `RECORD_VERSION` when this tool wrote it. */
  version: number;
  /** `ci/lib/detect.mts`'s stack at the moment of writing. */
  stack: string;
  /** The commands the loop runs. `null` means none was detected or overridden. */
  commands: { test: string | null; check: string | null };
  /** The status checks the merge gate requires on the default branch. */
  checks: string[];
  /** The hooks of this setup that are installed and carry its marker. */
  hooks: string[];
  /** Where a branch slug declares its proof. */
  proof: { dir: string };
  /** Where the label vocabulary is defined; a pointer, not a copy. */
  labels: { source: string };
  /** When this file was generated, ISO 8601. */
  generatedAt: string;
  /** What generated it. Not `GENERATED_BY` means a person touched it. */
  generatedBy: string;
};

/** Every named reason this file can refuse a record for. */
export type RecordReason =
  | 'record:unreadable'
  | 'record:unparsable'
  | 'record:unknown-key'
  | 'record:missing-field'
  | 'record:wrong-type'
  | 'record:unknown-version';

/**
 * The one way out on a bad record: a named `reason` a caller can branch on,
 * and the dotted path of the offending `field` when there is one. The
 * message is for a person; the reason is the contract.
 */
export class RecordError extends Error {
  readonly reason: RecordReason;
  readonly field: string | null;

  constructor(reason: RecordReason, message: string, field: string | null = null) {
    super(message);
    this.name = 'RecordError';
    this.reason = reason;
    this.field = field;
  }
}

/** The record's path inside a repository. */
export function recordPath(root: string): string {
  return join(root, RECORD_FILE);
}

type Scalar = 'string' | 'number';
type FieldSpec =
  | { kind: 'scalar'; type: Scalar }
  /** A string that may be `null`, which is how "nothing was detected" is recorded. */
  | { kind: 'nullable-string' }
  | { kind: 'string-array' }
  | { kind: 'object'; fields: Record<string, FieldSpec> };

/**
 * The shape, as data. Validation walks this table rather than a chain of
 * `if`s, so a field added to `AdoptionRecord` without a rule here is caught
 * by `tsc` and a key absent from the table is an unknown key at runtime.
 */
const SHAPE: Record<keyof AdoptionRecord, FieldSpec> = {
  version: { kind: 'scalar', type: 'number' },
  stack: { kind: 'scalar', type: 'string' },
  commands: { kind: 'object', fields: { test: { kind: 'nullable-string' }, check: { kind: 'nullable-string' } } },
  checks: { kind: 'string-array' },
  hooks: { kind: 'string-array' },
  proof: { kind: 'object', fields: { dir: { kind: 'scalar', type: 'string' } } },
  labels: { kind: 'object', fields: { source: { kind: 'scalar', type: 'string' } } },
  generatedAt: { kind: 'scalar', type: 'string' },
  generatedBy: { kind: 'scalar', type: 'string' },
};

/** True for a plain object; an array is not one, and neither is `null`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const at = (prefix: string, key: string): string => (prefix ? `${prefix}.${key}` : key);

/** Checks one value against one rule; throws with the dotted field path. */
function validateField(value: unknown, spec: FieldSpec, path: string): void {
  switch (spec.kind) {
    case 'scalar':
      if (typeof value !== spec.type) throw new RecordError('record:wrong-type', `${path} must be a ${spec.type}`, path);
      return;
    case 'nullable-string':
      if (value !== null && typeof value !== 'string') throw new RecordError('record:wrong-type', `${path} must be a string or null`, path);
      return;
    case 'string-array':
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new RecordError('record:wrong-type', `${path} must be an array of strings`, path);
      }
      return;
    case 'object':
      if (!isPlainObject(value)) throw new RecordError('record:wrong-type', `${path} must be an object`, path);
      validateObject(value, spec.fields, path);
      return;
  }
}

/** Every key of `fields` present and well typed, and no key outside them. */
function validateObject(value: Record<string, unknown>, fields: Record<string, FieldSpec>, prefix: string): void {
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new RecordError('record:unknown-key', `${at(prefix, key)} is not part of the adoption record`, at(prefix, key));
    }
  }
  for (const [key, spec] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new RecordError('record:missing-field', `${at(prefix, key)} is missing`, at(prefix, key));
    }
    validateField(value[key], spec, at(prefix, key));
  }
}

/**
 * Parses and validates the record's text. The only entry point that turns
 * bytes into an `AdoptionRecord`; every rejection is a `RecordError`.
 */
export function parseRecord(text: string): AdoptionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RecordError('record:unparsable', `${RECORD_FILE} is not JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new RecordError('record:wrong-type', `${RECORD_FILE} must hold one JSON object`);
  validateObject(parsed, SHAPE, '');
  // The shape is checked before the version, so a file that is not a record
  // at all is reported as what it is rather than as a version problem. A
  // version this reader does not know is refused rather than guessed at:
  // reading a future shape with today's rules is exactly the silent default
  // this file exists to prevent.
  if (parsed.version !== RECORD_VERSION) {
    throw new RecordError(
      'record:unknown-version',
      `${RECORD_FILE} is version ${String(parsed.version)}; this reader knows version ${RECORD_VERSION}`,
      'version',
    );
  }
  return parsed as unknown as AdoptionRecord;
}

/**
 * The record at `root`, or `null` when there is none. ENOENT is the only
 * errno that means "there is none": a record that exists and cannot be read
 * throws, because reporting it as absent would send adoption to write over
 * a file it was never allowed to look at.
 */
export function readRecord(root: string): AdoptionRecord | null {
  let text: string;
  try {
    text = readFileSync(recordPath(root), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new RecordError('record:unreadable', `${RECORD_FILE} exists and could not be read: ${(err as Error).message}`);
  }
  return parseRecord(text);
}

/** What `buildRecord` needs from the inventory; a subset of `Inventory`. */
export type RecordSource = {
  stack: string;
  test: string | null;
  check: string | null;
  ruleset: { requiredStatusChecks: string[] } | null;
  hooks: string[];
};

/**
 * The record an inventory implies. Every field is a derivation of what the
 * inventory read; nothing here detects anything of its own.
 */
export function buildRecord(source: RecordSource, now: Date = new Date()): AdoptionRecord {
  return {
    version: RECORD_VERSION,
    stack: source.stack,
    commands: { test: source.test, check: source.check },
    checks: [...(source.ruleset?.requiredStatusChecks ?? [])].sort(),
    hooks: [...source.hooks].sort(),
    proof: { dir: PROOF_DIR },
    labels: { source: LABELS_SOURCE },
    generatedAt: now.toISOString(),
    generatedBy: GENERATED_BY,
  };
}

/** One field that differs between two records, by its dotted path. */
export type Change = { field: string; from: unknown; to: unknown };

/**
 * Fields that are not compared: `generatedAt` moves on every write by
 * definition, so reporting it as a change would drown the real ones.
 */
const NOT_A_CHANGE = new Set<string>(['generatedAt']);

/** Compares two values structurally; the record holds only JSON scalars and arrays. */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Every field where `after` differs from `before`, by dotted path, in the
 * order `SHAPE` declares them — a nested object is descended into rather
 * than compared whole, so a change is reported as `commands.test` and never
 * as `commands`. `generatedAt` is excluded (`NOT_A_CHANGE`).
 */
export function diffRecords(before: AdoptionRecord, after: AdoptionRecord): Change[] {
  const changes: Change[] = [];
  const walk = (a: Record<string, unknown>, b: Record<string, unknown>, fields: Record<string, FieldSpec>, prefix: string): void => {
    for (const [key, spec] of Object.entries(fields)) {
      const path = at(prefix, key);
      if (NOT_A_CHANGE.has(path)) continue;
      if (spec.kind === 'object') {
        walk(a[key] as Record<string, unknown>, b[key] as Record<string, unknown>, spec.fields, path);
        continue;
      }
      if (!same(a[key], b[key])) changes.push({ field: path, from: a[key] ?? null, to: b[key] ?? null });
    }
  };
  walk(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, SHAPE, '');
  return changes;
}

/**
 * The fields where a record and what detection says today disagree. Only the
 * detected fields are compared: `checks` and `hooks` describe GitHub and the
 * filesystem, which the inventory reports directly, and pinning them is the
 * record's job rather than a disagreement.
 */
export function staleFields(record: AdoptionRecord, detected: { stack: string; test: string | null; check: string | null }): string[] {
  const stale: string[] = [];
  if (record.stack !== detected.stack) stale.push('stack');
  if (record.commands.test !== detected.test) stale.push('commands.test');
  if (record.commands.check !== detected.check) stale.push('commands.check');
  return stale;
}

/**
 * Writes the record. The only function that produces the file — `adopt` is
 * its only caller, and the trailing newline keeps it a well-formed text file.
 */
export function writeRecord(root: string, record: AdoptionRecord): string {
  const path = recordPath(root);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}
