// The hooks an adopted repository gets, resolved from the adoption record
// (#166). `scripts/init.mts` installs them unconditionally and reports
// afterwards: it merges the deny list into `.claude/settings.json` and writes
// `hooks/git-pre-push` into the repository's git hooks directory on every run,
// for every repository, with no record of what it installed and no way to read
// it back. An adopting repository that already has a `pre-push`, or a settings
// file with its own deny entries, gets a merge and no report of what was kept.
//
// This module makes the hook set data. `planHooks(record, options)` resolves
// the record's `hooks[]` to the files that would be installed and answers a
// plan of `{ path, action, reason }` — one entry per hook this repository
// ships, plus the permission file — **without writing anything**.
// `scripts/adopt.mts --hooks` is what executes that plan, and `doctor` (#168)
// can later read the same record to say which of them is missing today.
//
// **What the record selects, and what it cannot.** `hooks[]` names the hooks
// to install, and every name in it must be one this repository ships
// (`readShipped`) — an unknown name is a named refusal, never a silent skip,
// because a record naming a hook nobody installs is a repository that believes
// it is protected and is not. The deny list is not selectable: it is the
// permission half of the same protection and is always planned.
//
// **What "installing" means, per kind.** The git hook is a file copied into
// the repository's hooks directory. The event hooks `hooks/hooks.json`
// registers are not: they run from the plugin root
// (`${CLAUDE_PLUGIN_ROOT}/hooks/…`) and nothing of them is ever copied into an
// adopted repository, so they are planned as `skip` with the reason
// `plugin-provided` — reported rather than dropped, which is the difference
// between "this is not installed here" and "this was forgotten".
//
// **The marker is what protects a hand-written hook.** A `pre-push` whose text
// does not carry `agentic-setup` was written by a person; it is skipped with
// the reason `not-ours` and never replaced. There is no `--force` past it, for
// the same reason the generated workflows have none (#165): the remedy is to
// read the file, not to lose it.
//
// **Crash policy: fail closed.** Every function either returns the answer or
// throws a named `HookError`. A shipped file that is not there, a manifest
// that is not the shape, a settings file that is not JSON *or whose
// `permissions.deny` holds an entry that is not a string* (#302), and a target
// that exists and cannot be read are each a named refusal — never a partial
// install, and never a merge over a file this module could not look at. Only
// ENOENT reads as "it is not there"; every other errno fails closed. That is
// stricter than `scripts/init.mts`, which reports an unparsable settings file
// and carries on; a caller of this module asked for a plan, and half a plan is
// worse than none. Every entry also carries `previous`, what the file holds
// today, so the caller that executes the plan can put back what it wrote when
// a later write of the same plan fails: half an install is worse than none
// too, and only the caller knows that it happened.
//
// Node built-ins only.
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdoptionRecord } from './record.mts';
import { GIT_HOOKS, HOOK_MARKER, SUPERSEDED_DENY_RULES } from './constants.mts';

/**
 * The text a hook of this setup carries, and the whole ownership test. It has
 * one definition, in `./constants.mts`, which `scripts/init.mts` and
 * `scripts/lib/adopt/inventory.mts` read too (#302); this name is the one the
 * rest of this module and its cases were written against.
 */
export const MARKER = HOOK_MARKER;

/** The one git hook this setup installs, named as the record names it. */
export const GIT_HOOK = GIT_HOOKS[0];

/** The file the git hook is copied from, under this repository's `hooks/`. */
export const GIT_HOOK_SOURCE = 'git-pre-push';

/** The mode the installed git hook carries; git runs nothing it cannot execute. */
export const GIT_HOOK_MODE = 0o755;

/** The permission file the deny list is merged into, inside the adopted repository. */
export const SETTINGS_FILE = join('.claude', 'settings.json');

/**
 * The plan entry that owns the permission file. Not a hook name: `hooks[]`
 * cannot select it (a record naming it is an unknown hook), because the deny
 * list is what makes the hooks enforceable rather than a thing to install
 * beside them.
 */
export const DENY_ENTRY = 'deny-list';

/** Where the event hooks are registered, relative to this repository's root. */
export const HOOKS_MANIFEST = join('hooks', 'hooks.json');

/** The file the deny list is read from, relative to this repository's root. */
export const SETTINGS_TEMPLATE = join('templates', 'claude-settings.json');

/** Every named reason this module can refuse for. */
export type HookReason =
  | 'hooks:unknown-hook'
  | 'hooks:source-missing'
  | 'hooks:source-unreadable'
  | 'hooks:manifest-unparsable'
  | 'hooks:settings-unparsable'
  | 'hooks:unreadable';

/**
 * The one way out on a refusal: a named `reason` a caller can branch on, and
 * the `field` it rejected — a hook name or a file — when there is one. The
 * message is for a person; the reason is the contract.
 */
export class HookError extends Error {
  readonly reason: HookReason;
  readonly field: string | null;

  constructor(reason: HookReason, message: string, field: string | null = null) {
    super(message);
    this.name = 'HookError';
    this.reason = reason;
    this.field = field;
  }
}

/** What happens to one file: the same three actions the generated workflows use. */
export type HookAction = 'create' | 'update' | 'skip';

/** Why. Every `skip` carries one, and so does every write. */
export type HookPlanReason =
  /** there was no such file; it would be written */
  | 'absent'
  /** the deny list gains entries, or a superseded one is replaced */
  | 'merged'
  /** the file is already what would be written; nothing is written */
  | 'unchanged'
  /** the file is ours and its contents moved; it would be rewritten */
  | 'reinstalled'
  /** the file does not carry the marker: a person wrote it, and it is left alone */
  | 'not-ours'
  /** the record does not name this hook, so nothing is installed for it */
  | 'not-recorded'
  /** it runs from the plugin root; nothing of it is copied into a repository */
  | 'plugin-provided';

/** What a deny-list merge did, named entry by entry so a caller can report it. */
export type DenyMerge = {
  /** Rules of the shipped set that were not there and would be added. */
  added: string[];
  /** Rules already in the file that this tool did not put there, and keeps. */
  preserved: string[];
  /** Rules replaced by the wording that superseded them. */
  replaced: Array<{ from: string; to: string }>;
};

/** One file the plan covers. `content` is `null` when nothing is written. */
export type HookPlanEntry = {
  /** The hook this entry installs, as the record names it, or `DENY_ENTRY`. */
  hook: string;
  /** Where it lands, relative to the adopted repository's root. */
  path: string;
  action: HookAction;
  reason: HookPlanReason;
  /** The bytes to write, or `null` on a `skip`. */
  content: string | null;
  /**
   * What the file holds today, or `null` when there is no such file. It is
   * what `scripts/adopt.mts --hooks` puts back when a later write of the same
   * plan fails: the header promises a fail-closed install and never a partial
   * one, and a plan executed halfway is exactly a partial one (#302).
   */
  previous: string | null;
  /** The mode to set after writing, or `null` when the default will do. */
  mode: number | null;
  /** The deny-list report, on the permission file's entry and nowhere else. */
  deny: DenyMerge | null;
};

/** The plan: one entry per shipped hook, plus the permission file. */
export type Plan = { entries: HookPlanEntry[] };

/** What this repository ships, read once from its own files. */
export type Shipped = {
  /** The text of `hooks/git-pre-push`. */
  prePush: string;
  /** The deny rules of `templates/claude-settings.json`, in file order. */
  deny: string[];
  /** The event hooks `hooks/hooks.json` registers, by script name, sorted. */
  events: string[];
  /** Every name a record's `hooks[]` may hold: the git hook, then the events. */
  names: string[];
};

/** Where this repository's own files live, from this module's location. */
export function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** True when a hook's text is one of ours — the marker, and nothing else. */
export function isOurs(text: string): boolean {
  return text.includes(MARKER);
}

/** Reads one of this repository's own files, or refuses by name. */
function readShippedFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    throw new HookError(
      missing ? 'hooks:source-missing' : 'hooks:source-unreadable',
      `${path} ${missing ? 'is not there' : `could not be read: ${(err as Error).message}`}`,
      path,
    );
  }
}

/** The shape `hooks/hooks.json` has, as far as this module reads it. */
type Manifest = { hooks?: Record<string, Array<{ hooks?: Array<{ command?: unknown }> }>> };

/**
 * The event hooks the manifest registers, by the basename of the script each
 * command runs. Read rather than listed, so a hook added to `hooks.json` is a
 * name a record may carry without a second edit here.
 */
function eventHooks(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new HookError('hooks:manifest-unparsable', `${HOOKS_MANIFEST} is not JSON: ${(err as Error).message}`, HOOKS_MANIFEST);
  }
  const events = (parsed as Manifest)?.hooks;
  if (typeof events !== 'object' || events === null || Array.isArray(events)) {
    throw new HookError('hooks:manifest-unparsable', `${HOOKS_MANIFEST} holds no \`hooks\` mapping`, HOOKS_MANIFEST);
  }
  const names = new Set<string>();
  for (const groups of Object.values(events)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const entry of Array.isArray(group?.hooks) ? group.hooks : []) {
        const command = typeof entry?.command === 'string' ? entry.command : '';
        const match = command.match(/hooks\/([A-Za-z0-9_-]+)\.mts/);
        if (match) names.add(match[1]);
      }
    }
  }
  if (names.size === 0) throw new HookError('hooks:manifest-unparsable', `${HOOKS_MANIFEST} registers no hook command`, HOOKS_MANIFEST);
  return [...names].sort();
}

/** The deny rules of the shipped settings template, or a named refusal. */
function shippedDeny(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new HookError('hooks:source-unreadable', `${SETTINGS_TEMPLATE} is not JSON: ${(err as Error).message}`, SETTINGS_TEMPLATE);
  }
  const deny = (parsed as { permissions?: { deny?: unknown } })?.permissions?.deny;
  if (!Array.isArray(deny) || deny.some((rule) => typeof rule !== 'string')) {
    throw new HookError('hooks:source-unreadable', `${SETTINGS_TEMPLATE} holds no \`permissions.deny\` list of strings`, SETTINGS_TEMPLATE);
  }
  return deny as string[];
}

/**
 * What this repository ships. The one function here that reads files outside
 * the repository being adopted, and it reads nothing but this repository's own.
 */
export function readShipped(dir: string = pluginRoot()): Shipped {
  const prePush = readShippedFile(join(dir, 'hooks', GIT_HOOK_SOURCE));
  const events = eventHooks(readShippedFile(join(dir, HOOKS_MANIFEST)));
  const deny = shippedDeny(readShippedFile(join(dir, SETTINGS_TEMPLATE)));
  return { prePush, deny, events, names: [GIT_HOOK, ...events] };
}

/** Reads a file of the adopted repository; `null` only when it is not there. */
function readTarget(path: string, reason: HookReason): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new HookError(reason, `${path} exists and could not be read: ${(err as Error).message}`, path);
  }
}

/** A path as the report shows it: relative to the adopted repository's root. */
function shown(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === '' ? path : rel;
}

/** The plan entry for the git hook the record named, or the reason it has none. */
function planGitHook(root: string, hooksDir: string, shipped: Shipped, recorded: boolean): HookPlanEntry {
  const path = join(hooksDir, GIT_HOOK);
  const entry = { hook: GIT_HOOK, path: shown(root, path), content: null, mode: null, deny: null, previous: null };
  if (!recorded) return { ...entry, action: 'skip', reason: 'not-recorded' };

  const current = readTarget(path, 'hooks:unreadable');
  if (current === null) {
    return { ...entry, action: 'create', reason: 'absent', content: shipped.prePush, mode: GIT_HOOK_MODE };
  }
  if (!isOurs(current)) return { ...entry, action: 'skip', reason: 'not-ours' };
  if (current === shipped.prePush) return { ...entry, action: 'skip', reason: 'unchanged' };
  return { ...entry, action: 'update', reason: 'reinstalled', content: shipped.prePush, mode: GIT_HOOK_MODE, previous: current };
}

/** The settings file as it is on disk, and as it parses; `null` when absent. */
type Settings = { text: string; value: Record<string, unknown> };

/** The settings file of the adopted repository, parsed, or a named refusal. */
function readSettings(path: string): Settings | null {
  // A file that exists and cannot be read is `hooks:unreadable`, not
  // `hooks:settings-unparsable`: the reason is the contract, and "could not be
  // read" and "is not JSON" are different answers.
  const text = readTarget(path, 'hooks:unreadable');
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new HookError('hooks:settings-unparsable', `${SETTINGS_FILE} is not JSON: ${(err as Error).message}`, SETTINGS_FILE);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HookError('hooks:settings-unparsable', `${SETTINGS_FILE} must hold one JSON object`, SETTINGS_FILE);
  }
  return { text, value: parsed as Record<string, unknown> };
}

/**
 * The deny rules the adopted repository holds today, or a named refusal.
 *
 * An entry that is not a string used to be dropped on the floor (#302): the
 * merged list was written back without it, so a rule a person had written as
 * an object, a number or `null` disappeared from their permission file and
 * nothing said so. A deny list this module cannot read is a permission file it
 * must not rewrite — the same rule the marker enforces for a hand-written
 * hook, and the same one `hooks:settings-unparsable` already states for a file
 * that is not JSON at all. The remedy is to read the file.
 */
function currentDeny(settings: Settings | null): string[] {
  if (settings === null) return [];
  const deny = (settings.value.permissions as { deny?: unknown } | undefined)?.deny;
  if (deny === undefined || deny === null) return [];
  if (!Array.isArray(deny)) {
    throw new HookError('hooks:settings-unparsable', `${SETTINGS_FILE} holds a \`permissions.deny\` that is not a list`, SETTINGS_FILE);
  }
  const stray = deny.findIndex((rule) => typeof rule !== 'string');
  if (stray !== -1) {
    throw new HookError(
      'hooks:settings-unparsable',
      `${SETTINGS_FILE} holds a \`permissions.deny\` entry that is not a string (index ${stray}); a rule this tool cannot read is not a rule it may drop`,
      SETTINGS_FILE,
    );
  }
  return deny as string[];
}

/**
 * The deny list an existing one and the shipped set imply: the adopter's own
 * rules kept in place, the superseded wordings replaced by their successors,
 * and the shipped rules that are not there yet appended. Nothing is removed
 * that this installer did not itself seed under an older name.
 */
export function mergeDeny(current: string[], shipped: string[]): { deny: string[]; merge: DenyMerge } {
  const unique = [...new Set(current)];
  const replaced = unique.filter((rule) => Object.hasOwn(SUPERSEDED_DENY_RULES, rule)).map((rule) => ({ from: rule, to: SUPERSEDED_DENY_RULES[rule] }));
  const kept = unique.filter((rule) => !Object.hasOwn(SUPERSEDED_DENY_RULES, rule));
  const wanted = [...new Set([...shipped, ...replaced.map((pair) => pair.to)])];
  const added = wanted.filter((rule) => !kept.includes(rule));
  const preserved = kept.filter((rule) => !shipped.includes(rule));
  return { deny: [...kept, ...added], merge: { added, preserved, replaced } };
}

/** The plan entry for the permission file; always planned, never selectable. */
function planDenyList(root: string, shipped: Shipped): HookPlanEntry {
  const path = join(root, SETTINGS_FILE);
  const settings = readSettings(path);
  const current = currentDeny(settings);
  const { deny, merge } = mergeDeny(current, shipped.deny);

  const entry = { hook: DENY_ENTRY, path: shown(root, path), mode: null, deny: merge, previous: settings?.text ?? null };
  // A file that already holds every wanted rule is left exactly as it is —
  // formatting, key order and every other setting included. Rewriting it to
  // this tool's own formatting would be a change nobody asked for, and would
  // make a second run something other than the no-op it promises to be.
  if (settings !== null && merge.added.length === 0 && merge.replaced.length === 0) {
    return { ...entry, action: 'skip', reason: 'unchanged', content: null };
  }
  const merged = { ...(settings?.value ?? {}), permissions: { ...((settings?.value.permissions as Record<string, unknown> | undefined) ?? {}), deny } };
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  return settings === null
    ? { ...entry, action: 'create', reason: 'absent', content }
    : { ...entry, action: 'update', reason: 'merged', content };
}

/** What `planHooks` needs to know about where it is planning. */
export type PlanOptions = {
  /** The adopted repository's root. */
  root: string;
  /** The directory git runs hooks from — git's own answer, never a guess. */
  hooksDir: string;
  /** What this repository ships; read from disk when it is not supplied. */
  shipped?: Shipped;
};

/**
 * The files the record's `hooks[]` implies, as a plan. Reads the adopted
 * repository to decide `create` from `update` from `skip`, and **writes
 * nothing**: `scripts/adopt.mts --hooks` is what writes. Every hook this
 * repository ships gets an entry, named whether it is installed or not, so
 * "not installed here" is a line in the report rather than a silence.
 */
export function planHooks(record: AdoptionRecord, options: PlanOptions): Plan {
  const shipped = options.shipped ?? readShipped();

  // Every recorded name is checked before a single file is looked at: a record
  // naming a hook nobody ships is a repository that believes it is protected
  // and is not, and the plan it would get would install part of what it asked
  // for and say nothing about the rest.
  for (const name of record.hooks) {
    if (!shipped.names.includes(name)) {
      throw new HookError(
        'hooks:unknown-hook',
        `the adoption record names the hook \`${name}\`, which this setup does not ship; the set is \`${shipped.names.join('`, `')}\``,
        name,
      );
    }
  }

  const recorded = new Set(record.hooks);
  const entries: HookPlanEntry[] = [planGitHook(options.root, options.hooksDir, shipped, recorded.has(GIT_HOOK))];
  for (const name of shipped.events) {
    entries.push({
      hook: name,
      // The event hooks run from the plugin root, so there is no file inside
      // the adopted repository to name; the manifest that registers them is
      // what the report points at instead.
      path: HOOKS_MANIFEST,
      action: 'skip',
      reason: recorded.has(name) ? 'plugin-provided' : 'not-recorded',
      content: null,
      mode: null,
      deny: null,
      previous: null,
    });
  }
  entries.push(planDenyList(options.root, shipped));
  return { entries };
}
