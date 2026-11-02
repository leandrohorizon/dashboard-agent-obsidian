# Agent Obsidian Dashboard

Plugin de Obsidian que centraliza a operação do fluxo de cards do
[Agent Obsidian](https://github.com/leandrohorizon/agent_obsidian): Kanban por
pasta, lista com filtros, painel de `current_card` por projeto e ações de copiar
comando.

## Princípio

O plugin **lê** o board e os `.agent_obsidian` e **não executa** comando do fluxo
nem move card entre pastas. As únicas escritas são manutenção do state (reparo
idempotente e limpeza de `current_card`, com confirmação) e criação de card novo
a partir do template.

Não conhece agente de IA nenhum: o comando sugerido é dado de configuração.

## Instalação

```bash
git clone https://github.com/leandrohorizon/dashboard-agent-obsidian.git
cd dashboard-agent-obsidian
npm ci
npm run build
```

Copie `main.js`, `manifest.json` e `styles.css` para
`<vault>/.obsidian/plugins/dashboard-agent-obsidian/` e habilite em
`Settings` → `Community plugins`.

Requer Obsidian desktop (o plugin lê o `.agent_obsidian` por caminho absoluto,
fora do vault) e Node.js 20+ para build.

## Desenvolvimento

```bash
npm run watch     # rebuild contínuo
npm run verify    # typecheck + testes unitários + build + teste de integração
npm test          # 106 verificações das funções puras
npm run smoke     # 45 verificações de integração contra um vault real
```

O teste de integração carrega o `main.js` gerado com um `obsidian` stub e um
vault montado do disco, então bundle desatualizado quebra a verificação. Ele
precisa de um vault do Agent Obsidian:

```bash
AOB_VAULT=/caminho/do/vault npm run verify     # bash/zsh
$env:AOB_VAULT = "C:\caminho\do\vault"; npm run verify   # PowerShell
```

Sem `AOB_VAULT`, o teste de integração é ignorado com aviso e o `verify`
continua verde.

## Configuração

`Settings` → `Dashboard do Agent Obsidian`:

| Campo | Conteúdo |
|---|---|
| Raízes | diretórios cujos **filhos diretos** são projetos |
| Projetos incluídos manualmente | projetos fora das raízes |
| Projetos ignorados | caminhos que a varredura deve pular |
| Ações de copiar | lista JSON com `id`, `label`, `states`, `text` e `onlyWithPr` opcional |

Um diretório só é projeto se tiver `.agent_obsidian` na raiz.
