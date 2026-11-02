import * as nodePath from 'path';
import { classifyLink } from '../src/shared/links';
import { countTasks, extractLinks, extractSection, isEmptySection } from '../src/shared/text';
import { parseDateValue, parseDateMap, sortWithEmptyLast } from '../src/shared/dates';
import { validateCard } from '../src/shared/validation';
import { DATE_FIELDS, type BoardCard } from '../src/shared/types';
import { fillCardTemplate, sanitizeCardName } from '../src/shared/cardTemplate';
import { isDivergent, normalizeStatus } from '../src/shared/status';
import { normalizeRepo } from '../src/shared/repo';
import { normalizeFeature } from '../src/shared/features';
import { substitutePlaceholders, unknownPlaceholders, validateActions, actionsForCard } from '../src/shared/actions';
import {
  evaluateAgentState,
  readCurrentCard,
  serializeAgentState,
} from '../src/shared/state';
import {
  depthBelow,
  expandHome,
  isPathInside,
  normalizeProjectName,
  resolveProjectKey,
} from '../src/shared/paths';
import { discoverProjects, type FsProbe } from '../src/projects/registry';
import * as nodeFs from 'fs';
import * as nodeOs from 'os';
import {
  clearCurrentCard,
  readState,
  repairStateFile,
  writeWithConcurrencyCheck,
} from '../src/state/agentStateStore';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function equal<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, `esperado ${JSON.stringify(expected)}, obtido ${JSON.stringify(actual)}`);
}

const CARD = [
  '---',
  'status: In Progress',
  '---',
  '',
  '### Descrição',
  'Texto qualquer.',
  '```',
  '### Tarefas',
  '- [ ] dentro do fence',
  '```',
  '',
  '### Tarefas',
  '- [ ] aberta',
  '- [x] fechada',
  '  - [ ] aninhada aberta',
  '',
  '### Dependências',
  '- [[card-a]] — dependência',
  '- `[[nome-do-card]]` no código inline',
  '',
  '### Dependentes',
  '- [[card-b|apelido]]',
  '',
].join('\n');

equal('seção ignora heading dentro de fence', extractSection(CARD, 'Descrição')?.includes('dentro do fence'), true);
check('seção para no próximo heading', !(extractSection(CARD, 'Descrição') ?? '').includes('- [ ] aberta'));
equal('tarefas contadas só na seção', countTasks(extractSection(CARD, 'Tarefas')), {
  pending: 2,
  done: 1,
  total: 3,
});
equal('links ignoram código inline', extractLinks(extractSection(CARD, 'Dependências')), ['card-a']);
equal('link com apelido usa o alvo', extractLinks(extractSection(CARD, 'Dependentes')), ['card-b']);
equal('seção ausente retorna null', extractSection(CARD, 'Discussões'), null);
check('seção com só blockquote é vazia', isEmptySection('> instrução\n'));
check('seção com texto não é vazia', !isEmptySection('algo'));

const CARD_WITH_SUBHEADINGS = [
  '### Descrição',
  '',
  '> instrução do template',
  '',
  '## Objetivo',
  'conteúdo real da descrição',
  '',
  '## Contexto',
  'mais conteúdo',
  '',
  '### Dependências',
  '- [[card-a]]',
].join('\n');
check(
  'subseção H2 faz parte da Descrição',
  (extractSection(CARD_WITH_SUBHEADINGS, 'Descrição') ?? '').includes('conteúdo real da descrição'),
);
check(
  'Descrição com subseções não é vazia',
  !isEmptySection(extractSection(CARD_WITH_SUBHEADINGS, 'Descrição')),
);
check(
  'Descrição não engole a seção seguinte',
  !(extractSection(CARD_WITH_SUBHEADINGS, 'Descrição') ?? '').includes('[[card-a]]'),
);
const CARD_WITH_CANONICAL_H2 = ['### Descrição', 'texto', '## Discussões', 'conversa'].join('\n');
check(
  'heading canônico de nível menor fecha a seção',
  !(extractSection(CARD_WITH_CANONICAL_H2, 'Descrição') ?? '').includes('conversa'),
);

const DATE_CASES: Array<[string, unknown]> = [
  ['data YAML', new Date(Date.UTC(2026, 9, 23))],
  ['string ISO', '2026-10-23'],
];
for (const [label, raw] of DATE_CASES) {
  const parsed = parseDateValue(raw);
  equal(`data ${label}`, parsed.kind === 'valid' ? parsed.iso : parsed.kind, '2026-10-23');
}
equal('data inválida é inválida', parseDateValue('2026-13-45').kind, 'invalid');
equal('data impossível é inválida', parseDateValue('2026-02-30').kind, 'invalid');
equal('data vazia', parseDateValue('').kind, 'empty');
equal('data nula', parseDateValue(null).kind, 'empty');

const dates = ['2026-01-01', '', '2026-03-01', 'inválida'];
equal(
  'vazio sempre no fim (asc)',
  sortWithEmptyLast(dates, (value) => parseDateValue(value), 'asc'),
  ['2026-01-01', '2026-03-01', '', 'inválida'],
);
equal(
  'vazio sempre no fim (desc)',
  sortWithEmptyLast(dates, (value) => parseDateValue(value), 'desc'),
  ['2026-03-01', '2026-01-01', '', 'inválida'],
);

equal('status em lista de um item', normalizeStatus(['Done']).kind, 'ok');
equal('status em lista de um item (valor)', normalizeStatus(['Done']).value, 'Done');
equal('status vazio', normalizeStatus('').kind, 'missing');
equal('status desconhecido', normalizeStatus('Paused').kind, 'unknown');
equal('status em lista de vários', normalizeStatus(['A', 'B']).kind, 'list');
check('divergência detectada', isDivergent('2.in_progress', normalizeStatus('Done')));
check('sem divergência quando bate', !isDivergent('4.done', normalizeStatus('Done')));
check('backlog nunca diverge', !isDivergent('0.backlog', normalizeStatus('Done')));
check('status ausente não diverge', !isDivergent('2.in_progress', normalizeStatus('')));

equal('repo ssh com .git', normalizeRepo('git@github.com:leandrohorizon/app.notifier_listener.git'), 'leandrohorizon/app.notifier_listener');
equal('repo https com .git', normalizeRepo('https://github.com/leandrohorizon/agent_obsidian.git'), 'leandrohorizon/agent_obsidian');
equal('repo ssh sem .git', normalizeRepo('git@github.com:leandrohorizon/third-hand'), 'leandrohorizon/third-hand');
equal('repo sentinela local', normalizeRepo('Local (sem remote)'), null);
equal('repo sentinela removido', normalizeRepo('URL de repositório removida'), null);

equal('feature válida', normalizeFeature('dashboard-obsidian'), { value: 'dashboard-obsidian', invalid: false });
equal('feature lista usa o primeiro', normalizeFeature(['um-dois', 'tres']), { value: 'um-dois', invalid: false });
equal('feature inválida', normalizeFeature('Dashboard_Obsidian').invalid, true);
equal('feature vazia', normalizeFeature(''), { value: null, invalid: false });

const goodActions = validateActions([
  { id: 'start-card', label: 'iniciar', states: ['1.not_started'], text: '/start-card "{{name}}"' },
]);
equal('ação válida', goodActions.actions.length, 1);
equal('ação válida sem erro', goodActions.errors, []);
equal(
  'estado inválido desabilita a ação',
  validateActions([{ id: 'x', label: 'l', states: ['9.invalido'], text: 'y' }]).actions.length,
  0,
);
check(
  'placeholder desconhecido é reportado',
  validateActions([{ id: 'x', label: 'l', states: ['4.done'], text: '{{desconhecido}}' }]).errors.some(
    (message) => message.includes('{{desconhecido}}'),
  ),
);
check('id duplicado é reportado', validateActions([
  { id: 'a', label: 'l', states: ['4.done'], text: 'x' },
  { id: 'a', label: 'l', states: ['4.done'], text: 'y' },
]).errors.some((message) => message.includes('duplicado')));
equal('placeholders desconhecidos', unknownPlaceholders('{{name}} {{oauth}}'), ['oauth']);
equal(
  'substituição preserva desconhecido',
  substitutePlaceholders('/start-card "{{name}}" {{path}}', {
    name: 'card x',
    path: 'p',
    link: 'obsidian://open?vault=v&file=f',
    wikilink: '[[card x]]',
    pr: 'org/repo#1',
    pr_url: 'https://github.com/org/repo/pull/1',
    project: 'pr',
    feature: 'f',
    branch: 'b',
  }),
  '/start-card "card x" p',
);
equal(
  'link e wikilink são placeholders válidos',
  validateActions([
    { id: 'copy-link', label: 'nome e link', states: ['4.done'], text: '{{name}} -> {{link}} {{wikilink}}' },
  ]).errors,
  [],
);
equal(
  'pr e pr_url são placeholders válidos',
  validateActions([
    { id: 'copy-pr', label: 'PR', states: ['4.done'], onlyWithPr: true, text: '{{pr}} -> {{pr_url}}' },
  ]).errors,
  [],
);
equal(
  'substituição de PR no formato nome -> link',
  substitutePlaceholders('{{pr}} -> {{pr_url}}', {
    name: 'card x',
    path: 'p',
    link: 'l',
    wikilink: 'w',
    pr: 'org/repo#1',
    pr_url: 'https://github.com/org/repo/pull/1',
    project: 'pr',
    feature: 'f',
    branch: 'b',
  }),
  'org/repo#1 -> https://github.com/org/repo/pull/1',
);
check(
  'onlyWithPr não booleano é erro',
  validateActions([{ id: 'x', label: 'l', states: ['4.done'], onlyWithPr: 'sim', text: 'y' }]).errors.some(
    (message) => message.includes('onlyWithPr'),
  ),
);

const prActions = validateActions([
  { id: 'work-on-card', label: 'trabalhar', states: ['2.in_progress'], text: 'a' },
  { id: 'copy-pr', label: 'PR', states: ['2.in_progress'], onlyWithPr: true, text: 'b' },
]).actions;
equal(
  'ação de PR escondida sem PR',
  actionsForCard(prActions, { state: '2.in_progress', hasPr: false }).map((action) => action.id),
  ['work-on-card'],
);
equal(
  'ação de PR aparece com PR',
  actionsForCard(prActions, { state: '2.in_progress', hasPr: true }).map((action) => action.id),
  ['work-on-card', 'copy-pr'],
);

const VAULT = nodePath.join(nodePath.sep === '\\' ? 'C:\\vault' : '/vault');
const STATE_OK = JSON.stringify({
  version: '2.0',
  vault_path: VAULT,
  guidelines_path: nodePath.join(VAULT, 'guidelines'),
  condensed_memory_path: nodePath.join(VAULT, 'condensed memory', 'projects', 'proj.md'),
  current_card: null,
});

equal('state 2.0 não precisa de reparo', evaluateAgentState(STATE_OK, { vaultPath: VAULT, projectName: 'proj' }).kind, 'ok');
equal(
  'BOM não impede o parse do state',
  evaluateAgentState(`\uFEFF${STATE_OK}`, { vaultPath: VAULT, projectName: 'proj' }).kind,
  'ok',
);

const STATE_OLD = JSON.stringify({
  version: '1.0',
  guidelines_path: '/old/guidelines',
  conduct_path: '/old/conduct.md',
  condensed_memory_path: '/old/memory.md',
  chave_desconhecida: 'preservar',
});
const repaired = evaluateAgentState(STATE_OLD, { vaultPath: VAULT, projectName: 'proj' });
check('state 1.0 é reparado', repaired.kind === 'repair');
if (repaired.kind === 'repair') {
  equal('versão atualizada', repaired.data.version, '2.0');
  equal('chave desconhecida preservada', repaired.data.chave_desconhecida, 'preservar');
  equal('conduct_path removido', 'conduct_path' in repaired.data, false);
  equal(
    'memória apontando para projects/',
    repaired.data.condensed_memory_path,
    nodePath.join(VAULT, 'condensed memory', 'projects', 'proj.md'),
  );
  const again = evaluateAgentState(serializeAgentState(repaired.data), {
    vaultPath: VAULT,
    projectName: 'proj',
  });
  equal('reparo é idempotente', again.kind, 'ok');
}

const future = evaluateAgentState(
  JSON.stringify({ ...JSON.parse(STATE_OK), version: '3.0' }),
  { vaultPath: VAULT, projectName: 'proj' },
);
equal('versão futura bloqueia', future.kind === 'blocked' ? future.code : future.kind, 'future-version');

const broken = evaluateAgentState('{ "version": "2.0", ', { vaultPath: VAULT, projectName: 'proj' });
equal('json truncado bloqueia', broken.kind === 'blocked' ? broken.code : broken.kind, 'invalid-json');

equal(
  'current_card lido',
  readCurrentCard({ current_card: { name: 'n', path: 'p' } }),
  { name: 'n', path: 'p' },
);
equal('current_card nulo', readCurrentCard({ current_card: null }), { name: null, path: null });

equal('nome do projeto normalizado', normalizeProjectName('C:\\Users\\x\\agent-obsidian'), 'agent_obsidian');
equal('nome com espaço', normalizeProjectName('/tmp/third hand'), 'third_hand');
check('path contido', isPathInside('/vault/board/2.in_progress/a.md', '/vault/board'));
check('path com .. não é contido', !isPathInside('/vault/board/../fora.md', nodePath.join('/vault', 'board')));
equal('profundidade', depthBelow('/vault/board/2.in_progress', '/vault/board/2.in_progress/proj/a.md'), 2);
equal('expandHome', expandHome('~/projetos', '/home/user'), nodePath.join('/home/user', 'projetos'));

const linkContext = {
  cardsByBasename: new Map([
    ['card-a', [{ basename: 'card-a', state: '4.done' as const, path: 'board/4.done/card-a.md' }]],
    [
      'duplicado',
      [
        { basename: 'duplicado', state: '3.in_review' as const, path: 'board/3.in_review/duplicado.md' },
        { basename: 'duplicado', state: '4.done' as const, path: 'board/4.done/duplicado.md' },
      ],
    ],
  ]),
  featureExists: (slug: string) => slug === 'deploy-n8n',
  attachmentExists: (name: string) => name === 'Pasted image 1.png',
};
equal('link de card', classifyLink('card-a', linkContext).kind, 'card');
equal('link ambíguo', classifyLink('duplicado', linkContext).kind, 'ambiguous');
equal('link de feature memory', classifyLink('deploy-n8n', linkContext).kind, 'feature');
equal('link de anexo', classifyLink('Pasted image 1.png', linkContext).kind, 'attachment');
equal('link quebrado', classifyLink('inexistente', linkContext).kind, 'broken');

const rootDir = nodePath.resolve('fixture-workspace');
const manualDir = nodePath.resolve('fixture-manual');
const files: Record<string, FsProbe> = {
  [rootDir]: 'dir',
  [nodePath.join(rootDir, 'proj-a')]: 'dir',
  [nodePath.join(rootDir, 'proj-a', '.agent_obsidian')]: 'file',
  [nodePath.join(rootDir, 'proj-b')]: 'dir',
  [nodePath.join(rootDir, 'proj-b', '.agent_obsidian')]: 'file',
  [nodePath.join(rootDir, 'sem-state')]: 'dir',
  [nodePath.join(rootDir, '.oculto')]: 'dir',
  [nodePath.join(rootDir, '.oculto', '.agent_obsidian')]: 'file',
  [nodePath.join(rootDir, 'node_modules')]: 'dir',
  [nodePath.join(rootDir, 'node_modules', '.agent_obsidian')]: 'file',
  [nodePath.join(rootDir, 'proj-a', 'nested')]: 'dir',
  [nodePath.join(rootDir, 'proj-a', 'nested', '.agent_obsidian')]: 'file',
  [nodePath.join(manualDir, 'proj-c')]: 'dir',
  [nodePath.join(manualDir, 'proj-c', '.agent_obsidian')]: 'file',
};
const registry = discoverProjects(
  {
    roots: [rootDir, nodePath.join(rootDir, 'inexistente')],
    extraProjects: [nodePath.join(manualDir, 'proj-c'), nodePath.join(manualDir, 'sumiu')],
    excludedPaths: [nodePath.join(manualDir, 'proj-c')],
  },
  {
    homeDir: '/home/user',
    probe: (path) => files[path] ?? 'missing',
    listDirectories: (path) => {
      const prefix = path.endsWith(nodePath.sep) ? path : path + nodePath.sep;
      const names = Object.keys(files)
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length).split(nodePath.sep)[0]);
      return [...new Set(names)];
    },
  },
);
equal('projetos descobertos', registry.projects.map((project) => project.name), ['proj_a', 'proj_b']);
check(
  'raiz inexistente gera erro',
  registry.errors.some((error) => error.scope === 'root' && error.path.includes('inexistente')),
);
check(
  'projeto manual excluído não entra',
  !registry.projects.some((project) => project.name === 'proj_c'),
);
check(
  'projeto manual inexistente gera erro',
  registry.errors.some((error) => error.scope === 'project'),
);

equal(
  'mesma chave para caminhos equivalentes',
  resolveProjectKey(rootDir + nodePath.sep) === resolveProjectKey(rootDir),
  true,
);

const baseCard: BoardCard = {
  path: 'board/2.in_progress/x.md',
  basename: 'x',
  state: '2.in_progress',
  repo: 'org/repo',
  repoRaw: 'https://github.com/org/repo.git',
  status: normalizeStatus('In Progress'),
  feature: 'dashboard-obsidian',
  featureInvalid: false,
  dates: parseDateMap({ created: '2026-10-30' }, DATE_FIELDS),
  mtime: Date.UTC(2026, 9, 30),
  pendingTasks: 1,
  doneTasks: 0,
  totalTasks: 1,
  prUrl: null,
  prInvalid: false,
  sections: { 'Descrição': 'texto', 'Tarefas': '- [ ] a' },
  outgoingLinks: [],
};

const cardIssues = validateCard(baseCard);
equal(
  'sem aviso de Dependências/Dependentes ausentes',
  cardIssues.filter((issue) => issue.code.startsWith('missing-dependen')).length,
  0,
);
check(
  'Discussões ausente continua avisando',
  cardIssues.some((issue) => issue.code === 'missing-discussions'),
);
check(
  'card sem descrição continua erro',
  validateCard({ ...baseCard, sections: { Tarefas: '- [ ] a' } }).some(
    (issue) => issue.code === 'missing-description' && issue.severity === 'error',
  ),
);
check(
  'card com Descrição em subseções H2 não é acusado',
  !validateCard({
    ...baseCard,
    sections: {
      'Descrição': extractSection(CARD_WITH_SUBHEADINGS, 'Descrição'),
      Tarefas: '- [ ] a',
    },
  }).some((issue) => issue.code === 'missing-description'),
);

equal('nome de card remove caracteres inválidos', sanitizeCardName('a/b:c*d?"e"f<g>h|i'), 'a b c d e f g h i');
equal('nome de card colapsa espaços', sanitizeCardName('  dois   espaços  '), 'dois espaços');
equal('nome de card vazio', sanitizeCardName('   '), '');

const templateText = [
  '---',
  'repo:',
  'status:',
  '  - Not Started',
  'feature:',
  '---',
  '',
  '### Descrição',
  'texto',
].join('\n');
const filled = fillCardTemplate(templateText, {
  repo: '',
  branch: '',
  status: 'In Progress',
  feature: 'dashboard-obsidian',
  created: '2026-10-30',
});
check('frontmatter preenchido tem status', filled.includes('status: In Progress'));
check('frontmatter preenchido tem feature', filled.includes('feature: dashboard-obsidian'));
check('frontmatter preenchido tem created', filled.includes('created: 2026-10-30'));
check('lista de status do template foi substituída', !filled.includes('- Not Started'));
check('corpo do template preservado', filled.includes('### Descrição'));
check('frontmatter começa com repo vazio', filled.startsWith('---\nrepo: \n'), filled.slice(0, 20));

const tempDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'aob-state-'));const stateFile = nodePath.join(tempDir, '.agent_obsidian');
const stateContext = { vaultPath: VAULT, projectName: 'proj' };
const memoryPath = nodePath.join(VAULT, 'condensed memory', 'projects', 'proj.md');
const guidelines = nodePath.join(VAULT, 'guidelines');

nodeFs.writeFileSync(stateFile, JSON.stringify({ version: '1.0', guidelines_path: '/old' }), 'utf8');
equal('reparo em arquivo real', repairStateFile(stateFile, stateContext).kind, 'repaired');
const repairedText = nodeFs.readFileSync(stateFile, 'utf8');
const repairedData = JSON.parse(repairedText);
equal('arquivo reparado tem version 2.0', repairedData.version, '2.0');
equal('arquivo reparado aponta guidelines', repairedData.guidelines_path, guidelines);
equal('arquivo reparado aponta memória', repairedData.condensed_memory_path, memoryPath);
equal('reparo é idempotente no arquivo', repairStateFile(stateFile, stateContext).kind, 'unchanged');

const snapshotBeforeEdit = readState(stateFile).snapshot;
nodeFs.writeFileSync(stateFile, repairedText.replace('"2.0"', '"2.0" '), 'utf8');
const concurrentWrite = writeWithConcurrencyCheck(
  stateFile,
  serializeAgentState({ version: '2.0' }),
  snapshotBeforeEdit,
);
equal('escrita concorrente é abortada', concurrentWrite.ok, false);
check(
  'mensagem de concorrência',
  concurrentWrite.ok === false && concurrentWrite.reason === 'changed',
  JSON.stringify(concurrentWrite),
);

const fullState = {
  version: '2.0',
  vault_path: VAULT,
  guidelines_path: guidelines,
  condensed_memory_path: memoryPath,
  current_card: { name: 'card x', path: nodePath.join(VAULT, 'board', '2.in_progress', 'card x.md') },
  chave_extra: 'preservar',
};
nodeFs.writeFileSync(stateFile, JSON.stringify(fullState), 'utf8');
const clearSnapshot = readState(stateFile).snapshot;
equal(
  'limpar current_card',
  clearSnapshot === null ? 'sem snapshot' : clearCurrentCard(stateFile, clearSnapshot, stateContext).kind,
  'ok',
);
const cleared = JSON.parse(nodeFs.readFileSync(stateFile, 'utf8'));
equal('current_card virou null', cleared.current_card, null);
equal('limpar preserva outras chaves', cleared.chave_extra, 'preservar');
equal('limpar preserva version', cleared.version, '2.0');

nodeFs.writeFileSync(stateFile, JSON.stringify({ version: '1.0' }), 'utf8');
const blockedClearSnapshot = readState(stateFile).snapshot;
equal(
  'limpar bloqueado quando o state precisa de reparo',
  blockedClearSnapshot === null ? 'sem snapshot' : clearCurrentCard(stateFile, blockedClearSnapshot, stateContext).kind,
  'blocked',
);

nodeFs.writeFileSync(stateFile, JSON.stringify({ version: '3.0' }), 'utf8');
equal('reparo bloqueado em versão futura', repairStateFile(stateFile, stateContext).kind, 'blocked');
equal(
  'arquivo de versão futura fica intocado',
  JSON.parse(nodeFs.readFileSync(stateFile, 'utf8')).version,
  '3.0',
);

nodeFs.rmSync(tempDir, { recursive: true, force: true });

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`\n${failures.length} de ${total} verificações falharam:\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(`\n${passed}/${total} verificações passaram.`);
