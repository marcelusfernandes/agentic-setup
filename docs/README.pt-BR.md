# agentic-git

![Claude Code 2.1+](https://img.shields.io/badge/Claude%20Code-2.1%2B-blue) ![MIT](https://img.shields.io/badge/license-MIT-green)

> Esta é a tradução completa para Português (Brasil) do [`README.md`](../README.md). Nomes de comandos, caminhos de arquivo e chaves de configuração permanecem em inglês, exatamente como são digitados.

`agentic-git` transforma um repositório GitHub em um pipeline de entrega operável por máquina: um objetivo vira um épico, o épico vira uma issue-pai com sub-issues carregando dependências reais (`blocked-by`), cada unidade de trabalho vira um branch em um git worktree, fatias independentes desse trabalho rodam como subagentes implementadores em paralelo com posse exclusiva de arquivos, e tudo chega através de PRs que fecham suas issues após um merge revisado e checado contra conflitos. É agnóstico de stack — um `scan` único grava um perfil de projeto legível por máquina, e toda ação específica de stack é lida desse perfil em vez de embutida no código. Ele também configura o próprio projeto — gerando ou *adaptando* `.claude/agents/*.md`, hooks em `.claude/settings.json` e uma seção do `CLAUDE.md` sob medida para o que encontrou, nunca sobrescrevendo o que já existe.

```
   objetivo / PRD
       │
       │ /agentic-git:plan
       ▼
   epic.md + tasks/*.md                          (apenas local, ainda não está no GitHub)
       │
       │ /agentic-git:sync
       ▼
   milestone ──▶ issue do épico #100
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
      #101         #102         #103            (sub-issues, links blocked-by)
        │            │            │
        │ /agentic-git:start (branch + worktree, por tarefa ou compartilhado por épico)
        ▼            ▼            ▼
   .worktrees/101   .worktrees/102   ...
        │
        │ /agentic-git:work
        ▼
   fluxo A ─┐
   fluxo B ─┼──▶ agentes implementadores (paralelo, arquivos disjuntos) ──▶ commits
   fluxo C ─┘
        │
        │ /agentic-git:pr
        ▼
   PR ── Closes #101, Closes #102 ── Part of #100
        │
        │ /agentic-git:review [--fix]
        ▼
   agentes revisores (paralelo) ──▶ achados ──▶ uma rodada de correção em lote
        │
        │ /agentic-git:merge
        ▼
   dry run com merge-tree ──▶ merge ──▶ fecha issues ──▶ remove worktree
        │
        ▼
   épico 100% ──▶ /agentic-git:cleanup ──▶ arquivado
```

## Por quê

1. **O trabalho não vira issue.** Objetivos vivem no chat, PRDs vivem em documentos — o GitHub nunca vê o plano, então dependências e progresso não existem em lugar nenhum legível por máquina.
2. **Agentes em paralelo colidem.** Rodar vários agentes contra o mesmo código sem posse exclusiva de arquivos significa trabalho sobrescrito e diffs impossíveis de revisar.
3. **Todo projeto precisa configurar seu `.claude/` na mão.** Agents, hooks e convenções de `CLAUDE.md` são reescritos do zero em cada repositório, em vez de gerados a partir do que o repositório já é.

`agentic-git` resolve os três: um modelo de estado em disco, uma camada de GitHub que transforma esse estado em issues e links reais, e uma camada de execução paralela com garantias mecânicas de segurança (escopos disjuntos, locks, dry runs de merge-tree) em vez de apenas promessas em prompt.

## Instalação

```
/plugin marketplace add marcelusfernandes/agentic-setup
/plugin install agentic-git@agentic-setup
```

| Pré-requisito | Requisito |
|---|---|
| `git` | ≥ 2.38 (necessário para `git merge-tree --write-tree`) |
| `gh` | instalado e autenticado (`gh auth login`) |
| `jq` | instalado — todo o estado é JSON |
| Sistema operacional | apenas macOS ou Linux na versão 0.1.0 (Windows está fora de escopo — veja Solução de problemas) |

## Início rápido

```bash
# 0. Instalar (uma vez por máquina)
/plugin marketplace add marcelusfernandes/agentic-setup
/plugin install agentic-git@agentic-setup

# 1. Configurar este repositório (uma vez por repositório)
/agentic-git:init            # pré-requisitos, diretório de estado, rerere+zdiff3, labels, .gitignore
/agentic-git:scan            # detecta a stack → .claude/agentic/project-profile.json
/agentic-git:adopt           # gera/adapta .claude/agents, hooks, CLAUDE.md (mostra um diff antes)
/agentic-git:doctor          # está tudo verde?

# 2. Planejar e publicar um bloco de trabalho
/agentic-git:plan "Add OAuth login with Google and GitHub" --milestone v1.2
/agentic-git:sync oauth-login          # → milestone, issue do épico #100, sub-issues #101-#106

# 3. Executar
/agentic-git:status next               # quais issues estão desbloqueadas
/agentic-git:start epic oauth-login    # worktree + branch + instalação + testes de baseline
/agentic-git:work 101                  # decompõe em fluxos, roda implementadores em paralelo

# 4. Entregar
/agentic-git:pr 101                    # gates, push, PR com "Closes #101"
/agentic-git:review 45 --fix           # revisores em paralelo, uma rodada de correção em lote
/agentic-git:merge 45                  # preflight → merge → fecha issues → remove worktree

# 5. Quando o épico terminar
/agentic-git:merge epic oauth-login    # trem de merge ordenado sobre os PRs restantes
/agentic-git:cleanup --archive
```

Veja [`docs/QUICKSTART.md`](QUICKSTART.md) (em inglês) para a mesma sequência com a saída esperada em cada passo.

## Comandos

| Skill | O que faz | Quando usar | Escreve no GitHub? |
|---|---|---|---|
| `init` | Pré-requisitos, árvore de estado, rerere+zdiff3, `.gitignore`, labels do workflow | Uma vez por repositório | Sim (apenas labels) |
| `scan` | Detecta a stack → `project-profile.json` | Após `init`, ou quando a stack mudar (`--refresh`) | Não |
| `adopt` | Gera/adapta `.claude/agents`, hooks, `CLAUDE.md` | Após `scan` | Não |
| `doctor` | Diagnostica instalação, estado, capacidades do host; imprime os comandos de correção exatos | A qualquer momento | Não (`--fix` só altera coisas locais) |
| `plan` | Objetivo/PRD → épico local + até 10 tarefas com grafo de dependências | Antes de `sync` | Não |
| `sync` | Publica o épico no GitHub: milestone, issue do épico, sub-issues, links | Após `plan` | Sim |
| `start` | Branch + worktree + dependências + testes de baseline para uma issue ou épico | Antes de `work` | Sim (label + comentário) |
| `work` | Decompõe uma issue em fluxos por escopo de arquivo, roda implementadores em paralelo | Após `start` | Sim (comentário de progresso) |
| `status` | Painel somente leitura — épicos, `next`, `blocked`, `streams`, `prs` | A qualquer momento | Não |
| `pr` | Roda os gates, faz push, abre o PR com `Closes #N` | Após `work` | Sim |
| `review` | Despacha agentes revisores, posta uma revisão agregada, correção opcional | Após `pr` | Sim (comentário de revisão) |
| `merge` | Preflight (merge-tree, CI, revisão) → merge → limpeza → fecha issues | Após `review` | Sim |
| `resolve-conflicts` | Rebase, classifica conflitos, resolve automaticamente os triviais, para nos semânticos | Quando `pr`/`merge` reporta conflitos | Sim (push + comentário no PR) |
| `cleanup` | Remove worktrees/branches órfãos, faz prune, arquiva épicos concluídos, fecha milestones | Após um `merge` ou quando um épico termina | Sim (apaga branch, fecha milestone) |

Não existe uma skill `milestone` isolada — milestones são declaradas em `epic.md`, garantidas por `sync`, reportadas por `status` e fechadas por `cleanup`. Chame o script diretamente a qualquer momento:

```bash
bash "$CLAUDE_PLUGIN_ROOT"/scripts/host.sh milestone list|ensure|close
```

Também não existe uma skill `next` isolada — é um modo de `status` (`/agentic-git:status next`).

## O que ele coloca no seu projeto

| Local | Conteúdo | É commitado? |
|---|---|---|
| `.claude/agentic/config.json` | Padrões de política (templates de branch, estratégia de merge, limites de autonomia) | Sim |
| `.claude/agentic/project-profile.json` | Stack detectada + seus `overrides` | Sim |
| `.claude/agentic/epics/<slug>/` | `epic.md`, `tasks/*.md`, `mapping.json`, `ledger.md` | Sim |
| `.claude/agentic/hooks/*.sh` | Scripts independentes de stack que o `adopt` copia (formatação, guarda de segredos) | Sim |
| `.claude/agentic/runtime/` | Cache de capacidades do host, estado de fluxos, locks — por máquina | Não (ignorado pelo git) |
| `.claude/agents/*.md` | `test-runner`, `code-reviewer`, `refactorer` — gerados ou adaptados | Sim |
| `.claude/settings.json` | Duas entradas de hook mescladas (`PostToolUse` de formatação, `PreToolUse` de guarda de segredos) | Sim |
| `CLAUDE.md` | Um bloco delimitado por sentinelas `<!-- BEGIN agentic-git -->…<!-- END agentic-git -->` | Sim |
| `.worktrees/` | Git worktrees dos branches em andamento | Não (ignorado pelo git) |

Arquivos existentes nunca são sobrescritos: o `adopt` mescla entradas de hook por um marcador `agentic/hooks/`, anexa conteúdo dentro de sentinelas em arquivos de agente, e só adiciona chaves que o `adopt` ainda não tinha visto no frontmatter de um agente. O `adopt` sempre mostra um diff e pede confirmação antes de escrever, a menos que `--dry-run` seja usado.

**Para remover tudo o que o agentic-git adicionou:**

```bash
git rm -r .claude/agentic .claude/agents/test-runner.md .claude/agents/code-reviewer.md .claude/agents/refactorer.md
# depois edite manualmente CLAUDE.md e .claude/settings.json para apagar o bloco de sentinela / as entradas de hook
rm -rf .worktrees
git worktree prune
/plugin uninstall agentic-git
```

Tudo o que ele escreveu é histórico git puro — dar `git revert` no commit do `adopt` tem o mesmo efeito do lado da configuração.

## Como o trabalho em paralelo permanece seguro

- **Fluxos com escopo de arquivo.** `work` decompõe uma issue em 1 a 4 fluxos com globs de `files[]` disjuntos, verificados mecanicamente expandindo contra `git ls-files` e cruzando cada par. Sobreposição é resolvida mesclando os dois fluxos ou elevando os caminhos compartilhados para `shared`, com exatamente um dono.
- **Escritor único para arquivos compartilhados.** Um fluxo que não é dono nunca edita um caminho compartilhado — ele apenas anexa um pedido a `runtime/streams/<issue>/requests.jsonl` e continua trabalhando no seu próprio escopo.
- **Auditoria após cada onda.** Depois de cada onda, `git status --porcelain` no worktree é conferido contra a união dos escopos declarados. Qualquer coisa escrita fora da faixa interrompe a execução.
- **Dry run com `merge-tree`, sempre.** Todo PR e toda etapa de um trem de merge de épico é checado com `git merge-tree --write-tree` antes de qualquer alteração no histórico — em memória, sem efeitos colaterais na árvore de trabalho ou no índice.
- **Conflitos param para um humano.** `resolve-conflicts` só resolve automaticamente conflitos idênticos-dos-dois-lados, aditivos-em-lista, apenas-formatação, artefatos regeneráveis e resoluções replay do rerere, sob limites estritos de arquivos/hunks. Qualquer outra coisa — a mesma lógica mudou dos dois lados, uma migration, um caminho protegido — é um `STOP:` com os comandos exatos de recuperação.
- **O livro-razão de decisões (ruling ledger).** Toda decisão autônoma (dividir um fluxo, resolver um conflito trivial, cair para o modo de checklist) é anexada como uma linha em `epics/<slug>/ledger.md` e mostrada no resumo da skill e no comentário de PR do merge, para que um revisor veja exatamente o que foi decidido.

## Configuração

### `config.json` — política (escrito uma vez pelo `init`, nunca sobrescrito automaticamente)

```json
{
  "base_branch": "main",                 // resolvido a partir do branch padrão no momento do init
  "protected_branches": ["main", "master", "develop", "release/*"],
  "protected_paths": ["**/migrations/**", ".github/workflows/**", "**/auth/**", "**/security/**"],
  "branch_template": "{type}/{issue}-{slug}",
  "epic_branch_template": "epic/{slug}",
  "worktree_dir": ".worktrees",
  "worktree_link": [".env", ".env.local", ".envrc"],   // arquivos não versionados linkados em cada worktree
  "commit_template": "{type}({scope}): {subject} (#{issue})",
  "merge_strategy": "squash",            // squash | merge | rebase
  "delete_branch_on_merge": true,
  "require_review": true,                // merge para (STOP) a menos que reviewDecision == APPROVED
  "require_ci": true,                    // merge para a menos que todo check esteja SUCCESS/NEUTRAL
  "default_reviewers": [],
  "max_tasks_per_epic": 10,              // plan para com uma proposta de divisão acima disso
  "max_parallel_streams": 4,
  "worktree_mode": "auto",               // auto | shared | per-task
  "conflict_autonomy": { "max_files": 10, "max_hunks": 20, "max_rebase_commits": 20 },
  "test_gate_hook": false                // opcional, via adopt --enable-test-gate
}
```

Edite diretamente — é commitado, JSON simples, e toda skill lê o arquivo do zero a cada execução.

### `project-profile.json` — fatos detectados, sobrescrevíveis

Escrito por `scan`; nunca edite nada manualmente além do bloco `overrides`, que é mesclado (deep-merge) sobre todo valor detectado no momento da leitura e preservado literalmente por `scan --refresh`:

```json
{
  "overrides": {
    "commands": { "test": "make test-fast", "test_file": "make test-one FILE={file}" },
    "shared_files": ["config/routes.rb"],
    "secrets_globs": ["config/master.key"]
  }
}
```

Esquemas completos, anotados (em inglês): [`docs/STATE-MODEL.md`](STATE-MODEL.md).

## Suporte a stacks

`scan` detecta a stack a partir de manifestos, arquivos de configuração e scripts já presentes no repositório — nada é embutido por projeto. Tabela condensada de formatador/linter/typechecker (tabela completa em `docs/ARCHITECTURE.md`):

| Detectado | Formatação | Lint | Typecheck |
|---|---|---|---|
| Prettier / Biome / ESLint | `prettier --write` / `biome format --write` | `eslint .` / `biome lint .` | `tsc --noEmit` |
| Python (Ruff, Black+isort, mypy/pyright) | `ruff format` / `black && isort` | `ruff check` / `flake8` | `mypy .` / `pyright` |
| Go | `gofmt -w` | `golangci-lint run` / `go vet ./...` | `go build ./...` |
| Rust | `cargo fmt` | `cargo clippy -- -D warnings` | `cargo check` |
| Ruby | `rubocop -a` | `rubocop` | — |
| PHP | `php-cs-fixer fix` | `phpstan analyse` | — |
| Elixir | `mix format` | `mix credo` | `mix dialyzer` |
| Dart/Flutter | `dart format` | `dart analyze` | — |
| Swift | `swiftformat` | `swiftlint` | — |
| Java/Kotlin (Gradle) | `./gradlew spotlessApply` (só no projeto inteiro — por arquivo é lento demais) | `./gradlew check` | `./gradlew compileJava` |
| C/C++ | `clang-format -i` | `clang-tidy` | — |
| Terraform | `terraform fmt` | `tflint` | `terraform validate` |
| Nada detectado | `null` — o gate é pulado, nunca inventado | `null` | `null` |

Sua stack não está listada, ou foi detectada errado? Defina `overrides.commands` em `project-profile.json` — toda skill lê através desse override, sem precisar mudar código do plugin.

## Segurança

O plugin embarca exatamente um hook de guarda (`PreToolUse` em `Bash`), ativo para **qualquer** agente na sessão, não só os deste plugin:

| Padrão | Decisão |
|---|---|
| `git push --force` / `-f` (não `--force-with-lease`) | **nega** — use `resolve-conflicts`, que usa `--force-with-lease` com segurança |
| Force push mirando um branch protegido, ou `git push origin HEAD:main` | **nega** |
| `git worktree remove --force`/`-f` | **pergunta** |
| `git branch -D` / `--delete --force` | **pergunta** |
| `rm -rf` mirando `.worktrees/`, `.claude/agentic/`, ou `.git/` | **nega** — use `/agentic-git:cleanup` |
| `git reset --hard` num worktree com alterações não commitadas | **pergunta** |
| Escrever no `.git/` do checkout principal a partir de um worktree | **nega** |
| `git clean -xf` | **pergunta** |
| `gh repo delete`/`archive`, apagar um branch remoto protegido | **nega** |

Todo o resto passa silenciosamente. A guarda falha de forma **aberta** — um hook quebrado nunca bloqueia seu terminal.

**O que o plugin nunca fará, em nenhuma circunstância:** `git push --force` (só `--force-with-lease`, e só num branch que ele mesmo criou); `git branch -D`; `git reset --hard`; `git clean -fdx`; `git rebase --skip`; resolver automaticamente um conflito de merge semântico; `git checkout --ours/--theirs` em qualquer coisa que não seja um conflito trivial verificado mecanicamente; `gh pr merge --admin`; aprovar ou solicitar mudanças em um PR automaticamente; criar issues no próprio repositório do plugin (`marcelusfernandes/agentic-setup`) caso você tenha esquecido de trocar o `origin`.

## Solução de problemas

Sempre comece com:

```
/agentic-git:doctor
```

Ele roda todas as checagens como um único script e imprime `OK|WARN|FAIL` mais o comando de correção exato em cada linha.

| Sintoma | Causa | Correção |
|---|---|---|
| `doctor` reporta `git_too_old` | `git` < 2.38 — `merge-tree --write-tree` não está disponível | Atualize o git e rode `doctor` de novo |
| `init`/`sync`/`pr` param em `gh auth` | `gh` não autenticado, ou faltando o escopo `repo` | `gh auth login` / `gh auth refresh -s repo` |
| Um gate imprime "test: skipped (no command configured)" | `scan` não conseguiu detectar um comando de teste e corretamente gravou `null` em vez de adivinhar | Adicione `overrides.commands.test` em `project-profile.json`, depois rode `doctor` |
| `start` para com um baseline vermelho | Os testes já falham no branch base, antes de qualquer trabalho começar | Conserte o baseline primeiro, ou digite a confirmação literal para prosseguir mesmo assim (fica registrado como uma decisão no ledger) |
| `pr`/`merge` reporta que o branch conflita com a base | `merge-tree --write-tree` encontrou conflitos reais | `/agentic-git:resolve-conflicts <pr-ou-branch>` |
| `resolve-conflicts` imprime `STOP: N semantic conflicts` | A mesma lógica mudou dos dois lados, ou um caminho protegido está envolvido | Esse é o resultado esperado — resolva manualmente no caminho indicado, depois `git add <arquivos> && git rebase --continue` |
| `adopt` se recusa a mexer num arquivo de agente ou hook | Um sha não bate com `adopt-manifest.json` — um humano editou dentro do bloco de sentinela | Responda ao prompt por arquivo; o padrão é "manter o seu" |

## Contribuindo

```bash
bash tests/lint.sh              # shellcheck + lista de bashisms proibidos (bash 3.2) em scripts/ e assets/
bash tests/smoke.sh             # scripts de hook e de estado contra fixtures, num repositório descartável
claude plugin validate --strict .
```

Os três precisam passar sem nenhum erro antes de abrir um PR. Veja [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) (em inglês) para o design completo e a ordem de construção.

## Licença

MIT — veja [`LICENSE`](../LICENSE).
