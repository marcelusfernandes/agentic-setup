// How the negative control reads an overlaid run's output: which failures the
// overlay accounts for, and whether the red was structural *because of* the
// overlay. Split out of `ci/negative-control.mts` by #412, which took that
// file to within twelve lines of the 800-line limit while adding ranking to
// both of the functions below.
//
// Pure: nothing here reads a file, spawns a process or looks at the
// environment. That is what invariant 6 names as importable and directly
// testable, and `tests/negative-control-attribution.test.mts` is the test
// that could not be written while these lived behind a module that runs its
// check at import time.
//
// **The one rule both functions obey.** Evidence is *ranked*, never counted.
// A line that merely contains an overlaid path is a mention — a test case
// whose own name quotes a path does that, and this repository writes nineteen
// of them. A line that says which file a failure *belongs to* is an owner: a
// source location (`<file>:12`, a `file://` URL) or a name carrying its own
// non-zero failure count. A mention never outvotes an owner, in either
// direction.
//
// No runtime dependencies (invariant 1); erasable TypeScript only (invariant 2).

// A structural failure (missing module, missing export, syntax error) reads
// as red for the wrong reason: it says the file could not run at all, not
// that an assertion caught the PR's change. See safe-worktree §B7.
export const STRUCTURAL_SIGNATURE = /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|does not provide an export named/;

// --- did anything the overlay placed actually fail? (#354) ----------------

/**
 * A line that reports a failure. Deliberately narrow, and deliberately not
 * the structural signature: `Cannot find module` on a line of its own is a
 * dependency logging and carrying on, which is the noise #214 taught this
 * file to ignore. `[1-9]\d* failed` rather than `failed`, because a per-file
 * summary line saying `0 failed` is a *green* file reporting itself, and
 * reading it as a failure is how any red becomes every file's red.
 */
export const FAILURE_SIGNATURE =
  /\bFAIL(?:ED|URE|URES)?\b|\bCRASHED\b|\bnot ok\b|[✕✗✘×⨯]|Error:|Error \[|\bpanic:|\bTraceback\b|\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b/;

/** The overlaid run's output as diagnostic blocks of lines. */
export const blocks = (output: string): string[][] =>
  output.split(/\n[ \t]*\n/).map((block) => block.split('\n'));

/**
 * The strings that stand for `paths` in a runner's output: the repository
 * path itself and the file's basename, because a runner that spawns one
 * process per test file prints the basename (`land.test.mts: 61 passed, 14
 * failed`) while a stack frame prints the whole path. The path form alone
 * missed nearly every honest red this repository has produced.
 *
 * What the widening costs, stated in full because a narrower claim was made
 * here first and was wrong: this is a substring match, so a same-named file
 * elsewhere in the tree is one way it can credit the overlay wrongly, and a
 * *prose mention* of an overlaid file — a test case whose own name quotes a
 * path, of which this repository has nineteen — is another. Both are
 * answered by ranking the evidence in `attributeFailures` rather than by
 * narrowing the match: a mention alone never outvotes a failure that says
 * which file it belongs to. Both costs are stated here because both are
 * still real — widening the list did not remove either, it moved the answer
 * to the ranking — and because the narrower claim written here first said
 * there was only one.
 *
 * The same widened list is shared with `structuralInOverlay`, and #412
 * gave that function its own ranking for the same reason. It used to read a
 * block naming only a basename beside `Cannot find module` as `structural`
 * where it had read `pass`, which was described here as failing closed; it
 * failed closed onto honest work, and that is what #390 was reported from.
 * A mention no longer decides either verdict.
 */
export const overlayNames = (paths: string[]): string[] => {
  const named = paths.map((p) => p.trim()).filter(Boolean);
  return [...new Set([...named, ...named.map((p) => p.split('/').pop() ?? p)])];
};

/** Whether `line` mentions one of `names` at all. */
export const namesOverlay = (line: string, names: string[]): boolean =>
  names.some((name) => line.includes(name));

/**
 * Whether `line` names one of `names` as a *source location* — `<name>:12`
 * or a `file://` URL — which is the shape a stack frame and a Node error
 * header use to say where a failure happened. It is the one way a failure
 * and the file it happened in may be on different lines and still belong
 * together.
 */
export const locatesOverlay = (line: string, names: string[]): boolean =>
  names.some((name) => {
    const at = line.indexOf(name);
    if (at < 0) return false;
    return /^:\d/.test(line.slice(at + name.length)) || line.slice(0, at).includes('file://');
  });

/**
 * A failure line that says *whose* failure it is: a file-shaped token
 * carrying a non-zero failure count on the same line, which is what a runner
 * that spawns one process per test file prints
 * (`negative-control.test.mts: 34 passed, 1 failed`).
 *
 * Only this shape may be called someone else's red. A bare `FAIL <case
 * name>` names no file at all — a runner prints those under the file it is
 * reporting, several lines from the name — and an aggregate
 * (`2397 passed, 1 failed (node)`) is the whole suite, not a file. Counting
 * either as another file's failure would put a warning on nearly every
 * honest `pass`, naming the overlay's own failures as unrelated, which is
 * worse than no warning at all.
 */
export const FILE_VERDICT = /[\w.-]+\.[A-Za-z0-9]{1,6}\b[^\n]*\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b/;

/**
 * Whether `line` names one of `names` as the *owner* of a non-zero failure
 * count — the name, then a count on the same line after it. That is a runner
 * reporting a file's own result (`land.test.mts: 61 passed, 14 failed`), and
 * with a source location it is one of the two shapes that say which file a
 * failure belongs to rather than merely mentioning one.
 */
export const ownsFailure = (line: string, names: string[]): boolean =>
  names.some((name) => {
    const at = line.indexOf(name);
    if (at < 0) return false;
    return /^[^\n]*\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b/.test(line.slice(at + name.length));
  });

export type Attribution = { owned: boolean; mentioned: boolean; failures: string[]; elsewhere: string[] };

/**
 * Which of the overlaid run's failures the overlay accounts for, ranked by
 * how much the evidence actually says.
 *
 * `owned` is a failure that says which file it belongs to and names an
 * overlaid one: a source location, or a name carrying its own non-zero
 * count. `mentioned` is the weaker thing — a failure line that contains an
 * overlaid path anywhere, which a test case whose *name* quotes a path also
 * does. `failures` is everything that reported a failure and named no
 * overlaid file, in the order the run printed it, for a verdict that has to
 * say what it did see; `elsewhere` is the subset of those that names another
 * file as the owner of a non-zero count.
 *
 * An empty `failures` beside neither `owned` nor `mentioned` means the
 * command failed without reporting any failure at all, which cannot be
 * attributed either — there is nothing to read.
 */
export function attributeFailures(output: string, paths: string[]): Attribution {
  const named = overlayNames(paths);
  let owned = false;
  let mentioned = false;
  const failures: string[] = [];
  const elsewhere: string[] = [];
  for (const lines of blocks(output)) {
    const located = named.length > 0 && lines.some((line) => locatesOverlay(line, named));
    for (const line of lines) {
      if (!FAILURE_SIGNATURE.test(line)) continue;
      if (named.length > 0 && namesOverlay(line, named)) {
        mentioned = true;
        if (located || ownsFailure(line, named)) owned = true;
        continue;
      }
      if (located) {
        owned = true;
        continue;
      }
      failures.push(line.trim());
      if (FILE_VERDICT.test(line)) elsewhere.push(line.trim());
    }
  }
  return { owned, mentioned, failures, elsewhere };
}

// --- was the red structural *because of* the overlay? (#214, #412) --------

/**
 * Whether one diagnostic block blames an overlaid file for a structural
 * failure, as opposed to merely mentioning one near it.
 *
 * Two shapes qualify, and they are the same two `attributeFailures` calls an
 * owner:
 *
 * - the signature line **names** an overlaid path itself —
 *   `Error: Cannot find module '/…/scripts/added.mts'`, which is what a
 *   missing module prints;
 * - some line in the block **locates** an overlaid file as a source position
 *   — `file:///…/src/importer.mts:1`, which is the header a missing export
 *   or a syntax error prints two lines above its `SyntaxError`, naming the
 *   imported module on the signature line and never the file that failed.
 *
 * What is deliberately *not* an owner here, although `ownsFailure` treats it
 * as one: a per-file verdict line (`one.test.mts: 0 passed, 2 failed`). It
 * owns an **assertion** red and says nothing about whether the file loaded.
 * That is the one thing the two rankings disagree about, and it is the whole
 * defect: `tests/run.mts` prints that line and then the child's own output
 * with no blank line between, so a failing case whose *name* quotes
 * `Cannot find module` lands in the same block as it — and the block then
 * carried a signature and named an overlaid file without anything in it
 * blaming that file for anything structural.
 */
const structuralOwner = (lines: string[], named: string[]): boolean =>
  lines.some((line) => STRUCTURAL_SIGNATURE.test(line) && namesOverlay(line, named))
    || (lines.some((line) => STRUCTURAL_SIGNATURE.test(line))
      && lines.some((line) => locatesOverlay(line, named)));

/**
 * Whether the overlaid run failed structurally *because of the overlay*.
 *
 * The output is split into diagnostic blocks — maximal runs of consecutive
 * non-blank lines, which is how a runtime prints one diagnostic: the error
 * header, the offending source line, then its stack frames. A block counts
 * only when something in it owns the signature, in the sense above; `paths`
 * is the overlaid test files plus every file the diff touches.
 *
 * Reading the whole output instead made any structural-looking line anywhere
 * decide the outcome: a dependency that logs `Cannot find module` and carries
 * on prints its line in a block of its own and says nothing about whether the
 * overlaid file could run, yet it flipped an honest assertion red to
 * `structural` (#214). Reading a block as structural on a bare *mention* of
 * an overlaid path was the same mistake one level in, and cost the same way:
 * the run was honest, the verdict was `structural`, and the reporter renamed
 * two of this repository's own test cases to get past it (#390).
 */
export function structuralInOverlay(output: string, paths: string[]): boolean {
  const named = overlayNames(paths);
  if (named.length === 0) return false;
  return blocks(output).some((lines) => structuralOwner(lines, named));
}
