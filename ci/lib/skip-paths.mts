// The documentation path classes, in one place, read by both gates that ask
// a question about them (#412, from #370).
//
// **Why the list is shared and the carve-outs are not.** `ci/negative-control.mts`
// asks "does this diff owe a failing test"; `scripts/land.mts` asks "may this
// diff merge unreviewed". The *classes* are the same answer to both — a
// Markdown file has no unit test to fail and nothing for a reviewer to break —
// so they lived as two literal copies held together by a drift pin in
// `tests/land.test.mts`, which is a pin guarding a duplication rather than a
// rule. The two **carve-outs** are genuinely different lists and stay where
// they are: `NEVER_SKIP_GLOBS` in the check is the gate's own installed code,
// and `NEVER_DOCS_GLOBS` in `land.mts` narrows that by `.github/workflows/**`
// and `templates/.github/workflows/**`, because those *define* the required
// checks `land.mts` gates on. A list that is the same answer is shared; a list
// that is a different answer is not.
//
// **Why it lives under `ci/`.** `scripts/init.mts` copies this repository's
// `ci/` into an adopting repository as `.github/scripts/agentic` and does not
// copy `scripts/`, so shared code sits here and is imported by `scripts/`,
// never the reverse — the direction `scripts/lib/proof.mts` already takes with
// `ci/lib/detect.mts`, and `scripts/land.mts` with `ci/lib/globs.mts`.
//
// It is a module of its own rather than an export of `ci/negative-control.mts`
// because that file runs its check at import time (`parseArgs(process.argv)`
// at top level), so nothing may import a constant out of it. Moving the list
// here makes it importable without moving that execution: the check keeps its
// top-level run, and the thing anyone wanted from it is no longer behind it.
//
// No runtime dependencies (invariant 1); erasable TypeScript only (invariant 2).

/**
 * The classes a pull request may sit entirely inside without owing a failing
 * test, and — minus each gate's own carve-out — without owing a review.
 *
 * Markdown is a class wherever it lives: `*` never crosses a `/`, so `*.md`
 * alone covered the root only and a pull request touching nothing but
 * `skills/x/SKILL.md` or `agents/y.md` failed as `no-tests` although there was
 * nothing to test. The root form is kept alongside the recursive one, which is
 * why the list below carries both: it is read by people as well as by
 * `matchesAny`. (The recursive glob is not written out here — its two stars
 * and slash would close this comment.) `.claude` is session configuration,
 * which no test covers either.
 *
 * `tests/land.test.mts` pins this list by writing it out itself (invariant 10)
 * and asserts that neither gate declares a second copy.
 */
export const SKIP_PATH_GLOBS = ['docs/**', '.github/**', 'templates/**', '.claude/**', '*.md', '**/*.md'];
