// The one fake `gh` the installer's cases run against, and the helpers that
// drive it. Extracted from tests/init.test.mts (#229) so tests/init.test.mts
// and tests/init-rules.test.mts read the same fake: two copies of a fake of
// one command drift apart, and a case that passes against a fake the real
// command no longer matches proves nothing.
//
// The contract it mocks: `auth status` always succeeds; `repo view --json
// defaultBranchRef` answers with `$state/default-branch` (defaulting to
// "main"), or fails when `$state/repo-view-fail` is there — the read whose
// failure used to be silently guessed as "main" (#229); `api
// repos/{owner}/{repo} --jq .allow_auto_merge` / `--jq
// .delete_branch_on_merge` each report a state-dir marker (real gh does not
// have an `autoMergeAllowed` field on `repo view --json`, so that command is
// deliberately left unmocked -- it falls to the catch-all); `repo edit
// --enable-auto-merge` / `--delete-branch-on-merge` create the matching
// marker; `label create` succeeds and dumps its argv NUL-separated, one
// record per line, to `$state/gh-label-argv.log`, so a label seeded with an
// empty `--description` (every `type:` label) can still be read back argument
// by argument — the space-joined `gh-argv.log` cannot show one. Every call
// touching `.../rulesets` (list, detail, POST, PUT) is handled by one case arm
// keyed on the endpoint prefix: a 403 fixture (`$state/rulesets-403`) wins
// over everything; otherwise `-X POST`/`-X PUT` write the request body to
// `$state/ruleset-{post,put}-body.json` and report a canned id, a GET on the
// collection echoes `$state/rulesets-list.json` (default `[]`), and a GET on
// `.../rulesets/<id>` echoes `$state/ruleset-<id>.json` (default `{}`) — the
// live list endpoint answers with summaries only, so conditions, rules and
// bypass actors live in the per-id fixture, exactly as the real API serves
// them. A `$state/ruleset-<id>-fail` marker makes that one detail GET fail
// instead — the refusal path of the lookup.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, ROOT, RUNTIME } from './harness.mts';

const FAKE_GH = `#!/usr/bin/env bash
state="$FAKE_GH_STATE_DIR"
printf '%s\\n' "$*" >> "$state/gh-argv.log"
case "\${1:-} \${2:-}" in
  "auth status") exit 0 ;;
  "repo view")
    if [ -f "$state/repo-view-fail" ]; then
      echo "gh: HTTP 502: Bad Gateway (https://api.github.invalid/graphql)" >&2
      exit 1
    fi
    printf '{"defaultBranchRef":{"name":"%s"}}\\n' "$(cat "$state/default-branch" 2>/dev/null || echo main)" ;;
  "api repos/{owner}/{repo}")
    case "$4" in
      .allow_auto_merge)
        if [ -f "$state/automerge-enabled" ]; then echo "true"; else echo "false"; fi ;;
      .delete_branch_on_merge)
        if [ -f "$state/deletebranch-enabled" ]; then echo "true"; else echo "false"; fi ;;
      *) echo "" ;;
    esac
    ;;
  "api repos/{owner}/{repo}/rulesets"*)
    if [ -f "$state/rulesets-403" ]; then
      echo "gh: HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature (https://docs.github.com)" >&2
      exit 1
    fi
    if [ "\${3:-}" = "-X" ] && [ "\${4:-}" = "POST" ]; then
      cat > "$state/ruleset-post-body.json"
      echo '{"id":101,"name":"agentic-setup"}'
    elif [ "\${3:-}" = "-X" ] && [ "\${4:-}" = "PUT" ]; then
      cat > "$state/ruleset-put-body.json"
      echo '{"id":42,"name":"agentic-setup"}'
    else
      id="\${2##*/rulesets/}"
      if [ "$id" = "\${2:-}" ]; then
        cat "$state/rulesets-list.json" 2>/dev/null || echo '[]'
      elif [ -f "$state/ruleset-$id-fail" ]; then
        echo "gh: HTTP 500: Internal Server Error (https://api.github.invalid/rulesets/$id)" >&2
        exit 1
      else
        cat "$state/ruleset-$id.json" 2>/dev/null || echo '{}'
      fi
    fi
    ;;
  "repo edit")
    case "$3" in
      --enable-auto-merge) touch "$state/automerge-enabled" ;;
      --delete-branch-on-merge) touch "$state/deletebranch-enabled" ;;
    esac
    ;;
  "label create")
    printf '%s\\0' "$@" >> "$state/gh-label-argv.log"
    printf '\\n' >> "$state/gh-label-argv.log"
    exit 0 ;;
  "api") echo "" ;;
  *) exit 0 ;;
esac
`;
const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-init-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// AGENTIC_REVIEWER_TOKEN decides whether --require-review warns (#143 AC3),
// so the base environment of every fake-gh run drops it: the cases say
// what it is, never the shell the suite happens to run in.
const ENV_WITHOUT_REVIEWER_TOKEN = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== 'AGENTIC_REVIEWER_TOKEN'),
);

export function initWithGh(dir: string, stateDir: string, ...extra: string[]) {
  return initWithGhEnv(dir, stateDir, {}, ...extra);
}
/** The same run with `env` laid over that reviewer-token-free base environment. */
export function initWithGhEnv(dir: string, stateDir: string, env: Record<string, string>, ...extra: string[]) {
  return spawnSync(RUNTIME, [join(ROOT, 'scripts', 'init.mts'), ...extra], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...ENV_WITHOUT_REVIEWER_TOKEN, PATH: PATH_WITH_FAKE_GH, FAKE_GH_STATE_DIR: stateDir, ...env },
  });
}
/** The installer run offline (`--no-gh`), where no fake gh is consulted at all. */
export function initNoGh(dir: string, ...extra: string[]) {
  return spawnSync(RUNTIME, [join(ROOT, 'scripts', 'init.mts'), '--no-gh', ...extra], { cwd: dir, encoding: 'utf8' });
}
export function ghLog(stateDir: string): string {
  return existsSync(join(stateDir, 'gh-argv.log')) ? readFileSync(join(stateDir, 'gh-argv.log'), 'utf8') : '';
}

/** A throwaway state dir for the fake gh, cleaned up by finish(). */
export function ghState(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agentic-init-${label}-`));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A state dir seeded with a ruleset list and one detail fixture per entry. */
export function rulesState(label: string, entries: Array<Record<string, any>>): string {
  const dir = ghState(`rules-${label}`);
  // the live list endpoint answers with summaries; details come per id
  writeFileSync(join(dir, 'rulesets-list.json'), JSON.stringify(entries.map(({ rules, bypass_actors, ...summary }) => summary)));
  for (const entry of entries) writeFileSync(join(dir, `ruleset-${entry.id}.json`), JSON.stringify(entry));
  return dir;
}
