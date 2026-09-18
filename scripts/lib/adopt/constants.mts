// The constants `scripts/init.mts`, `scripts/lib/adopt/inventory.mts` and
// `scripts/lib/adopt/hooks.mts` all need, defined once (#302).
//
// Each of those three used to carry its own copy — the hook marker as a
// literal in two of them and as a regex in the third, the superseded deny
// rules as two identical tables — under a comment asking that the copies be
// moved together. A comment is not a mechanism: nothing failed when one of
// them moved and the others did not, which is exactly the shape of defect the
// deny table exists to fix. This module is the mechanism.
//
// **Crash policy: none of its own.** It holds values and no behaviour: there
// is nothing here to read, spawn or parse, so there is nothing here to fail.
// The files that import it keep their own policies.
//
// Node built-ins only; it imports nothing at all.

/**
 * The text every hook this setup installs carries, and the whole ownership
 * test. A `pre-push` without it was written by a person and is never replaced:
 * `scripts/lib/adopt/hooks.mts` plans around it, `scripts/init.mts` tests for
 * it before overwriting, and `scripts/lib/adopt/inventory.mts` counts a hook
 * as installed only when it carries it.
 */
export const HOOK_MARKER = 'agentic-setup';

/**
 * The git hooks this setup installs into an adopted repository — the set the
 * inventory looks for and the set an adoption record intends. One entry today;
 * it is a list because the shape is "the hooks", not "the hook".
 */
export const GIT_HOOKS = ['pre-push'];

/**
 * Every deny rule this installer has ever seeded, keyed by the wording it was
 * written as and answering with the wording it is written as today (#204,
 * #242). A rule this map knows is replaced, not kept beside its successor; a
 * rule it does not know is the adopter's own and is left exactly as it is.
 */
export const SUPERSEDED_DENY_RULES: Record<string, string> = {
  'Bash(gh pr merge *--admin*)': 'Bash(gh pr merge *)',
};
