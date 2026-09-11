---
name: Task
about: One unit of work for one agent in one worktree
title: "<type>(<scope>): <short goal>"
labels: ["state:ready"]
---

## Context
Why it exists. Links to the spec, the report, or the code it changes (`file:line`).

## Goal
One verifiable sentence.

## Acceptance criteria
- [ ] AC1 … (with the test that proves it)
- [ ] AC2 …

## Proof
The test command and what it covers. (`## Validation`, the Codex route's name for this section, is accepted instead.)
Negative control: which assertions must fail before the change (the `negative-control` check verifies this).

## Files
Globs this issue may touch (the `scope` check enforces them; one or more per bullet, backticked):
- `src/...`
- `tests/...`

## Dependencies
Blocked by: #N (or "none")
