#!/usr/bin/env node
// What `node scripts/adopt.mts --pr` says about a tick nothing can act on, and
// about a gap it recorded rather than performed (#423, absorbing #400 and #403).
//
// Two defects of one rendering. A gap whose remedy is not a file is accepted
// and reported in a bare list, so "accepted" reads as "done" for a remedy
// nothing ran; and a mistyped gap name is carried through with no mark, so a
// person who ticks `workflow:missing` sees their typo accepted while
// `workflows:missing` is counted as declined and its files are left out of the
// branch. Both are the report of a decision saying something true-sounding
// about a state that is not the state.
//
// This file is the split target `tests/adopt-pr-decision.test.mts` declares:
// that file stands at 785 lines of the 800 this repository holds every file
// to, and the two findings name nine outcomes between them. The cases here are
// the vocabulary and the wording — pure functions over a decision, and the two
// renderings they feed. The spawn that proves the same rendering end to end,
// through the real script against a throwaway repository, is the `typo` case
// in that file; invariant 6's "spawn the real script" is answered there, and
// `renderBody`/`renderDecisionComment` are exercised directly here for the
// same reason sections G and H of that file exercise the planner directly.
//
// Invariant 10: the gap vocabulary, the remedies and every expected sentence
// are written out here as literals. Nothing is imported from
// `scripts/lib/adopt/inventory.mts` and nothing is derived from the renderer:
// a pin that reuses the thing it pins cannot catch that thing drifting.
//
// Negative control: on the base `scripts/lib/adopt/decision.mts` exists and
// imports cleanly, so every case here fails on its own assertion rather than
// on a missing module — `classifyAccepted`, `nearestGap`, `tickShadowing` and
// `unrecognisedNotes` are not exported there, the accepted side renders a bare
// list, and `decidedByPhrase` has one wording for both shapes of `null`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finish, ROOT } from './lib/harness.mts';

/** The label a plan issue carries once the decision it asked for was made. */
const DECIDED_LABEL = 'human:decided';

/** The login the timeline names as having applied it. */
const DECIDED_BY = 'the-owner';

/** The login that applied `human:pending`, which never decides anything. */
const PENDING_BY = 'planner-bot';

/** The one adoption branch, written out rather than imported. */
const BRANCH = 'chore/adopt-agentic-setup';

/** Its slug — what `node scripts/proof.mts <slug>` is given. */
const SLUG = 'adopt-agentic-setup';

/** The plan issue number the rendered artefacts name. */
const PLAN_ISSUE = 41;

/**
 * Every gap name `scripts/lib/adopt/inventory.mts` defines, in its order,
 * written out by hand. This is the pin: the module under test writes the same
 * seven names and a `Record<Gap, …>` makes `npm run check` refuse a drift, and
 * a copy here is what catches the two lists agreeing with each other while
 * both are wrong.
 */
const VOCABULARY = [
  'ruleset:absent',
  'ruleset:review-not-required',
  'labels:missing',
  'hooks:not-installed',
  'workflows:missing',
  'test-command:none',
  'record:stale',
];

/** The one gap whose remedy is a file the adoption branch carries. */
const FILE_GAP = 'workflows:missing';

/** A gap whose remedy is not a file: accepting it performs nothing. */
const RECORDED_GAP = 'labels:missing';

/** What performs it, which is the thing the bare list dropped. */
const RECORDED_REMEDY = 'node scripts/init.mts';

/** The typo a person produces by dropping one character of `FILE_GAP`. */
const TYPO = 'workflow:missing';

/** A ticked name that is near nothing at all. */
const NONSENSE = 'everything:please';

type AcceptedGap = { gap: string; state: string; paths: string[]; remedy: string | null; nearest: string | null };
type DecisionRecord = { accepted: string[]; declined: string[]; decidedBy: string | null };

type Module = {
  KNOWN_GAPS?: readonly string[];
  GAP_REMEDIES?: Record<string, string>;
  nearestGap?: (name: string) => string | null;
  classifyAccepted?: (accepted: readonly string[]) => AcceptedGap[];
  tickShadowing?: (gap: string, accepted: readonly string[]) => string | null;
  unrecognisedNotes?: (record: DecisionRecord) => string[];
  decidedByPhrase?: (record: DecisionRecord, label: string) => string;
  decisionReport?: (record: DecisionRecord) => DecisionRecord & { ticks?: AcceptedGap[]; shadowed?: { gap: string; tick: string }[] };
  decidedBy?: (timeline: unknown, label: string) => string | null;
  renderDecisionComment?: (record: DecisionRecord, label: string, branch: string) => string;
};

let mod: Module | null = null;
try {
  mod = (await import('../scripts/lib/adopt/decision.mts')) as unknown as Module;
} catch {
  mod = null;
}

type PlannedFile = { path: string; content: string | null; outcome: string; reason: string };
type Plan = { files: PlannedFile[]; checks: string[] };
type PlanModule = {
  renderBody?: (plan: unknown, context: unknown) => string;
  planPullRequest?: (record: unknown, options: unknown) => Plan;
};

let planner: PlanModule | null = null;
try {
  planner = (await import('../scripts/lib/adopt/pr.mts')) as unknown as PlanModule;
} catch {
  planner = null;
}

// --- A: the vocabulary this module reports against --------------------------
check('classifyAccepted is exported', typeof mod?.classifyAccepted === 'function');
check('nearestGap is exported', typeof mod?.nearestGap === 'function');
check('tickShadowing is exported', typeof mod?.tickShadowing === 'function');
check('unrecognisedNotes is exported', typeof mod?.unrecognisedNotes === 'function');
check(
  'the vocabulary it reports against is the inventory’s seven gap names, in order',
  [...(mod?.KNOWN_GAPS ?? [])].join(',') === VOCABULARY.join(','),
  [...(mod?.KNOWN_GAPS ?? [])].join(',') || '(not exported)',
);
check(
  'every gap of that vocabulary has a named remedy, so no accepted gap is reported without one',
  VOCABULARY.every((gap) => typeof (mod?.GAP_REMEDIES ?? {})[gap] === 'string' && (mod?.GAP_REMEDIES ?? {})[gap].length > 0),
  JSON.stringify(mod?.GAP_REMEDIES ?? null),
);
check(
  'the remedy it names for the gap that blocks a landing is the command that creates the labels',
  ((mod?.GAP_REMEDIES ?? {})[RECORDED_GAP] ?? '').includes(RECORDED_REMEDY),
  (mod?.GAP_REMEDIES ?? {})[RECORDED_GAP] ?? '(no remedy)',
);

// --- B: the four outcomes a tick can have -----------------------------------
const classify = (accepted: string[]): AcceptedGap[] => {
  if (!mod?.classifyAccepted) return [];
  try {
    return mod.classifyAccepted(accepted);
  } catch {
    return [];
  }
};
const entryFor = (accepted: string[], gap: string): AcceptedGap | undefined => classify(accepted).find((e) => e.gap === gap);
const stateOf = (accepted: string[], gap: string): string => entryFor(accepted, gap)?.state ?? '(nothing)';

check(
  'an exact tick whose remedy is a file is carried',
  stateOf([FILE_GAP, RECORDED_GAP], FILE_GAP) === 'carried',
  JSON.stringify(classify([FILE_GAP, RECORDED_GAP])),
);
check(
  'an exact tick whose remedy is not a file is recorded, and names what performs it',
  stateOf([FILE_GAP, RECORDED_GAP], RECORDED_GAP) === 'recorded' &&
    (entryFor([FILE_GAP, RECORDED_GAP], RECORDED_GAP)?.remedy ?? '').includes(RECORDED_REMEDY),
  JSON.stringify(classify([FILE_GAP, RECORDED_GAP])),
);
check(
  'a near-miss tick is unrecognised, and the gap it was nearly is named',
  stateOf([TYPO], TYPO) === 'unrecognised' && entryFor([TYPO], TYPO)?.nearest === FILE_GAP,
  JSON.stringify(classify([TYPO])),
);
check(
  'a ticked name near nothing is unrecognised with no nearest gap',
  stateOf([NONSENSE], NONSENSE) === 'unrecognised' && entryFor([NONSENSE], NONSENSE)?.nearest === null,
  JSON.stringify(classify([NONSENSE])),
);
check(
  'nearestGap answers the same question on its own, and none of the seven is a near-miss of another',
  mod?.nearestGap?.(TYPO) === FILE_GAP &&
    mod?.nearestGap?.(NONSENSE) === null &&
    VOCABULARY.every((gap) => (mod?.nearestGap?.(gap) ?? gap) === gap),
  `${String(mod?.nearestGap?.(TYPO))} | ${String(mod?.nearestGap?.(NONSENSE))}`,
);
check(
  'a gap left untouched while a near-miss of its name was ticked is distinguishable from one simply left alone',
  mod?.tickShadowing?.(FILE_GAP, [TYPO]) === TYPO && mod?.tickShadowing?.(RECORDED_GAP, [TYPO]) === null,
  `${String(mod?.tickShadowing?.(FILE_GAP, [TYPO]))} | ${String(mod?.tickShadowing?.(RECORDED_GAP, [TYPO]))}`,
);

// --- C: the comment on the plan issue ---------------------------------------
// The body is hard-wrapped, so every assertion reads it unwrapped: a substring
// test over wrapped text passes a sentence that is not there.
const unwrap = (text: string): string => text.split('\n').join(' ').replace(/\s+/g, ' ');

const comment = (record: DecisionRecord): string => {
  if (!mod?.renderDecisionComment) return '';
  try {
    return mod.renderDecisionComment(record, DECIDED_LABEL, BRANCH);
  } catch {
    return '';
  }
};

/** The rendered line naming one gap, or '' when nothing names it. */
const lineFor = (text: string, gap: string): string =>
  text.split('\n').find((line) => line.trimStart().startsWith(`- \`${gap}\``)) ?? '';

const carriedAndRecorded = comment({ accepted: [FILE_GAP, RECORDED_GAP], declined: ['ruleset:absent'], decidedBy: DECIDED_BY });
check(
  'the comment says an accepted gap whose remedy is a file is carried in the diff',
  lineFor(carriedAndRecorded, FILE_GAP).includes('carried') && lineFor(carriedAndRecorded, FILE_GAP).includes('.github/workflows/'),
  lineFor(carriedAndRecorded, FILE_GAP) || carriedAndRecorded.slice(0, 400),
);
check(
  'the comment says an accepted gap whose remedy is not a file was recorded and not performed, and names the remedy',
  lineFor(carriedAndRecorded, RECORDED_GAP).includes('recorded') &&
    lineFor(carriedAndRecorded, RECORDED_GAP).includes('not performed') &&
    lineFor(carriedAndRecorded, RECORDED_GAP).includes(RECORDED_REMEDY),
  lineFor(carriedAndRecorded, RECORDED_GAP) || carriedAndRecorded.slice(0, 400),
);
check(
  'the accepted side is no longer a bare list: the two are rendered differently',
  lineFor(carriedAndRecorded, FILE_GAP) !== `- \`${FILE_GAP}\`` && lineFor(carriedAndRecorded, RECORDED_GAP) !== `- \`${RECORDED_GAP}\``,
  `${lineFor(carriedAndRecorded, FILE_GAP)} | ${lineFor(carriedAndRecorded, RECORDED_GAP)}`,
);

const typoAlone = comment({ accepted: [TYPO, RECORDED_GAP], declined: [FILE_GAP], decidedBy: DECIDED_BY });
check(
  'the comment names an unrecognised tick as one, without the run having refused it',
  unwrap(typoAlone).includes(`\`${TYPO}\``) && /unrecognised/i.test(typoAlone),
  typoAlone.slice(0, 600),
);
check(
  'and it names the untouched near-miss beside it, so the two facts are read together',
  unwrap(typoAlone).includes(FILE_GAP) && unwrap(lineFor(typoAlone, FILE_GAP)).includes(TYPO),
  `${lineFor(typoAlone, FILE_GAP)} || ${unwrap(typoAlone).slice(0, 600)}`,
);

const typoAndReal = comment({ accepted: [TYPO, FILE_GAP], declined: ['ruleset:absent'], decidedBy: DECIDED_BY });
check(
  'a near-miss ticked beside the box it was nearly is still named, and says the real box was ticked too',
  unwrap(typoAndReal).includes(`\`${TYPO}\``) && /ticked in its own right/.test(unwrap(typoAndReal)),
  unwrap(typoAndReal).slice(0, 700),
);
check(
  'and nothing in that comment reports the real gap as declined',
  lineFor(typoAndReal, FILE_GAP).includes('carried') && !unwrap(typoAndReal).includes(`\`${FILE_GAP}\` — left out`),
  lineFor(typoAndReal, FILE_GAP) || unwrap(typoAndReal).slice(0, 700),
);

const nonsense = comment({ accepted: [NONSENSE, FILE_GAP], declined: [], decidedBy: DECIDED_BY });
check(
  'a ticked name that is a near-miss of nothing says exactly that, rather than guessing',
  unwrap(nonsense).includes(`\`${NONSENSE}\``) && /near-miss of no gap name/.test(unwrap(nonsense)),
  unwrap(nonsense).slice(0, 700),
);
check(
  'a decision with no unrecognised tick carries no unrecognised section at all',
  !/unrecognised/i.test(comment({ accepted: [FILE_GAP], declined: [], decidedBy: DECIDED_BY })),
  comment({ accepted: [FILE_GAP], declined: [], decidedBy: DECIDED_BY }),
);

// --- D: the pull request body says the same three things --------------------
// The plan is written out here rather than planned: `renderBody` reads the
// files, the slug, the proof and the checks, and none of them is the subject
// of this file.
const RECORD_VALUE = {
  version: 1,
  stack: 'node',
  commands: { test: 'npm test', check: 'tsc' },
  checks: [],
  hooks: ['pre-push'],
  proof: { dir: 'proof' },
  labels: { source: 'scripts/init.mts' },
  generatedAt: '2026-01-01T00:00:00.000Z',
  generatedBy: 'agentic-setup/adopt',
};

const PLAN = {
  branch: BRANCH,
  slug: SLUG,
  files: [{ path: 'agentic.config.json', content: '{}\n', outcome: 'written', reason: 'generated' }],
  globs: ['agentic.config.json'],
  checks: [],
  proof: { slug: SLUG, command: 'npm test', source: 'record', declaration: `proof/${SLUG}.json` },
};

const body = (record: DecisionRecord): string => {
  if (!planner?.renderBody) return '';
  try {
    return planner.renderBody(PLAN, {
      issue: PLAN_ISSUE,
      defaultBranch: 'main',
      record: RECORD_VALUE,
      decision: record,
      decidedLabel: DECIDED_LABEL,
    });
  } catch {
    return '';
  }
};

const prBody = body({ accepted: [TYPO, RECORDED_GAP, FILE_GAP], declined: ['ruleset:absent'], decidedBy: DECIDED_BY });
check(
  'the pull request body distinguishes a carried gap from a recorded one, and names the remedy',
  lineFor(prBody, FILE_GAP).includes('carried') &&
    lineFor(prBody, RECORDED_GAP).includes('not performed') &&
    lineFor(prBody, RECORDED_GAP).includes(RECORDED_REMEDY),
  `${lineFor(prBody, FILE_GAP)} | ${lineFor(prBody, RECORDED_GAP)}`,
);
check(
  'the pull request body names the unrecognised tick as one',
  /unrecognised/i.test(prBody) && unwrap(prBody).includes(`\`${TYPO}\``),
  unwrap(prBody).slice(0, 800),
);
const prBodyShadow = body({ accepted: [TYPO, RECORDED_GAP], declined: [FILE_GAP], decidedBy: DECIDED_BY });
check(
  'the pull request body names the untouched near-miss beside the tick that missed it',
  unwrap(lineFor(prBodyShadow, FILE_GAP)).includes(TYPO),
  lineFor(prBodyShadow, FILE_GAP) || unwrap(prBodyShadow).slice(0, 800),
);
check(
  'the body still closes the plan issue on its first line',
  prBody.split('\n')[0] === `Closes #${PLAN_ISSUE}`,
  prBody.split('\n').slice(0, 2).join('\n'),
);

// --- E: the phrase for a decision nobody is named for -----------------------
// Both shapes of `decidedBy: null` are by design (item 33, Decision point 5):
// a timeline that names no such event, and a standing event that carries no
// actor. The old sentence — "no `labeled` event in this issue's timeline names
// who applied it" — is false about the second, which PR #396 introduced, and
// sends a reader looking for a missing event that is sitting there. The
// timeline never reaches this function, so the wording has to be true of both.
const phrase = (decidedBy: string | null): string => {
  if (!mod?.decidedByPhrase) return '';
  try {
    return mod.decidedByPhrase({ accepted: [FILE_GAP], declined: [], decidedBy }, DECIDED_LABEL);
  } catch {
    return '';
  }
};
check(
  'the phrase for a decision nobody is named for is true of both shapes of null',
  /no such event/.test(phrase(null)) && /no actor/.test(phrase(null)),
  phrase(null) || '(no phrase)',
);
check(
  'and it no longer claims the timeline names no event at all',
  phrase(null).length > 0 && !phrase(null).includes(`names who applied \`${DECIDED_LABEL}\``),
  phrase(null),
);
check(
  'a decision with a login still names that person and nothing else',
  phrase(DECIDED_BY).includes(`@${DECIDED_BY}`) && !/no such event/.test(phrase(DECIDED_BY)),
  phrase(DECIDED_BY),
);

// --- F: who decided is the LAST matching event's actor, absent or not -------
// Moved here from `tests/adopt-pr-decision.test.mts` to make room in that file
// for the spawn case this sweep adds: same subject as the phrase above — who
// the report says decided — and the timelines are literals of this file.
const who = (timeline: unknown): string | null | 'not-exported' => {
  if (!mod?.decidedBy) return 'not-exported';
  try {
    return mod.decidedBy(timeline, DECIDED_LABEL);
  } catch {
    return 'not-exported';
  }
};
const labeled = (name: string, login: string | null) => ({
  event: 'labeled',
  label: { name },
  ...(login === null ? {} : { actor: { login } }),
});

check('decidedBy is exported', typeof mod?.decidedBy === 'function');
check(
  'the last labeled event for the label is the one reported, not the first',
  who([labeled(DECIDED_LABEL, 'first-decider'), labeled(DECIDED_LABEL, DECIDED_BY)]) === DECIDED_BY,
  String(who([labeled(DECIDED_LABEL, 'first-decider'), labeled(DECIDED_LABEL, DECIDED_BY)])),
);
check(
  'an event for another label never decides',
  who([labeled(DECIDED_LABEL, DECIDED_BY), labeled('human:pending', PENDING_BY)]) === DECIDED_BY,
  String(who([labeled(DECIDED_LABEL, DECIDED_BY), labeled('human:pending', PENDING_BY)])),
);
check('a timeline naming no such event answers null', who([labeled('human:pending', PENDING_BY)]) === null, String(who([labeled('human:pending', PENDING_BY)])));
check('a timeline that is not a list answers null', who('not a list') === null && who(null) === null, `${who('not a list')} | ${who(null)}`);
check(
  'a last event with no actor answers null, never the earlier decider',
  who([labeled(DECIDED_LABEL, 'first-decider'), labeled(DECIDED_LABEL, null)]) === null,
  String(who([labeled(DECIDED_LABEL, 'first-decider'), labeled(DECIDED_LABEL, null)])),
);
check(
  'the same for an actor whose login is null rather than absent',
  who([labeled(DECIDED_LABEL, 'first-decider'), { event: 'labeled', label: { name: DECIDED_LABEL }, actor: { login: null } }]) === null,
  String(who([labeled(DECIDED_LABEL, 'first-decider'), { event: 'labeled', label: { name: DECIDED_LABEL }, actor: { login: null } }])),
);
check(
  'and an actorless event earlier in the timeline does not erase a later decider',
  who([labeled(DECIDED_LABEL, null), labeled(DECIDED_LABEL, DECIDED_BY)]) === DECIDED_BY,
  String(who([labeled(DECIDED_LABEL, null), labeled(DECIDED_LABEL, DECIDED_BY)])),
);

// --- G: the documentation says all of it (invariant 8) ----------------------
// Read as text and held to the sentences this change introduces, written out
// here rather than imported from anything that produces them.
const prDoc = readFileSync(join(ROOT, 'docs', 'adopt-pr.md'), 'utf8');
const item33 = readFileSync(join(ROOT, 'docs', 'decisions', '0033-a-tick-is-what-adoption-acts-on.md'), 'utf8');

check(
  'the document carries an accepted-gap table, the mirror of the declined one',
  prDoc.includes('| Accepted gap | What the pull request does |'),
  prDoc.split('\n').find((line) => line.startsWith('| Accepted gap')) ?? '(no accepted table)',
);
check(
  'it names the landing chain: an accepted labels:missing nobody ran leaves land.mts refusing',
  unwrap(prDoc).includes('review:not-approved') && unwrap(prDoc).includes('scripts/land.mts') && unwrap(prDoc).includes(RECORDED_REMEDY),
  '(landing chain)',
);
check(
  'it records which of the two answers the sequence question got, and why',
  /The sequence stays six steps/.test(unwrap(prDoc)),
  '(sequence decision)',
);
check(
  'it says an unrecognised tick is reported rather than refused, and where the vocabulary comes from',
  /unrecognised/i.test(prDoc) && unwrap(prDoc).includes('scripts/lib/adopt/inventory.mts'),
  '(unrecognised prose)',
);
check(
  'it documents the two fields the JSON gained, and no longer says the JSON carries none of it',
  unwrap(prDoc).includes('"ticks"') && unwrap(prDoc).includes('"shadowed"') && !/JSON is not part of this/.test(prDoc),
  unwrap(prDoc).split('```json')[1]?.slice(0, 300) ?? '(no JSON example)',
);
check(
  'it says what a second entry in GAP_PATHS would do to the same typo',
  unwrap(prDoc).includes('GAP_PATHS') && /a second entry/.test(unwrap(prDoc)),
  '(second entry prose)',
);
check(
  'the document describes both shapes of a decision nobody is named for, not just the empty timeline',
  unwrap(prDoc).includes('carries no actor') && unwrap(prDoc).includes('there is no such event'),
  unwrap(prDoc).split('`decidedBy` is `null`')[1]?.slice(0, 300) ?? '(no such paragraph)',
);
check(
  'and it says the comment names the remedy of a recorded gap and any tick nothing can act on',
  /the command that performs a gap nothing here performed/.test(unwrap(prDoc)),
  '(comment contents)',
);
check(
  'item 33 gains the forward direction of the cost it already carries, as a dated update',
  !item33.includes('*(none yet)*') && /## Updates/.test(item33) && unwrap(item33.split('## Updates')[1] ?? '').includes('2026-09-20'),
  (item33.split('## Updates')[1] ?? '(no Updates section)').slice(0, 400),
);
check(
  'and that update says the drift it names is now caught by npm run check',
  unwrap(item33.split('## Updates')[1] ?? '').includes('npm run check'),
  (item33.split('## Updates')[1] ?? '(no Updates section)').slice(0, 400),
);

// --- G2: the object the `--pr` JSON carries -------------------------------
// `decisionReport` is what `scripts/lib/adopt/pr-run.mts` emits under
// `decision`. It adds to the two lists rather than reshaping them: `accepted`
// and `declined` stay the names the person ticked, in their order, because
// that is what `docs/adopt-pr.md` documents and what any existing consumer
// reads. What is new is `ticks` — the classification, one entry per ticked box
// — and `shadowed`, the declined gaps a near-miss was ticked against.
type Reported = DecisionRecord & { ticks?: AcceptedGap[]; shadowed?: { gap: string; tick: string }[] };
const report = (record: DecisionRecord): Reported => {
  if (!mod?.decisionReport) return { accepted: ['(not exported)'], declined: [], decidedBy: null };
  try {
    return mod.decisionReport(record);
  } catch {
    return { accepted: ['(threw)'], declined: [], decidedBy: null };
  }
};

const RECORD_IN = { accepted: [TYPO, RECORDED_GAP], declined: [FILE_GAP, 'ruleset:absent'], decidedBy: DECIDED_BY };
const reported = report(RECORD_IN);
check('decisionReport is exported', typeof mod?.decisionReport === 'function');
check(
  'it keeps the two lists exactly as the boxes were ticked, in their order',
  (reported.accepted ?? []).join(',') === RECORD_IN.accepted.join(',') &&
    (reported.declined ?? []).join(',') === RECORD_IN.declined.join(',') &&
    reported.decidedBy === DECIDED_BY,
  JSON.stringify(reported),
);
check(
  'it carries one tick per accepted box, in the same order, each with its state',
  (reported.ticks ?? []).map((tick) => tick.gap).join(',') === RECORD_IN.accepted.join(',') &&
    (reported.ticks ?? []).map((tick) => tick.state).join(',') === 'unrecognised,recorded',
  JSON.stringify(reported.ticks),
);
check(
  'a consumer of the JSON alone can tell a carried gap from a recorded one',
  (report({ accepted: [FILE_GAP, RECORDED_GAP], declined: [], decidedBy: null }).ticks ?? [])
    .map((tick) => `${tick.gap}=${tick.state}`)
    .join(',') === `${FILE_GAP}=carried,${RECORDED_GAP}=recorded`,
  JSON.stringify(report({ accepted: [FILE_GAP, RECORDED_GAP], declined: [], decidedBy: null }).ticks),
);
check(
  'and a tick that names a gap from one that names nothing',
  (report({ accepted: [NONSENSE], declined: [], decidedBy: null }).ticks ?? [])[0]?.nearest === null &&
    (reported.ticks ?? [])[0]?.nearest === FILE_GAP,
  JSON.stringify(report({ accepted: [NONSENSE], declined: [], decidedBy: null }).ticks),
);
check(
  'the declined gap a near-miss was ticked against is named, and the one nobody aimed at is not',
  (reported.shadowed ?? []).length === 1 &&
    (reported.shadowed ?? [])[0]?.gap === FILE_GAP &&
    (reported.shadowed ?? [])[0]?.tick === TYPO,
  JSON.stringify(reported.shadowed),
);
check(
  'a decision with nothing mistyped reports no shadowed gap at all',
  (report({ accepted: [RECORDED_GAP], declined: [FILE_GAP], decidedBy: null }).shadowed ?? []).length === 0,
  JSON.stringify(report({ accepted: [RECORDED_GAP], declined: [FILE_GAP], decidedBy: null }).shadowed),
);
check(
  'it answers with a new object and never writes into the record it was handed',
  reported !== (RECORD_IN as unknown as Reported) &&
    Object.keys(RECORD_IN).join(',') === 'accepted,declined,decidedBy' &&
    RECORD_IN.accepted.join(',') === `${TYPO},${RECORDED_GAP}`,
  Object.keys(RECORD_IN).join(','),
);
check(
  'the JSON it produces survives a round trip, so what a consumer parses is what it built',
  JSON.stringify(JSON.parse(JSON.stringify(reported))) === JSON.stringify(reported),
  JSON.stringify(reported).slice(0, 300),
);

// --- I: only a *declined* box empties the checks ----------------------------
// Moved here from `tests/adopt-pr-decision.test.mts` with the sweep that split
// it: these prove the planner by importing it, and that file keeps the cases
// that spawn the real script.
//
// A planned workflow carries no content for three different reasons, and only
// one of them is a decision: `declined`, but also `unchanged` when the base
// already carries the generated file and `not-generated` when a person wrote
// it. (`planSettings` has three more, on `.claude/settings.json`, and none of
// them reaches a workflow — which is why the count is three and not six.)
// Reading "no content" as "declined" made the body say the box was left
// empty over a decision that ticked it — a false sentence about the decision,
// in the artefact whose purpose is recording the decision.
//
// The base content here is the planner's own first answer rather than an
// import of `renderWorkflows`: a second base that agreed with the generator
// by construction could not tell `unchanged` from anything else.

/** The planner's answer for one base reader, or `null` when it could not run. */
function planWith(baseFile: (path: string) => string | null, declined?: string[]): Plan | null {
  if (!planner?.planPullRequest) return null;
  try {
    return planner.planPullRequest(RECORD_VALUE, { root: ROOT, baseFile, ...(declined === undefined ? {} : { declined }) });
  } catch {
    return null;
  }
}

const isWorkflow = (file: PlannedFile): boolean => file.path.startsWith('.github/workflows/');
const fresh = planWith(() => null);
const generated = new Map((fresh?.files ?? []).filter(isWorkflow).map((file) => [file.path, file.content]));
check('the planner answers with the generated workflows at all', generated.size > 0 && fresh !== null, String(generated.size));

const unchanged = planWith((path) => generated.get(path) ?? null);
const unchangedWorkflows = (unchanged?.files ?? []).filter(isWorkflow);
check(
  'a base that already carries the generated workflows plans every one of them as skipped (unchanged)',
  unchangedWorkflows.length === generated.size && unchangedWorkflows.every((file) => file.reason === 'unchanged' && file.content === null),
  JSON.stringify(unchangedWorkflows.map((file) => file.reason)),
);
check(
  'and its checks are the ones the record renders: nobody declined anything',
  (unchanged?.checks ?? []).length > 0,
  (unchanged?.checks ?? []).join(','),
);

/** The body for a planned branch, with a decision that ticked every box. */
const bodyFor = (plan: Plan | null): string =>
  !planner?.renderBody || plan === null
    ? ''
    : planner.renderBody(plan, {
        issue: PLAN_ISSUE,
        defaultBranch: 'main',
        record: RECORD_VALUE,
        decision: { accepted: [...VOCABULARY], declined: [], decidedBy: DECIDED_BY },
        decidedLabel: DECIDED_LABEL,
      });

/** The sentence a body may only carry when a box really was left empty. */
const CLAIM = 'because the box for it was left empty';

const unchangedBody = unwrap(bodyFor(unchanged));
check(
  'the body of an unchanged-workflow branch never claims a box was left empty',
  unchangedBody.length > 0 && !unchangedBody.includes(CLAIM),
  unchangedBody.slice(0, 400),
);

const declinedPlan = planWith(() => null, [FILE_GAP]);
check(
  'a declined workflow box, and only that, empties the checks',
  (declinedPlan?.checks ?? ['x']).length === 0,
  (declinedPlan?.checks ?? []).join(','),
);
const declinedBody = unwrap(bodyFor(declinedPlan));
check(
  'and its body says so, as one unbroken sentence rather than three loose words',
  declinedBody.includes(CLAIM),
  declinedBody.slice(0, 600),
);

// --- H: what the flag does, said in both adoption documents (invariant 8) ---
// Moved here from `tests/adopt-pr-decision.test.mts` with the sweep that split
// that file: the prose pins of both adoption documents sit beside the ones
// above rather than in two places, and that file keeps the spawn cases.
const adoptDoc = readFileSync(join(ROOT, 'docs', 'adopt.md'), 'utf8');
const docs = `${adoptDoc}\n${prDoc}`;
check('the documentation says what a tick does and what leaving one empty does', /What a tick does/.test(adoptDoc) && /ticks decide/i.test(prDoc), 'tick prose');
check('it names the refusal a decided plan with nothing ticked gets', docs.includes('pr:plan-nothing-ticked') && docs.includes('plan:nothing-ticked'), 'nothing-ticked');
check('it names the two failures the decision record can have', docs.includes('pr:timeline-unreadable') && docs.includes('pr:decision-not-recorded'), 'named failures');
check('it says the decision is commented on the plan issue before the pull request is opened', /before .{0,40}pull request/i.test(prDoc) && /timeline/.test(prDoc), 'comment order');
check(
  'the bolded sentence about an existing label is narrowed to the label the inventory read saw',
  adoptDoc.includes('**A label the inventory read saw is left exactly as it is.**') &&
    !adoptDoc.includes('**A label the repository already has is left exactly as it is.**'),
  adoptDoc.split('\n').find((line) => line.startsWith('**A label')) ?? '(no such sentence)',
);

finish();
