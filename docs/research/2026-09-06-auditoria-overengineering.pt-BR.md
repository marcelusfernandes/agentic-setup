# Auditoria de overengineering — `agentic-setup`

Auditor externo, sem histórico com o projeto. Leitura do código (não só dos docs),
`wc -l` por diretório, epics #2/#29/#40 e os 27 PRs merged. Nada foi executado que
mutasse estado.

---

## 0. Os números, antes de qualquer opinião

```
git ls-files | xargs wc -l   →  7.754 linhas rastreadas

código        3.089   hooks 824 · ci 1.075 · scripts 1.190
testes        2.737   (razão 0,89:1 sobre o código — normal, não inflada)
docs/skills   1.086   docs 574 · skills 422 · agents 90
templates       245
```

Arquivos maiores:

```
749  tests/issue-lint.test.mts        467  hooks/lib/common.mts
485  tests/reconcile.test.mts         446  ci/issue-lint.mts
395  tests/claim.test.mts             368  scripts/land.mts
314  tests/land.test.mts              350  scripts/reconcile.mts
                                      241  scripts/claim.mts
                                      196  scripts/init.mts
                                      169  ci/negative-control.mts
                                      136  ci/lib/detect.mts
                                      131  tests/protect-main.test.mts
                                      119  hooks/protect-main.mts
                                      117  ci/lib/scope.mts
                                       98  ci/scope-check.mts
                                       82  hooks/stop-gate.mts
                                       63  hooks/protect-worktree.mts
                                       45  hooks/git-pre-push
```

Nota sobre "418 casos": há **329 chamadas de `check()`** nos 12 arquivos de teste.
O número maior aparece em runtime porque vários arquivos iteram tabelas
(`tests/protect-main.test.mts` tem ~90 linhas de tabela por trás de 7 `check()`).
A suíte é honesta — spawna o script real contra repos git descartáveis. O problema
não é a suíte.

**27 PRs merged em 2 dias, 3 milestones.** Zero deles entrega valor para um
repositório-alvo. Todos são o próprio andaime. Isso não é crítica em si — é um
plugin, o andaime *é* o produto. Mas muda a leitura da frase "o processo encontrou
os próprios bugs": encontrou bugs que ele mesmo criou. Voltarei a isso na §1.

---

## 1. Inventário: essencial vs. acidental

Legenda da última coluna:
**PROSA BASTAVA** · **PROSA FALHOU (citado)** · **ESSENCIAL (código obrigatório)** ·
**REDUNDANTE (outra camada já resolve)**.

### 1.1 Hooks — 824 linhas

| componente | linhas | contra o que protege | veredito |
|---|---|---|---|
| `hooks/lib/common.mts` linhas 106–467 (`unquote` + `skipWord` + `commandSegments`) | **362** (~110 de comentário) | scanner de quoting de shell para o `protect-main` ver `git push` escondido em `` ` ` ``, `$()`, `"..."`, `$'...'`, redirecionamentos, comentários | **REDUNDANTE** |
| `hooks/protect-main.mts` | 119 | (1) force-push (2) push em main (3) delete de main (4) `--admin` (5) merge sem check verde/label | **REDUNDANTE nos itens 1–4; item 5 morto na prática** |
| `hooks/git-pre-push` (bash) | **45** | push em main e non-fast-forward, em *qualquer* push da máquina, dentro ou fora do Claude Code | **ESSENCIAL** (e é a camada que realmente funciona) |
| `hooks/protect-worktree.mts` | 63 | subagente escrevendo com path absoluto na cópia principal em vez do worktree | **PROSA FALHOU** — mas note: **não há incidente registrado neste projeto**; a evidência é de terceiro (`open-gsd/gsd-core` #260, lido no survey dos próprios autores: *"the prose guard … is never enforced because the model under load skips it"*). O veredito continua justo — é um modo de falha real e barato de fechar —, só não é local. |
| `hooks/stop-gate.mts` | 82 | rodar check+test antes do agente parar | **REDUNDANTE — e há prova experimental** |

**O experimento controlado acidental — a descoberta mais forte desta auditoria.**
O corpo da epic #40 diz que M3 foi

> *"the first milestone dispatched by the plugin's own `orchestrate` skill in a real
> plugin session (`claude --plugin-dir`), **with the hooks active**, instead of by an
> orchestrator driving the Agent tool by hand."*

Lido literalmente — e essa é a leitura simples — **M1 e M2 rodaram sem nenhum hook do
plugin carregado**: 19 PRs, 14 rejeições de reviewer, zero acidentes com `main`, zero
escrita fora de worktree registrada. O que segurou o loop foi a CI (`scope`,
`negative-control`, `test`), a ruleset e o reviewer. As 824 linhas de `hooks/`
produziram exatamente zero evidência de necessidade nas duas milestones que o projeto
usa como prova de que o loop funciona.

O `stop-gate` reforça isso de forma independente: o `hooks.json` só o registrava em
`Stop` até o PR #52 (M3), e `Stop` dispara na sessão principal — o orquestrador, que
roda em `main` e é explicitamente pulado (`PROTECTED.test(branch)`). Quando os hooks
*finalmente* passaram a rodar, em M3, descobriu-se que o gate nunca dispararia para
implementer nenhum (#49: *"found in the plugin-session logs"*). Um gate que ficou
inerte por três milestones sem que ninguém notasse a diferença não é load-bearing —
e o próprio header dele admite: *"the real gate is CI"*.

**O item 5 do `protect-main` (merge gate) é código morto por construção.** O
próprio header do `scripts/land.mts` escreve:

> *"protect-main's PreToolUse hook matches `gh pr merge` in the Bash command string;
> it never sees this call, since land.mts spawns gh from node, not from a shell
> command Claude Code runs. This script does not rely on that hook firing — it
> replaces it."*

Então o único caminho de merge do loop **não passa** pelo gate. O gate só pegaria um
agente digitando `gh pr merge` à mão — exatamente o que o `skills/orchestrate` §5
proíbe em negrito (*"never run `gh pr merge` by hand for this step"*). É a rota mais
complexa do hook (fail-*closed*, 2 chamadas `gh`, parse de rollup), guardando um
comando que o próprio card proíbe e que a ruleset do servidor já barra.

**Quantas camadas para "não force-push"?** Quatro:
1. `permissions.deny` em `templates/claude-settings.json` (declarativo, 0 código);
2. `protect-main.mts` `isForcePush()` + os 362 linhas de scanner;
3. `hooks/git-pre-push` (`git merge-base --is-ancestor`, determinístico);
4. a ruleset do GitHub no servidor.

E os autores admitem, no fecho de #2, que a camada 2 é incompleta por construção:

> *"Known, accepted: `git push origin $(echo main)` and its backtick twin are
> undecidable statically and belong to the git pre-push hook and the guard-main
> action."*

Isto é: eles sabem que só as camadas 3 e 4 decidem, e mesmo assim gastaram **três
PRs inteiros** (#14, #22, #28) refinando a camada 2. O review do PR #22 tem uma
tabela de 60+ linhas de casos de quoting bash executados à mão com shim de `git`.
Foi o review mais rigoroso do projeto inteiro, gasto na camada menos load-bearing.

**E o survey dos próprios autores diz para não fazer isso.**
`docs/research/2026-09-05-hooks-plugins-survey.pt-BR.md`, §4, conclusões literais:

> *"Runtime do hook: **Bash + `printf`/`grep`, sem `jq` nem Python, como padrão**."*
> *"reservar hooks em bash (não Python) apenas para as 1-2 regras que realmente
> precisam checar estado do repositório."*
> *"os projetos mais populares … **não usam hooks para enforcement**."*
> *"nem a Anthropic usa hook para o gate de merge de PR de agente — usa branch
> protection + status check do GitHub."*

O projeto construiu o oposto de cada uma dessas quatro recomendações, e o survey é
datado do mesmo dia do M3. Isso não é um detalhe: é a evidência mais forte da
auditoria, porque é auto-produzida.

### 1.2 CI — 1.075 linhas

| componente | linhas | contra o que protege | veredito |
|---|---|---|---|
| `ci/negative-control.mts` | 169 | PR cujos testes passam sem a mudança ("teste vazio") | **ESSENCIAL** — é a única coisa que faz "merge sem humano" ser honesto. Prosa não consegue: ninguém verifica a si mesmo. |
| `ci/scope-check.mts` + `lib/scope.mts` + `lib/globs.mts` | 98+117+24 | diff fora dos globs declarados na issue | **ESSENCIAL**, mas é o único lugar onde bash de fato dói (ver §2) |
| `ci/lib/detect.mts` | 136 | descobrir o comando de teste de 9 stacks | **PROSA BASTAVA** — o survey dos autores registra que o padrão real (usado pelo `superpowers`, 282k★) é *"deixar a skill/CLAUDE.md instruir o agente a descobrir o comando de teste"*; e o próprio `AGENTIC_TEST_CMD` já cobre o caso difícil |
| `ci/issue-lint.mts` + `lib/issue.mts` | 446+57 | issue mal-formada dispatchada; globs sobrepostos entre issues em voo; renomear entry point sem citar quem referencia | **misto — ver abaixo** |

**`issue-lint` é o componente mais desproporcional do projeto.** 446 linhas +
749 de teste = **1.195 linhas**, ~15% do repositório, para validar um template de
markdown. Decompondo:

- **AC1 (seções presentes)**: 15 linhas, útil, barato. Um `grep -q '^## Files'` faz.
- **AC2 (glob "new" vs. erro)**: custou #37, #41/#47, #42/#54 — quatro PRs, três
  deles corrigindo a heurística "o que conta como diretório novo". `firstWildcardIndex`,
  `fixedDirPrefix`, `newLiteralPaths`, `newWildcardPrefixes`, `newPathsOverlap`. Isto
  é uma máquina de estados sobre *convenção de nomenclatura de pasta*.
- **AC3 (disjunção entre issues em voo)**: real, mas o `scope-check` já pega o
  resultado (dois PRs tocando o mesmo arquivo dão conflito de merge — o git resolve).
  É otimização de agendamento vendida como safety.
- **AC4 (entry-point reference warning)**: aqui está o argumento mais fraco do
  projeto. Nasceu de **um** incidente (#3: `tests/smoke.mts` → `tests/run.mts` com
  `.github/workflows/test.yml` referenciando o path antigo). O resultado é um
  `git grep -F` de todo path e basename coberto contra a árvore inteira — que
  precisou de #44/#57 (perf: de N spawns para 2) e cujo `--strict` foi **aposentado
  do default** em M3 (#45: *"stops folding lint warnings for type:bug"*). Um check
  que só emite warning e cujo modo estrito foi retirado por ruído não paga 200+
  linhas. O bug #3 seria pego pela CI: renomear o arquivo quebra o workflow, o
  `test` fica vermelho, o PR não merge. Ele *foi* pego — os autores só quiseram
  pegá-lo mais cedo.
- **Ruído medido**: as próprias epics #29 e #40 carregam um comentário
  `issue-lint FAIL` com cinco seções faltando. O lint dispara em issues-mãe para as
  quais nunca foi desenhado. Toda milestone nasce com um FAIL automático no topo.

### 1.3 Scripts de orquestração — 1.190 linhas

| componente | linhas | contra o que protege | veredito |
|---|---|---|---|
| `scripts/claim.mts` | 241 | dois agentes claimando a mesma issue; `git push` idêntico lendo como sucesso | **ESSENCIAL — mas o insight cabe em 1 linha** |
| `scripts/land.mts` | 368 | rotular `state:done` depois de um merge que o servidor recusou (#25) | **PROSA FALHOU (citado) — mas a solução está na camada errada** |
| `scripts/reconcile.mts` | 350 | orquestrador reconciliando de memória em vez do GitHub | **acidental na maior parte** |
| `scripts/init.mts` | 196 | instalar templates/labels/hook | **ESSENCIAL, e é o que um instalador deve ser** |

**Onde prosa comprovadamente falhou — os dois casos reais, e são de atomicidade,
não de obediência.** Vale registrar com clareza porque é o argumento mais forte
*a favor* dos autores:

- **#25**: o card dizia *"green checks and `review:approved` → merge → label done"*.
  O orquestrador rodou `gh pr merge`, o servidor recusou (um `labeled` re-disparou
  um check required), e o orquestrador rotulou `state:done` **assim mesmo**.
- **#50**: o orquestrador claimou a issue #49 antes de ler o `FAIL` do lint dela.

Nenhum dos dois é desobediência. Os dois são **ler estado, agir depois, estado
mudou no meio**. Uma instrução em prosa "leia `mergeStateStatus` primeiro" não
conserta isso: o modelo lê uma vez e age sobre a leitura velha. Um processo que lê e
age **na mesma invocação** conserta. Portanto: `claim` e `land` como *scripts* estão
certos. O que está errado é o *tamanho* deles (§3) e a *camada* (§4).

**`reconcile.mts` é onde a complexidade acidental se concentra.** Dos 27 PRs
merged, seis mexem só nele: #21, #23, #27 (dedup de check runs cancelados,
ordenação por `startedAt`), #48 (`%(refname:short)` ambíguo), #55, #58 (pid vivo/
morto em worktree locked). Nenhum desses bugs existe fora do `reconcile.mts`:

- O dedup de runs cancelados é uma **reimplementação de `gh pr checks`**. O
  comentário do próprio código admite: *"the way `gh pr checks` deduplicates"*.
  Eles escolheram `gh pr list --json statusCheckRollup` (cru, com runs canceladas)
  em vez do comando que já resolve, e depois consertaram o resultado três vezes.
- O `%(refname:short)` ambíguo (#48) surgiu ao trocar `git ls-remote` por
  `for-each-ref` por performance. É um bug introduzido por uma otimização de um
  script opcional.
- O `deadWorktrees` (#58) — parsear a razão do lock do Claude Code, extrair
  `pid <N>`, `process.kill(pid, 0)`, tratar ESRCH vs. EPERM — resolve um problema
  que só existe porque o orquestrador é presumido de vida longa. `git worktree
  prune` + "o orquestrador remove worktrees órfãos no início do pass" resolve 90%
  disso em prosa.

### 1.4 Templates, docs, tsc

| componente | linhas | veredito |
|---|---|---|
| `templates/.github/workflows/agentic-checks.yml` | 65 | **ESSENCIAL** — é onde a força real está |
| `templates/.github/workflows/guard-main.yml` | 44 | **ESSENCIAL para repo privado free** (sem ruleset); redundante em público/pago |
| `templates/.github/workflows/issue-lint.yml` | 76 | acidental, junto com o lint |
| `templates/.github/ISSUE_TEMPLATE/task.md` + `pull_request_template.md` | 40 | **ESSENCIAL** — é o contrato que o `scope` lê |
| `templates/claude-settings.json` | 16 | **ESSENCIAL** — deny declarativo, custo zero |
| `docs/{workflow,orchestration,decisions}.md` | 437 | boa qualidade; `orchestration.md` tem um parágrafo de 25 linhas sobre lock de worktree que é doc de um bug, não de um contrato |
| `tsconfig.json` + `@types/node` + `tsc` | 15 + 2 deps | ver §3 |
| matriz Node **e** Bun em `test.yml` | — | **puro gold-plating** — o plugin exige Node ≥ 22.18 (`engines`), e o README documenta um bug do Bun com `.mts` que já obriga o usuário a checar a versão. A perna Bun dobra o custo de CI para suportar um runtime que a doc já desaconselha |

---

## 2. A versão mínima, concreta

### 2.1 Árvore de arquivos

```
agentic-setup/
├── README.md                          ~120 linhas
├── .claude-plugin/plugin.json
├── .claude/settings.json              deny list (16 linhas, inalterado)
├── hooks/
│   ├── hooks.json                     2 hooks, não 3
│   ├── no-main-push.sh                ~12 linhas   (PreToolUse Bash)
│   ├── worktree-fence.sh              ~20 linhas   (PreToolUse Edit|Write)
│   └── git-pre-push                   45 linhas    (inalterado — já é bash)
├── skills/
│   ├── orchestrate/SKILL.md           ~120 linhas  (o loop, em prosa + 3 chamadas)
│   ├── init/SKILL.md                  ~50 linhas
│   ├── safe-worktree/SKILL.md         ~55 linhas   (inalterado)
│   └── issue-and-pr/SKILL.md          ~109 linhas  (inalterado)
├── agents/{implementer,reviewer,docs-writer}.md    90 linhas (inalterados)
├── bin/
│   ├── claim.sh                       ~30 linhas
│   ├── land.sh                        ~25 linhas
│   └── init.sh                        ~80 linhas
├── ci/
│   ├── negative-control.sh            ~40 linhas
│   └── scope-check.py                 ~45 linhas   (o único que não é bash — ver 2.3)
├── templates/.github/
│   ├── ISSUE_TEMPLATE/task.md         28 linhas (inalterado)
│   ├── pull_request_template.md       12 linhas (inalterado)
│   └── workflows/{agentic-checks,guard-main,on-merge-relabel}.yml
└── docs/{workflow,decisions}.md       ~300 linhas
```

**Total estimado: ~1.100 linhas** (contra 7.754) mais docs. Sem `package.json`, sem
`tsconfig.json`, sem `node_modules`, sem matriz de runtime.

### 2.2 O código que precisa mesmo ser código

**Lock de branch — o insight inteiro de `claim.mts` (241 linhas) em uma linha:**

```bash
#!/usr/bin/env bash
# bin/claim.sh <issue-n> <slug>  →  exit 0 claimed · 2 held · 1 refused
set -euo pipefail
n="$1"; slug="$2"
read -r state type <<<"$(gh issue view "$n" --json state,title \
  -q '.state + " " + (.title | capture("^(?<t>[a-z]+)").t)')"
[ "$state" = OPEN ] || { echo '{"refused":"closed"}'; exit 1; }
gh issue view "$n" --json labels -q '.labels[].name' | grep -qx state:ready \
  || { echo '{"refused":"not ready"}'; exit 1; }

branch="$type/$n-$slug"
git fetch -q origin
# ↓ ESTA linha é o bug #34 inteiro. --force-with-lease=<ref>: = create-only;
#   --porcelain + "^\*" distingue "criei o ref" de "Everything up-to-date"
#   (que sai com exit 0 e seria lido como sucesso).
git push --porcelain --force-with-lease="refs/heads/$branch:" \
     origin "origin/main:refs/heads/$branch" 2>&1 \
  | grep -q "^\*" || { echo "{\"held\":\"$branch\"}"; exit 2; }

gh issue edit "$n" --add-assignee @me \
  --add-label state:in-progress --remove-label state:ready
echo "{\"issue\":$n,\"branch\":\"$branch\"}"
```

**Merge gate — `land.mts` (368 linhas) reduzido, e movido para o servidor:**

```bash
#!/usr/bin/env bash
# bin/land.sh <pr>   — o servidor é a autoridade; este script não a duplica.
set -euo pipefail
pr="$1"
# Pré-requisito de instalação (uma vez, no init): gh repo edit --enable-auto-merge
#
# Com ruleset (público, ou org paga): não reimplemente "todos os checks required
# estão verdes" — a ruleset já sabe. --auto faz o GitHub mergear no instante em
# que ela aceitar, o que resolve a janela de re-run (#25) por construção: não há
# leitura para ficar velha.
#
# SEM ruleset (repo privado no plano free — decisions.md §9): --auto sozinho
# mergeia na hora, sem gate nenhum. Aí a verificação de checks no cliente É
# load-bearing, e estas 3 linhas a restauram:
if ! gh api "repos/{owner}/{repo}/rulesets" -q 'length' | grep -qv '^0$'; then
  gh pr checks "$pr" --required --fail-fast \
    || { echo '{"refused":"required checks not green"}'; exit 1; }
fi
gh pr merge "$pr" --squash --delete-branch --auto
echo "{\"queued\":$pr}"
```

…e o relabel, que era a parte que de fato quebrou em #25, sai do orquestrador e vira
um workflow disparado **pelo evento de merge**:

```yaml
# .github/workflows/on-merge-relabel.yml
name: on-merge-relabel
on:
  pull_request:
    types: [closed]
permissions: { issues: write, pull-requests: read }
jobs:
  relabel:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - env: { GH_TOKEN: "${{ github.token }}", BODY: "${{ github.event.pull_request.body }}" }
        run: |
          set -euo pipefail
          printf '%s' "$BODY" | sed 's/`[^`]*`//g' \
            | grep -oiE '(close[sd]?|fix(e[sd])?|resolve[sd]?):? *#[0-9]+' \
            | grep -oE '[0-9]+' | sort -u | while read -r n; do
              # simplificado: land.mts remove TODO label state:*; para paridade,
              # leia `gh issue view $n --json labels` e itere.
              gh issue edit "$n" --add-label state:done \
                --remove-label state:in-review --remove-label state:in-progress || true
            done
```

**Negative control — 169 linhas de TS viram ~40 de bash:**

```bash
#!/usr/bin/env bash
# ci/negative-control.sh <base-sha> <head-sha>
set -euo pipefail
base="$1"; head="$2"
: "${AGENTIC_TEST_CMD:?set AGENTIC_TEST_CMD in the workflow}"

pr="${PR_NUMBER:?set PR_NUMBER (github.event.pull_request.number)}"
for l in $(gh pr view "$pr" --json labels -q '.labels[].name'); do
  case "$l" in type:docs|type:deps|type:infra|type:refactor|type:spec)
    echo "skipped ($l)"; exit 0;; esac
done

tests=$(git diff --no-renames --name-only "$base...$head" \
        | grep -E '(^|/)(tests?|spec|e2e|__tests__)/|\.(test|spec)\.|_test\.(go|py)$' || true)
[ -n "$tests" ] || { echo "FAIL: no-tests"; exit 1; }

t=$(mktemp -d); trap 'git worktree remove --force "$t" 2>/dev/null; rm -rf "$t"' EXIT
git worktree add -q --detach "$t" "$base"
[ -d node_modules ] && ln -s "$PWD/node_modules" "$t/node_modules" 2>/dev/null || true

( cd "$t" && eval "$AGENTIC_TEST_CMD" ) \
  || { echo "FAIL: inconclusive — base does not pass its own tests"; exit 1; }

while read -r f; do
  mkdir -p "$t/$(dirname "$f")"
  git show "$head:$f" > "$t/$f" 2>/dev/null || rm -f "$t/$f"
done <<< "$tests"

if ( cd "$t" && eval "$AGENTIC_TEST_CMD" ); then
  echo "FAIL: vacuous — the PR's tests pass without the PR's change"; exit 1
fi
echo "pass"
```

**Hook de main — 481 linhas (scanner + protect-main) viram 12:**

```bash
#!/usr/bin/env bash
# hooks/no-main-push.sh — PreToolUse(Bash). Falha ABERTO (é camada 2 de 4).
cmd=$(cat | grep -o '"command"[^"]*"[^"]*"' | sed 's/.*: *"//; s/"$//') || exit 0
branch=$(git branch --show-current 2>/dev/null)
if grep -qE '\bgit +(-[^ ]+ +)*push\b' <<<"$cmd"; then
  if grep -qE '(main|master)' <<<"$cmd" || [[ "$branch" =~ ^(main|master)$ ]]; then
    [ "${AGENTIC_ALLOW_PUSH_MAIN:-}" = 1 ] && exit 0
    echo "no push to main/master; open a PR (the pre-push hook and the ruleset also refuse)" >&2
    exit 2
  fi
fi
exit 0
```

Sim, isso tem falsos positivos (`git push origin feat/1-fix-main-menu`). É
**aceitável e até desejável**: o custo de um falso positivo é o agente ler uma linha
de stderr e renomear o slug; o custo do falso negativo é zero, porque o
`git-pre-push` e a ruleset decidem de verdade. É exatamente o trade-off que 362
linhas de scanner de quoting recusam a fazer.

### 2.3 O único lugar onde bash não serve, e isso é honesto

`scope-check` precisa casar `dir/**`, `dir/*.ext` e `?` contra uma lista de paths.
`[[ $f == $glob ]]` do bash **não** implementa `**` corretamente
(`shopt -s globstar` só funciona em expansão de path, não em comparação de string).
Duas saídas legítimas:

```bash
# (a) deixe o git casar — pathspec suporta ** nativamente
git ls-files -- "$glob"        # mas só lista arquivos rastreados; não serve p/ diff
```

```python
# (b) ci/scope-check.py — ~45 linhas, stdlib pura, sem deps
import fnmatch, json, os, re, subprocess, sys
body = os.environ["PR_BODY"]
nums = re.findall(r'(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):? *#(\d+)',
                  re.sub(r'`[^`]*`|```[\s\S]*?```', '', body), re.I)   # ← bug #13, 1 linha
if not nums: sys.exit("scope: no Closes/Fixes/Resolves #N in the PR body")
globs = []
for n in dict.fromkeys(nums):
    b = subprocess.run(["gh","issue","view",n,"--json","body","-q",".body"],
                       capture_output=True, text=True, check=True).stdout
    sec = re.search(r'^## Files\s*$(.*?)(?=^## |\Z)', b, re.M|re.S)
    if sec:
        for line in sec.group(1).splitlines():
            m = re.match(r'\s*[-*]\s+(.*)', line)
            if m:
                q = re.findall(r'`([^`]+)`', m.group(1))
                globs += q or [g.strip() for g in m.group(1).split(",") if g.strip()]
globs += re.findall(r'authorised:\s*`?([^\s`,;]+)', body, re.I)
files = subprocess.run(["git","diff","--no-renames","--name-only",
                        f"{sys.argv[1]}...{sys.argv[2]}"],
                       capture_output=True, text=True, check=True).stdout.split()
def hit(f): return any(fnmatch.fnmatch(f, g) or fnmatch.fnmatch(f, g.rstrip("/")+"/**")
                       for g in globs)
bad = [f for f in files if not hit(f)]
print(json.dumps({"ok": not bad, "violations": bad, "globs": globs}, indent=2))
sys.exit(1 if bad else 0)
```

Isto é o `scope-check.mts` (98) + `lib/scope.mts` (117) + `lib/globs.mts` (24) =
**239 linhas** virando **~45**, sem `tsc`, sem `package.json`, sem matriz de runtime.
`fnmatch` do Python trata `**` de forma um pouco mais frouxa que o `globToRegExp`
deles (`*` cruza `/`) — na prática isso torna o check **mais permissivo**, o que é a
direção segura para um check que já é apenas um dos três gates.

### 2.4 O markdown que substitui o resto

**`skills/orchestrate/SKILL.md` — passo 0, substituindo `reconcile.mts` (350 linhas):**

```markdown
## 0. Reconciliar a partir do GitHub, nunca da memória

Rode estes três comandos e cruze o resultado você mesmo. Não confie no que
você lembra do pass anterior — sua janela de contexto foi resumida.

    git fetch --prune origin
    gh issue list --milestone "<m>" --state open --json number,title,body,labels
    gh pr list --state open --json number,headRefName,labels,reviewDecision
    gh pr checks <n>            # por PR — este comando JÁ desduplica runs canceladas
    git worktree list --porcelain

Classifique cada issue in-progress:
- tem PR aberto            → em andamento, siga para o passo 4
- sem PR e sem branch remoto → volte para state:ready
- sem PR mas com branch remoto → resumível: despache round N+1 a partir de
  origin/<branch>, sem re-claim
- worktree local cuja branch não existe mais no remoto → `git worktree remove --force`

Se algum comando falhar (auth, rate limit), pare e reporte. Não adivinhe.
```

Nota importante: usar `gh pr checks <n>` em vez de `gh pr list --json
statusCheckRollup` **elimina de uma vez** os bugs #21, #23 e #27 — o `gh` já
desduplica por nome mantendo o run mais recente. O código deles reimplementou isso e
levou três PRs para acertar.

**Substituindo o `issue-lint` (446 linhas) — no `agents/` do planner e no CI:**

```markdown
## Antes de despachar uma issue, verifique você mesmo:

- [ ] tem as seis seções: Context, Goal, Acceptance criteria, Proof, Files, Dependencies
- [ ] `## Acceptance criteria` tem ao menos um `- [ ]`
- [ ] `## Files` tem ao menos um bullet com um glob, e nada de prosa dentro do bullet
- [ ] `## Dependencies` tem uma linha `Blocked by:` (ou "none")
- [ ] os globs desta issue não intersectam os de nenhuma outra issue já
      state:in-progress ou state:in-review na milestone — leia as outras
- [ ] se a issue renomeia ou remove um arquivo, rode
      `git grep -l -F <basename>` e confira se algum arquivo FORA dos globs
      declarados o referencia. Se sim, inclua esse arquivo em `## Files`.

Uma issue que falhe qualquer item volta para você reescrever, não para o implementer.
```

E, como rede mínima no servidor, um workflow de 20 linhas em vez de 76+446:

```yaml
- run: |
    for s in Context Goal "Acceptance criteria" Proof Files Dependencies; do
      grep -q "^## $s" issue-body.md || echo "- missing: ## $s" >> out.md
    done
    grep -qE '^\s*[-*]\s+\[[ x]\]' issue-body.md || echo "- no AC checkbox" >> out.md
    [ -s out.md ] && gh issue comment "$ISSUE" --body-file out.md || true
```

**Substituindo `detect.mts` (136 linhas), no `agents/implementer.md`:**

```markdown
3. Descubra o comando de teste do projeto: `Makefile` com alvo `test:`, senão
   `package.json#scripts.test`, senão `pytest`, `go test ./...`, `cargo test`,
   `mix test`, `bundle exec rspec`. Se o `CLAUDE.md` do repositório nomear um,
   ele ganha. Escreva no PR qual comando você usou.
```

E no workflow, `AGENTIC_TEST_CMD` obrigatório em vez de heurística — o que o
`init.sh` pergunta uma vez na instalação e grava no `agentic-checks.yml`.

### 2.5 A tabela que importa: a versão mínima contra a lista de bugs real

| bug real do projeto | PR | a versão mínima… | por quê |
|---|---|---|---|
| `mergeStateStatus` velho → `state:done` prematuro | #25→#30 | **pega, e melhor** | `--auto` + relabel no evento `pull_request: closed`. Não há leitura para envelhecer: o relabel é disparado pelo merge, não pela crença do orquestrador. Estruturalmente impossível. |
| runs canceladas lidas como red no rollup | #21, #23 | **nunca encontra** | usa `gh pr checks`, que já desduplica. Bug auto-infligido por reimplementar o comando. |
| ordenar runs por `startedAt` e não `completedAt` | #27 | **nunca encontra** | idem |
| `git push` idêntico = no-op exit 0 lido como claim | #34 | **pega** | é a linha `--porcelain … \| grep -q "^\*"` de 2.2. O insight é obrigatório e cabe em 1 linha. |
| `--force-with-lease=<ref>:` para não fast-forwardar o ref de outro agente | #34 | **pega** | mesma linha |
| `%(refname:short)` ambíguo com branch local homônima | #48 | **nunca encontra** | não lê refs locais; `gh pr list` responde pelo estado remoto |
| `"conclusion": ""` (string vazia) em check rodando | #36 | **nunca encontra** | não parseia rollup cru |
| `SubagentStop` nunca disparava | #49→#52 | **nunca encontra** | não tem stop-gate. E M1+M2 provam que não faz falta. |
| red estrutural no negative control contado como pass | #10→#20 | **pega o principal** | o `\|\| { echo inconclusive; exit 1; }` sobre a baseline é a parte que importa (#20). O *warning* de assinatura estrutural (#10) some — risco aceito: é warning, não gate. |
| closing keyword dentro de code span alargando escopo | #13 | **pega** | remover os code spans com `sed` antes de aplicar o regex — 1 linha, mostrada em 2.2 e 2.3 |
| quoting / `$()` / backtick no guard de comando | #14, #22, #28 | **nunca encontra** | não tem scanner. E os autores já admitem que `$(echo main)` é indecidível — o `pre-push` decide. |
| glob wildcard sob diretório novo | #41/#47 | **nunca encontra** | não classifica "new" vs "matched" |
| `?` não era wildcard | #42/#54 | **nunca encontra** | `fnmatch` já trata |
| `git grep` por arquivo coberto (perf) | #44/#57 | **nunca encontra** | é um item de checklist em prosa, rodado uma vez pelo planner |
| worktree locked por pid morto | #55/#58 | **nunca encontra** | `git worktree prune` + regra em prosa no passo 0 |
| orquestrador claimou #49 sem ler o FAIL do lint | #50→#53 | **pega parcialmente** | o `claim.sh` não roda lint; mas o item "só despache o que passou no checklist" fica no card. Risco real aceito: este é o caso mais fraco da versão mínima. |
| worktree do subagente escrevendo na cópia principal | (header) | **pega** | `worktree-fence.sh`, ~20 linhas de bash com `realpath` |

**Placar: de 17 incidentes, a versão mínima pega 6, pega 1 melhor por construção,
perde 1 parcialmente, e simplesmente nunca encontra 9** — porque 9 deles são bugs
de código que ela não escreve. Essa é a definição operacional de complexidade
acidental: um bug que só existe porque a solução existe.

---

## 3. Onde está genuinamente superconstruído

Em ordem de quanto eu deletaria primeiro.

**(a) O scanner de shell: `hooks/lib/common.mts` 106–467 (362 linhas) +
`protect-main.mts` (119).** 481 linhas, 131 linhas de tabela de teste, 3 PRs, o
review mais longo do repositório — para uma camada que falha **aberta**, que os
autores admitem ser incompleta por construção, e cujo trabalho o `git-pre-push` (45
linhas de bash) faz de forma **decidível** no nível do ref. Substituir pelo hook de
12 linhas de 2.2. *Economia: ~470 linhas de código + ~120 de teste.*

**(b) O merge gate dentro do `protect-main` (itens 4–5).** Código morto: o
`land.mts` não passa por ele (header do próprio `land.mts`), o card proíbe
`gh pr merge` à mão, o `permissions.deny` já barra `--admin`, e a ruleset barra no
servidor. É a quarta cópia da mesma regra. *Economia: ~45 linhas + 2 chamadas `gh`
por comando Bash que contenha "merge".*

**(c) O `stop-gate`.** Não rodou para nenhum implementer em M1+M2 (19 PRs) e nada
quebrou. A CI é o gate; o próprio header admite (*"the real gate is CI"*). Se
quiserem manter, o `agents/implementer.md` passo 6 já diz para rodar o check.
*Economia: 82 + 62 de teste.*

**(d) `issue-lint` AC4 (entry-point warning) e AC2 (new-dir heuristics).** O AC4
custou 4 PRs, gerou ruído suficiente para ser **retirado do default** (#45), e nasceu
de um incidente que a CI pegou. O AC2 custou 3 PRs para decidir o que é "diretório
novo". Ambos otimizam *detecção precoce* de algo que o `scope-check` + a CI já
barram na hora do PR. Reduzir o lint às seis seções + "tem bullet em Files": ~40
linhas. *Economia: ~400 linhas de código + ~600 de teste.*

Resposta direta à pergunta do dono: **não, o warning de entry-point não vale o
custo** — e o fato de terem tido que aposentar o `--strict` é o próprio projeto
admitindo isso em produção.

**(e) `reconcile.mts` (350) — não é necessário; `gh` + prosa bastam.** Ele existe
para poupar o orquestrador de cruzar três comandos. Mas: (i) o cruzamento é
trivialmente descrito em 15 linhas de markdown (§2.4); (ii) ele reimplementa
`gh pr checks` e comprou 3 bugs por isso; (iii) `deadWorktrees` é infraestrutura
para um problema de ciclo de vida de processo que `git worktree prune` cobre no
caso comum. *Economia: 350 + 485 de teste = 835 linhas.*

Se quiserem manter algo, mantenham um `reconcile.sh` de ~30 linhas que só faz os
três `gh` e imprime tudo junto — sem classificação, sem pid, sem dedup.

**(f) TypeScript sobre Node 22 para scripts que só shellam `gh` e `git`.**
O que o `tsc` compra: `strict` sobre ~3.000 linhas cuja superfície de tipos é
`{ stdout: string, status: number }` e `JSON.parse(...) as any`. Olhe o
`issue-lint.mts`: `let parsed: any`, `raw as unknown`, `(i: any)`. Os pontos onde os
bugs realmente estavam — `"conclusion": ""` sendo string vazia em vez de null, `=`
vs `*` no porcelain, `%(refname:short)` ambíguo — são todos **semântica de
ferramenta externa**, que nenhum sistema de tipos captura. O custo: `package.json`,
`tsconfig.json`, 2 devDependencies, `npm ci` na CI, a restrição `erasableSyntaxOnly`
como invariante nº2 do `CLAUDE.md`, e o requisito Node ≥ 22.18 numa camada de
segurança que **falha aberta quando o Node falta** — ou seja, nas máquinas com mais
chance de não ter Node 22, o guard simplesmente evapora em silêncio. E o survey dos
próprios autores recomenda bash como default. *Veredito: o TS não compra nada aqui.*

**(g) A perna Bun na matriz de CI.** O `engines` exige Node ≥ 22.18. O README
documenta um bug do Bun 1.2.8 com `.mts`. Suportar um runtime que a própria doc
desaconselha, ao custo de dobrar o CI, é gold-plating puro.

**(h) A suíte de 329 casos: NÃO é desproporcional.** 2.737 linhas de teste para
3.089 de código é 0,89:1 — perfeitamente normal, e a disciplina (spawnar o script
real contra repo git descartável, sem mock) é a melhor coisa do repositório. O
veredito honesto é: **a suíte é proporcional a um código que não deveria existir.**
Delete (a)–(f) e ela cai para ~700 linhas naturalmente, sem afrouxar nada.
As duas exceções que eu cortaria de todo modo: `tests/run.test.mts` (52 linhas
testando o test runner — meta-teste sem risco) e a perna Bun.

---

## 4. Onde está subconstruído ou na camada errada

O esforço foi para o **cliente** quando o poder está no **servidor**. Cada item
abaixo é uma feature concreta do GitHub que substitui código local por regra
inviolável.

**(1) Aprovação: use `gh pr review --approve`, não um label.** Hoje o reviewer faz
`gh pr edit --add-label review:approved`, e três lugares independentes checam esse
label (`protect-main` item 5, `land.mts`, `reconcile.mts`). Se o reviewer submetesse
uma *review* de verdade e a ruleset exigisse **1 approving review**, o gate seria
100% server-side e as três verificações locais sumiriam.
*Restrição real que precisa ser dita:* o GitHub recusa auto-aprovação, e
orquestrador + reviewer compartilham o mesmo `gh auth`. Isso exige uma segunda
identidade — um GitHub App token ou machine user para o reviewer. É um passo de
setup no `init`, não um impedimento, mas os autores vão levantar isso e com razão.

**(2) Merge: `gh pr merge --auto`.** O `land.mts` reimplementa, no cliente, a
pergunta "o servidor aceitaria este merge?": lê a ruleset via `gh api
repos/{owner}/{repo}/rulesets` (uma listagem + uma chamada por id de ruleset),
desduplica o rollup, checa `mergeStateStatus`, faz polling com `--wait`, e depois
faz polling de novo até `MERGED`. Tudo isso é literalmente a definição de
`--auto`: o GitHub mergeia no instante em que as condições forem satisfeitas.
368 linhas → 3.

**(3) Relabel: `on: pull_request: [closed]` com `if: merged == true`.** Este é o
ponto mais importante do relatório. O incidente #25 (rotular `done` sem merge) não é
um problema de "prosa vs. script" — é um problema de **quem dispara a ação**.
Enquanto o relabel for feito por quem *pediu* o merge, ele pode divergir do que
aconteceu. Feito pelo *evento* de merge, não pode. O `land.mts` gasta ~80 linhas
(o loop `AC4_MAX_ATTEMPTS`, o `mergedView`, o tratamento de `--delete-branch`
falhando localmente) para simular, com polling, um webhook que o GitHub já entrega.

**(4) `merge_queue` em vez de "não exigimos branch atualizada".** `decisions.md` §4
aceita explicitamente o risco de mergear branches desatualizadas ("a CI roda de novo
na main depois"). Com 4 agentes em paralelo isso é uma aposta. A merge queue do
GitHub testa cada PR contra a main resultante antes de integrar — é exatamente o
problema que eles têm, resolvido no servidor.

**(5) `required_status_checks` + `required_linear_history` + `block_force_pushes` na
ruleset.** Já cobrem os itens 1–3 do `protect-main` em repositório público ou org
paga. O repo do plugin é público. O único cenário onde a camada local é a única é
**privado no plano free**, e ali o `git-pre-push` (bash, 45 linhas) já resolve
melhor que o scanner, porque age no ref e não no texto do comando. **Ressalva
importante:** o `pre-push` cobre *push*, não *merge* — num repo privado free, sem
ruleset, nada no servidor exige checks verdes para mergear. Nesse cenário específico
a verificação de checks do `land.mts` é load-bearing, e não redundante; é o que as
três linhas condicionais do `land.sh` em 2.2 restauram.

**(6) O que está genuinamente subconstruído:** a **identidade separada do
reviewer**. Sem isso, todo o gate de review é auto-declarado por labels que o mesmo
token pode escrever — o `land.mts` checa `review:approved`, e quem põe o label é o
mesmo `gh auth` que roda o merge. Um agente confuso (ou um prompt injection numa
issue) fecha o ciclo sozinho. Isso é um buraco de segurança real, e nenhuma das
7.754 linhas o cobre. O `init` deveria exigir um segundo token.

---

## 5. Recomendação: três opções

### (a) Manter como está

**Mantém:** tudo. **Deleta:** nada.
**Risco aceito:** **cerca de metade dos PRs (14 de 27, 52%)** foi manutenção de
camadas redundantes ou não-load-bearing. Contando por número de PR: scanner de shell
**#14, #22, #28**; `reconcile` **#18, #23, #27, #48, #55, #58**; `stop-gate` **#52**;
heurísticas de glob do `issue-lint` **#38, #47, #54, #57**. A outra metade (**#20**
negative-control, **#34** claim/porcelain, **#36** land, **#11**, **#12**, **#13**, **#15**, **#35**)
consertou ou construiu camadas essenciais — o framing "o loop achou os próprios bugs"
só é circular no primeiro grupo. Essa taxa não cai sozinha: a superfície continua lá.
O plugin também nunca foi rodado em repositório de terceiro; toda a "prova" é
auto-referente.
**Tamanho:** 7.754 linhas.

### (b) Enxugar para um núcleo

**Mantém:** `negative-control`, `scope-check`, `claim`, o `git-pre-push`, o
`protect-worktree`, os templates de issue/PR, `guard-main`, `init`, os três
`agents/`, os quatro `skills/`, `docs/{workflow,decisions}`, e a suíte de testes
sobre o que sobrou (nas mesmas regras: script real, repo descartável).
**Deleta:** o scanner de quoting (481) → hook de 12 linhas; o merge gate do
`protect-main`; o `stop-gate` (82); o `issue-lint` reduzido a 6 seções + 1 bullet
(−400); o `reconcile.mts` (350) → 30 linhas de bash ou prosa; a perna Bun;
`land.mts` (368) → `--auto` + workflow `on: closed`; `detect.mts` (136) →
`AGENTIC_TEST_CMD` obrigatório no init. Mantém `.mts` **só** se quiserem — mas eu
converteria.
**Risco aceito:** perde a detecção precoce de issue mal-formada (volta a ser pega no
PR, uma iteração depois) e o warning de red estrutural. Perde nada de segurança:
todas as camadas deletadas são redundantes com servidor ou `pre-push`.
**Tamanho:** ~2.000–2.400 linhas (código ~900, testes ~700, docs ~500).

### (c) A versão md + sh + gh

O esboço completo da §2. **Mantém:** o contrato de issue/PR, os três agentes, os
cards, `negative-control.sh`, `scope-check.py`, `claim.sh`, `git-pre-push`,
`worktree-fence.sh`, e a ruleset como autoridade única de merge.
**Deleta:** todo o TypeScript, `package.json`, `tsconfig.json`, `node_modules`,
a matriz de runtime, `reconcile`, `issue-lint`, `stop-gate`, `detect`, o scanner.
**Pressuposto:** a ruleset do GitHub existe (repo público ou org paga). Em repo
privado no plano free, `land.sh` precisa das três linhas de `gh pr checks --required`
de 2.2 — sem elas, `--auto` mergeia sem gate nenhum.
**Risco aceito:** um agente que ignore o checklist do card despacha uma issue ruim,
e isso só é pego no PR (uma iteração perdida). Sem lint no CI, milestones grandes
acumulam issues mal-escritas. E — o caso mais fraco — o `claim.sh` não recusa uma
issue que falharia o lint (#50).
**Tamanho:** ~1.100 linhas + docs.

### O que eu escolheria

**Plugin público, project-agnostic, para outras pessoas adotarem: (c), com uma
correção — mantenha `claim` e `land` como *scripts curtos*, não como prosa.**

O discriminador não é elegância, é **quem terá que depurar isso**. Um adotante que
roda Go, Ruby ou Elixir não tem stack Node; para ele o plugin é uma caixa-preta em
`.mts` que exige Node ≥ 22.18 e — pior — cujos guards **falham abertos em silêncio**
quando o Node não está lá. A camada de segurança evapora exatamente nas máquinas
com maior chance de não a satisfazer, e ninguém percebe. Bash + `gh` são legíveis e
depuráveis em qualquer stack, e a ruleset do GitHub é a mesma para todo mundo.
Some-se a isso que o survey dos próprios autores documenta que (i) os plugins
populares não usam hooks para enforcement, (ii) a própria Anthropic faz o gate de
merge com branch protection + status check, não com hook, e (iii) bash é o runtime
recomendado. Um plugin público que contraria seu próprio levantamento precisa de um
argumento, e eu não achei um.

A correção: `claim.sh` e `land.sh` continuam scripts porque o problema deles é
**atomicidade de leitura-e-ação**, não obediência — e isso prosa não resolve
(#25, #50). Mas são 30 e 25 linhas, não 241 e 368.

**Repo privado de um time só: (b).**

Aqui o time escolhe o runtime, todo mundo tem Node, e o custo de manutenção é
interno e visível. `reconcile` como JSON único é conveniência real quando você roda
o loop 20 vezes por dia; `issue-lint` reduzido evita idas e vindas quando você
escreve 30 issues por milestone. O que **não** muda entre os dois cenários: o
scanner de quoting, o merge gate duplicado no `protect-main` e o `stop-gate` saem
nos dois. Redundância com o servidor não fica melhor por ser privada — e num repo
privado no plano free, onde a ruleset não existe, o que salva é o `git-pre-push` de
bash, não 481 linhas de parser de aspas.

---

## Apêndice — as três frases que resolvem a discussão

1. `scripts/land.mts`, header: *"protect-main's PreToolUse hook … never sees this
   call … This script does not rely on that hook firing — it replaces it."*
   → o gate mais complexo do hook guarda um caminho que o loop não usa.
2. Epic #2, fecho: *"`git push origin $(echo main)` and its backtick twin are
   undecidable statically and belong to the git pre-push hook and the guard-main
   action."* → os autores sabem qual camada decide, e refinaram a outra três vezes.
3. `docs/research/…survey.pt-BR.md`, §4: *"nem a Anthropic usa hook para o gate de
   merge de PR de agente — usa branch protection + status check do GitHub."*
   → escrito pelos autores, no mesmo dia do M3, e implementado ao contrário.
