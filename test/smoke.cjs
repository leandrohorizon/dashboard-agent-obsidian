const fs = require('fs');
const path = require('path');
const Module = require('module');
const yaml = require('js-yaml');
const { JSDOM } = require('jsdom');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const VAULT = process.env.AOB_VAULT ? path.resolve(process.env.AOB_VAULT) : '';

if (VAULT === '' || !fs.existsSync(path.join(VAULT, 'board'))) {
  console.log(
    '\nSmoke test ignorado: defina AOB_VAULT apontando para um vault do Agent Obsidian',
  );
  console.log('(o diretório precisa ter uma pasta `board/` com cards).\n');
  process.exit(0);
}

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function equal(name, actual, expected) {
  check(name, actual === expected, `esperado ${expected}, obtido ${actual}`);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
global.window = window;
global.document = window.document;
global.Element = window.Element;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.navigator = window.navigator;
global.Event = window.Event;

const clipboard = [];
Object.defineProperty(window.navigator, 'clipboard', {
  value: { writeText: async (text) => { clipboard.push(text); } },
  configurable: true,
});

const proto = window.Element.prototype;

function applyOptions(element, options) {
  if (!options) return element;
  if (typeof options === 'string') {
    element.className = options;
    return element;
  }
  if (options.cls) {
    element.className = Array.isArray(options.cls) ? options.cls.join(' ') : options.cls;
  }
  if (options.text !== undefined) element.textContent = options.text;
  if (options.type !== undefined) element.setAttribute('type', options.type);
  if (options.href !== undefined) element.setAttribute('href', options.href);
  if (options.value !== undefined) element.value = options.value;
  if (options.attr) {
    for (const [key, value] of Object.entries(options.attr)) element.setAttribute(key, value);
  }
  return element;
}

proto.createEl = function createEl(tag, options, callback) {
  const element = document.createElement(tag);
  applyOptions(element, options);
  this.appendChild(element);
  if (typeof callback === 'function') callback(element);
  return element;
};
proto.createDiv = function createDiv(options, callback) {
  return this.createEl('div', options, callback);
};
proto.createSpan = function createSpan(options, callback) {
  return this.createEl('span', options, callback);
};
proto.empty = function empty() {
  while (this.firstChild) this.removeChild(this.firstChild);
};
proto.addClass = function addClass(...values) {
  for (const value of values) {
    for (const cls of String(value).split(/\s+/).filter(Boolean)) this.classList.add(cls);
  }
};
proto.removeClass = function removeClass(...values) {
  for (const value of values) {
    for (const cls of String(value).split(/\s+/).filter(Boolean)) this.classList.remove(cls);
  }
};
proto.setText = function setText(text) {
  this.textContent = text;
};
proto.getText = function getText() {
  return this.textContent;
};

class TAbstractFile {
  constructor(filePath) {
    this.path = filePath;
    this.name = filePath.split('/').pop();
    this.basename = this.name.replace(/\.md$/, '');
    this.extension = this.name.includes('.') ? this.name.split('.').pop() : '';
  }
}

class TFile extends TAbstractFile {
  constructor(filePath, stat) {
    super(filePath);
    this.stat = stat;
  }
}

class TFolder extends TAbstractFile {
  constructor(filePath) {
    super(filePath);
    this.children = [];
  }
}

const notices = [];
const opened = [];
let currentApp = null;

class WorkspaceLeaf {
  constructor(app) {
    this.app = app;
    this.view = null;
  }
  async setViewState() {}
  async openFile(file) {
    opened.push(file.path);
  }
}

class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = document.createElement('div');
    this.contentEl = document.createElement('div');
    this.containerEl.appendChild(this.contentEl);
  }
  registerEvent(reference) {
    return reference;
  }
}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest ?? {};
  }
  addRibbonIcon() {
    return document.createElement('div');
  }
  addCommand() {}
  registerView() {}
  addSettingTab() {}
  async loadData() {
    return null;
  }
  async saveData() {}
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement('div');
  }
}

class Setting {
  constructor(containerEl) {
    this.settingEl = document.createElement('div');
    containerEl.appendChild(this.settingEl);
  }
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addTextArea(callback) {
    const inputEl = document.createElement('textarea');
    this.settingEl.appendChild(inputEl);
    callback({
      inputEl,
      setValue(value) {
        inputEl.value = value;
        return this;
      },
      setPlaceholder() {
        return this;
      },
      onChange(handler) {
        inputEl.addEventListener('change', () => handler(inputEl.value));
        return this;
      },
    });
    return this;
  }
}

class Modal {
  constructor(app) {
    this.app = app;
    this.titleEl = document.createElement('div');
    this.contentEl = document.createElement('div');
  }
  open() {}
  close() {}
}

const fakeObsidian = {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Modal,
  Notice: class {
    constructor(message) {
      notices.push(message);
    }
  },
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  Platform: { isDesktopApp: true },
  setIcon: (element) => element,
  normalizePath: (value) => value.replace(/\\/g, '/').replace(/\/+/g, '/'),
};

function buildVault() {
  const byPath = new Map();

  const register = (relativePath, stat) => {
    const file = new TFile(relativePath, stat);
    byPath.set(relativePath, file);
    return file;
  };

  const walk = (absoluteDir, relativeDir) => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.name === '.obsidian' || entry.name === 'node_modules') continue;
      const absolute = path.join(absoluteDir, entry.name);
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      const stat = fs.statSync(absolute);
      register(relative, { mtime: Math.floor(stat.mtimeMs), ctime: 0, size: stat.size, type: 'file' });
    }
  };

  for (const root of ['board', 'condensed memory', 'resources']) {
    const absolute = path.join(VAULT, root);
    if (fs.existsSync(absolute)) walk(absolute, root);
  }

  const folders = new Map();
  const folderFor = (relativeDir) => {
    if (folders.has(relativeDir)) return folders.get(relativeDir);
    const folder = new TFolder(relativeDir);
    folders.set(relativeDir, folder);
    return folder;
  };

  for (const [relativePath, file] of byPath) {
    const segments = relativePath.split('/');
    segments.pop();
    let parentPath = '';
    for (const segment of segments) {
      const childPath = parentPath === '' ? segment : `${parentPath}/${segment}`;
      const parent = parentPath === '' ? { children: [] } : folderFor(parentPath);
      const child = folderFor(childPath);
      if (!parent.children.includes(child)) parent.children.push(child);
      parentPath = childPath;
      if (parentPath === '') break;
    }
    const parent = folderFor(segments.join('/'));
    parent.children.push(file);
  }

  const rootEntry = { children: [...folders.values()].filter((folder) => !folder.path.includes('/')) };

  return {
    byPath,
    folders,
    rootEntry,
  };
}

const vaultData = buildVault();
const vaultHandlers = new Map();
const overrides = new Map();

function readContent(relativePath) {
  if (overrides.has(relativePath)) return overrides.get(relativePath);
  const absolute = path.join(VAULT, ...relativePath.split('/'));
  if (!fs.existsSync(absolute)) return null;
  return fs.readFileSync(absolute, 'utf8');
}

const vault = {
  getName: () => 'agent_obsidian',
  adapter: {
    getBasePath: () => VAULT,
    stat: async (relativePath) => {
      const absolute = path.join(VAULT, ...relativePath.split('/'));
      if (!fs.existsSync(absolute)) {
        return { mtime: Date.now(), ctime: 0, size: 10, type: 'file' };
      }
      const stat = fs.statSync(absolute);
      return { mtime: Math.floor(stat.mtimeMs), ctime: 0, size: stat.size, type: 'file' };
    },
  },
  getAbstractFileByPath: (relativePath) => vaultData.byPath.get(relativePath) ?? vaultData.folders.get(relativePath) ?? null,
  getFiles: () => [...vaultData.byPath.values()],
  cachedRead: async (file) => {
    const text = readContent(file.path);
    if (text !== null) return text;
    return [
      '---',
      'status: In Progress',
      'pr_url: https://github.com/org/repo/pull/1',
      '---',
      '',
      '### Descrição',
      'card criado pelo harness',
      '',
      '### Tarefas',
      '- [ ] uma tarefa',
      '',
    ].join('\n');
  },
  getConfig: (key) => (key === 'attachmentFolderPath' ? 'resources' : null),
  on: (event, handler) => {
    const handlers = vaultHandlers.get(event) ?? [];
    handlers.push(handler);
    vaultHandlers.set(event, handlers);
    return { event };
  },
  offref: () => {},
  emit: (event, payload) => {
    for (const handler of vaultHandlers.get(event) ?? []) handler(payload);
  },
};

function parseFrontmatter(relativePath) {
  const text = readContent(relativePath);
  if (text === null) return undefined;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return undefined;
  try {
    return yaml.load(match[1]) ?? undefined;
  } catch {
    return undefined;
  }
}

const app = {
  vault,
  metadataCache: { getFileCache: (file) => ({ frontmatter: parseFrontmatter(file.path) }) },
  workspace: {
    getLeavesOfType: () => [],
    getLeaf: () => new WorkspaceLeaf(app),
  },
};
currentApp = app;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'obsidian') return fakeObsidian;
  return originalLoad.call(this, request, parent, isMain);
};
const pluginModule = require(path.join(PLUGIN_DIR, 'main.js'));
Module._load = originalLoad;

const PluginClass = pluginModule.default ?? pluginModule;
check('main.js exporta uma classe de plugin', typeof PluginClass === 'function');

const bundle = fs.readFileSync(path.join(PLUGIN_DIR, 'main.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));

check('AG1: sem dependência de runtime', packageJson.dependencies === undefined);
check('AG2: sem requestUrl', !bundle.includes('requestUrl'));
check('AG2: sem fetch(', !/\bfetch\s*\(/.test(bundle));
check('AG2: sem XMLHttpRequest', !bundle.includes('XMLHttpRequest'));
check('AG3: sem child_process', !bundle.includes('child_process'));
check('AG3: sem execSync', !bundle.includes('execSync'));
check('AG3: sem spawnSync', !bundle.includes('spawnSync'));
check(
  'AG4: sem nome de agente no bundle',
  !/claude|gemini|copilot|openai|anthropic/i.test(bundle),
);

async function main() {
  const plugin = new PluginClass(app, {});
  const registered = {};
  plugin.registerView = (type, factory) => {
    registered[type] = factory;
  };
  await plugin.onload();

  check('view registrada', typeof registered['aob-dashboard'] === 'function');

  plugin.settings.roots = ['C:\\Users\\leck_\\workspace'];
  plugin.settings.extraProjects = [];
  plugin.settings.excludedPaths = [];

  const leaf = new WorkspaceLeaf(app);
  const view = registered['aob-dashboard'](leaf);
  await view.onOpen();
  document.body.appendChild(view.containerEl);

  const stateFolders = fs
    .readdirSync(path.join(VAULT, 'board'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const expectedCards = (() => {
    let count = 0;
    const countDir = (dir, depth) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (depth < 2) countDir(path.join(dir, entry.name), depth + 1);
          continue;
        }
        if (entry.name.endsWith('.md')) count += 1;
      }
    };
    for (const state of stateFolders) countDir(path.join(VAULT, 'board', state), 1);
    return count;
  })();

  const expectedActiveCard = (
    JSON.parse(fs.readFileSync(path.join(VAULT, '.agent_obsidian'), 'utf8').replace(/^\uFEFF/, ''))
      .current_card?.name ?? ''
  );

  equal('colunas = pastas de estado', view.contentEl.querySelectorAll('.aob-column').length, stateFolders.length);
  equal('tiles = cards do board', view.contentEl.querySelectorAll('.aob-card').length, expectedCards);
  equal('três abas', view.contentEl.querySelectorAll('.aob-tab').length, 3);
  check('badge de divergência aparece', view.contentEl.querySelectorAll('.aob-badge.is-warning').length > 0);

  const kanbanBefore = view.contentEl.querySelectorAll('.aob-card').length;

  const projectsTab = [...view.contentEl.querySelectorAll('.aob-tab')].find(
    (button) => button.textContent === 'Projetos',
  );
  projectsTab.click();
  const projectRows = view.contentEl.querySelectorAll('.aob-table tbody tr').length;
  check('painel de projetos lista os projetos encontrados', projectRows >= 1, `linhas: ${projectRows}`);
  check(
    'painel de projetos mostra o projeto do vault',
    view.contentEl.textContent.includes('agent_obsidian'),
  );
  check(
    'painel de projetos mostra o card ativo',
    expectedActiveCard !== '' && view.contentEl.textContent.includes(expectedActiveCard),
    `esperado: ${expectedActiveCard}`,
  );

  const boardTab = [...view.contentEl.querySelectorAll('.aob-tab')].find(
    (button) => button.textContent === 'Kanban',
  );
  boardTab.click();
  equal('kanban restaurado', view.contentEl.querySelectorAll('.aob-card').length, kanbanBefore);

  const columns = [...view.contentEl.querySelectorAll('.aob-column')];
  const inProgressColumn = columns.find(
    (column) => column.querySelector('.aob-column-name')?.textContent === '2.in_progress',
  );
  check('coluna 2.in_progress existe', inProgressColumn !== undefined);

  const firstCard = inProgressColumn.querySelector('.aob-card');
  check('há card em 2.in_progress', firstCard !== null);
  firstCard.click();
  check('painel de detalhe abre', view.contentEl.querySelector('.aob-aside-title') !== null);
  const copyButtons = view.contentEl.querySelectorAll('.aob-copy');
  check('ação de copiar aparece no detalhe', copyButtons.length > 0);

  if (copyButtons.length > 0) {
    const button = copyButtons[0];
    const label = button.textContent;
    button.click();
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    check('botão nomeia o verbo Copiar', label.startsWith('Copiar — '), label);
    check('clipboard recebeu o texto', clipboard.length === 1, JSON.stringify(clipboard));
    check(
      'texto copiado é o comando configurado',
      /^\/(start-card|work-on-card|review-card|complete-card) "/.test(clipboard[0] ?? ''),
      clipboard[0],
    );
  }

  const copyLabels = [...view.contentEl.querySelectorAll('.aob-copy')].map((button) => button.textContent);
  check(
    'ação de review removida',
    copyLabels.every((label) => !/review/i.test(label)),
    JSON.stringify(copyLabels),
  );

  const prButtonsHere = [...view.contentEl.querySelectorAll('.aob-copy')].map((button) => button.textContent);
  equal('ação de PR não aparece em card sem PR', prButtonsHere.length, 1);

  const reviewColumn = [...view.contentEl.querySelectorAll('.aob-column')].find(
    (column) => column.querySelector('.aob-column-name')?.textContent === '3.in_review',
  );
  check('coluna 3.in_review existe', reviewColumn !== undefined);
  const reviewTiles = [...reviewColumn.querySelectorAll('.aob-card')];
  const prTile =
    reviewTiles.find(
      (tile) => tile.querySelector('.aob-card-title')?.textContent === 'memoria operacional da IA',
    ) ?? reviewTiles[0];
  check('há card em 3.in_review', prTile !== undefined);
  prTile.click();

  const prButton = [...view.contentEl.querySelectorAll('.aob-copy')].find((button) =>
    /PR/.test(button.textContent),
  );
  check(
    'ação de nome e link do PR aparece em card com PR',
    prButton !== undefined,
    JSON.stringify([...view.contentEl.querySelectorAll('.aob-copy')].map((button) => button.textContent)),
  );
  if (prButton) {
    prButton.click();
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    const prText = clipboard[clipboard.length - 1] ?? '';
    check('texto do PR segue "título -> url"', /^.+ -> https?:\/\/\S+$/.test(prText), prText);
  }

  const activeTiles = view.contentEl.querySelectorAll('.aob-card.is-active');
  check('existe card ativo destacado no kanban', activeTiles.length >= 1, `${activeTiles.length}`);
  const highlighted = [...view.contentEl.querySelectorAll('.aob-card.is-active')].some(
    (tile) => tile.querySelector('.aob-card-title')?.textContent === expectedActiveCard,
  );
  check(
    'o current_card do projeto está destacado',
    expectedActiveCard !== '' && highlighted,
    `esperado: ${expectedActiveCard}`,
  );

  const newCardButton = [...view.contentEl.querySelectorAll('.aob-button')].find(
    (button) => button.getAttribute('aria-label') === 'Novo card',
  );
  check('botão de novo card existe', newCardButton !== undefined);

  const closeButton = view.contentEl.querySelector('.aob-close');
  check('botão de fechar o detalhe existe', closeButton !== null);
  closeButton.click();
  check('detalhe fecha ao clicar no ×', view.contentEl.querySelector('.aob-aside') === null);

  const listTab = [...view.contentEl.querySelectorAll('.aob-tab')].find(
    (button) => button.textContent === 'Lista',
  );
  listTab.click();
  equal('lista mostra os mesmos cards', view.contentEl.querySelectorAll('.aob-table tbody tr').length, kanbanBefore);

  const searchBox = () => view.contentEl.querySelector('.aob-filters input[type="search"]');
  const rowCount = () => view.contentEl.querySelectorAll('.aob-table tbody tr').length;
  const flushSearch = () => new Promise((resolve) => window.setTimeout(resolve, 260));
  const typeSearch = (input, value) => {
    input.value = value;
    input.dispatchEvent(new window.Event('input'));
  };

  const searchInput = searchBox();
  check('campo de busca existe', searchInput !== null);
  searchInput.focus();
  check('campo de busca recebe foco', document.activeElement === searchInput);

  typeSearch(searchInput, 'zzzz');
  await flushSearch();
  equal('busca sem correspondência esvazia a lista', rowCount(), 0);
  check('busca mantém o foco depois de filtrar', document.activeElement === searchInput);
  equal('busca não recria o input', searchBox(), searchInput);

  typeSearch(searchInput, '');
  await flushSearch();
  equal('limpar a busca restaura a lista', rowCount(), kanbanBefore);

  typeSearch(searchInput, 'memoria');
  await flushSearch();
  const rowsWithSearch = rowCount();
  check('busca existente encontra cards', rowsWithSearch > 0, `${rowsWithSearch}`);
  check('busca de palavra inteira mantém o foco', document.activeElement === searchInput);

  searchInput.value = 'memXoria';
  searchInput.setSelectionRange(4, 4);
  searchInput.dispatchEvent(new window.Event('input'));
  await flushSearch();
  equal('edição no meio do texto mantém o valor digitado', searchInput.value, 'memXoria');
  equal('edição no meio do texto mantém o cursor', searchInput.selectionStart, 4);
  equal('edição no meio do texto mantém o fim da seleção', searchInput.selectionEnd, 4);
  check('edição no meio do texto mantém o foco', document.activeElement === searchInput);
  equal('texto editado é aplicado ao filtro', rowCount(), 0);

  typeSearch(searchInput, 'memoria');
  await flushSearch();

  const stateChip = [...view.contentEl.querySelectorAll('.aob-chip')].find(
    (element) => element.textContent === '1.not_started',
  );
  stateChip.click();
  equal('busca preservada ao mexer no filtro de estado', searchBox().value, 'memoria');
  const statesAfterChip = [...view.contentEl.querySelectorAll('.aob-table tbody tr')].map(
    (row) => row.children[2].textContent,
  );
  check(
    'busca compõe com o filtro de estado',
    statesAfterChip.every((state) => state !== '1.not_started'),
    JSON.stringify(statesAfterChip),
  );
  [...view.contentEl.querySelectorAll('.aob-chip')]
    .find((element) => element.textContent === '1.not_started')
    .click();

  const selectFor = (label) => {
    const field = [...view.contentEl.querySelectorAll('.aob-field')].find(
      (element) => element.querySelector('.aob-field-label')?.textContent === label,
    );
    return field ? field.querySelector('select') : null;
  };

  const projectSelect = selectFor('Projeto');
  check('filtro de projeto existe', projectSelect !== null);
  projectSelect.value = '__none__';
  projectSelect.dispatchEvent(new window.Event('change'));
  equal('busca preservada ao mexer no filtro de projeto', searchBox().value, 'memoria');
  const projectsAfterFilter = [...view.contentEl.querySelectorAll('.aob-table tbody tr')].map(
    (row) => row.children[1].textContent,
  );
  check(
    'busca compõe com o filtro de projeto',
    projectsAfterFilter.every((project) => project === '—'),
    JSON.stringify(projectsAfterFilter),
  );
  selectFor('Projeto').value = '';
  selectFor('Projeto').dispatchEvent(new window.Event('change'));

  const sortSelect = selectFor('Ordenar por');
  check('filtro de ordenação existe', sortSelect !== null);
  sortSelect.value = 'title';
  sortSelect.dispatchEvent(new window.Event('change'));
  equal('busca preservada ao trocar a ordenação', searchBox().value, 'memoria');
  const titlesSorted = [...view.contentEl.querySelectorAll('.aob-table tbody tr')].map(
    (row) => row.children[0].textContent,
  );
  const descending = [...titlesSorted].sort((left, right) => right.localeCompare(left));
  check(
    'ordenação por título aplicada com busca ativa',
    JSON.stringify(titlesSorted) === JSON.stringify(descending),
    `obtido ${JSON.stringify(titlesSorted)} vs esperado ${JSON.stringify(descending)}`,
  );
  selectFor('Ordenar por').value = 'mtime';
  selectFor('Ordenar por').dispatchEvent(new window.Event('change'));

  const sinceInput = view.contentEl.querySelector('.aob-since input[type="date"]');
  check('filtro de data existe', sinceInput !== null);
  sinceInput.value = '2020-01-01';
  sinceInput.dispatchEvent(new window.Event('change'));
  equal('busca preservada ao mexer no filtro de data', searchBox().value, 'memoria');
  check('filtro de data mantém a busca aplicada', rowCount() <= rowsWithSearch, `${rowCount()} vs ${rowsWithSearch}`);
  view.contentEl.querySelector('.aob-since input[type="date"]').value = '';
  view.contentEl.querySelector('.aob-since input[type="date"]').dispatchEvent(new window.Event('change'));

  typeSearch(searchBox(), '');
  await flushSearch();
  equal('lista volta ao total depois de limpar a busca', rowCount(), kanbanBefore);

  equal('filtro de pendentes removido da barra', view.contentEl.querySelectorAll('.aob-check').length, 0);
  const headerLabels = [...view.contentEl.querySelectorAll('.aob-table thead th')].map(
    (cell) => cell.textContent,
  );
  check('coluna de pendentes removida da lista', !headerLabels.includes('Pendentes'), JSON.stringify(headerLabels));
  const sortOptions = [...(selectFor('Ordenar por')?.querySelectorAll('option') ?? [])].map(
    (option) => option.value,
  );
  check('ordenação por pendentes removida', !sortOptions.includes('pending'), JSON.stringify(sortOptions));

  const kanbanAgain = [...view.contentEl.querySelectorAll('.aob-tab')].find(
    (button) => button.textContent === 'Kanban',
  );
  kanbanAgain.click();
  check(
    'indicador de pendentes removido dos tiles',
    !/\d+\/\d+ pendentes/.test(view.contentEl.textContent),
  );
  const otherStates = stateFolders.filter((state) => state !== '2.in_progress');
  for (const state of otherStates) {
    const chip = [...view.contentEl.querySelectorAll('.aob-chip')].find(
      (element) => element.textContent === state,
    );
    if (chip) chip.click();
  }
  equal(
    'colunas vazias são minimizadas',
    view.contentEl.querySelectorAll('.aob-column.is-empty').length,
    otherStates.length,
  );
  equal(
    'coluna com cards continua aberta',
    view.contentEl.querySelectorAll('.aob-column:not(.is-empty)').length,
    1,
  );

  const visibleBeforeDelete = view.contentEl.querySelectorAll('.aob-card').length;
  const firstCardUnder = (folderPath) => {
    const folder = vaultData.folders.get(folderPath);
    const direct = folder.children.find((child) => child.path.endsWith('.md'));
    if (direct) return { folder, file: direct };
    for (const child of folder.children) {
      if (!Array.isArray(child.children)) continue;
      const nested = firstCardUnder(child.path);
      if (nested) return nested;
    }
    return null;
  };
  const victimEntry = firstCardUnder('board/2.in_progress');
  check('harness encontra card em 2.in_progress', victimEntry !== null);
  const victim = victimEntry.file;
  vaultData.byPath.delete(victim.path);
  victimEntry.folder.children = victimEntry.folder.children.filter((child) => child.path !== victim.path);
  vault.emit('delete', { path: victim.path });
  await new Promise((resolve) => window.setTimeout(resolve, 800));
  equal(
    'arquivo apagado sai do kanban sem atualizar à mão',
    view.contentEl.querySelectorAll('.aob-card').length,
    visibleBeforeDelete - 1,
  );

  const createdPath = 'board/2.in_progress/card de teste do harness.md';
  overrides.set(
    createdPath,
    [
      '---',
      'status: In Progress',
      'pr_url: https://github.com/org/repo/pull/1',
      '---',
      '',
      '### Descrição',
      'card criado pelo harness',
      '',
      '### Tarefas',
      '- [ ] uma tarefa',
      '',
    ].join('\n'),
  );
  const createdFile = new TFile(createdPath, { mtime: Date.now(), ctime: 0, size: 10, type: 'file' });
  vaultData.byPath.set(createdPath, createdFile);
  vaultData.folders.get('board/2.in_progress').children.push(createdFile);
  vault.emit('create', createdFile);
  await new Promise((resolve) => window.setTimeout(resolve, 800));
  equal(
    'arquivo criado entra no kanban sem atualizar à mão',
    view.contentEl.querySelectorAll('.aob-card').length,
    visibleBeforeDelete,
  );

  const createdTile = [...view.contentEl.querySelectorAll('.aob-card')].find(
    (tile) => tile.querySelector('.aob-card-title')?.textContent === 'card de teste do harness',
  );
  check('card criado aparece no kanban', createdTile !== undefined);
  if (createdTile) {
    createdTile.click();
    const createdPrButton = [...view.contentEl.querySelectorAll('.aob-copy')].find((button) =>
      /PR/.test(button.textContent),
    );
    check('card com PR mostra a ação de PR', createdPrButton !== undefined);
    if (createdPrButton) {
      createdPrButton.click();
      await new Promise((resolve) => window.setTimeout(resolve, 10));
      equal(
        'usa o nome do card como título do PR',
        clipboard[clipboard.length - 1],
        'card de teste do harness -> https://github.com/org/repo/pull/1',
      );
    }
  }

  const kanbanTab = [...view.contentEl.querySelectorAll('.aob-tab')].find(
    (button) => button.textContent === 'Kanban',
  );
  if (kanbanTab && !kanbanTab.classList.contains('is-active')) kanbanTab.click();
  for (;;) {
    const inactive = [...view.contentEl.querySelectorAll('.aob-chip')].find(
      (chip) => !chip.classList.contains('is-active'),
    );
    if (inactive === undefined) break;
    inactive.click();
  }

  const perfFolder = vaultData.folders.get('board/2.in_progress');
  const baseTiles = view.contentEl.querySelectorAll('.aob-card').length;
  const syntheticFiles = [];
  for (let index = 0; index < 500; index += 1) {
    const relativePath = `board/2.in_progress/card sintetico ${index}.md`;
    const file = new TFile(relativePath, { mtime: Date.now(), ctime: 0, size: 10, type: 'file' });
    vaultData.byPath.set(relativePath, file);
    perfFolder.children.push(file);
    syntheticFiles.push(file);
  }
  await view.refresh();
  equal(
    'board sintético entra no kanban',
    view.contentEl.querySelectorAll('.aob-card').length,
    baseTiles + syntheticFiles.length,
  );

  const perfInput = view.contentEl.querySelector('.aob-filters input[type="search"]');
  const startedAt = Date.now();
  perfInput.focus();
  perfInput.value = 'card sintetico 42';
  perfInput.dispatchEvent(new window.Event('input'));
  await new Promise((resolve) => window.setTimeout(resolve, 300));
  const elapsedMs = Date.now() - startedAt;
  check('busca responde em board maior', elapsedMs < 2000, `${elapsedMs}ms`);
  const syntheticMatches = view.contentEl.querySelectorAll('.aob-card').length;
  check('busca filtra no board sintético', syntheticMatches >= 1 && syntheticMatches <= 20, `${syntheticMatches}`);
  check('busca mantém o foco no board sintético', document.activeElement === perfInput);

  for (const file of syntheticFiles) {
    vaultData.byPath.delete(file.path);
    perfFolder.children = perfFolder.children.filter((child) => child !== file);
  }
  perfInput.value = '';
  perfInput.dispatchEvent(new window.Event('input'));
  await new Promise((resolve) => window.setTimeout(resolve, 300));
  await view.refresh();
  equal('board sintético removido', view.contentEl.querySelectorAll('.aob-card').length, baseTiles);

  const total = passed + failures.length;
  if (failures.length > 0) {
    console.error(`\n${failures.length} de ${total} verificações falharam:\n`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log(`\n${passed}/${total} verificações passaram.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
