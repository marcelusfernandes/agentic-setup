#!/usr/bin/env node
// Cases for the hooks an adopted repository gets (#166):
// `scripts/lib/adopt/hooks.mts` turns the adoption record's `hooks[]` into a
// plan of files, and `scripts/adopt.mts --hooks` is the only thing that
// executes it.
//
// Two kinds of case, deliberately, the same split as
// `tests/adopt-workflows.test.mts`:
//  - the **writes** are proved by spawning the real script (CLAUDE.md
//    invariant 6) against throwaway git repositories, with a small fake `gh`
//    first on PATH for the three reads `takeInventory` makes;
//  - the **plan** is asked for by the acceptance criterion as a value that is
//    returned *without writing*, which no amount of spawning can observe. So
//    that one module is imported, and the shipped hook set it resolves is
//    re-derived here, by a second implementation reading `hooks/hooks.json`,
//    and compared with the one the module answers.
//
// The record's shape, the marker's text, the deny rules and the reason names
// are written out as literals below. They are the contract the script is held
// to, and importing them from the module that produces them would let both
// sides move together without a case noticing.
//
// The two fixtures write `agentic.config.json` by hand. That is deliberate and
// it is the only way these cases can exist: `buildRecord` fills `hooks[]` from
// the hooks the inventory found *installed*, so `--record` on a repository
// carrying a foreign `pre-push` writes `hooks: []`, and no run of `--record`
// can ever produce the record naming a hook that does not exist that the third
// acceptance criterion asks for.
//
// Negative control: on the base `scripts/lib/adopt/hooks.mts` does not exist,
// so the import below answers `null` and every plan case fails on its own
// assertion; `--hooks` is not a flag there either, so every spawn exits 1 on
// usage and nothing is ever installed.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, git, tempRepo, RUNTIME, ROOT } from './lib/harness.mts';

/** The git hook this setup installs, as `docs/adopt.md` names it. */
const GIT_HOOK = 'pre-push';

/** Where the git hook lands inside a throwaway repository. */
const PRE_PUSH = '.git/hooks/pre-push';

/** The permission file the deny list is merged into, and the entry that owns it. */
const SETTINGS = '.claude/settings.json';
const DENY_ENTRY = 'deny-list';

/** The text a hook of this setup carries, as `scripts/lib/adopt/inventory.mts` reads it. */
const MARKER = 'agentic-setup';

/** The record's name, at the adopted repository's root. */
const RECORD_FILE = 'agentic.config.json';

/** One deny rule of the shipped set, and the superseded wording #242 replaces. */
const SHIPPED_DENY = 'Bash(gh pr merge *)';
const SUPERSEDED_DENY = 'Bash(gh pr merge *--admin*)';

/** A deny rule no version of this installer ever seeded; the adopter's own. */
const CUSTOM_DENY = 'Bash(terraform apply *)';

// --- the module under test, imported rather than spawned --------------------
type DenyMerge = { added: string[]; preserved: string[]; replaced: Array<{ from: string; to: string }> };
type PlanEntry = {
  hook: string;
  path: string;
  action: 'create' | 'update' | 'skip';
  reason: string;
  content: string | null;
  mode: number | null;
  deny: DenyMerge | null;
};
type Plan = { entries: PlanEntry[] };
type Shipped = { prePush: string; deny: string[]; events: string[]; names: string[] };
type Module = {
  MARKER: string;
  GIT_HOOK: string;
  SETTINGS_FILE: string;
  DENY_ENTRY: string;
  readShipped: (dir?: string) => Shipped;
  planHooks: (record: unknown, options: { root: string; hooksDir: string; shipped?: Shipped }) => Plan;
  isOurs: (text: string) => boolean;
};

let mod: Module | null = null;
try {
  mod = (await import('../scripts/lib/adopt/hooks.mts')) as unknown as Module;
} catch {
  mod = null;
}

check('scripts/lib/adopt/hooks.mts exists and exports planHooks', typeof mod?.planHooks === 'function');
check('it exports the shipped-set reader and the ownership test', typeof mod?.readShipped === 'function' && typeof mod?.isOurs === 'function');
check('it exports the marker a hook of this setup carries', mod?.MARKER === MARKER, String(mod?.MARKER));
check('it names the git hook and the permission file it installs', mod?.GIT_HOOK === GIT_HOOK && mod?.SETTINGS_FILE === SETTINGS, `${mod?.GIT_HOOK} | ${mod?.SETTINGS_FILE}`);

// --- a fake `gh` -------------------------------------------------------------
const FAKE_GH = `#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  "api repos/{owner}/{repo}")
    echo '{"default_branch":"main","allow_auto_merge":true,"delete_branch_on_merge":false}'
    ;;
  "api repos/{owner}/{repo}/rules/branches/main")
    echo '[{"type":"pull_request","parameters":{"required_approving_review_count":1}}]'
    ;;
  "label list")
    echo '[]'
    ;;
  *)
    echo "fake-gh: unknown command: $*" >&2
    exit 1
    ;;
esac
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-hooks-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// This repository dogfoods itself, so the shell running the suite may have the
// detection overrides set for real.
const { AGENTIC_TEST_CMD: _t, AGENTIC_CHECK_CMD: _c, ...BASE_ENV } = process.env;

function adopt(args: string[], cwd: string) {
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'adopt.mts'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...BASE_ENV, PATH: PATH_WITH_FAKE_GH },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function parse(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** An adoption record as `scripts/lib/adopt/record.mts` writes one, as a literal. */
const recordOf = (hooks: string[]): string =>
  `${JSON.stringify(
    {
      version: 1,
      stack: 'node',
      commands: { test: 'node t.mjs', check: 'tsc' },
      checks: [],
      hooks,
      proof: { dir: 'proof' },
      labels: { source: 'scripts/init.mts' },
      generatedAt: '2026-01-01T00:00:00.000Z',
      generatedBy: 'agentic-setup/adopt',
    },
    null,
    2,
  )}\n`;

/** A committed throwaway repository; `files` land in the initial commit. */
function fixture(files: Record<string, string>): string {
  const dir = tempRepo();
  commit(dir, { 'README.md': '# fixture\n', 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node t.mjs', check: 'tsc' } }), ...files }, 'initial');
  return dir;
}

/** `.claude/settings.json` as an adopter who has their own rules would have it. */
const settingsWith = (deny: string[]): string => `${JSON.stringify({ permissions: { deny } }, null, 2)}\n`;

/** The deny list of a repository's settings file, or `[]`. */
function denyOf(dir: string): string[] {
  try {
    return JSON.parse(read(join(dir, SETTINGS))).permissions?.deny ?? [];
  } catch {
    return [];
  }
}

/** A file's text, or '' when it is not there — a case must fail, never crash. */
function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The entry of an executed plan for one hook, or undefined. */
const entryFor = (out: any, hook: string): any => (Array.isArray(out?.hooks) ? out.hooks.find((h: any) => h?.hook === hook) : undefined);

// --- A: the shipped set, re-derived here ------------------------------------
// A second implementation of "what this repository ships": the git hook, plus
// every event hook `hooks/hooks.json` registers, by the basename of the script
// its command runs. The module walks the same file; this walks it with a
// regex, so the two cannot drift together.
const manifest = readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8');
const eventNames = [...new Set([...manifest.matchAll(/hooks\/([A-Za-z0-9_-]+)\.mts/g)].map((m) => m[1]))].sort();
check('the manifest this case reads registers the event hooks', eventNames.length >= 4, eventNames.join(','));

/** The shipped set, or a null-ish stand-in when the module is not there. */
function shipped(): Shipped | null {
  if (!mod) return null;
  try {
    return mod.readShipped();
  } catch {
    return null;
  }
}

const set = shipped();
check('readShipped names the git hook and every hook the manifest registers', set !== null && [GIT_HOOK, ...eventNames].every((name) => set.names.includes(name)), (set?.names ?? []).join(','));
check('readShipped names nothing beyond them', (set?.names ?? []).length === eventNames.length + 1, (set?.names ?? []).join(','));
check('readShipped carries the shipped pre-push, marker and all', (set?.prePush ?? '').includes(MARKER) && (set?.prePush ?? '') === readFileSync(join(ROOT, 'hooks', 'git-pre-push'), 'utf8'), String((set?.prePush ?? '').length));
check('readShipped carries the deny list this setup seeds', (set?.deny ?? []).includes(SHIPPED_DENY), (set?.deny ?? []).join(' | '));
check('isOurs recognises the shipped hook and refuses a stranger', mod?.isOurs(set?.prePush ?? '') === true && mod?.isOurs('#!/bin/sh\nexit 0\n') === false, `${mod?.isOurs(set?.prePush ?? '')} ${mod?.isOurs('#!/bin/sh\nexit 0\n')}`);

// --- B: planning writes nothing ---------------------------------------------
const planned = fixture({ [RECORD_FILE]: recordOf([GIT_HOOK]) });
const beforePlan = git(['status', '--porcelain'], planned);
const hooksDir = join(planned, '.git', 'hooks');

/** Calls the planner, answering `null` when the module or the call is not there. */
function plan(record: unknown, root: string, dir: string): Plan | null {
  if (!mod) return null;
  try {
    return mod.planHooks(record, { root, hooksDir: dir });
  } catch {
    return null;
  }
}

/** The reason a refused plan carries, and the field it rejected. */
function planFailure(record: unknown, root: string, dir: string): { reason: string; field: string } {
  if (!mod) return { reason: '', field: '' };
  try {
    mod.planHooks(record, { root, hooksDir: dir });
    return { reason: '', field: '' };
  } catch (err) {
    return { reason: String((err as { reason?: unknown })?.reason ?? ''), field: String((err as { field?: unknown })?.field ?? '') };
  }
}

const recordValue = JSON.parse(recordOf([GIT_HOOK]));
const firstPlan = plan(recordValue, planned, hooksDir);
check('planHooks returns a plan of paths and actions', Array.isArray(firstPlan?.entries) && (firstPlan?.entries ?? []).length > 0, JSON.stringify(firstPlan?.entries?.map((e) => e.path)));
check(
  'every plan entry carries a path, an action and a reason',
  (firstPlan?.entries ?? []).every((e) => typeof e.path === 'string' && ['create', 'update', 'skip'].includes(e.action) && typeof e.reason === 'string' && e.reason.length > 0),
  JSON.stringify(firstPlan?.entries),
);
check('the plan covers the git hook and the permission file', (firstPlan?.entries ?? []).some((e) => e.hook === GIT_HOOK) && (firstPlan?.entries ?? []).some((e) => e.hook === DENY_ENTRY), (firstPlan?.entries ?? []).map((e) => e.hook).join(','));
check(
  'a hook the record does not name is reported rather than dropped',
  eventNames.every((name) => (firstPlan?.entries ?? []).some((e) => e.hook === name && e.action === 'skip')),
  (firstPlan?.entries ?? []).map((e) => `${e.hook}:${e.action}:${e.reason}`).join(' | '),
);
check('planHooks writes nothing of its own', git(['status', '--porcelain'], planned) === beforePlan, git(['status', '--porcelain'], planned));
check('planHooks creates no hook file of its own', !existsSync(join(hooksDir, GIT_HOOK)) || readFileSync(join(hooksDir, GIT_HOOK), 'utf8') !== (set?.prePush ?? ''), PRE_PUSH);

// --- C: an unknown name is a named error, and installs nothing --------------
const unknown = planFailure(JSON.parse(recordOf(['pre-commit'])), planned, hooksDir);
check('a record naming a hook this setup does not ship is refused by name', unknown.reason === 'hooks:unknown-hook', `${unknown.reason} ${unknown.field}`);
check('the refusal names the hook it rejected', unknown.field === 'pre-commit', unknown.field);

const strange = fixture({ [RECORD_FILE]: recordOf(['pre-commit']) });
const c = adopt(['--hooks'], strange);
const cOut = parse(c.stdout);
check('--hooks over a record naming an unknown hook exits 1', c.status === 1 && cOut !== null, `${c.stdout}\n${c.stderr}`);
check('--hooks over a record naming an unknown hook errors by name', cOut?.error === 'hooks:unknown-hook' && cOut?.field === 'pre-commit', c.stdout);
check('--hooks over a record naming an unknown hook installs nothing', !existsSync(join(strange, '.git', 'hooks', GIT_HOOK)) && !existsSync(join(strange, SETTINGS)), git(['status', '--porcelain'], strange));

// --- D: the foreign pre-push and the adopter's own deny rule survive --------
const FOREIGN = '#!/bin/sh\n# our own pre-push, written by a person\nexec ./scripts/lint.sh\n';
const guarded = fixture({ [RECORD_FILE]: recordOf([GIT_HOOK]), [SETTINGS]: settingsWith([CUSTOM_DENY, SUPERSEDED_DENY]) });
mkdirSync(join(guarded, '.git', 'hooks'), { recursive: true });
writeFileSync(join(guarded, PRE_PUSH), FOREIGN);
chmodSync(join(guarded, PRE_PUSH), 0o755);

const d = adopt(['--hooks'], guarded);
const dOut = parse(d.stdout);
check('--hooks over a foreign pre-push exits 0', d.status === 0 && dOut !== null, `${d.stdout}\n${d.stderr}`);
check('--hooks reports one outcome per hook of the shipped set', Array.isArray(dOut?.hooks) && dOut.hooks.length === eventNames.length + 2, d.stdout);
check(
  'a pre-push this tool did not write is skipped, with the reason',
  entryFor(dOut, GIT_HOOK)?.outcome === 'skipped' && entryFor(dOut, GIT_HOOK)?.reason === 'not-ours',
  JSON.stringify(entryFor(dOut, GIT_HOOK)),
);
check('a pre-push this tool did not write is left byte-identical', read(join(guarded, PRE_PUSH)) === FOREIGN, read(join(guarded, PRE_PUSH)));
check('the skipped pre-push names the file it did not touch', entryFor(dOut, GIT_HOOK)?.file === PRE_PUSH, JSON.stringify(entryFor(dOut, GIT_HOOK)));

const denyEntry = entryFor(dOut, DENY_ENTRY);
check('the deny list is merged into the settings file', denyEntry?.outcome === 'updated' && denyEntry?.reason === 'merged', JSON.stringify(denyEntry));
check("the adopter's own deny rule survives the merge", denyOf(guarded).includes(CUSTOM_DENY), denyOf(guarded).join(' | '));
check("the adopter's own deny rule is reported as preserved", Array.isArray(denyEntry?.deny?.preserved) && denyEntry.deny.preserved.includes(CUSTOM_DENY), JSON.stringify(denyEntry?.deny));
check('the rules this setup seeds are added and reported', Array.isArray(denyEntry?.deny?.added) && denyEntry.deny.added.includes(SHIPPED_DENY) && denyOf(guarded).includes(SHIPPED_DENY), JSON.stringify(denyEntry?.deny));
check(
  'a superseded rule is replaced rather than left beside its successor',
  !denyOf(guarded).includes(SUPERSEDED_DENY) && Array.isArray(denyEntry?.deny?.replaced) && denyEntry.deny.replaced.some((r: any) => r?.from === SUPERSEDED_DENY && r?.to === SHIPPED_DENY),
  denyOf(guarded).join(' | '),
);
check(
  '--hooks touched the settings file and nothing else in the tree',
  git(['status', '--porcelain'], guarded)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.trim().split(/\s+/).slice(1).join(' '))
    .join(',') === SETTINGS,
  git(['status', '--porcelain'], guarded),
);

// --- E: a clean repository gets the hook, and a second run is a no-op -------
const clean = fixture({ [RECORD_FILE]: recordOf([GIT_HOOK]), [SETTINGS]: settingsWith([CUSTOM_DENY]) });
const e = adopt(['--hooks'], clean);
const eOut = parse(e.stdout);
check('--hooks over a clean repository exits 0', e.status === 0 && eOut !== null, `${e.stdout}\n${e.stderr}`);
check('--hooks creates the pre-push hook the record names', entryFor(eOut, GIT_HOOK)?.outcome === 'created' && entryFor(eOut, GIT_HOOK)?.reason === 'absent', JSON.stringify(entryFor(eOut, GIT_HOOK)));
check('the installed pre-push is the one this repository ships', read(join(clean, PRE_PUSH)) === (set?.prePush ?? ''), PRE_PUSH);
check('the installed pre-push is executable', existsSync(join(clean, PRE_PUSH)) && (statSync(join(clean, PRE_PUSH)).mode & 0o111) !== 0, PRE_PUSH);
check(
  'the event hooks the plugin provides are reported, never copied',
  eventNames.every((name) => entryFor(eOut, name)?.outcome === 'skipped' && typeof entryFor(eOut, name)?.reason === 'string' && entryFor(eOut, name).reason.length > 0),
  JSON.stringify(eOut?.hooks),
);

const afterFirst = read(join(clean, PRE_PUSH));
git(['add', '-A'], clean);
git(['commit', '-q', '--allow-empty', '-m', 'adopted'], clean);

const f = adopt(['--hooks'], clean);
const fOut = parse(f.stdout);
check('a second --hooks exits 0', f.status === 0 && fOut !== null, `${f.stdout}\n${f.stderr}`);
check('a second --hooks reports skip for every file', Array.isArray(fOut?.hooks) && fOut.hooks.every((h: any) => h?.outcome === 'skipped'), f.stdout);
check('a second --hooks reports the installed hook as unchanged', entryFor(fOut, GIT_HOOK)?.reason === 'unchanged' && entryFor(fOut, DENY_ENTRY)?.reason === 'unchanged', JSON.stringify(fOut?.hooks));
check('a second --hooks leaves the tree unchanged', git(['status', '--porcelain'], clean) === '', git(['status', '--porcelain'], clean));
check('a second --hooks leaves the hook file byte-identical', read(join(clean, PRE_PUSH)) === afterFirst, PRE_PUSH);

// --- F: an older hook of ours is reinstalled --------------------------------
mkdirSync(join(clean, '.git', 'hooks'), { recursive: true });
writeFileSync(join(clean, PRE_PUSH), `#!/usr/bin/env bash\n# an older ${MARKER} hook\nexit 0\n`);
const g = adopt(['--hooks'], clean);
const gOut = parse(g.stdout);
check('--hooks over an older hook of ours exits 0', g.status === 0 && gOut !== null, `${g.stdout}\n${g.stderr}`);
check('an older hook of ours is reinstalled, with the reason', entryFor(gOut, GIT_HOOK)?.outcome === 'updated' && entryFor(gOut, GIT_HOOK)?.reason === 'reinstalled', JSON.stringify(entryFor(gOut, GIT_HOOK)));
check('the reinstalled hook is the one this repository ships', read(join(clean, PRE_PUSH)) === (set?.prePush ?? ''), PRE_PUSH);

// --- G: no record is a refusal, not a guess ---------------------------------
const bare = fixture({});
const before = git(['status', '--porcelain'], bare);
const h = adopt(['--hooks'], bare);
const hOut = parse(h.stdout);
check('--hooks without a record exits 1', h.status === 1 && hOut !== null, `${h.stdout}\n${h.stderr}`);
check('--hooks without a record refuses by name', hOut?.reason === 'hooks:no-record', h.stdout);
check('--hooks without a record writes nothing', git(['status', '--porcelain'], bare) === before && !existsSync(join(bare, PRE_PUSH)), git(['status', '--porcelain'], bare));

// --- H: usage ----------------------------------------------------------------
const both = adopt(['--hooks', '--workflows'], clean);
check('--hooks with a second mode flag is a usage error', both.status === 1 && /usage/.test(parse(both.stdout)?.error ?? ''), `${both.stdout}\n${both.stderr}`);
check('the usage line names --hooks', /--hooks/.test(parse(both.stdout)?.error ?? ''), `${both.stdout}\n${both.stderr}`);
const forced = adopt(['--hooks', '--force'], clean);
check(
  '--force is not a modifier of --hooks: a foreign hook has no way past the refusal',
  forced.status === 1 && /usage/.test(parse(forced.stdout)?.error ?? ''),
  `${forced.stdout}\n${forced.stderr}`,
);

// --- I: the documentation the acceptance criterion asks for -----------------
const docs = readFileSync(join(ROOT, 'docs', 'adopt.md'), 'utf8');
check('docs/adopt.md documents the --hooks flag', /node scripts\/adopt\.mts --hooks/.test(docs));
check('docs/adopt.md documents the skip reasons', ['not-ours', 'unchanged', 'not-recorded', 'plugin-provided'].every((reason) => docs.includes(reason)), 'skip reasons');
check('docs/adopt.md documents the re-run guarantee', /re-run|run again|twice/i.test(docs) && docs.includes('hooks[]'), 'rerun');

// --- J: a write that cannot be made leaves nothing installed (#302) ---------
// The header promises a fail-closed install and never a partial one, but the
// write loop installed the git hook before it reached the settings file: a
// settings write that fails used to leave the hook behind and report only
// `hooks:not-written`. A read-only `.claude/` is the cheapest way to make the
// second write fail *after* the first one succeeded: the plan is complete
// (there is no settings file to read), and only the write of it is refused.
//
// Skipped as root, the way `tests/adopt-record.test.mts` and
// `tests/adopt-inventory.test.mts` skip their own EACCES cases: root writes
// through the mode, `--hooks` then exits 0, and the case would report a red
// that says nothing about the rollback it exists to prove.
const IS_ROOT = process.getuid?.() === 0;
if (IS_ROOT) {
  check('the partial-install rollback case skipped (running as root, which a read-only directory cannot stop)', true);
} else {
  const blocked = fixture({ [RECORD_FILE]: recordOf([GIT_HOOK]) });
  mkdirSync(join(blocked, '.claude'), { recursive: true });
  chmodSync(join(blocked, '.claude'), 0o555);
  const j = adopt(['--hooks'], blocked);
  check(
    'a settings file that cannot be written is hooks:not-written',
    j.status === 1 && parse(j.stdout)?.error === 'hooks:not-written',
    `${j.stdout}\n${j.stderr}`,
  );
  check('a --hooks run that could not finish leaves no hook installed', !existsSync(join(blocked, PRE_PUSH)), PRE_PUSH);
}

// --- K: a deny entry that is not a string is a refusal, not a silent drop ----
const poisoned = fixture({
  [RECORD_FILE]: recordOf([GIT_HOOK]),
  [SETTINGS]: `${JSON.stringify({ permissions: { deny: [CUSTOM_DENY, 7] } }, null, 2)}\n`,
});
const k = adopt(['--hooks'], poisoned);
check(
  'a deny entry that is not a string is a named refusal',
  k.status === 1 && parse(k.stdout)?.error === 'hooks:settings-unparsable' && parse(k.stdout)?.field === SETTINGS,
  `${k.stdout}\n${k.stderr}`,
);
check('a deny entry that is not a string installs nothing', !existsSync(join(poisoned, PRE_PUSH)), PRE_PUSH);
check('a deny entry that is not a string is left exactly as it was', read(join(poisoned, SETTINGS)).includes('7'), read(join(poisoned, SETTINGS)));

// --- L: the record carries the hooks adoption intends, so no hand edit is it -
check(
  'docs/adopt.md documents no hand edit of hooks[] as the way to install a hook',
  !/name them in `hooks\[\]` before running/.test(docs),
  'hand edit still documented',
);

finish();
