#!/usr/bin/env node
// Bounded headless execution. GitHub owns workflow state; files below are audit logs.
// Fail closed on subprocess/schema/state errors. Honor Codex's configured permissions.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Result = { status: 'continue' | 'waiting_human' | 'waiting_ci' | 'blocked' | 'complete'; objective: number; summary: string };
type Snapshot = { goal: number; status: string; next: { pr: { number: number } | null } | null; checkpoints: Array<{ number: number; answer: unknown; reply: string }>; humanRequests: Array<{ kind: string; number: number; label: string }> };
const here = dirname(fileURLToPath(import.meta.url));

function state(goal: number): Snapshot {
  const r = spawnSync(process.execPath, [join(here, 'github.mts'), 'status', String(goal)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const data = JSON.parse(r.stdout || '{}');
  if (r.status !== 0 || data.error || data.goal !== goal) throw new Error(data.error || 'could not reconcile objective');
  return data;
}

async function main() {
  const [rawGoal, ...args] = process.argv.slice(2);
  if (!/^[1-9]\d*$/.test(rawGoal ?? '')) throw new Error('usage: run.mts <objective> [--max-turns N] [--profile name]');
  const goal = Number(rawGoal); let maxTurns = 12; let profile: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value || !['--max-turns', '--profile'].includes(args[i])) throw new Error('unknown or incomplete option');
    if (args[i] === '--profile') profile = value;
    else { if (!/^[1-9]\d*$/.test(value) || Number(value) > 100) throw new Error('--max-turns must be 1..100'); maxTurns = Number(value); }
  }
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (root.status !== 0) throw new Error('run from inside the target git repository');
  process.chdir(root.stdout.trim());
  const gitPath = spawnSync('git', ['rev-parse', '--git-path', 'agentic-runs'], { encoding: 'utf8' });
  if (gitPath.status !== 0) throw new Error('cannot locate run logs');
  const logsRoot = resolve(gitPath.stdout.trim());
  mkdirSync(logsRoot, { recursive: true });
  const logs = mkdtempSync(join(logsRoot, `${goal}-`));
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  const started = Date.now(); let turns = 0;
  const finish = (result: Result | { status: 'limit'; objective: number; summary: string }) => {
    const report = { ...result, turns, usage, duration_ms: Date.now() - started, logs };
    appendFileSync(join(logs, 'summary.json'), `${JSON.stringify(report)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(report));
    if (result.status === 'blocked' || result.status === 'limit') process.exitCode = 2;
  };
  for (; turns < maxTurns;) {
    const before = state(goal);
    if (before.status === 'complete') return finish({ status: 'complete', objective: goal, summary: 'Objective completion confirmed by GitHub.' });
    if (before.status === 'waiting_human') return finish({ status: 'waiting_human', objective: goal,
      summary: [...before.checkpoints.filter((c) => !c.answer).map((c) => `checkpoint #${c.number}: ${c.reply}`),
        ...before.humanRequests.map((request) => `${request.kind} #${request.number}: human decision requested (${request.label})`)].join('; ') });
    if (before.status === 'blocked') return finish({ status: 'blocked', objective: goal, summary: 'Reconcile dependencies, cancelled tasks or the closed objective before resuming.' });
    if (before.status === 'waiting_ci' && before.next?.pr) {
      const checks = spawnSync('gh', ['pr', 'checks', String(before.next.pr.number), '--required', '--json', 'name,bucket'], { encoding: 'utf8' });
      // Pending CI needs no model turn. Failed checks need a repair; errors must surface.
      const entries = JSON.parse(checks.stdout || 'null');
      if (!Array.isArray(entries) || !entries.length) throw new Error('required checks cannot be read or are not configured');
      if (entries.some((c) => c.bucket === 'pending') && !entries.some((c) => ['fail', 'cancel'].includes(c.bucket))) {
        return finish({ status: 'waiting_ci', objective: goal, summary: `PR #${before.next.pr.number} has pending required checks.` });
      }
    }
    turns++;
    const resultFile = join(logs, `${turns}.result.json`);
    const jsonl = join(logs, `${turns}.jsonl`);
    const stderr = join(logs, `${turns}.stderr.log`);
    const prompt = `Use $autonomous-loop at ${join(here, '..', 'SKILL.md')} for objective #${goal}. `
      + 'Perform one bounded transition of the authorized loop, recording durable progress in GitHub. '
      + 'Reconcile first; read the task and decision evidence you need. Return the requested JSON. '
      + 'Use continue only after concrete progress; persist checkpoints before returning waiting_human. '
      + 'Do not approve your own checkpoint, reset repair budgets, broaden permissions or create another objective.';
    const command = ['exec', '--cd', process.cwd(), '--json', '--output-schema', join(here, 'result.schema.json'), '-o', resultFile,
      ...(profile ? ['--profile', profile] : []), prompt];
    let partial = ''; let interrupted = false;
    const code = await new Promise<number>((resolveCode, reject) => {
      const child = spawn('codex', command, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = () => { interrupted = true; child.kill('SIGINT'); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      const clear = () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); };
      child.stdout.on('data', (chunk: Buffer) => {
        appendFileSync(jsonl, chunk, { mode: 0o600 }); partial += chunk.toString();
        const lines = partial.split('\n'); partial = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'turn.completed') for (const key of Object.keys(usage) as Array<keyof typeof usage>) {
              const value = event.usage?.[key]; if (typeof value === 'number' && value >= 0) usage[key] += value;
            }
          } catch { /* Non-event output is retained in the log, not injected into context. */ }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => appendFileSync(stderr, chunk, { mode: 0o600 }));
      child.on('error', (error) => { clear(); reject(error); });
      child.on('close', (exitCode) => { clear(); resolveCode(exitCode ?? 1); });
    });
    if (interrupted || code !== 0) throw new Error(`Codex ${interrupted ? 'interrupted' : `exited ${code}`}; durable state remains in GitHub; logs: ${logs}`);
    const result = JSON.parse(readFileSync(resultFile, 'utf8')) as Result;
    if (!result || result.objective !== goal || typeof result.summary !== 'string'
      || !['continue', 'waiting_human', 'waiting_ci', 'blocked', 'complete'].includes(result.status)) throw new Error(`invalid Codex result; logs: ${logs}`);
    const after = state(goal);
    if (result.status === 'complete' && after.status !== 'complete') throw new Error(`Codex claimed completion without closing the verified objective; logs: ${logs}`);
    if (result.status === 'waiting_human' && !after.checkpoints.some((c) => !c.answer) && !after.humanRequests.length) throw new Error(`Codex did not persist its checkpoint or human request; logs: ${logs}`);
    if (result.status !== 'continue') return finish(result);
    console.log(JSON.stringify({ status: 'continue', objective: goal, turn: turns, summary: result.summary }));
  }
  finish({ status: 'limit', objective: goal, summary: 'Execution turn limit reached. Resume this objective; this is not completion or approval.' });
}
try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
