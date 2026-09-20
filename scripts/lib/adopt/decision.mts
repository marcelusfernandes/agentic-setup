// The decision a person wrote on the adoption plan issue, read (#368).
//
// `scripts/adopt.mts --plan-issue` renders one checkbox per gap and ends
// "Tick what should happen, then move this issue to `human:decided`", and
// `--pr` refuses with the same sentence. Until this module existed the ticks
// were never read: the gate resolved on the label alone, so a person who
// ticked two gaps out of five and one who ticked all five got the same pull
// request, and neither was told. The form asked a question whose answer
// nothing consumed.
//
// This module is the reading, and nothing else. It is pure — no `gh`, no
// `git`, no disk — so the whole of what a tick means can be tested directly,
// and `scripts/lib/adopt/pr-run.mts` is the one place that fetches the body
// and the timeline this reads. It lives beside `pr.mts` rather than inside it
// because that file is 618 of the 800 lines this repository holds every file
// to, and the decision is its own subject.
//
// **The backticked token decides, and the prose never does.** A checkbox line
// is `- [x] \`<gap>\` — <what adoption would do>`, and only the first
// backticked span is read. Everything after it is prose a person may rewrite
// while they answer — and they do: an owner who declines the workflows writes
// *"no: we maintain these by hand"* over the remedy the script generated. A
// parser that read the remedy would lose the decision the moment somebody
// answered in their own words, which is the one thing a form asking for an
// answer must survive. A line whose gap name is not backticked contributes
// nothing rather than contributing a guess.
//
// **An unknown token is not refused, and since #423 it is named.** The gap
// vocabulary is `scripts/lib/adopt/inventory.mts`'s. A person may tick a box
// for a gap this version does not know, or mistype one, and the right answer
// is still to carry the name through to the record of the decision rather
// than to stop an adoption over a typo — `parseDecision` below is unchanged
// on that point. What changed is that the *report* says which ticks nothing
// could act on, because a typo that is accepted in silence declines the gap
// it was aimed at and drops that gap's files, and every artefact then records
// the decision as if it were the one intended (#400).
//
// **The vocabulary is mirrored here, and the mirror is checked by `tsc`.**
// `GAP_REMEDIES` writes the seven names out rather than importing the list at
// runtime: `import type { Gap }` is erased by `verbatimModuleSyntax`, so this
// module still has no runtime dependency on `inventory.mts` and an unknown
// tick still cannot become a refusal. `Record<Gap, string>` makes `npm run
// check` refuse a name added to or renamed in that module without this one
// following, which is the drift item 33's cost list accepted when `GAP_PATHS`
// was written the same way — now caught at compile time in both directions
// rather than at neither.
//
// **Crash policy: this module cannot fail.** Every function is total over
// whatever it is handed — a body that is not the rendered shape, a timeline
// that is not an array of events — and answers "nothing was decided" or "no
// login" rather than throwing. What a caller does with "nothing" is the
// caller's refusal to name, not this module's.
//
// Node built-ins only.
import { WORKFLOW_DIR } from './workflows.mts';
import type { Gap } from './inventory.mts';

/** What a plan issue's body says: the gaps ticked, and the gaps left empty. */
export type Decision = {
  /** The gaps whose box carries a mark, in the order the body lists them. */
  accepted: string[];
  /** The gaps whose box is empty, in the same order. */
  declined: string[];
};

/**
 * One checkbox line of the plan's checklist.
 *
 * `[-*]` because a person editing the body may reflow a bullet; `[ xX]`
 * because GitHub renders `[X]` as ticked and a person typing by hand produces
 * both. The gap name is the **first** backticked span, and the expression
 * stops there: a remedy that quotes a second path (`create \`state:ready\``)
 * must not turn that path into a second decision.
 */
const CHECKBOX = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+`([^`]+)`/;

/**
 * The decision a plan issue's body carries. Lines that are not checkboxes are
 * skipped, so the inventory bullets above the checklist and the `## Files`
 * globs below it are never read as gaps, and a body with no checklist at all
 * decides nothing rather than throwing.
 */
export function parseDecision(body: string): Decision {
  const accepted: string[] = [];
  const declined: string[] = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const match = CHECKBOX.exec(line);
    if (match === null) continue;
    const gap = (match[2] ?? '').trim();
    if (gap === '') continue;
    (match[1] === ' ' ? declined : accepted).push(gap);
  }
  return { accepted, declined };
}

/**
 * The paths a gap's remedy writes, for the gaps whose remedy is a file the
 * adoption pull request carries. A path is matched by prefix, so one entry
 * covers a directory.
 *
 * **One gap is in this map, and the other six belong out of it.** Their own
 * remedies say why, in `scripts/adopt.mts`'s `REMEDIES`: `ruleset:absent` and
 * `ruleset:review-not-required` are a GitHub API call (`init.mts --rules`),
 * `labels:missing` is `gh label create`, `hooks:not-installed` is a file under
 * the directory git runs hooks from, which `docs/adopt-pr.md` already states
 * no pull request can carry, `test-command:none` is an environment variable,
 * and `record:stale` is `--record --force`, a flag `--pr` never runs — it uses
 * the record it was handed as it stands. Declining one of those is recorded
 * and changes no file, which is the acceptance criterion's "named as declined
 * and nothing more".
 *
 * `agentic.config.json`, `.claude/settings.json` and the proof files are in no
 * entry here on purpose: they answer no gap, so no tick governs them. The
 * proof files in particular are the pull request's own deliberate red, not a
 * remedy, and a branch that dropped them would prove nothing.
 */
export const GAP_PATHS: Record<string, string[]> = {
  'workflows:missing': [`${WORKFLOW_DIR}/`],
};

/** Every path prefix the declined gaps of a decision would have written. */
export function declinedPrefixes(declined: readonly string[]): string[] {
  return declined.flatMap((gap) => GAP_PATHS[gap] ?? []);
}

/** True when a planned path is one a declined gap would have written. */
export function isDeclined(path: string, declined: readonly string[]): boolean {
  return declinedPrefixes(declined).some((prefix) => path.startsWith(prefix));
}

/**
 * What performs each gap's remedy, in the words a person can run.
 *
 * It is the *command*, not the plan issue's sentence: `scripts/adopt.mts`'s
 * `REMEDIES` renders a description against one report ("create the 3 missing
 * label(s) …"), which names no command for `labels:missing` at all. The
 * command is read off the code — `scripts/init.mts` is what runs `gh label
 * create` for every label of the dictionary — and it is what an accepted gap
 * nothing performed has to name, because the person who ticked that box is
 * the person who now has to run it.
 *
 * Typed `Record<Gap, string>` so the seven names are exhaustive and checked:
 * see this file's header for why the type is imported and the list is not.
 */
export const GAP_REMEDIES: Record<Gap, string> = {
  'ruleset:absent': 'node scripts/init.mts --rules',
  'ruleset:review-not-required': 'node scripts/init.mts --rules',
  'labels:missing': 'node scripts/init.mts',
  'hooks:not-installed': 'node scripts/adopt.mts --hooks',
  'workflows:missing': 'node scripts/adopt.mts --workflows',
  'test-command:none': 'set `AGENTIC_TEST_CMD`, or add a test command detection can find',
  'record:stale': 'node scripts/adopt.mts --record --force',
};

/** Every gap name this version knows, in the order the inventory defines them. */
export const KNOWN_GAPS: readonly string[] = Object.keys(GAP_REMEDIES);

/** The remedy for a gap name, or `null` when the name is not one of the seven. */
const remedyFor = (gap: string): string | null => (GAP_REMEDIES as Record<string, string>)[gap] ?? null;

/**
 * How far a ticked name may be from a gap name and still be read as a miss of
 * it. Two, because the mistake this exists for is a dropped or doubled
 * character (`workflow:missing`), and because no two of the seven names are
 * within two edits of each other — a threshold that let one gap name be a
 * near-miss of another would turn a correct tick into a warning.
 */
export const NEAR_MISS_DISTANCE = 2;

/** Levenshtein distance, over two short names; no allocation beyond one row. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * The gap name a ticked token is within `NEAR_MISS_DISTANCE` of, or `null`.
 *
 * A known name answers itself, at distance zero. Ties keep the first name in
 * `KNOWN_GAPS`, which is the inventory's own order: the answer is a hint a
 * person reads, and an order fixed by the vocabulary is one that cannot change
 * with the order the boxes happen to be ticked in.
 */
export function nearestGap(name: string): string | null {
  return KNOWN_GAPS.filter((gap) => Math.abs(gap.length - name.length) <= NEAR_MISS_DISTANCE)
    .map((gap) => ({ gap, distance: editDistance(name, gap) }))
    .filter((entry) => entry.distance <= NEAR_MISS_DISTANCE)
    .reduce<{ gap: string; distance: number } | null>(
      (best, entry) => (best === null || entry.distance < best.distance ? entry : best),
      null,
    )?.gap ?? null;
}

/**
 * What accepting one gap did: the diff carries its remedy, or the run wrote
 * the tick down and performed nothing, or no gap of this version has that
 * name at all.
 */
export type TickState = 'carried' | 'recorded' | 'unrecognised';

/** One ticked box, and what the run could do about it. */
export type AcceptedGap = {
  gap: string;
  state: TickState;
  /** The paths its remedy writes, empty unless the state is `carried`. */
  paths: string[];
  /** What performs it, or `null` for a name this version does not define. */
  remedy: string | null;
  /** The gap an unrecognised name is a near-miss of, or `null`. */
  nearest: string | null;
};

/**
 * Every ticked box, classified. This is the answer the bare `**Accepted:**`
 * list dropped: `GAP_PATHS` already knew which remedies are files, and both
 * of its reads were on the declined side, so a gap the run performed and a
 * gap it only wrote down were one word in three artefacts (#403).
 */
export function classifyAccepted(accepted: readonly string[]): AcceptedGap[] {
  return accepted.map((gap) => {
    const paths = GAP_PATHS[gap] ?? [];
    if (!KNOWN_GAPS.includes(gap)) {
      return { gap, state: 'unrecognised', paths: [], remedy: null, nearest: nearestGap(gap) };
    }
    return { gap, state: paths.length > 0 ? 'carried' : 'recorded', paths, remedy: remedyFor(gap), nearest: null };
  });
}

/**
 * The unrecognised tick that was aimed at this gap, or `null`.
 *
 * Asked of a **declined** gap, it separates the two things #400 found
 * indistinguishable: a box left empty on purpose, and a box left empty while
 * its name was ticked one character wrong. It is a word in the report and
 * never a refusal — the run cannot know which of the two happened, and only
 * the person who ticked can.
 */
export function tickShadowing(gap: string, accepted: readonly string[]): string | null {
  return accepted.find((tick) => !KNOWN_GAPS.includes(tick) && nearestGap(tick) === gap) ?? null;
}

/** ` — …` naming the tick that shadows a declined gap, or '' when none does. */
function shadowNote(gap: string, accepted: readonly string[]): string {
  const tick = tickShadowing(gap, accepted);
  return tick === null ? '' : `; \`${tick}\` was ticked, a near-miss of this name, so this box may have been meant`;
}

/** The accepted list: one bullet per ticked box, saying what the tick did. */
export function acceptedLines(accepted: readonly string[]): string[] {
  return classifyAccepted(accepted).map((entry) => {
    if (entry.state === 'carried') {
      return `- \`${entry.gap}\` — **carried**: its remedy is \`${entry.paths.join('\`, \`')}\`, and this branch is what carries it.`;
    }
    if (entry.state === 'recorded') {
      return `- \`${entry.gap}\` — **recorded, not performed**: its remedy is not a file, so nothing in this branch closes it. Run \`${entry.remedy}\`.`;
    }
    return `- \`${entry.gap}\` — **unrecognised**: no gap of this version carries that name, so nothing acted on it.`;
  });
}

/** What one unrecognised tick may have been aimed at, in the plan's own terms. */
function unrecognisedLine(entry: AcceptedGap, record: DecisionRecord): string {
  const head = `- \`${entry.gap}\``;
  if (entry.nearest === null) return `${head} — a near-miss of no gap name, so there is nothing it could have meant.`;
  const paths = GAP_PATHS[entry.nearest] ?? [];
  if (record.accepted.includes(entry.nearest)) {
    return `${head} — nearest is \`${entry.nearest}\`, which was ticked in its own right, so nothing was lost to this one.`;
  }
  if (!record.declined.includes(entry.nearest)) {
    return `${head} — nearest is \`${entry.nearest}\`, which this plan does not list.`;
  }
  const cost = paths.length === 0 ? '' : `, and \`${paths.join('\`, \`')}\` is not in this diff`;
  return `${head} — nearest is \`${entry.nearest}\`, whose own box is empty: it counts as declined${cost}.`;
}

/**
 * The section that names the ticks nothing could act on, or nothing at all.
 *
 * It sits in both the comment and the pull-request body, beside the declined
 * gap each one shadows, because the two facts are only useful together: "a
 * name nobody defines was accepted" and "the gap it was aimed at was declined"
 * are one mistake read side by side and two unrelated lines read apart.
 */
export function unrecognisedNotes(record: DecisionRecord): string[] {
  const unknown = classifyAccepted(record.accepted).filter((entry) => entry.state === 'unrecognised');
  if (unknown.length === 0) return [];
  return [
    '**Ticks this version cannot act on.** A name no gap of this version defines is',
    'carried into the record rather than refused — a typo in a box is not a reason to',
    'stop an adoption — and nothing performed it:',
    '',
    ...unknown.map((entry) => unrecognisedLine(entry, record)),
    '',
  ];
}

/** One event of an issue timeline, as GitHub renders it; every field optional. */
export type TimelineEvent = {
  event?: unknown;
  label?: { name?: unknown } | null;
  actor?: { login?: unknown } | null;
};

/**
 * Who applied a label, out of an issue's timeline: the **last** `labeled`
 * event naming it, or `null` when the timeline names none.
 *
 * The last and not the first, because a label removed and applied again is an
 * ordinary thing — a person who decides, changes their mind, and decides
 * again — and the decision `--pr` acts on is the one standing now. `null` is
 * a timeline that *answered* and named no such event, which is a fact about
 * the issue; a timeline that could not be read at all never reaches here, and
 * `pr-run.mts` fails closed on it by name.
 *
 * **The last matching event's actor is the answer, including when it has
 * none.** An earlier version kept the previous login when the last event
 * carried no actor — GitHub omits one for an event attributed to a deleted
 * user or to an integration — and that reported *a different person* as the
 * one who decided. It is the direction this module's own reasoning forbids:
 * the point of failing closed on an unreadable timeline is that `null` must
 * not mean two things, and carrying an earlier login forward makes a non-null
 * value mean two things instead, which is worse. A login that is wrong looks
 * exactly like a login that is right, and nothing downstream can tell them
 * apart; a `null` announces itself.
 */
export function decidedBy(timeline: unknown, label: string): string | null {
  if (!Array.isArray(timeline)) return null;
  let login: string | null = null;
  for (const raw of timeline as TimelineEvent[]) {
    if (raw?.event !== 'labeled') continue;
    if (String(raw?.label?.name ?? '') !== label) continue;
    const actor = String(raw?.actor?.login ?? '');
    login = actor === '' ? null : actor;
  }
  return login;
}

/** What the comment and the pull request body need to say about one decision. */
export type DecisionRecord = {
  accepted: string[];
  declined: string[];
  /** The login that applied the decided label, or `null` when none is recorded. */
  decidedBy: string | null;
};

/** The declined list: what the branch leaves out, and what was aimed at it. */
function declinedLines(declined: readonly string[], accepted: readonly string[]): string[] {
  return declined.map((gap) => {
    const paths = GAP_PATHS[gap] ?? [];
    const head =
      paths.length === 0 ? `- \`${gap}\`` : `- \`${gap}\` — left out of the pull request: \`${paths.join('`, `')}\``;
    return `${head}${shadowNote(gap, accepted)}`;
  });
}

/**
 * How the comment and the body name who decided, or say that nobody is named.
 *
 * **One sentence for both shapes of `null`, because both are by design.** Item
 * 33's Decision point 5 makes a timeline that answers and names no `labeled`
 * event `null`; PR #396 made a standing `labeled` event carrying no actor —
 * GitHub omits one for a deleted user or an integration — `null` as well,
 * rather than reporting the person who applied the label an edit earlier. The
 * old wording claimed the first of those about both, and a reader of it went
 * looking for a missing event that was sitting in the timeline (#400). The
 * timeline never reaches this function, so the honest phrase is the one true
 * of either: `decidedBy` is the answer, and the answer is nobody.
 */
export function decidedByPhrase(record: DecisionRecord, label: string): string {
  return record.decidedBy === null
    ? `No \`labeled\` event for \`${label}\` in this issue's timeline names a person: either there is no such ` +
        'event, or the standing one carries no actor. Either way this run cannot say who applied it.'
    : `Applied \`${label}\`: @${record.decidedBy}, read from this issue's timeline.`;
}

/**
 * The comment `--pr` leaves on the plan issue before it opens the pull
 * request. It is the record the issue itself carries: until it existed, the
 * only trace of what was decided was the body's edit history, which no script
 * and no closeout reads.
 */
export function renderDecisionComment(record: DecisionRecord, label: string, branch: string): string {
  return [
    '`node scripts/adopt.mts --pr` read this decision and acted on it.',
    '',
    record.accepted.length === 0
      ? '**Accepted:** nothing.'
      : [
          '**Accepted** — the boxes ticked above. A gap whose remedy is a file is carried in',
          'the diff, and the pull request lists file by file what changed and what the base',
          'already had; a gap whose remedy is not a file is recorded here and performed by',
          'nothing, so the command that performs it is named beside it:',
          '',
          ...acceptedLines(record.accepted),
        ].join('\n'),
    '',
    record.declined.length === 0
      ? '**Declined:** nothing; every box was ticked.'
      : [
          '**Declined** — the boxes left empty. A gap whose remedy is a file is not in the',
          'branch at all; a gap whose remedy is not a file is recorded here and nothing more:',
          '',
          ...declinedLines(record.declined, record.accepted),
        ].join('\n'),
    '',
    ...unrecognisedNotes(record),
    decidedByPhrase(record, label),
    '',
    `The branch is \`${branch}\`. Nothing was written into the working tree of the repository this ran in.`,
    '',
  ].join('\n');
}
