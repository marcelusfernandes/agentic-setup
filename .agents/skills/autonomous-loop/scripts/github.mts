#!/usr/bin/env node
// GitHub is the state store. Reads fail closed; no local state or worktree cleanup.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

type Issue = { number: number; title: string; body: string | null; state: string; state_reason?: string; pull_request?: unknown; labels?: Array<{ name: string }> };
type Comment = { body: string; html_url: string; user: { login: string; type: string } };
type PR = { number: number; state: string; headRefName: string; headRefOid: string; baseRefName: string; reviewDecision: string | null; isDraft: boolean; isCrossRepository: boolean; labels?: Array<{ name: string }> };
type Checkpoint = { number: number; title: string; revision: string; blocks: 'all' | number[]; reply: string; answer: { text: string; author: string; url: string } | null; labels: string[] };
type Task = { number: number; title: string; branch: string; state: string; missing: string[]; dependencies: number[]; blockers: number[]; pr: PR | null; labels: string[] };

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')}: ${(result.stderr || result.error?.message || result.stdout || 'failed').trim().slice(0, 600)}`);
  return result.stdout.trim();
}
function gh<T>(args: string[]): T { return JSON.parse(run('gh', args)) as T; }
const api = <T,>(path: string): T => gh<T>(['api', `repos/{owner}/{repo}/${path}`]);
function section(body: string, name: string, absent = ''): string {
  // Ignore fenced examples; duplicate contract headings are ambiguous, not last-wins.
  let fence = ''; let active = false; let found = false; const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = ''; continue; }
    if (fence) continue;
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      active = heading[1].toLowerCase() === name.toLowerCase();
      if (active && found) throw new Error(`duplicate ## ${name}`);
      if (active) found = true;
    } else if (active) out.push(line);
  }
  return found ? out.join('\n').trim() : absent;
}
function refs(text: string): number[] {
  if (!text || /^none$/i.test(text)) return [];
  return [...new Set(text.split('\n').filter((l) => l.trim()).map((line) => {
    const match = line.trim().match(/^-\s+#([1-9]\d*)(?:\s|$)/);
    if (!match) throw new Error(`expected a '- #123' issue entry: ${line}`);
    return Number(match[1]);
  }))];
}
const branchFor = (number: number) => `codex/task-${number}`;
function dependencyRefs(text: string): number[] {
  // Existing adopters may still have CI requiring the legacy dependency line.
  const legacy = text.match(/^Blocked by: *(none|#[1-9]\d*(?: *, *#[1-9]\d*)*)$/i);
  return legacy ? refs(/^none$/i.test(legacy[1]) ? '' : legacy[1].split(',').map((n) => `- ${n.trim()}`).join('\n')) : refs(text);
}
const finished = (issue: Issue) => issue.state === 'closed' && issue.state_reason !== 'not_planned';
function issue(number: number): Issue {
  const value = api<Issue>(`issues/${number}`);
  if (value.pull_request || value.number !== number || !['open', 'closed'].includes(value.state)) throw new Error(`#${number} is not a readable issue`);
  return value;
}
function snapshot(goalNumber: number) {
  const goal = issue(goalNumber); const body = goal.body ?? '';
  const defaultBranch = gh<{ defaultBranchRef: { name: string } }>(['repo', 'view', '--json', 'defaultBranchRef']).defaultBranchRef?.name;
  if (!defaultBranch) throw new Error('repository has no default branch');
  const integrationBranch = section(body, 'Integration branch', defaultBranch);
  if (!integrationBranch) throw new Error('Integration branch must be nonempty when present');
  if (run('git', ['check-ref-format', '--branch', integrationBranch]) !== integrationBranch) throw new Error('integration branch must be a literal branch name');
  if (!run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${integrationBranch}`])) throw new Error('integration branch does not exist on origin');
  for (const name of ['Goal', 'Success criteria', 'Boundaries']) if (!section(body, name)) throw new Error(`objective is missing ## ${name}`);
  const permissions = section(body, 'Permissions');
  const allowed = (name: string) => new RegExp(`^${name}: yes$`, 'mi').test(permissions) && !new RegExp(`^${name}: no$`, 'mi').test(permissions);
  const humans = [...section(body, 'Decision makers').matchAll(/@([a-z\d-]+)/gi)].map((m) => m[1].toLowerCase());
  if (!humans.length) throw new Error('objective needs human logins under ## Decision makers');
  const taskNumbers = refs(section(body, 'Plan')); const checkpointNumbers = refs(section(body, 'Checkpoints'));
  if ([...taskNumbers, ...checkpointNumbers].includes(goalNumber) || taskNumbers.some((n) => checkpointNumbers.includes(n))) throw new Error('objective, tasks and checkpoints must be different issues');
  if (taskNumbers.some((number) => branchFor(number) === integrationBranch)) throw new Error('integration branch cannot be a task branch in this objective');
  const authority = [...['Goal', 'Success criteria', 'Boundaries', 'Permissions', 'Decision makers'].map((h) => section(body, h)), integrationBranch];
  const checkpoints: Checkpoint[] = checkpointNumbers.map((number) => {
    const item = issue(number); const text = item.body ?? '';
    for (const name of ['Question', 'Options', 'Recommendation', 'Impact', 'Blocks']) if (!section(text, name)) throw new Error(`checkpoint #${number} is missing ## ${name}`);
    const rawBlocks = section(text, 'Blocks');
    const blocks = rawBlocks === 'all' ? 'all' as const : refs(rawBlocks);
    if (blocks !== 'all' && (!blocks.length || blocks.some((n) => !taskNumbers.includes(n)))) throw new Error(`checkpoint #${number} names an unknown task`);
    const revision = createHash('sha256').update(JSON.stringify([goalNumber, authority, number, item.title, text])).digest('hex').slice(0, 12);
    const pages = gh<Comment[][]>(['api', `repos/{owner}/{repo}/issues/${number}/comments`, '--paginate', '--slurp']);
    if (!Array.isArray(pages) || pages.some((p) => !Array.isArray(p))) throw new Error(`unreadable comments for checkpoint #${number}`);
    const match = pages.flat().filter((c) => c.user?.type === 'User' && humans.includes(c.user.login.toLowerCase()))
      .map((c) => ({ comment: c, answer: c.body.match(new RegExp(`^Decision ${revision}: ([\\s\\S]+)$`))?.[1].trim() }))
      .filter((c) => c.answer).at(-1);
    return { number, title: item.title, revision, blocks, reply: `Decision ${revision}: <answer>`, labels: (item.labels ?? []).map((label) => label.name),
      answer: match ? { text: match.answer!, author: match.comment.user.login, url: match.comment.html_url } : null };
  });
  const tasks: Task[] = taskNumbers.map((number) => {
    const item = issue(number); const text = item.body ?? ''; const branch = branchFor(number);
    // `Proof` is the Claude route's name for the `Validation` section; either non-empty heading specifies the task.
    const specified = (h: string) => Boolean(section(text, h).trim()) || (h === 'Validation' && Boolean(section(text, 'Proof').trim()));
    const missing = ['Goal', 'Acceptance criteria', 'Validation'].filter((h) => !specified(h));
    const dependencies = dependencyRefs(section(text, 'Dependencies'));
    const prs = gh<PR[]>(['pr', 'list', '--head', branch, '--state', 'all', '--limit', '100', '--json', 'number,state,headRefName,headRefOid,baseRefName,reviewDecision,isDraft,isCrossRepository,labels']);
    if (!Array.isArray(prs) || prs.length === 100) throw new Error(`ambiguous PR list for #${number}`);
    const own = prs.filter((p) => !p.isCrossRepository && p.headRefName === branch);
    const open = own.filter((p) => p.state === 'OPEN');
    if (open.length > 1) throw new Error(`multiple open PRs for #${number}`);
    const pr = open[0] ?? own.find((p) => p.state === 'MERGED' && p.baseRefName === integrationBranch) ?? null;
    const remote = run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    const completedWithoutPR = finished(item) && !own.some((p) => ['OPEN', 'MERGED'].includes(p.state));
    const state = item.state_reason === 'not_planned' ? 'cancelled' : pr?.state === 'MERGED' || completedWithoutPR ? 'done'
      : missing.length ? 'needs_spec' : pr ? (pr.reviewDecision === 'APPROVED' ? 'waiting_ci' : 'review') : remote ? 'in_progress' : 'ready';
    return { number, title: item.title, branch, missing, dependencies, blockers: [], pr, state, labels: (item.labels ?? []).map((label) => label.name) };
  });
  // Exact names only: `human:reviewed` records a past decision and never gates.
  const pendingHuman = (labels: string[]) => labels.find((label) => PENDING_HUMAN.has(label.toLowerCase())) ?? null;
  const humanRequests: Array<{ kind: 'objective' | 'task' | 'pr' | 'dependency'; number: number; label: string; blocks: 'all' | number[] }> = [];
  const goalHuman = pendingHuman((goal.labels ?? []).map((label) => label.name));
  if (goalHuman) humanRequests.push({ kind: 'objective', number: goalNumber, label: goalHuman, blocks: 'all' });
  for (const task of tasks) {
    const taskHuman = pendingHuman(task.labels);
    if (taskHuman) humanRequests.push({ kind: 'task', number: task.number, label: taskHuman, blocks: [task.number] });
    const prHuman = task.pr ? pendingHuman((task.pr.labels ?? []).map((label) => label.name)) : null;
    if (task.pr && prHuman) humanRequests.push({ kind: 'pr', number: task.pr.number, label: prHuman, blocks: [task.number] });
  }
  const pending = checkpoints.filter((c) => !c.answer);
  const global = pending.filter((c) => c.blocks === 'all').map((c) => c.number);
  for (const task of tasks) {
    task.blockers = pending.filter((c) => c.blocks === 'all' || c.blocks.includes(task.number)).map((c) => c.number);
    task.blockers.push(...humanRequests.filter((request) => request.blocks === 'all' || request.blocks.includes(task.number)).map((request) => request.number));
    for (const dep of task.dependencies) {
      if (dep === goalNumber || dep === task.number) throw new Error(`task #${task.number} depends on itself or its objective`);
      const other = tasks.find((t) => t.number === dep); const decision = checkpoints.find((c) => c.number === dep);
      if (other ? other.state !== 'done' : decision ? !decision.answer : (() => {
        const external = issue(dep); const externalHuman = pendingHuman((external.labels ?? []).map((label) => label.name));
        if (externalHuman) {
          const request = humanRequests.find((entry) => entry.kind === 'dependency' && entry.number === dep);
          if (request && request.blocks !== 'all') request.blocks.push(task.number);
          else humanRequests.push({ kind: 'dependency', number: dep, label: externalHuman, blocks: [task.number] });
        }
        return !finished(external) || externalHuman;
      })()) task.blockers.push(dep);
    }
  }
  // A pending decision also blocks dependents of already merged tasks.
  for (let pass = 0; pass < tasks.length; pass++) for (const task of tasks) {
    task.blockers = [...new Set([...task.blockers, ...task.dependencies.flatMap((n) => tasks.find((t) => t.number === n)?.blockers ?? [])])];
  }
  const actionable = tasks.filter((t) => t.state !== 'done' && t.state !== 'cancelled' && !t.blockers.length);
  const next = actionable.find((t) => ['in_progress', 'review', 'waiting_ci'].includes(t.state)) ?? actionable[0] ?? null;
  const allDone = tasks.length > 0 && tasks.every((t) => t.state === 'done') && !pending.length && !humanRequests.length;
  const status = goal.state === 'closed' ? (goal.state_reason !== 'not_planned' && allDone ? 'complete' : 'blocked')
    : !tasks.length && !global.length && !humanRequests.length ? 'planning'
    : allDone ? 'ready_to_finish'
    : next ? (next.state === 'waiting_ci' ? 'waiting_ci' : 'working') : pending.length ? 'waiting_human' : 'blocked';
  const projectedStatus = status === 'blocked' && humanRequests.length ? 'waiting_human' : status;
  return { goal: goalNumber, title: goal.title, defaultBranch, integrationBranch, status: projectedStatus, closed: goal.state === 'closed', labels: (goal.labels ?? []).map((label) => label.name), permissions: { publish: allowed('publish'), merge: allowed('merge') }, next,
    tasks, checkpoints, humanRequests, successCriteria: section(body, 'Success criteria') };
}

const LABELS = [
  ['state:ready', 'Ready for the next authorized transition', '1d76db'],
  ['state:in-progress', 'Implementation is in progress', 'fbca04'],
  ['state:in-review', 'Awaiting review, checks, or objective verification', '5319e7'],
  ['state:qa-failed', 'Review or required checks need repair', 'd73a4a'],
  ['state:blocked', 'Blocked by specification, dependency, cancellation, or decision', 'b60205'],
  ['state:done', 'Completed from verified GitHub state', '0e8a16'],
  ['human:pending', 'A human decision is required; affected work is paused', 'f9d0c4'],
  ['human:reviewed', 'A human decision was recorded; kept as the audit trail', 'c2e0c6'],
  ['human', 'Legacy alias of human:pending', 'c5def5'],
] as const;
// Gate labels, matched by exact name. Bare `human` predates the two states and still pauses work.
const PENDING_HUMAN = new Set(['human', 'human:pending']);
const HUMAN_STATES = new Set([...PENDING_HUMAN, 'human:reviewed']);
const STATES = new Set(LABELS.filter(([name]) => name.startsWith('state:')).map(([name]) => name));

function qaFailed(pr: PR | null): boolean {
  if (!pr || pr.state !== 'OPEN') return false;
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return true;
  const result = spawnSync('gh', ['pr', 'checks', String(pr.number), '--required', '--json', 'name,bucket'], { encoding: 'utf8', timeout: 60_000 });
  let checks: Array<{ name: string; bucket: string }>;
  try { checks = JSON.parse(result.stdout || 'null'); } catch { throw new Error('required checks cannot be read'); }
  const buckets = new Set(['pass', 'fail', 'pending', 'skipping', 'cancel']);
  if (![0, 1, 8].includes(result.status ?? -1) || !Array.isArray(checks)
    || checks.some((check) => !check || typeof check.name !== 'string' || !buckets.has(check.bucket))) {
    throw new Error('required checks cannot be read');
  }
  return checks.some((check) => ['fail', 'cancel'].includes(check.bucket));
}

function reconcileLabels(state: ReturnType<typeof snapshot>) {
  if (!state.permissions.publish) throw new Error('label publication is not authorized by the objective');
  type Target = { kind: 'issue' | 'pr'; number: number; labels: string[]; desired: string; human?: 'human:pending' | 'human:reviewed' };
  const qa = new Map<number, boolean>();
  for (const task of state.tasks) if (task.pr) qa.set(task.pr.number, qaFailed(task.pr));
  const taskState = (task: Task) => task.state === 'done' ? 'state:done'
    : task.pr?.state === 'OPEN' && task.pr.baseRefName !== state.integrationBranch ? 'state:blocked'
    : task.blockers.length || ['needs_spec', 'cancelled'].includes(task.state) ? 'state:blocked'
    : task.state === 'ready' ? 'state:ready' : task.state === 'in_progress' ? 'state:in-progress'
    : task.pr && qa.get(task.pr.number) ? 'state:qa-failed' : 'state:in-review';
  const objectivePR = state.next?.pr ?? null;
  const objectiveState = state.status === 'complete' ? 'state:done' : state.status === 'planning' ? 'state:ready'
    : ['waiting_human', 'blocked'].includes(state.status) ? 'state:blocked'
    : objectivePR?.state === 'OPEN' && objectivePR.baseRefName !== state.integrationBranch ? 'state:blocked'
    : objectivePR && qa.get(objectivePR.number) ? 'state:qa-failed'
    : objectivePR ? 'state:in-review'
    : ['waiting_ci', 'ready_to_finish'].includes(state.status) ? 'state:in-review' : 'state:in-progress';
  const targets: Target[] = [{ kind: 'issue', number: state.goal, labels: state.labels, desired: objectiveState }];
  for (const task of state.tasks) {
    const desired = taskState(task);
    targets.push({ kind: 'issue', number: task.number, labels: task.labels, desired });
    if (task.pr) targets.push({ kind: 'pr', number: task.pr.number, labels: (task.pr.labels ?? []).map((label) => label.name),
      desired: task.pr.state === 'MERGED' ? 'state:done' : desired });
  }
  for (const checkpoint of state.checkpoints) targets.push({ kind: 'issue', number: checkpoint.number,
    labels: checkpoint.labels, desired: checkpoint.answer ? 'state:done' : 'state:blocked', human: checkpoint.answer ? 'human:reviewed' : 'human:pending' });
  const pages = gh<Array<Array<{ name: string }>>>(['api', 'repos/{owner}/{repo}/labels', '--paginate', '--slurp']);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error('repository labels cannot be read');
  const existing = new Set(pages.flat().map((label) => label.name.toLowerCase()));
  for (const [name, description, color] of LABELS) if (!existing.has(name.toLowerCase())) {
    run('gh', ['label', 'create', name, '--description', description, '--color', color]);
  }
  let updated = 0;
  for (const target of targets) {
    const remove = target.labels.filter((label) => STATES.has(label.toLowerCase() as typeof LABELS[number][0]) && label.toLowerCase() !== target.desired);
    // Human states are owned by the workflow on checkpoint issues only; elsewhere they are preserved as found.
    if (target.human) remove.push(...target.labels.filter((label) => HUMAN_STATES.has(label.toLowerCase()) && label.toLowerCase() !== target.human));
    const present = new Set(target.labels.map((label) => label.toLowerCase()));
    const add = [target.desired, ...(target.human ? [target.human] : [])].filter((label) => !present.has(label));
    if (!add.length && !remove.length) continue;
    run('gh', [target.kind, 'edit', String(target.number), ...add.flatMap((label) => ['--add-label', label]),
      ...[...new Set(remove)].flatMap((label) => ['--remove-label', label])]);
    updated++;
  }
  return { goal: state.goal, updated, labels: LABELS.map(([name]) => name) };
}

function main() {
  const [command, rawGoal, rawTask, ...extra] = process.argv.slice(2);
  if (!['status', 'labels', 'claim', 'land', 'finish'].includes(command) || !/^[1-9]\d*$/.test(rawGoal ?? '')) throw new Error('usage: github.mts status|labels|claim|land|finish <objective> [task | --evidence file]');
  const state = snapshot(Number(rawGoal));
  if (command === 'status') return state;
  if (command === 'labels') {
    if (rawTask || extra.length) throw new Error('labels accepts only an objective number');
    return reconcileLabels(state);
  }
  if (state.closed) throw new Error('objective is closed; inspect its completion or cancellation before proceeding');
  if (command === 'finish') {
    if (!state.permissions.publish) throw new Error('objective completion publication is not authorized');
    if (state.status !== 'ready_to_finish') throw new Error('objective still needs planning, tasks or human answers');
    if (rawTask !== '--evidence' || extra.length !== 1) throw new Error('finish requires --evidence <file>');
    const evidence = readFileSync(extra[0], 'utf8').trim();
    if (!evidence) throw new Error('completion evidence is empty');
    run('gh', ['issue', 'close', rawGoal, '--reason', 'completed', '--comment', evidence]);
    if (issue(Number(rawGoal)).state !== 'closed') throw new Error('objective closure not confirmed');
    return { status: 'complete', goal: state.goal };
  }
  if (!/^[1-9]\d*$/.test(rawTask ?? '') || extra.length) throw new Error(`${command} requires a task number`);
  const task = state.tasks.find((t) => t.number === Number(rawTask));
  if (!task || task.blockers.length || ['done', 'cancelled', 'needs_spec'].includes(task.state)) throw new Error('task is not actionable; inspect status');
  if (command === 'claim') {
    if (!state.permissions.publish) throw new Error('publication is not authorized by the objective');
    if (task.pr) throw new Error('task already has a PR');
    if (state.tasks.some((t) => t.number !== task.number && !t.blockers.length && ['in_progress', 'review', 'waiting_ci'].includes(t.state))) throw new Error('another task is active; finish or pause it before claiming');
    const base = state.integrationBranch;
    run('git', ['fetch', 'origin']);
    const ref = `refs/heads/${task.branch}`;
    const push = spawnSync('git', ['push', '--porcelain', `--force-with-lease=${ref}:`, 'origin', `refs/remotes/origin/${base}:${ref}`], { encoding: 'utf8', timeout: 60_000 });
    if (push.status === 0 && (push.stdout ?? '').split('\n').some((l) => l.startsWith('*\t'))) return { claimed: task.number, branch: task.branch };
    if ((push.stdout ?? '').split('\n').some((l) => l.startsWith('=\t')) || /\[rejected\]|cannot lock ref|already exists/.test(`${push.stdout}${push.stderr}`)) {
      process.exitCode = 2; return { held: task.number, branch: task.branch };
    }
    throw new Error((push.stderr || push.error?.message || 'branch claim failed').trim().slice(0, 600));
  }
  if (!state.permissions.merge) throw new Error('merge is not authorized by the objective');
  const pr = task.pr;
  if (!pr || pr.state !== 'OPEN' || pr.isDraft || pr.reviewDecision !== 'APPROVED' || pr.baseRefName !== state.integrationBranch) throw new Error('task needs an approved, non-draft PR to the objective integration branch');
  const rules = api<Array<{ type: string; parameters?: { required_status_checks?: unknown[]; required_approving_review_count?: number; dismiss_stale_reviews_on_push?: boolean } }>>(`rules/branches/${encodeURIComponent(pr.baseRefName)}`);
  if (!rules.some((r) => r.type === 'required_status_checks' && r.parameters?.required_status_checks?.length)
    || !rules.some((r) => r.type === 'pull_request' && (r.parameters?.required_approving_review_count ?? 0) > 0 && r.parameters?.dismiss_stale_reviews_on_push)) throw new Error('automatic merge needs server-required checks and review with stale approvals dismissed');
  const checks = gh<Array<{ name: string; bucket: string }>>(['pr', 'checks', String(pr.number), '--required', '--json', 'name,bucket']);
  if (!checks.length || checks.some((c) => c.bucket !== 'pass')) throw new Error('required checks are not all passing');
  run('gh', ['pr', 'merge', String(pr.number), '--squash', '--match-head-commit', pr.headRefOid]);
  const after = gh<{ state: string }>(['pr', 'view', String(pr.number), '--json', 'state']);
  if (after.state !== 'MERGED') throw new Error('merge not confirmed; reconcile before retrying');
  return { merged: pr.number, task: task.number, goal: state.goal };
}
try { console.log(JSON.stringify(main())); }
catch (error) { console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
