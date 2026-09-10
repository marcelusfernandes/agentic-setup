#!/usr/bin/env node
// Real helper + real git remote; GitHub and Codex responses are controlled CLI fixtures.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, commit, finish, git, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

const repo = tempRepo(); const origin = join(tempRepo(), 'origin.git'); const bin = join(repo, '.fixture-bin');
mkdirSync(bin);
const base = commit(repo, { 'answer.mts': 'export const answer = 1;\n', '.gitignore': '.fixture-bin/\n' }, 'initial');
git(['init', '--bare', '-q', origin], repo);
git(['remote', 'add', 'origin', origin], repo); git(['push', '-q', 'origin', 'main'], repo);
const store = join(bin, 'state.json'); const log = join(bin, 'calls.jsonl');
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
const file = process.env.LOOP_FIXTURE; const state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.LOOP_CALLS, JSON.stringify(args)+'\\n');
const output = value => console.log(JSON.stringify(value));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
if (state.fail) { console.error('simulated GitHub unavailable'); process.exit(1); }
if (args[0] === 'api') {
  const match = args[1].match(/issues\\/(\\d+)(\\/comments)?$/);
  if (match) {
    const item = state.issues[match[1]];
    if (!item) { console.error('not found'); process.exit(1); }
    output(match[2] ? [state.comments[match[1]] || []] : item);
  } else if (args[1].endsWith('/labels')) output([state.catalog || []]);
  else if (args[1].includes('/rules/branches/')) output(state.rules);
  else process.exit(3);
} else if (args[0] === 'repo') output({defaultBranchRef:{name:'main'}});
else if (args[0] === 'pr' && args[1] === 'list') output(Object.values(state.prs).filter(p => p.headRefName === args[args.indexOf('--head')+1]));
else if (args[0] === 'pr' && args[1] === 'checks') { if(state.checksUnreadable){console.error('checks unavailable');process.exit(1);} output(state.checks); process.exit(state.checks.some(c=>c.bucket==='pending')?8:0); }
else if (args[0] === 'pr' && args[1] === 'merge') {
  const pr = state.prs[args[2]];
  if (args[args.indexOf('--match-head-commit')+1] !== pr.headRefOid || state.rejectMerge) process.exit(1);
  pr.state=state.afterMerge || 'MERGED'; save();
} else if (args[0] === 'pr' && args[1] === 'view') output({state:state.prs[args[2]].state});
else if ((args[0] === 'issue' || args[0] === 'pr') && args[1] === 'edit') {
  state.editCount=(state.editCount||0)+1;
  if(state.failEditAt===state.editCount){save();console.error('simulated label edit failure');process.exit(1);}
  const record=args[0]==='issue'?state.issues[args[2]]:state.prs[args[2]];
  record.labels=record.labels||[];
  for(let i=3;i<args.length;i+=2){const name=args[i+1];if(args[i]==='--add-label'&&!record.labels.some(l=>l.name===name))record.labels.push({name});if(args[i]==='--remove-label')record.labels=record.labels.filter(l=>l.name!==name);}
  save();
}
else if (args[0] === 'label' && args[1] === 'create') {
  state.catalog=state.catalog||[]; state.catalog.push({name:args[2],description:args[args.indexOf('--description')+1],color:args[args.indexOf('--color')+1]}); save();
}
else if (args[0] === 'issue' && args[1] === 'close') { state.issues[args[2]].state='closed'; state.issues[args[2]].state_reason='completed'; save(); }
else { console.error('unexpected gh call: '+args.join(' ')); process.exit(3); }
`;
writeFileSync(join(bin, 'gh'), fakeGh); chmodSync(join(bin, 'gh'), 0o755);
const helper = join(ROOT, '.agents/skills/autonomous-loop/scripts/github.mts');
const runner = join(ROOT, '.agents/skills/autonomous-loop/scripts/run.mts');
const objective = (plan = '', checkpoints = '') => `## Goal\nMake answer return 2.\n## Success criteria\nThe acceptance test passes.\n## Boundaries\nLocal behavior only; no deployment.\n## Permissions\npublish: yes\nmerge: yes\n## Decision makers\n@owner\n## Plan\n${plan}\n## Checkpoints\n${checkpoints}\n`;
const task = (dependencies = '') => `## Goal\nReturn 2.\n## Acceptance criteria\n- [ ] answer equals 2\n## Validation\nnode --test answer.test.mts\n## Dependencies\n${dependencies}\n`;
const checkpoint = (blocks = 'all') => `## Question\nShould the public result change to 2?\n## Options\n1 or 2\n## Recommendation\n2\n## Impact\nExisting clients observe a new result.\n## Blocks\n${blocks}\n`;
const item = (number: number, body: string, state = 'open') => ({ number, title: `Item ${number}`, body, state, state_reason: state === 'closed' ? 'completed' : undefined, labels: [] as Array<{ name: string }> });
let fixture: any = { issues: { 1: item(1, objective()) }, comments: {}, prs: {}, rules: [], checks: [{ name: 'test', bucket: 'pass' }] };
const save = () => writeFileSync(store, JSON.stringify(fixture));
const refresh = () => { fixture = JSON.parse(readFileSync(store, 'utf8')); };
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOOP_FIXTURE: store, LOOP_CALLS: log };
function invoke(args: string[], script = helper) {
  const result = spawnSync(RUNTIME, [script, ...args], { cwd: repo, encoding: 'utf8', env });
  const output = result.stdout.trim().split('\n').at(-1) || '{}';
  let data: any; try { data = JSON.parse(output); } catch { data = {}; }
  return { code: result.status, data, out: `${result.stdout}${result.stderr}` };
}
const status = () => invoke(['status', '1']);
const humanAnswer = (revision: string, text = 'Use 2.', login = 'owner') => ({ body: `Decision ${revision}: ${text}`, html_url: 'https://github.com/example/repo/issues/3#issuecomment-1', user: { login, type: 'User' } });

save(); let r = status();
check('an empty objective asks for planning rather than reporting completion', r.data.status === 'planning', r.out);
fixture.issues[1].body = objective('- #2'); fixture.issues[2] = item(2, '## Goal\nReturn 2.'); save();
r = status(); check('a planned task with no criteria or validation needs specification', r.data.next?.state === 'needs_spec', r.out);
r = invoke(['claim', '1', '2']); check('unspecified work cannot claim a branch', r.code === 1 && !git(['ls-remote', '--heads', 'origin', 'codex/task-2'], repo), r.out);
fixture.issues[2].body = task(); save();
r = status(); check('specified work becomes ready without labels, milestones or globs', r.data.next?.state === 'ready', r.out);
fixture.issues[1].body = objective('- #2').replace('publish: yes', 'publish: no'); save();
r = invoke(['claim', '1', '2']); check('publication needs explicit permission', r.code === 1 && /not authorized/.test(r.out), r.out);
fixture.issues[1].body = objective('- #2', '- #3'); fixture.issues[3] = item(3, checkpoint()); save();
r = status(); const revision = r.data.checkpoints?.[0]?.revision;
check('an unanswered checkpoint blocks dependent execution', r.data.status === 'waiting_human' && typeof revision === 'string', r.out);
r = invoke(['claim', '1', '2']); check('claim rechecks human gates before pushing', r.code === 1 && !git(['ls-remote', '--heads', 'origin', 'codex/task-2'], repo), r.out);
fixture.issues[3].state = 'closed'; fixture.comments[3] = [humanAnswer(revision, 'Approved.', 'intruder')]; save();
r = status(); check('closing a checkpoint or an unauthorized answer does not approve it', r.data.status === 'waiting_human', r.out);
fixture.comments[3].push(humanAnswer(revision)); save();
r = status(); check('an explicit human answer unlocks the task and retains provenance', r.data.next?.number === 2 && r.data.checkpoints[0].answer?.author === 'owner', r.out);
r = status(); check('a fresh process recovers the accepted answer without a local state database', r.data.checkpoints[0].answer?.text === 'Use 2.', r.out);
const conditionalAnswer = 'Proceed.\nOnly after a manual backup; never migrate production.';
fixture.comments[3].push(humanAnswer(revision, conditionalAnswer)); save();
r = status(); check('multiline human conditions survive reconciliation in full', r.data.checkpoints[0].answer?.text === conditionalAnswer, r.out);
fixture.issues[3].body = checkpoint().replace('public result', 'public response contract'); save();
r = status(); check('editing the question invalidates prior approval', r.data.status === 'waiting_human' && r.data.checkpoints[0].revision !== revision, r.out);
fixture.issues[3].body = checkpoint(); fixture.issues[1].body = objective('- #2', '- #3').replace('no deployment', 'including production deployment'); save();
r = status(); check('broadening objective boundaries invalidates prior approval', r.data.status === 'waiting_human', r.out);
fixture.issues[1].body = objective('- #2', '- #3'); save();
r = invoke(['claim', '1', '2']); check('a claim creates the canonical remote branch', r.code === 0 && r.data.branch === 'codex/task-2', r.out);
check('branch starts at the default branch commit', git(['rev-parse', 'origin/codex/task-2'], repo) === base);
r = invoke(['claim', '1', '2']); check('repeat claim is held, not a second implementation', r.code === 2 && r.data.held === 2, r.out);
commit(repo, { 'unrelated.txt': 'main advanced\n' }, 'advance main'); git(['push', '-q', 'origin', 'main'], repo);
r = invoke(['claim', '1', '2']); check('claim never fast-forwards an existing lock when main advances', r.code === 2 && git(['rev-parse', 'origin/codex/task-2'], repo) === base, r.out);
git(['checkout', '-q', '-b', 'codex/task-2-r2', 'origin/codex/task-2'], repo);
r = status(); check('a retry branch needs no matching local/remote name or PID heuristic', r.data.next?.state === 'in_progress' && !('orphanWorktrees' in r.data), r.out);

fixture.issues[1].body = objective('- #2\n- #4\n- #5', '- #3'); fixture.issues[4] = item(4, task()); fixture.issues[5] = item(5, task('- #2')); fixture.issues[3].body = checkpoint('- #2'); save();
r = status(); check('a task-specific checkpoint allows independent work', r.data.next?.number === 4, r.out);
check('checkpoint blocks propagate to downstream dependencies', r.data.tasks.find((t: any) => t.number === 5)?.blockers.includes(3), r.out);
const scopedRevision = r.data.checkpoints[0].revision;
fixture.comments[3].push(humanAnswer(scopedRevision)); save();
r = invoke(['claim', '1', '4']); check('only one unblocked implementation can be active', r.code === 1 && /another task is active/.test(r.out), r.out);
fixture.issues[1].body = objective('- #2', '- #3'); save();

// Implement and validate in the real repo, then exercise PR review and landing gates.
const implemented = commit(repo, { 'answer.mts': 'export const answer = 2;\n', 'answer.test.mts': "import assert from 'node:assert/strict'; import { answer } from './answer.mts'; assert.equal(answer, 2);\n" }, 'implement answer');
const validation = spawnSync(RUNTIME, ['--test', 'answer.test.mts'], { cwd: repo, encoding: 'utf8' });
check('the implemented task passes its real acceptance test', validation.status === 0, validation.stderr);
git(['push', '-q', 'origin', 'HEAD:refs/heads/codex/task-2'], repo);
fixture.prs[20] = { number: 20, state: 'OPEN', headRefName: 'codex/task-2', headRefOid: implemented, baseRefName: 'main', reviewDecision: null, isDraft: false, isCrossRepository: false }; save();
fixture.prs[20].state = 'MERGED'; fixture.prs[20].baseRefName = 'temporary-feature'; save();
r = status(); check('a PR merged outside the default branch does not complete its task or objective', r.data.tasks[0]?.state !== 'done' && r.data.status !== 'ready_to_finish', r.out);
fixture.prs[20].state = 'OPEN'; fixture.prs[20].reviewDecision = 'APPROVED'; save();
r = invoke(['land', '1', '2']); check('an approved PR to another base cannot land', r.code === 1 && /integration branch/.test(r.out), r.out);
fixture.prs[20].baseRefName = 'main'; fixture.prs[20].reviewDecision = null; save();
r = invoke(['land', '1', '2']); check('unreviewed changes cannot merge', r.code === 1 && /approved/.test(r.out), r.out);
fixture.prs[20].reviewDecision = 'APPROVED'; save();
r = invoke(['land', '1', '2']); check('approval without server protection cannot merge', r.code === 1 && /server-required/.test(r.out), r.out);
fixture.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }, { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } }];
fixture.issues[1].body = objective('- #2', '- #3').replace('merge: yes', 'merge: no'); save();
r = invoke(['land', '1', '2']); check('changing merge permission also invalidates decision authority', r.code === 1, r.out);
fixture.issues[1].body = objective('- #2', '- #3'); fixture.checks[0].bucket = 'pending'; save();
r = invoke(['land', '1', '2']); check('pending CI is not queued for automatic merge', r.code === 1, r.out);
fixture.checks[0].bucket = 'pass'; fixture.rejectMerge = true; save();
r = invoke(['land', '1', '2']); check('server rejection remains a failure without bypass or retry', r.code === 1, r.out);
fixture.rejectMerge = false; save();
r = invoke(['land', '1', '2']); check('approved current-head code with passing protected checks merges', r.code === 0 && r.data.merged === 20, r.out); refresh();
const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const merges = calls.filter((args: string[]) => args[0] === 'pr' && args[1] === 'merge');
check('merge pins the reviewed commit and never uses admin, auto or branch deletion', merges.every((a: string[]) => a.includes(implemented) && !a.some((v) => ['--admin', '--auto', '--delete-branch'].includes(v))));
r = status(); check('a merged task progresses to objective verification', r.data.status === 'ready_to_finish', r.out);
r = invoke(['finish', '1']); check('empty completion claims are refused', r.code === 1, r.out);
const evidence = join(bin, 'evidence.md'); writeFileSync(evidence, `Acceptance passed at ${implemented}; PR #20 merged.\n`);
fixture.issues[1].body = objective('- #2', '- #3').replace('publish: yes', 'publish: no'); save();
const callsBeforeDeniedFinish = readFileSync(log, 'utf8').trim().split('\n').length;
r = invoke(['finish', '1', '--evidence', evidence]); refresh();
const deniedFinishCalls = readFileSync(log, 'utf8').trim().split('\n').slice(callsBeforeDeniedFinish).map((line) => JSON.parse(line));
check('finish needs explicit publication permission and leaves the objective open',
  r.code === 1 && /publication is not authorized/.test(r.out) && fixture.issues[1].state === 'open', r.out);
check('denied finish never posts evidence or closes the issue',
  !deniedFinishCalls.some((args: string[]) => args[0] === 'issue' && args[1] === 'close'));
fixture.issues[1].body = objective('- #2', '- #3'); save();
r = invoke(['finish', '1', '--evidence', evidence]); check('objective closes only with all tasks, decisions and evidence', r.code === 0 && r.data.status === 'complete', r.out); refresh();
r = status(); check('completion survives a fresh process', r.data.status === 'complete', r.out);

fixture.issues[1].state = 'open'; fixture.issues[2].state = 'closed'; fixture.issues[2].state_reason = 'not_planned'; save();
r = invoke(['finish', '1', '--evidence', evidence]); check('a cancelled task is not silently counted as completion', r.code === 1, r.out);
fixture.issues[2].state_reason = 'completed'; fixture.issues[1].body = objective('- #2', '- #3'); fixture.issues[3].body = checkpoint('all'); fixture.comments[3] = []; save();
r = invoke(['finish', '1', '--evidence', evidence]); check('unanswered checkpoints still block completion after tasks are done', r.code === 1, r.out);
fixture.fail = true; save(); r = invoke(['claim', '1', '2']); check('GitHub errors fail closed', r.code === 1 && /unavailable/.test(r.out), r.out); fixture.fail = false;
fixture.issues[1] = item(1, objective('- #2\n- #4')); fixture.issues[2] = item(2, task('- #4')); fixture.issues[4] = item(4, task('- #2')); fixture.prs = {}; save();
r = status(); check('dependency cycles block rather than allowing dispatch', r.data.status === 'blocked', r.out);
fixture.issues[1].state = 'closed'; save();
r = status(); check('premature goal closure is not reported as successful completion', r.data.status === 'blocked', r.out);
r = invoke(['claim', '1', '2']); check('a closed objective cannot dispatch work', r.code === 1, r.out);
fixture.issues[1] = item(1, objective('- #2\n- #4')); fixture.issues[2] = item(2, task('Blocked by: none')); fixture.issues[4] = item(4, task('Blocked by: #2')); save();
r = status(); check('legacy issue CI dependency lines preserve real dependency blocking', r.code === 0 && r.data.tasks[0].dependencies.length === 0 && r.data.tasks[1].blockers.includes(2), r.out);
fixture.issues[4].body = task('Blocked by: none\n- #2'); save();
r = status(); check('mixed legacy and native dependency formats fail closed', r.code === 1, r.out);

// Label projection is an explicit, permission-gated write; status remains read-only.
fixture = { issues: { 1: item(1, objective('- #2').replace('publish: yes', 'publish: no')), 2: item(2, task()) }, comments: {}, prs: {}, rules: [], checks: [], catalog: [] }; save();
const callsBeforeDenied = readFileSync(log, 'utf8').trim().split('\n').length;
r = invoke(['labels', '1']); refresh();
check('label reconciliation needs explicit publish permission', r.code === 1 && /not authorized/.test(r.out));
check('denied labels perform no GitHub writes', fixture.catalog.length === 0 && fixture.editCount === undefined &&
  readFileSync(log, 'utf8').trim().split('\n').slice(callsBeforeDenied).every((line) => !/"(edit|create)"/.test(line)));

fixture = { issues: { 1: item(1, objective('- #2', '- #3')), 2: item(2, task()), 3: item(3, checkpoint()) }, comments: {}, prs: {}, rules: [], checks: [], catalog: [
  { name: 'State:Ready', color: 'ffffff', description: 'keep existing catalog metadata' }, { name: 'type:feature', color: '000000' }
] };
fixture.issues[1].labels = [{ name: 'state:done' }, { name: 'scope:core' }];
fixture.issues[2].labels = [{ name: 'state:ready' }, { name: 'human' }];
fixture.issues[3].labels = [{ name: 'human' }]; // legacy label on a workflow-owned checkpoint: migrated, not preserved
const originalTitles = Object.values(fixture.issues).map((issue: any) => issue.title); save();
r = invoke(['labels', '1']); refresh();
check('labels replace conflicting managed state without title or unrelated-label mutation', r.code === 0 &&
  fixture.issues[1].labels.some((label: any) => label.name === 'state:blocked') &&
  fixture.issues[1].labels.some((label: any) => label.name === 'scope:core') &&
  !fixture.issues[1].labels.some((label: any) => label.name === 'state:done') &&
  JSON.stringify(Object.values(fixture.issues).map((issue: any) => issue.title)) === JSON.stringify(originalTitles), r.out);
check('pending checkpoint owns human:pending while tasks preserve manually added human',
  fixture.issues[3].labels.some((label: any) => label.name === 'human:pending') &&
  !fixture.issues[3].labels.some((label: any) => label.name === 'human') &&
  fixture.issues[2].labels.some((label: any) => label.name === 'human'));
check('both human states are seeded with distinct colours next to the legacy label',
  fixture.catalog.find((label: any) => label.name === 'human:pending')?.color === 'f9d0c4' &&
  fixture.catalog.find((label: any) => label.name === 'human:reviewed')?.color === 'c2e0c6' &&
  fixture.catalog.some((label: any) => label.name === 'human'));
check('existing label catalog metadata is preserved',
  fixture.catalog.find((label: any) => label.name.toLowerCase() === 'state:ready')?.description === 'keep existing catalog metadata' &&
  fixture.catalog.filter((label: any) => label.name.toLowerCase() === 'state:ready').length === 1);
r = status(); const labelRevision = r.data.checkpoints[0].revision;
fixture.comments[3] = [humanAnswer(labelRevision)]; save();
r = invoke(['labels', '1']); refresh();
const humanLabels = (record: any) => record.labels.map((label: any) => label.name).filter((name: string) => name.toLowerCase().startsWith('human')).sort();
check('recorded current-revision answer moves checkpoint to done and human:reviewed', r.code === 0 &&
  fixture.issues[3].labels.some((label: any) => label.name === 'state:done') &&
  JSON.stringify(humanLabels(fixture.issues[3])) === JSON.stringify(['human:reviewed']), r.out);
r = invoke(['labels', '1']); check('label reconciliation is idempotent', r.code === 0 && r.data.updated === 0, r.out);
fixture.issues[3].body = checkpoint().replace('public result', 'public response contract'); save();
r = invoke(['labels', '1']); refresh();
check('a new decision revision restores human:pending and removes human:reviewed', r.code === 0 &&
  fixture.issues[3].labels.some((label: any) => label.name === 'state:blocked') &&
  JSON.stringify(humanLabels(fixture.issues[3])) === JSON.stringify(['human:pending']), r.out);
r = status(); fixture.comments[3].push(humanAnswer(r.data.checkpoints[0].revision)); save();
r = invoke(['labels', '1']); refresh();
check('answering the new revision returns the checkpoint to human:reviewed', r.code === 0 &&
  JSON.stringify(humanLabels(fixture.issues[3])) === JSON.stringify(['human:reviewed']), r.out);
r = invoke(['labels', '1']); check('the reviewed state is idempotent too', r.code === 0 && r.data.updated === 0, r.out);

fixture.issues[2].labels = fixture.issues[2].labels.filter((label: any) => label.name !== 'human');
fixture.prs[20] = { number: 20, state: 'OPEN', headRefName: 'codex/task-2', headRefOid: base, baseRefName: 'main', reviewDecision: 'CHANGES_REQUESTED', isDraft: false, isCrossRepository: false, labels: [{ name: 'review:approved' }] }; save();
r = invoke(['labels', '1']); refresh();
check('changes requested projects qa-failed onto task, objective, and canonical PR', r.code === 0 &&
  [fixture.issues[1], fixture.issues[2], fixture.prs[20]].every((record: any) => record.labels.some((label: any) => label.name === 'state:qa-failed')));
fixture.prs[20].reviewDecision = null; fixture.checks = [{ name: 'test', bucket: 'fail' }]; save();
r = invoke(['labels', '1']); refresh();
check('failed required checks independently project qa-failed', r.code === 0 && fixture.prs[20].labels.some((label: any) => label.name === 'state:qa-failed'));
r = invoke(['land', '1', '2']); check('labels and legacy review labels cannot grant merge approval', r.code === 1 && /approved/.test(r.out), r.out);

fixture.prs[20].baseRefName = 'wrong-base'; fixture.checks = []; save();
r = invoke(['labels', '1']); refresh();
check('wrong-base canonical PR blocks its task, objective, and PR projection', r.code === 0 &&
  [fixture.issues[1], fixture.issues[2], fixture.prs[20]].every((record: any) => record.labels.some((label: any) => label.name === 'state:blocked')), r.out);
fixture.prs[20].baseRefName = 'main'; fixture.checks = [{ name: 'test', bucket: 'mystery' }]; fixture.editCount = 0; save();
r = invoke(['labels', '1']); refresh();
check('malformed check buckets fail closed before mutation', r.code === 1 && fixture.editCount === 0, r.out);
fixture.checksUnreadable = true; fixture.editCount = 0; save();
r = invoke(['labels', '1']); refresh();
check('unreadable QA preflight fails before every mutation', r.code === 1 && fixture.editCount === 0, r.out);
fixture.checksUnreadable = false; fixture.checks = []; fixture.editCount = 0; fixture.failEditAt = 2;
fixture.issues[1].labels = []; fixture.issues[2].labels = []; save();
r = invoke(['labels', '1']); refresh();
check('partial label API failure is reported rather than hidden', r.code === 1 && fixture.editCount === 2, r.out);
delete fixture.failEditAt; fixture.editCount = 0; save();
r = invoke(['labels', '1']); refresh();
check('retry converges after a partial label API failure', r.code === 0 &&
  fixture.issues[1].labels.some((label: any) => label.name === 'state:in-review') &&
  fixture.issues[2].labels.some((label: any) => label.name === 'state:in-review'), r.out);

fixture = { issues: { 1: item(1, objective('- #2\n- #4\n- #5')), 2: item(2, task(), 'closed'), 4: item(4, task()), 5: item(5, task('- #2')) }, comments: {}, prs: {}, rules: [], checks: [] };
fixture.issues[2].labels = [{ name: 'human' }, { name: 'state:done' }]; save();
r = status();
check('task human request blocks that task and transitive dependents despite forged state',
  r.data.tasks.find((entry: any) => entry.number === 2).blockers.includes(2) &&
  r.data.tasks.find((entry: any) => entry.number === 5).blockers.includes(2), r.out);
check('task human request leaves independent work actionable', r.data.next?.number === 4 && r.data.status === 'working', r.out);
fixture.issues[2].labels = [{ name: 'human:pending' }, { name: 'state:done' }]; save();
r = status(); check('task human:pending blocks exactly like the legacy label',
  r.data.tasks.find((entry: any) => entry.number === 5).blockers.includes(2) && r.data.humanRequests?.[0]?.label === 'human:pending', r.out);
fixture.issues[2].labels = [{ name: 'human:reviewed' }, { name: 'state:done' }]; save();
r = status(); check('task human:reviewed never blocks and creates no request',
  r.data.tasks.every((entry: any) => !entry.blockers.includes(2)) && r.data.humanRequests?.length === 0, r.out);
r = invoke(['labels', '1']); refresh();
check('reconciliation preserves a manually set human:reviewed on a task',
  r.code === 0 && fixture.issues[2].labels.some((label: any) => label.name === 'human:reviewed'), r.out);
fixture.issues[2].labels = [{ name: 'human' }, { name: 'state:done' }];
fixture.issues[2].state = 'open'; fixture.issues[2].state_reason = undefined; save();
r = invoke(['claim', '1', '2']); check('claim refuses a task with a human request', r.code === 1 && /not actionable/.test(r.out), r.out);
fixture.issues[1].labels = [{ name: 'human' }]; fixture.issues[2].labels = []; save();
r = status(); check('objective human request blocks every planned task', r.data.status === 'waiting_human' &&
  r.data.tasks.every((entry: any) => entry.blockers.includes(1)) && r.data.humanRequests?.[0]?.kind === 'objective', r.out);

fixture = { issues: { 1: item(1, objective('- #2')), 2: item(2, task()) }, comments: {}, prs: {}, rules: [], checks: [] };
fixture.prs[20] = { number: 20, state: 'OPEN', headRefName: 'codex/task-2', headRefOid: base, baseRefName: 'main', reviewDecision: 'APPROVED', isDraft: false, isCrossRepository: false, labels: [{ name: 'human' }, { name: 'state:done' }] }; save();
r = status(); check('canonical PR human request blocks land regardless of approval or state labels',
  r.data.status === 'waiting_human' && r.data.humanRequests?.some((request: any) => request.kind === 'pr' && request.number === 20), r.out);
r = invoke(['land', '1', '2']); check('land refuses a canonical PR with a human request', r.code === 1 && /not actionable/.test(r.out), r.out);
fixture.prs[20].labels = [{ name: 'human:reviewed' }]; save();
r = status(); check('canonical PR human:reviewed is not a request', r.data.humanRequests?.length === 0 && r.data.status !== 'waiting_human', r.out);
r = invoke(['land', '1', '2']); check('land passes the human gate for a reviewed PR', !/not actionable/.test(r.out), r.out);

fixture = { issues: { 1: item(1, objective('- #2', '- #3')), 2: item(2, task()), 3: item(3, checkpoint()) }, comments: {}, prs: {}, rules: [], checks: [] }; save();
r = status(); const staleRevision = r.data.checkpoints[0].revision;
check('unanswered checkpoint remains a gate without its human label', r.data.status === 'waiting_human', r.out);
fixture.comments[3] = [humanAnswer(staleRevision)]; fixture.issues[3].labels = [{ name: 'Human' }]; save();
r = status(); check('answered checkpoint stale human label does not create an ad hoc request',
  r.data.status === 'working' && r.data.humanRequests?.length === 0, r.out);
r = invoke(['labels', '1']); refresh(); check('label reconciliation replaces case-variant stale human on an answered checkpoint with human:reviewed',
  r.code === 0 && !fixture.issues[3].labels.some((label: any) => label.name.toLowerCase() === 'human') &&
  fixture.issues[3].labels.some((label: any) => label.name === 'human:reviewed'), r.out);
fixture.issues[2].state = 'closed'; fixture.issues[2].state_reason = 'completed'; fixture.issues[2].labels = [{ name: 'human' }]; save();
r = invoke(['finish', '1', '--evidence', evidence]); check('finish refuses human requests on completed tasks', r.code === 1 && /human|planning|tasks|decisions/.test(r.out), r.out);
fixture = { issues: { 1: item(1, objective('- #2')), 2: item(2, task('- #99'), 'closed'), 99: item(99, task(), 'closed') }, comments: {}, prs: {}, rules: [], checks: [] };
fixture.issues[99].labels = [{ name: 'human' }]; save();
r = status(); check('closed external prerequisite human request blocks its dependent and finish',
  r.data.status === 'waiting_human' && r.data.tasks[0].blockers.includes(99) &&
  r.data.humanRequests?.some((request: any) => request.kind === 'dependency' && request.number === 99), r.out);
r = invoke(['finish', '1', '--evidence', evidence]); check('finish refuses unresolved human request on external prerequisite', r.code === 1, r.out);
fixture.issues[99].labels = [{ name: 'human:reviewed' }]; save();
r = status(); check('a reviewed external prerequisite no longer blocks its dependent',
  r.data.status === 'ready_to_finish' && !r.data.tasks[0].blockers.includes(99) && r.data.humanRequests?.length === 0, r.out);
r = invoke(['finish', '1', '--evidence', evidence]); check('finish passes a reviewed external prerequisite', r.code === 0, r.out);

// A third-party pilot must stay on its explicit integration branch, never main.
const pilotBranch = 'test/openrouter';
git(['push', '-q', 'origin', `HEAD:refs/heads/${pilotBranch}`], repo);
const pilotObjective = (plan = '- #6', checkpoints = '', branch = pilotBranch) => `${objective(plan, checkpoints)}\n## Integration branch\n${branch}\n`;
fixture = { issues: { 1: item(1, pilotObjective()), 6: item(6, task()), 3: item(3, checkpoint()) }, comments: {}, prs: {}, checks: [{ name: 'test', bucket: 'pass' }], rules: [] }; save();
for (const emptyBranch of ['', '   ']) {
  fixture.issues[1].body = pilotObjective('- #6', '', emptyBranch); save();
  r = status(); check('a present empty integration branch refuses instead of selecting main', r.code === 1 && /nonempty/.test(r.out), r.out);
  r = invoke(['claim', '1', '6']); check('an empty pilot destination cannot publish a task branch', r.code === 1 && !git(['ls-remote', '--heads', 'origin', 'codex/task-6'], repo), r.out);
}
fixture.issues[1].body = objective('- #6') + '\n```markdown\n## Integration branch\n\n```\n'; save();
r = status(); check('a fenced example is not an explicit integration branch heading', r.code === 0 && r.data.integrationBranch === 'main', r.out);
fixture.issues[1].body = pilotObjective(); save();
r = status(); check('an objective can pin an existing test branch while main stays the default', r.code === 0 && r.data.integrationBranch === pilotBranch && r.data.defaultBranch === 'main', r.out);
r = invoke(['claim', '1', '6']); check('pilot claim starts at the test branch commit rather than main', r.code === 0 && git(['rev-parse', 'origin/codex/task-6'], repo) === implemented && git(['rev-parse', 'origin/main'], repo) !== implemented, r.out);
fixture.prs[60] = { number: 60, state: 'MERGED', headRefName: 'codex/task-6', headRefOid: implemented, baseRefName: 'main', reviewDecision: 'APPROVED', isDraft: false, isCrossRepository: false }; save();
r = status(); check('a merge to main does not complete a task scoped to the pilot branch', r.data.tasks[0]?.state !== 'done' && r.data.status !== 'ready_to_finish', r.out);
fixture.issues[6].state = 'closed'; fixture.issues[6].state_reason = 'completed'; save();
r = status(); check('issue closure cannot disguise a PR merged into the wrong integration branch', r.data.tasks[0]?.state !== 'done' && r.data.status !== 'ready_to_finish', r.out);
fixture.issues[6].state = 'open'; fixture.issues[6].state_reason = undefined;
fixture.prs[60].state = 'OPEN'; save();
r = invoke(['land', '1', '6']); check('pilot landing refuses a PR targeting main', r.code === 1 && /integration branch/.test(r.out), r.out);
fixture.prs[60].baseRefName = pilotBranch; save();
r = invoke(['land', '1', '6']); check('using a test branch does not bypass server-required review or checks', r.code === 1 && /server-required/.test(r.out), r.out);
fixture.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }, { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } }]; save();
r = invoke(['land', '1', '6']); check('protected pilot PR can land on the authorized branch', r.code === 0 && r.data.merged === 60, r.out); refresh();
r = status(); check('pilot merge counts even if GitHub leaves the non-default-base task issue open', fixture.issues[6].state === 'open' && r.data.status === 'ready_to_finish', r.out);
fixture.issues[1].body = pilotObjective('- #6', '- #3'); save();
r = status(); const pilotRevision = r.data.checkpoints[0].revision;
fixture.comments[3] = [humanAnswer(pilotRevision)]; save();
r = status(); check('pilot human answer is accepted for its recorded branch', r.data.checkpoints[0].answer?.author === 'owner', r.out);
fixture.issues[1].body = pilotObjective('- #6', '- #3', 'main'); save();
r = status(); check('changing the integration branch invalidates human answers', !r.data.checkpoints[0].answer && r.data.checkpoints[0].revision !== pilotRevision, r.out);
fixture.issues[1].body = pilotObjective('- #6', '', 'test/missing'); save();
r = invoke(['claim', '1', '6']); check('a missing test branch refuses mutation without falling back to main', r.code === 1 && /does not exist/.test(r.out), r.out);
fixture.issues[1].body = pilotObjective('- #6', '', '--help'); save();
r = status(); check('integration branch must be a valid literal git branch name', r.code === 1, r.out);
fixture.issues[1].body = pilotObjective('- #6', '', 'codex/task-6'); save();
r = status(); check('a task branch cannot become its own integration destination', r.code === 1 && /task branch/.test(r.out), r.out);

// Headless driver uses the same state helper; fake Codex makes observable transitions.
const fakeCodex = `#!/usr/bin/env node
const fs=require('node:fs'); const a=process.argv.slice(2); const p=process.env.LOOP_FIXTURE; const s=JSON.parse(fs.readFileSync(p,'utf8'));
s.codexCalls=(s.codexCalls||0)+1; s.codexArgs=a;
let status=s.runnerStatus||'continue';
if(s.runnerScenario==='complete' && s.codexCalls===2){s.issues[1].state='closed';s.issues[2].state='closed';status='complete';}
fs.writeFileSync(p,JSON.stringify(s));
const file=a[a.indexOf('-o')+1]; fs.writeFileSync(file,JSON.stringify({status,objective:s.wrongGoal?999:1,summary:'Fixture transition '+s.codexCalls}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:60,output_tokens:20,reasoning_output_tokens:5}}));
`;
writeFileSync(join(bin, 'codex'), fakeCodex); chmodSync(join(bin, 'codex'), 0o755);
fixture = { issues: { 1: item(1, objective('- #2')), 2: item(2, task()) }, comments: {}, prs: {}, rules: [], checks: [{ name: 'test', bucket: 'pass' }], runnerScenario: 'complete' }; save();
r = invoke(['1', '--max-turns', '3', '--profile', 'loop-test'], runner); refresh();
check('the headless loop advances across transitions without per-pass approval', r.code === 0 && r.data.status === 'complete' && fixture.codexCalls === 2, r.out);
check('usage is recorded from events including cache and reasoning', r.data.usage?.input_tokens === 200 && r.data.usage?.cached_input_tokens === 120 && r.data.usage?.output_tokens === 40, r.out);
check('runner uses a schema and preserves the chosen profile without overriding sandbox or approvals', fixture.codexArgs.includes('--output-schema') && fixture.codexArgs[fixture.codexArgs.indexOf('--profile') + 1] === 'loop-test' && !fixture.codexArgs.some((v: string) => ['--sandbox', '--ask-for-approval', '--dangerously-bypass-approvals-and-sandbox'].includes(v)));
r = invoke(['1'], runner); refresh(); check('an already completed objective consumes no further model calls', fixture.codexCalls === 2 && r.data.turns === 0, r.out);
fixture.issues[1] = item(1, objective('- #2', '- #3')); fixture.issues[2] = item(2, task()); fixture.issues[3] = item(3, checkpoint()); fixture.comments = {}; save();
r = invoke(['1'], runner); refresh(); check('waiting for a human consumes no model turns', r.data.status === 'waiting_human' && r.data.turns === 0 && fixture.codexCalls === 2, r.out);
fixture = { issues: { 1: item(1, objective('- #2')), 2: item(2, task()) }, comments: {}, prs: {}, rules: [], checks: [{ name: 'test', bucket: 'pass' }], codexCalls: 0 };
fixture.issues[2].labels = [{ name: 'human' }]; save();
r = invoke(['1'], runner); refresh(); check('runner stops for ad hoc human request without a model turn',
  r.data.status === 'waiting_human' && r.data.turns === 0 && fixture.codexCalls === 0 && /task #2.*human/.test(r.data.summary), r.out);
fixture.issues[1] = item(1, objective('- #2')); fixture.issues[2].labels = []; fixture.runnerScenario = ''; fixture.codexCalls = 0; save();
fixture.prs[20] = { number: 20, state: 'OPEN', headRefName: 'codex/task-2', headRefOid: implemented, baseRefName: 'main', reviewDecision: 'APPROVED', isDraft: false, isCrossRepository: false };
fixture.checks[0].bucket = 'pending'; save();
r = invoke(['1'], runner); refresh(); check('pending required CI consumes no model turns', r.data.status === 'waiting_ci' && r.data.turns === 0 && fixture.codexCalls === 0, r.out);
fixture.prs = {}; fixture.checks[0].bucket = 'pass'; save();
r = invoke(['1', '--max-turns', '2'], runner); check('the runner stops at its budget without declaring completion', r.code === 2 && r.data.status === 'limit' && r.data.turns === 2, r.out); refresh();
fixture.runnerStatus = 'complete'; save(); r = invoke(['1'], runner); check('a model completion claim must match persistent state', r.code === 1 && /without closing/.test(r.out), r.out);
fixture.runnerStatus = 'waiting_human'; save(); r = invoke(['1'], runner); check('human waits require a persisted checkpoint', r.code === 1 && /persist/.test(r.out), r.out);
fixture.runnerStatus = 'continue'; fixture.wrongGoal = true; save(); r = invoke(['1'], runner); check('a response for another objective is rejected', r.code === 1 && /invalid Codex result/.test(r.out), r.out);

finish();
