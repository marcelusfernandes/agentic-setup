// Minimal glob matching for the scope check. No dependency on purpose: the
// globs an issue declares are simple (`dir/**`, `dir/*.ext`, one exact file).
// Supported: `**` (any number of segments, including none), `*` (anything
// but `/`), `?` (exactly one character other than `/`), everything else
// literal. Paths are POSIX-relative, which is what `git diff --name-only`
// prints on every OS.

const escapeRegExp = (literal: string): string => literal.replace(/[.+^${}()|[\]\\]/g, '\\$&');

export function globToRegExp(glob: string): RegExp {
  const source = glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((piece) => {
      if (piece === '**/') return '(?:.*/)?';
      if (piece === '**') return '.*';
      if (piece === '*') return '[^/]*';
      if (piece === '?') return '[^/]';
      return escapeRegExp(piece);
    })
    .join('');
  return new RegExp(`^${source}$`);
}

export const matchesAny = (file: string, globs: string[]): boolean => globs.some((g) => globToRegExp(g).test(file));
