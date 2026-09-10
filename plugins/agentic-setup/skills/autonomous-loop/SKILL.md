---
name: autonomous-loop
description: Run or resume an authorized GitHub objective through planning, specification, implementation and review in Codex, pausing for consequential human decisions. Use for an autonomous development loop, not an ordinary one-off edit.
---

# Autonomous loop

Own the objective until its success criteria are met, a human decision is needed,
or an operational blocker has no useful next step. Continue after each task; do not
invent another objective when this one is complete. Use one coordinator and one
implementation at a time. The main agent may both plan and implement.

## Start and recover

- Read [the contract](references/contract.md) when starting a new objective or when
  its format is unfamiliar. GitHub is the durable state; conversation memory is not.
- Locate `scripts/github.mts` relative to this skill's directory. Run
  `node <skill-dir>/scripts/github.mts status <objective-number>` from the target repo.
- Read the objective's goal, success criteria and boundaries. Existing user approval
  persists. Starting this loop authorizes routine publication and merge after validation
  and review within those boundaries, unless the user explicitly restricts them. Record
  `publish: yes` and `merge: yes` once; do not ask again for each PR. Preserve explicit
  restrictions and current human decisions. Installing the plugin starts no objective.
- When publishing is authorized, run `labels <objective-number>` after reconciliation
  and each durable transition to keep GitHub status labels current. Keep descriptive
  titles: no `[ ]`, `[x]` or status prefixes. Checkboxes belong only in acceptance criteria.
- For a test-branch pilot, record its exact name under `Integration branch` before
  claiming work. Target that branch in PRs; never silently substitute the default branch.
- On restart, read the selected task, relevant accepted decisions and its branch/PR.
  Verify ownership of an existing session before resuming its work. Never infer that
  a worktree is abandoned from its name or a missing remote branch; never delete it
  automatically. A subagent does not imply a separate worktree.

## Advance the objective

1. **Plan:** keep a short roadmap in the objective's `Plan`. Detail the next useful
   task, not the whole speculative backlog. Read the planning templates in the contract.
2. **Specify:** give that task acceptance criteria and proportionate validation.
   File hints guide discovery; overlapping paths mean sequence the work. Dependencies
   express real prerequisites. Update the spec when a decision changes it.
3. **Implement:** re-read `status`, then `claim <objective> <task>` when publishing is
   authorized. A `held` result is not permission to take another session's work.
   Work on the returned branch in an isolated checkout; reuse a verified inactive
   session/worktree on restart. Include documentation and necessary manifests in the
   same change. Add regression tests when they demonstrate the changed behavior; a
   `test(red):` commit and a negative-control run are not universal requirements.
4. **Review:** validate, then open a PR to the integration branch with `Closes #<task>`. Use an independent
   review context for code intended to merge autonomously (Codex review or a reviewer
   subagent). Give it the spec, relevant decisions and diff, not the implementer's
   reasoning history. A local review is not a GitHub approval: publish the review
   under the configured separate reviewer identity. If missing reviewer access or
   repository policy needs a human decision, record a scoped `human` checkpoint for
   that setup; do not turn every routine PR into a new permission request.
5. **Land:** `land <objective> <task>` enforces the merge permission, unresolved
   `human` requests/checkpoints, current-head approval and required server checks. Never bypass a
   refusal with a direct merge. When CI/review is pending, use a waiting mechanism
   or return `waiting_ci`; do not repeatedly ask the model to poll unchanged state.
6. **Reconcile:** read `status` again, incorporate evidence and take the next task.
   After all tasks, verify the objective's success criteria. Use
   `finish <objective> --evidence <file>` only with concrete completion evidence.
   Synchronize labels after finishing too. If label writes fail, report the partial
   update and retry `labels`, not a successful claim or merge.

## Human decisions and bounded recovery

- Checkpoint a material product/scope decision, irreversible architectural commitment,
  production/data action, or cost/access beyond what the user authorized. Local
  implementation choices and test repairs remain autonomous.
- Present the question, recommendation, alternatives, consequences and which tasks
  depend on it. Record a checkpoint using the contract before dependent work proceeds.
  An unanswered or merely closed checkpoint is not approval. Continue independent work.
- A `human` label on the objective blocks all work; on a task or its PR it blocks that
  task and its dependents. Turn such requests into scoped, linked checkpoints before
  resuming. Remove the source `human` only after a real answer, with decision provenance.
  Never clear the label merely to unblock execution. Technical failures call for repair,
  not a new merge-permission question; escalate only a concrete missing human decision.
- Record a user's explicit answer with its source; never manufacture a decision from
  silence, a recommendation, elapsed time or a tool's success. Reuse accepted answers
  while the question and objective boundaries remain unchanged.
- Persist failed attempts and evidence in task comments. After two failed repair
  attempts without new evidence, return `blocked` with the smallest missing decision
  or resource. If a person must decide or supply it, record a linked `human` checkpoint.
  A restart does not reset this budget. A new human direction can.
- Keep updates short. Return one of `continue`, `waiting_human`, `waiting_ci`,
  `blocked`, or `complete`, with the objective number and a concise summary. When a
  headless runner requests one bounded transition, return `continue` after that
  transition; otherwise keep advancing until a terminal/waiting condition.
