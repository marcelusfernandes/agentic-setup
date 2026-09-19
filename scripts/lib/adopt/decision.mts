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
// **An unknown token is not refused.** The gap vocabulary is
// `scripts/lib/adopt/inventory.mts`'s, and this module deliberately does not
// import it: a person may tick a box for a gap this version does not know, or
// mistype one, and the right answer is to carry the name through to the
// record of the decision rather than to stop an adoption over a typo. Only
// `GAP_PATHS` below names gaps, and it names them as the paths their remedy
// writes.
//
// **Crash policy: this module cannot fail.** Every function is total over
// whatever it is handed — a body that is not the rendered shape, a timeline
// that is not an array of events — and answers "nothing was decided" or "no
// login" rather than throwing. What a caller does with "nothing" is the
// caller's refusal to name, not this module's.
//
// Node built-ins only.
import { WORKFLOW_DIR } from './workflows.mts';

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
 */
export function decidedBy(timeline: unknown, label: string): string | null {
  if (!Array.isArray(timeline)) return null;
  let login: string | null = null;
  for (const raw of timeline as TimelineEvent[]) {
    if (raw?.event !== 'labeled') continue;
    if (String(raw?.label?.name ?? '') !== label) continue;
    const actor = String(raw?.actor?.login ?? '');
    if (actor !== '') login = actor;
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

/** The gap list of a section, one per bullet, with the files it governs. */
function gapLines(gaps: readonly string[], carried: boolean): string[] {
  return gaps.map((gap) => {
    const paths = GAP_PATHS[gap] ?? [];
    if (paths.length === 0) return `- \`${gap}\``;
    return carried
      ? `- \`${gap}\` — \`${paths.join('`, `')}\``
      : `- \`${gap}\` — left out of the pull request: \`${paths.join('`, `')}\``;
  });
}

/** How the comment and the body name who decided, or say that nothing names them. */
export function decidedByPhrase(record: DecisionRecord, label: string): string {
  return record.decidedBy === null
    ? `No \`labeled\` event in this issue's timeline names who applied \`${label}\`, so this run cannot say.`
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
      : ['**Accepted** — the boxes ticked above:', '', ...gapLines(record.accepted, true)].join('\n'),
    '',
    record.declined.length === 0
      ? '**Declined:** nothing; every box was ticked.'
      : [
          '**Declined** — the boxes left empty. A gap whose remedy is a file is not in the',
          'branch at all; a gap whose remedy is not a file is recorded here and nothing more:',
          '',
          ...gapLines(record.declined, false),
        ].join('\n'),
    '',
    decidedByPhrase(record, label),
    '',
    `The branch is \`${branch}\`. Nothing was written into the working tree of the repository this ran in.`,
    '',
  ].join('\n');
}
