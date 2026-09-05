// Minimal glob matching for the scope check. No dependency on purpose: the
// globs an issue declares are simple (`dir/**`, `dir/*.ext`, one exact file).
// Supported: `**` (any number of segments, including none), `*` (anything
// but `/`), everything else literal. Paths are POSIX-relative, which is what
// `git diff --name-only` prints on every OS.

/** @param {string} literal */
const escapeRegExp = (literal) => literal.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** @param {string} glob */
export function globToRegExp(glob) {
  const source = glob
    .split(/(\*\*\/|\*\*|\*)/)
    .map((piece) => {
      if (piece === '**/') return '(?:.*/)?';
      if (piece === '**') return '.*';
      if (piece === '*') return '[^/]*';
      return escapeRegExp(piece);
    })
    .join('');
  return new RegExp(`^${source}$`);
}

/** @param {string} file @param {string[]} globs */
export const matchesAny = (file, globs) => globs.some((g) => globToRegExp(g).test(file));
