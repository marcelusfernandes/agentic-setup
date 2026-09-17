#!/usr/bin/env node
// Cases for the three documents that govern writing an issue, running a phase and running a
// dogfood pass: skills/issue-and-pr/SKILL.md, docs/workflow.md and docs/dogfood/README.md.
// Four rules the writing steps already needed and nobody had written are stated there, and
// this file is what keeps them stated. Reads the real files; no process spawned, there is
// nothing to run — the shape of tests/orchestrate-card.test.mts.
//
// Every assertion runs against a *slice* of its document, never the whole file, because a
// sentence that has drifted into another section is not the rule the reader is owed where
// they are reading. `section()` bounds both ends on a structural marker — a top-level
// heading, matched with its leading newline so an inline mention of the same words cannot
// open or close a block — and **fails closed**: a missing start or a missing terminator
// returns the empty string, which fails every content case, rather than widening the slice
// to the end of the file and letting an assertion match text the section does not contain.
// That widening is a real failure mode, not a hypothetical one: it is how a sibling pin
// stayed green (17 passed) against a card its sentence had been deleted from. Each slice
// therefore also carries two standing guards — it is non-empty and shorter than its
// document, and it stops before a phrase that lives past its terminator.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finish, ROOT } from './lib/harness.mts';

const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

/**
 * The text between two top-level headings, both anchored on their leading newline.
 * Returns '' when either marker is absent — fail closed, never widen to the end of file.
 */
function section(doc: string, start: string, end: string): string {
  const from = doc.indexOf(start);
  if (from === -1) return '';
  const to = doc.indexOf(end, from + start.length);
  if (to === -1) return '';
  return doc.slice(from, to);
}

/** The two standing guards every slice carries: bounded at both ends, and short of the far marker. */
function guardSlice(label: string, doc: string, slice: string, beyond: string): void {
  check(`${label}: the slice is bounded at both ends`, slice.length > 0 && slice.length < doc.length, `slice length ${slice.length} of ${doc.length}`);
  check(`${label}: the slice stops before ${JSON.stringify(beyond)}`, slice.length > 0 && !slice.includes(beyond));
}

// --- skills/issue-and-pr/SKILL.md: the two rules for writing `## Files` -------------------
// The list of what CI and issue-lint hold an issue to lives under "Write sub-issues
// (planner)" and ends where the "Labels" heading starts.
const skill = read('skills', 'issue-and-pr', 'SKILL.md');
const planner = section(skill, '\n## Write sub-issues (planner)', '\n## Labels');
guardSlice('issue-and-pr planner section', skill, planner, 'goes back to the implementer');

// AC1: a criterion naming a symbol puts the file holding it in `## Files`, like an entry point.
check(
  'issue-and-pr: an acceptance criterion may name a symbol, and the rule is about that criterion',
  /acceptance criterion[\s\S]{0,160}?\bsymbol\b/i.test(planner),
);
check(
  'issue-and-pr: the rule says what a symbol is (a function, class or constant)',
  /function, class or constant/i.test(planner),
);
check(
  'issue-and-pr: a criterion naming a symbol names the file holding it in `## Files`',
  /\bsymbol\b[\s\S]{0,400}?names the file holding it in `## Files`/i.test(planner),
);
check(
  'issue-and-pr: the symbol rule is stated as the entry-point rule, not a new one',
  /the same way an entry point does/i.test(planner),
);
check(
  'issue-and-pr: the symbol rule says reuse by import rather than copy is what makes the file needed',
  /reuse by import[\s\S]{0,80}?rather than copy/i.test(planner),
);

// AC2: an issue renaming or re-owning a label, flag or command lists every document naming it.
check(
  'issue-and-pr: the rule names a rename or a re-ownership of a label, flag or command',
  /renames or re-owns a label, flag or command/i.test(planner),
);
check(
  'issue-and-pr: such an issue lists in `## Files` every document that names it',
  /lists in `## Files` every document that names it/i.test(planner),
);
check(
  'issue-and-pr: the rule says the point is not needing the grant after the fact',
  /renames or re-owns[\s\S]{0,700}?`authorised:`/i.test(planner),
);
check(
  'issue-and-pr: the rule names the search that finds those documents while the issue is written',
  /renames or re-owns[\s\S]{0,700}?git grep/i.test(planner),
);

// --- docs/workflow.md: an issue may carry no milestone ------------------------------------
const workflow = read('docs', 'workflow.md');
const milestones = section(workflow, '\n## Milestones', '\n## Labels');
guardSlice('workflow Milestones section', workflow, milestones, 'who changes it');

// AC3: the milestone-less case, and what then happens.
check(
  'workflow: an issue may carry no milestone at all',
  /an issue may carry no milestone/i.test(milestones),
);
check(
  'workflow: a milestone-less issue is claimed and landed with the scripts, by hand',
  /no milestone[\s\S]{0,700}?claimed and landed with the scripts[\s\S]{0,120}?by hand/i.test(milestones),
);
check(
  'workflow: the scripts named are claim and land',
  /no milestone[\s\S]{0,700}?claim\.mts[\s\S]{0,200}?land\.mts/i.test(milestones),
);
check(
  'workflow: `reconcile` does not see a milestone-less issue',
  /`?reconcile`?[^.]{0,120}does not see it/i.test(milestones),
);
check(
  'workflow: the reason reconcile does not see it is that it lists one milestone\'s issues',
  /--milestone[\s\S]{0,200}?does not see it/i.test(milestones),
);
check(
  'workflow: the issue that adds the milestone-less view is named',
  /no milestone[\s\S]{0,900}?#259/i.test(milestones),
);

// --- docs/dogfood/README.md: the disposable repository is private, prefixed and handed back
const dogfood = read('docs', 'dogfood', 'README.md');
const whoWrites = section(dogfood, '\n## Who writes one, and when', '\n## What keeps it honest');
guardSlice('dogfood "Who writes one" section', dogfood, whoWrites, 'already-required');

// AC4: private, a fixed name prefix, named in the PR body for a person to delete.
check(
  'dogfood README: the disposable repository is created private',
  /disposable repository[\s\S]{0,400}?\*\*private\*\*/i.test(whoWrites),
);
check(
  'dogfood README: the fixed name prefix is `agentic-setup-dogfood-`',
  /agentic-setup-dogfood-/.test(whoWrites) && /name prefix/i.test(whoWrites),
);
check(
  'dogfood README: the pull-request body names it under a line asking a person to delete it',
  /pull[- ]request body[\s\S]{0,200}?asking a person to delete it/i.test(whoWrites),
);
check(
  'dogfood README: the line a person reads is spelled out',
  /Delete after review:/.test(whoWrites),
);
check(
  'dogfood README: the reason an agent cannot delete it is `gh repo delete` being denied by design',
  /`gh repo delete`[\s\S]{0,120}?den(ied|y)[\s\S]{0,60}?by design/i.test(whoWrites),
);

finish();
