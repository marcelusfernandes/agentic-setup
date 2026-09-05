# references/github.md — the GitHub host layer

This is the single file that documents every `gh`/REST call agentic-git makes.
`gh` is invoked **only** from `scripts/host/github/*.sh` (and the read-only
`status prs` mode, and `doctor`'s prereq checks) — never from a skill, an
agent, or any other script. `tests/lint.sh` enforces this by grepping for
`gh ` outside this allowlist.

Skills call the host layer through one dispatcher, never `gh` directly:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" <verb> [args...]
```

`host.sh` reads `config.json`'s `.host` (default `"github"`) and execs
`scripts/host/<host>/<verb>.sh "$@"`.

## 1. The verb contract

Every host implementation (GitHub today, GitLab tomorrow) provides these,
with identical stdin/stdout shapes. JSON always goes to stdout only; nothing
else is printed on stdout when a verb emits JSON.

| Verb | Input | Output (JSON on stdout) |
|---|---|---|
| `caps` | `[--no-cache\|--cached]` | `{native_parent,native_blocked_by,native_sub_issue_edit,sub_issues_api,probed_at}` |
| `repo-info` | `[--allow-self]` | `{host,owner,name,default_branch,remote}`; exit 2 on a non-GitHub origin, exit 3 on the plugin's own repo |
| `milestone` | `list \| ensure <title> [due_on] \| close <title> \| due <title> <due_on>` | `{number,title,state,open_issues,closed_issues}` (`list`: a JSON array of those) |
| `issue-create` | `--title --body-file --labels a,b [--milestone] [--parent N] [--blocked-by n,n] [--assignee]` | `{number,url}` |
| `issue-find` | `--marker "<m>" [--marker "<m2>" ...] [--label agentic] [--limit 100]` | `[{marker,number,url,title,state}]` |
| `issue-link` | `--parent N --children n,n \| --blocked N --by n,n` | `{mode:"native\|rest\|checklist",applied:[...]}` |
| `issue-close` | `<n> [--reason completed\|not-planned\|duplicate] [--comment "..."]` | `{number,state}` |
| `issue-label` *(extra)* | `<n> --add a,b --remove c,d` | `{number,labels:[...]}` |
| `issue-comment` *(extra)* | `<n> --body-file f \| --body "..."` | `{id,url}` |
| `pr-create` | `--base --head --title --body-file [--labels] [--milestone] [--draft] [--reviewers a,b]` | `{number,url}` |
| `pr-state` | `<n>` | `{number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,checks:[{name,status,conclusion}],headRefName,baseRefName,headRefOid,closingIssues:[n],url}` |
| `pr-merge` | `<n> --strategy squash\|merge\|rebase [--delete-branch] [--match-head <sha>] [--auto]` | `{merged:bool,sha}` |

Every script that shapes gh's JSON does so with **local `jq`**, never `gh
--jq`: it always captures gh's raw `--json ...` output first, then reshapes
it with a separate `jq` call. This keeps behaviour identical to real `gh`
and to a mocked `gh` in tests, since the mock cannot be expected to
reimplement jq filtering.

## 2. `caps.sh` — feature probe, never a version compare

`gh`'s `--parent`, `--blocked-by`, `--add-sub-issue` support shipped
independently of any coherent version scheme, so `caps.sh` greps `--help`
output instead of comparing `gh --version`:

```bash
gh issue create --help 2>/dev/null | grep -q -- '--parent'        && native_parent=true
gh issue create --help 2>/dev/null | grep -q -- '--blocked-by'    && native_blocked_by=true
gh issue edit   --help 2>/dev/null | grep -q -- '--add-sub-issue' && native_sub_issue_edit=true
```

`sub_issues_api` is always `null` from `caps.sh` — probing whether the REST
`sub_issues` endpoint is enabled for this repo costs a live API call, so it
is checked lazily, only when `issue-link.sh` actually falls to the REST
tier.

Cached at `.claude/agentic/runtime/host-caps.json` (git-ignored — this is
runtime, not project state), refreshed when the cached `probed_at_epoch` is
more than 7 days old, or immediately with `--no-cache`. `--cached` returns
the cache as-is when fresh; otherwise it probes and writes through, same as
the default.

## 3. Repo identity and the self-repo / non-GitHub guard

`repo-info.sh` parses `git config --get remote.origin.url` **without any
network call** — ssh (`git@host:owner/name.git`), `ssh://git@host/owner/name`,
and `https://host/owner/name(.git)?` forms are all handled by string
splitting, not a git or gh command. `default_branch` (from
`scripts/lib/common.sh`) is then consulted, which itself prefers the local
`refs/remotes/origin/HEAD` symref before ever shelling out to
`git remote show origin` (which *does* touch the network).

- Origin host is not `github.com` → **exit 2** with a CAUTION line. Only
  GitHub is supported today (see §6, "adding GitLab").
- Origin is `marcelusfernandes/agentic-setup` (the plugin's own repo) →
  **exit 3** with a CAUTION line, unless `--allow-self` is passed (tests /
  plugin development only). This is the guard against the workflow
  accidentally filing issues or opening PRs against its own source repo.

Every skill that mutates GitHub state (`sync`, `pr`, `merge`) calls
`repo-info.sh` first and prints the resolved `owner/repo` in its
confirmation line before doing anything else.

## 4. Milestones — no `gh milestone`, drive the REST endpoint

`gh` has no milestone subcommand; `milestone.sh` uses `gh api` directly:

```bash
# list (state=all so closed milestones are still discoverable for `ensure`/`close`)
gh api repos/{owner}/{repo}/milestones?state=all

# create (providing -f/-F switches gh api's default method to POST — no explicit -X needed)
gh api repos/{owner}/{repo}/milestones -f title="v1.0" [-f due_on="2026-12-01T00:00:00Z"]

# close / set a due date (PATCH is explicit)
gh api repos/{owner}/{repo}/milestones/{number} -X PATCH -f state="closed"
gh api repos/{owner}/{repo}/milestones/{number} -X PATCH -f due_on="2026-12-01T00:00:00Z"
```

`ensure <title> [due_on]` is idempotent: it lists with `state=all`, matches
by exact title with `jq`, and only POSTs when no match exists — never
duplicates a milestone. `due_on` is ISO 8601 (`2026-12-01T00:00:00Z`).

## 5. Issues: create, dedup, link, close, label, comment

### 5.1 Create

```bash
gh issue create --title "T" --body-file /tmp/body.md \
  --label task --label agentic ${MILESTONE:+--milestone "$MILESTONE"} \
  ${NATIVE_PARENT:+--parent "$PARENT"} ${NATIVE_BLOCKED_BY:+--blocked-by "$BLOCKED_BY"}
```

`--parent`/`--blocked-by` are only sent when `caps.sh --cached` says the
installed `gh` supports them; otherwise `issue-create.sh` omits them
silently and the caller links via `issue-link.sh` afterward (§5.3). The
issue number is parsed from the URL `gh issue create` prints
(`.../issues/<n>`), not from a separate lookup.

### 5.2 Dedup (why `issue-find.sh` exists)

Every issue this workflow creates carries a hidden marker in its body:

```
<!-- agentic-git:epic=<slug> id=<local-id> -->
```

`issue-find.sh` pages the REST issues endpoint — **not** `gh issue list`,
which has no cursor for bounded, resumable pagination:

```bash
gh api "repos/{owner}/{repo}/issues?labels=agentic&state=all&per_page=100&page=1"
gh api "repos/{owner}/{repo}/issues?labels=agentic&state=all&per_page=100&page=2"
# ...
```

It stops as soon as **a page comes back empty** or **every requested
marker has been matched** — a re-run of `sync` on a large repo does not
scan the whole issue tracker. A capped `AGENTIC_ISSUE_FIND_MAX_PAGES`
(default 20) is a last-resort safety valve, not part of the documented stop
condition.

### 5.3 Linking — the 3-tier fallback ladder (`issue-link.sh`)

1. **native** — `gh` resolves numbers/URLs to internal ids for you; always
   try this first when caps allow it:
   ```bash
   gh issue edit <epic#> --add-sub-issue <t1,t2,...>
   gh issue edit <task#> --add-blocked-by <n1,n2,...>
   ```
2. **REST** — the sub-issues and issue-dependencies REST surfaces. **The
   trap**: `sub_issue_id` / `issue_id` must be the issue's numeric database
   id, not its issue number, and *not* the GraphQL node id:
   ```bash
   # correct: numeric REST id
   gh api repos/{owner}/{repo}/issues/{number} --jq .id
   # WRONG for this purpose — this is the base64 GraphQL node id:
   gh issue view {number} --json id --jq .id
   ```
   Then:
   ```bash
   gh api repos/{owner}/{repo}/issues/{parent#}/sub_issues -X POST -f sub_issue_id={dbid}
   gh api repos/{owner}/{repo}/issues/{task#}/dependencies/blocked_by -X POST -f issue_id={dbid}
   ```
3. **checklist** (degraded, advisory only — GitHub does not enforce these
   relationships) — append `- [ ] #<n>` lines to the parent's body, or a
   `Blocked by: #a, #b` line to the child's body, via
   `gh issue edit <n> --body-file <tmp>`. Idempotent: a line already present
   is never duplicated.

Each downgrade (native → REST, REST → checklist) prints a `WARN` on stderr.
The caller (`sync.sh`) is expected to also append a ledger ruling and set
`mapping.json.link_mode` so `status` knows dependencies are advisory rather
than GitHub-enforced.

### 5.4 Close / label / comment

```bash
gh issue close <n> --reason completed              # completed | "not planned" | duplicate
gh issue close <n> --reason "not planned"
gh issue close <n> --comment "Merged in #<pr>" --reason completed

gh issue edit <n> --add-label "a,b" --remove-label "c,d"   # only when they actually change
gh issue comment <n> --body-file <f> | --body "..."
```

`issue-close.sh`'s `--reason not-planned` (hyphenated, matching this
plugin's flag style) is translated to gh's actual value `"not planned"`
(with a space) before the call. `issue-label.sh` reads
`gh issue view <n> --json labels` first and only calls `gh issue edit` when
an add or remove would actually change something — safe to call on every
status transition, even when nothing changed.

## 6. Closing keywords (for PR bodies)

GitHub auto-closes referenced issues when a PR merges to the default
branch, case-insensitively:

```
close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved  #123
Closes owner/repo#123        # cross-repo form
Closes #123, Fixes #124      # multiple, comma- or newline-separated
```

`pr.sh` uses `Closes #N` only for issues fully satisfied by a given PR. The
epic parent issue always gets a plain `Part of #N` — **never** a closing
keyword, or merging one task's PR would close the whole epic.

## 7. PRs

```bash
gh pr list --head <branch> --state all --json number,url    # idempotency check before create
gh pr create --base <base> --head <head> --title "T" --body-file <f> \
  ${LABELS} ${MILESTONE:+--milestone "$M"} ${DRAFT:+--draft} ${REVIEWERS:+--reviewer "$R"}

gh pr view <n> --json number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,\
statusCheckRollup,headRefName,baseRefName,headRefOid,closingIssuesReferences,url

gh pr merge <n> --squash|--merge|--rebase [--delete-branch] [--match-head-commit <sha>] [--auto]
```

`pr-create.sh` is idempotent: if `gh pr list --head <head>` already returns
an open PR, that PR is returned as-is — no duplicate, no error.

`mergeStateStatus` values: `BEHIND, BLOCKED, CLEAN, DIRTY, DRAFT, HAS_HOOKS,
UNKNOWN, UNSTABLE`. `reviewDecision` values: `APPROVED, CHANGES_REQUESTED,
REVIEW_REQUIRED, ""`. `pr-state.sh` reshapes `statusCheckRollup` (which can
mix CheckRun-shaped entries — `name`/`status`/`conclusion` — and legacy
StatusContext entries — `context`/`state`) into a single uniform
`checks:[{name,status,conclusion}]` shape by falling back
`.name // .context` and `.conclusion // .state`.

`pr-merge.sh` **never emits `--admin`** — bypassing branch protection is
outside this plugin's authority by design. `--match-head-commit` is always
forwarded when `--match-head <sha>` is given: it makes `gh pr merge` refuse
if anyone pushed to the PR since the caller's preflight, which is what
turns the merge skill's whole gate sequence (state → CI → review → dry-run
→ merge) into something actually atomic instead of racy. `--auto` enables
auto-merge and returns immediately with `{"merged":false,"sha":null}` —
auto-merge is fire-and-forget, so the caller records `pending-auto` state
and does not run post-merge cleanup.

## 8. Rate limiting (`issue-create.sh`)

```bash
gh api rate_limit    # -> {"rate":{"remaining":N,"reset":<epoch-seconds>}}
```

Checked before every issue creation. When `remaining < 10`, the script
sleeps until `reset` (clamped to `>= 0`) before proceeding, and warns on
stderr either way. Set `AGENTIC_NO_SLEEP=1` to skip the actual `sleep`
(tests only) while still getting the warning. `issue-find.sh`'s bounded
pagination (§5.2) and `status`'s default no-network mode are the other two
halves of this plugin's rate-limit story — see §11 row 18 of the
architecture doc.

## 9. How to add GitLab

1. Write `references/gitlab.md` (copy this file's structure).
2. Write `scripts/host/gitlab/*.sh` implementing the same ten verbs (§1)
   with `glab` instead of `gh` — identical stdin/stdout shapes, so nothing
   in any skill changes.
3. Set `"host": "gitlab"` in `config.json`; `host.sh` picks it up
   automatically.

Known gaps to design around up front: GitLab has no native sub-issues (map
epic→issue relationships with `related_issues` links, or fall straight to
checklist mode), and `blocked_by` is a GitLab Premium feature — so
`caps.sh` for GitLab should simply report `native_*: false` and let the
same checklist degradation path this plugin already exercises for old `gh`
versions carry the workflow. That existing degradation path (§5.3) is what
makes a GitLab port cheap instead of a rewrite.
