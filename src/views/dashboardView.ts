import {
  ItemView,
  Modal,
  Notice,
  Platform,
  TFile,
  setIcon,
  type App,
  type WorkspaceLeaf,
} from 'obsidian';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

import {
  CARD_STATES,
  DATE_FIELDS,
  type BoardCard,
  type CardState,
  type DateField,
} from '../shared/types';
import { formatDateValue, isOnOrAfter, parseDateValue, sortWithEmptyLast } from '../shared/dates';
import { isDivergent } from '../shared/status';
import { classifyLink, describeLinkKind, type LinkContext } from '../shared/links';
import { highestSeverity, validateCard, type Issue } from '../shared/validation';
import { actionsForCard, substitutePlaceholders, type CopyAction } from '../shared/actions';
import {
  BOARD_FOLDER,
  FEATURES_FOLDER,
  cardByPath,
  dependentsOf,
  scanBoard,
  type BoardScan,
} from '../board/index';
import { discoverProjects, type FsProbe, type ProjectEntry, type RegistryResult } from '../projects/registry';
import { expandHome, isPathInside, normalizeProjectName } from '../shared/paths';
import { evaluateAgentState, readCurrentCard } from '../shared/state';
import {
  clearCurrentCard,
  readState,
  repairStateFile,
  type StateSnapshot,
} from '../state/agentStateStore';
import { parseActionSettings, type SettingsHost } from '../settings';
import {
  CREATABLE_STATES,
  STATUS_BY_STATE,
  fillCardTemplate,
  sanitizeCardName,
  todayIso,
} from '../shared/cardTemplate';

declare const require: (id: string) => unknown;

export const VIEW_TYPE_DASHBOARD = 'aob-dashboard';

const TEMPLATE_PATH = 'templates/card template.md';

type ViewMode = 'board' | 'list' | 'projects';
type SinceField = DateField | 'mtime';
type SortField = DateField | 'mtime' | 'title' | 'project' | 'state' | 'pending';

interface ProjectStatus {
  entry: ProjectEntry;
  statePath: string;
  exists: boolean;
  verdict: 'ok' | 'repair' | 'blocked' | 'missing';
  message: string;
  version: string | null;
  currentCardName: string | null;
  currentCardPath: string | null;
  targetProblem: string | null;
  snapshot: StateSnapshot | null;
}

const SINCE_LABELS: Record<SinceField, string> = {
  mtime: 'modificado desde',
  created: 'criado desde',
  started: 'iniciado desde',
  reviewed: 'em review desde',
  completed: 'concluído desde',
};

const SORT_LABELS: Record<SortField, string> = {
  mtime: 'modificado',
  created: 'criado',
  started: 'iniciado',
  reviewed: 'em review',
  completed: 'concluído',
  title: 'título',
  project: 'projeto',
  state: 'estado',
  pending: 'pendentes',
};

export class DashboardView extends ItemView {
  private readonly host: SettingsHost;
  private scan: BoardScan | null = null;
  private registry: RegistryResult | null = null;
  private projectStatuses: ProjectStatus[] = [];
  private mode: ViewMode = 'board';
  private loading = false;
  private fatalError: string | null = null;
  private lastScanAt: Date | null = null;
  private selectedPath: string | null = null;
  private activeCardPaths = new Set<string>();
  private refreshHandle: number | null = null;

  private filterProject = '';
  private filterFeature = '';
  private filterStates = new Set<CardState>(CARD_STATES);
  private filterText = '';
  private filterSince = '';
  private filterSinceField: SinceField = 'mtime';
  private filterPendingOnly = false;
  private sortField: SortField = 'mtime';
  private sortDirection: 'asc' | 'desc' = 'desc';

  constructor(leaf: WorkspaceLeaf, host: SettingsHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return VIEW_TYPE_DASHBOARD;
  }

  getDisplayText(): string {
    return 'Dashboard do Agent Obsidian';
  }

  getIcon(): string {
    return 'layout-dashboard';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('aob-root');
    this.registerVaultEvents();
    await this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.refreshHandle !== null) {
      window.clearTimeout(this.refreshHandle);
      this.refreshHandle = null;
    }
  }

  private registerVaultEvents(): void {
    const onChange = (): void => this.scheduleRefresh();
    this.registerEvent(this.app.vault.on('create', onChange));
    this.registerEvent(this.app.vault.on('delete', onChange));
    this.registerEvent(this.app.vault.on('rename', onChange));
    this.registerEvent(this.app.vault.on('modify', onChange));
  }

  private scheduleRefresh(): void {
    if (this.refreshHandle !== null) window.clearTimeout(this.refreshHandle);
    this.refreshHandle = window.setTimeout(() => {
      this.refreshHandle = null;
      if (!this.loading) void this.refresh();
    }, 500);
  }

  async refresh(): Promise<void> {
    if (!Platform.isDesktopApp) {
      this.fatalError = 'Este plugin é desktop-only: depende de `fs` para ler o `.agent_obsidian` fora do vault.';
      this.render();
      return;
    }

    this.loading = true;
    this.fatalError = null;
    this.render();

    try {
      this.scan = await scanBoard(this.app);
      this.registry = discoverProjects(
        {
          roots: this.host.settings.roots,
          extraProjects: this.host.settings.extraProjects,
          excludedPaths: this.host.settings.excludedPaths,
        },
        {
          homeDir: process.env.USERPROFILE ?? os.homedir(),
          probe: probePath,
          listDirectories: listDirectories,
        },
      );
      this.projectStatuses = this.registry.projects.map((entry) => this.inspectProject(entry));
      this.activeCardPaths = this.collectActiveCardPaths();
      this.lastScanAt = new Date();

      if (this.selectedPath !== null && cardByPath(this.scan, this.selectedPath) === undefined) {
        this.selectedPath = null;
      }
    } catch (error) {
      this.fatalError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private inspectProject(entry: ProjectEntry): ProjectStatus {
    const statePath = nodePath.join(entry.path, '.agent_obsidian');
    const read = readState(statePath);

    if (read.error !== null) {
      return blockedStatus(entry, statePath, read.error, null);
    }
    if (read.snapshot === null) {
      return {
        entry,
        statePath,
        exists: false,
        verdict: 'missing',
        message: '`.agent_obsidian` ausente',
        version: null,
        currentCardName: null,
        currentCardPath: null,
        targetProblem: null,
        snapshot: null,
      };
    }

    const vaultPath = this.vaultBasePath;
    const verdict = evaluateAgentState(read.snapshot.text, {
      vaultPath,
      projectName: normalizeProjectName(entry.path),
    });

    if (verdict.kind === 'blocked') {
      return {
        ...blockedStatus(entry, statePath, verdict.message, read.snapshot),
        verdict: 'blocked',
      };
    }

    const current = readCurrentCard(verdict.data);
    const declaredVault = typeof verdict.data.vault_path === 'string' ? verdict.data.vault_path : vaultPath;
    const target = current.path === null ? null : checkCardTarget(current.path, declaredVault);

    return {
      entry,
      statePath,
      exists: true,
      verdict: verdict.kind === 'repair' ? 'repair' : 'ok',
      message:
        verdict.kind === 'repair'
          ? `precisa de reparo: ${verdict.changes.join(', ')}`
          : 'state íntegro',
      version: typeof verdict.data.version === 'string' ? verdict.data.version : null,
      currentCardName: current.name,
      currentCardPath: current.path,
      targetProblem: target,
      snapshot: read.snapshot,
    };
  }

  private get vaultBasePath(): string {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    return adapter.getBasePath?.() ?? '';
  }

  private get actions(): CopyAction[] {
    return parseActionSettings(this.host.settings.actionsJson).actions;
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    this.renderHeader(root);

    if (this.loading) {
      root.createDiv({ cls: 'aob-empty', text: 'Lendo o board e os projetos…' });
      return;
    }
    if (this.fatalError !== null) {
      root.createDiv({ cls: 'aob-error', text: this.fatalError });
      return;
    }
    if (this.scan === null) return;

    const body = root.createDiv({ cls: 'aob-body' });
    const main = body.createDiv({ cls: 'aob-main' });

    if (this.mode === 'projects') {
      this.renderProjects(main);
      return;
    }

    this.renderFilters(main);

    if (this.mode === 'board') this.renderKanban(main);
    else this.renderList(main);

    if (this.selectedPath !== null) {
      const aside = body.createDiv({ cls: 'aob-aside' });
      this.renderDetail(aside);
    }
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: 'aob-header' });

    const title = header.createDiv({ cls: 'aob-title' });
    title.createSpan({ text: 'Dashboard do Agent Obsidian' });

    const stamp = this.lastScanAt === null ? 'nunca' : this.lastScanAt.toLocaleTimeString();
    title.createSpan({ cls: 'aob-stamp', text: `última varredura: ${stamp}` });

    const tabs = header.createDiv({ cls: 'aob-tabs' });
    const renderTab = (mode: ViewMode, label: string): void => {
      const button = tabs.createEl('button', {
        cls: mode === this.mode ? 'aob-tab is-active' : 'aob-tab',
        text: label,
      });
      button.addEventListener('click', () => {
        this.mode = mode;
        this.render();
      });
    };
    renderTab('board', 'Kanban');
    renderTab('list', 'Lista');
    renderTab('projects', 'Projetos');

    const create = header.createEl('button', { cls: 'aob-button' });
    setIcon(create, 'file-plus');
    create.setAttribute('aria-label', 'Novo card');
    create.addEventListener('click', () => this.openCreateCardModal());

    const refresh = header.createEl('button', { cls: 'aob-button' });
    setIcon(refresh, 'refresh-cw');
    refresh.setAttribute('aria-label', 'Atualizar');
    refresh.addEventListener('click', () => void this.refresh());
  }

  private renderFilters(parent: HTMLElement): void {
    if (this.scan === null) return;
    const bar = parent.createDiv({ cls: 'aob-filters' });

    this.renderSelect(bar, 'Projeto', [
      { value: '', label: 'todos' },
      { value: '__none__', label: 'sem projeto' },
      ...uniqueValues(this.scan.cards.map((card) => card.repo)).map((value) => ({
        value,
        label: value,
      })),
    ], this.filterProject, (value) => {
      this.filterProject = value;
      this.render();
    });

    this.renderSelect(bar, 'Feature', [
      { value: '', label: 'todas' },
      { value: '__none__', label: 'sem feature' },
      ...uniqueValues(this.scan.cards.map((card) => card.feature)).map((value) => ({
        value,
        label: value,
      })),
    ], this.filterFeature, (value) => {
      this.filterFeature = value;
      this.render();
    });

    const text = bar.createEl('input', { cls: 'aob-input', type: 'search' });
    text.placeholder = 'título ou descrição';
    text.value = this.filterText;
    text.addEventListener('input', () => {
      this.filterText = text.value;
      this.renderBodyOnly();
    });

    const since = bar.createDiv({ cls: 'aob-since' });
    const sinceField = since.createEl('select', { cls: 'aob-select' });
    for (const field of ['mtime', ...DATE_FIELDS] as SinceField[]) {
      sinceField.createEl('option', { value: field, text: SINCE_LABELS[field] });
    }
    sinceField.value = this.filterSinceField;
    sinceField.addEventListener('change', () => {
      this.filterSinceField = sinceField.value as SinceField;
      this.render();
    });

    const sinceInput = since.createEl('input', { cls: 'aob-input', type: 'date' });
    sinceInput.value = this.filterSince;
    sinceInput.addEventListener('change', () => {
      this.filterSince = sinceInput.value;
      this.render();
    });

    const pendingLabel = bar.createEl('label', { cls: 'aob-check' });
    const pending = pendingLabel.createEl('input', { type: 'checkbox' });
    pending.checked = this.filterPendingOnly;
    pendingLabel.createSpan({ text: 'pendentes > 0' });
    pending.addEventListener('change', () => {
      this.filterPendingOnly = pending.checked;
      this.render();
    });

    const states = bar.createDiv({ cls: 'aob-states' });
    for (const state of this.scan.existingStates) {
      const chip = states.createEl('button', {
        cls: this.filterStates.has(state) ? 'aob-chip is-active' : 'aob-chip',
        text: state,
      });
      chip.addEventListener('click', () => {
        if (this.filterStates.has(state)) this.filterStates.delete(state);
        else this.filterStates.add(state);
        this.render();
      });
    }

    this.renderSelect(bar, 'Ordenar por', (Object.keys(SORT_LABELS) as SortField[]).map((field) => ({
      value: field,
      label: SORT_LABELS[field],
    })), this.sortField, (value) => {
      this.sortField = value as SortField;
      this.render();
    });

    const direction = bar.createEl('button', { cls: 'aob-button', text: this.sortDirection === 'desc' ? '↓' : '↑' });
    direction.addEventListener('click', () => {
      this.sortDirection = this.sortDirection === 'desc' ? 'asc' : 'desc';
      this.render();
    });
  }

  private renderSelect(
    parent: HTMLElement,
    label: string,
    options: Array<{ value: string; label: string }>,
    current: string,
    onChange: (value: string) => void,
  ): void {
    const wrapper = parent.createDiv({ cls: 'aob-field' });
    wrapper.createSpan({ cls: 'aob-field-label', text: label });
    const select = wrapper.createEl('select', { cls: 'aob-select' });
    for (const option of options) select.createEl('option', { value: option.value, text: option.label });
    select.value = current;
    select.addEventListener('change', () => onChange(select.value));
  }

  private renderBodyOnly(): void {
    if (this.scan === null) return;
    const main = this.contentEl.querySelector('.aob-main');
    if (!(main instanceof HTMLElement)) {
      this.render();
      return;
    }
    main.empty();
    this.renderFilters(main);
    if (this.mode === 'board') this.renderKanban(main);
    else this.renderList(main);
    const aside = this.contentEl.querySelector('.aob-aside');
    if (aside instanceof HTMLElement) {
      aside.empty();
      this.renderDetail(aside);
    }
  }

  private visibleCards(): BoardCard[] {
    if (this.scan === null) return [];

    let cards = this.scan.cards.filter((card) => this.filterStates.has(card.state));

    if (this.filterProject === '__none__') cards = cards.filter((card) => card.repo === null);
    else if (this.filterProject !== '') cards = cards.filter((card) => card.repo === this.filterProject);

    if (this.filterFeature === '__none__') cards = cards.filter((card) => card.feature === null);
    else if (this.filterFeature !== '') cards = cards.filter((card) => card.feature === this.filterFeature);

    if (this.filterText.trim() !== '') {
      const needle = this.filterText.trim().toLowerCase();
      cards = cards.filter(
        (card) =>
          card.basename.toLowerCase().includes(needle) ||
          (card.sections['Descrição'] ?? '').toLowerCase().includes(needle),
      );
    }

    if (this.filterPendingOnly) cards = cards.filter((card) => card.pendingTasks > 0);

    if (this.filterSince !== '') {
      const since = parseDateValue(this.filterSince);
      cards = cards.filter((card) => {
        if (since.kind !== 'valid') return true;
        const value =
          this.filterSinceField === 'mtime'
            ? ({ kind: 'valid', iso: isoFromTime(card.mtime), time: midnight(card.mtime) } as const)
            : card.dates[this.filterSinceField];
        return isOnOrAfter(value, since);
      });
    }

    return this.sortCards(cards);
  }

  private sortCards(cards: BoardCard[]): BoardCard[] {
    const field = this.sortField;

    if (field === 'title') {
      const sorted = [...cards].sort((left, right) => left.basename.localeCompare(right.basename));
      return this.sortDirection === 'asc' ? sorted : sorted.reverse();
    }
    if (field === 'project') {
      const sorted = [...cards].sort((left, right) =>
        (left.repo ?? '~').localeCompare(right.repo ?? '~'),
      );
      return this.sortDirection === 'asc' ? sorted : sorted.reverse();
    }
    if (field === 'state') {
      const sorted = [...cards].sort(
        (left, right) => CARD_STATES.indexOf(left.state) - CARD_STATES.indexOf(right.state),
      );
      return this.sortDirection === 'asc' ? sorted : sorted.reverse();
    }
    if (field === 'pending') {
      const sorted = [...cards].sort((left, right) => left.pendingTasks - right.pendingTasks);
      return this.sortDirection === 'asc' ? sorted : sorted.reverse();
    }
    if (field === 'mtime') {
      return sortWithEmptyLast(
        cards,
        (card) => ({ kind: 'valid', iso: isoFromTime(card.mtime), time: card.mtime }),
        this.sortDirection,
      );
    }

    const dateField = field as DateField;
    return sortWithEmptyLast(cards, (card) => card.dates[dateField], this.sortDirection);
  }

  private renderKanban(parent: HTMLElement): void {
    if (this.scan === null) return;
    const cards = this.visibleCards();
    const board = parent.createDiv({ cls: 'aob-kanban' });

    for (const state of this.scan.existingStates) {
      const column = board.createDiv({ cls: 'aob-column' });
      const inColumn = cards.filter((card) => card.state === state);
      const header = column.createDiv({ cls: 'aob-column-header' });
      header.createSpan({ cls: 'aob-column-name', text: state });
      header.createSpan({ cls: 'aob-column-count', text: String(inColumn.length) });

      if (inColumn.length === 0) {
        column.addClass('is-empty');
        column.setAttribute('title', `${state}: nenhum card`);
        continue;
      }

      for (const card of inColumn) this.renderCardTile(column, card);
    }
  }

  private renderCardTile(parent: HTMLElement, card: BoardCard): void {
    const tile = parent.createDiv({ cls: 'aob-card' });
    if (card.path === this.selectedPath) tile.addClass('is-selected');
    if (this.isActiveCard(card)) tile.addClass('is-active');

    tile.createDiv({ cls: 'aob-card-title', text: card.basename });
    const badges = tile.createDiv({ cls: 'aob-badges' });
    if (this.isActiveCard(card)) badges.createSpan({ cls: 'aob-badge is-active', text: 'ativo' });
    this.renderBadges(badges, card);

    tile.addEventListener('click', () => {
      this.selectedPath = card.path;
      this.render();
    });
  }

  private renderBadges(parent: HTMLElement, card: BoardCard): void {
    if (card.repo !== null) parent.createSpan({ cls: 'aob-badge', text: card.repo });
    if (card.feature !== null) parent.createSpan({ cls: 'aob-badge', text: card.feature });
    if (card.totalTasks > 0) {
      parent.createSpan({
        cls: card.pendingTasks > 0 ? 'aob-badge is-pending' : 'aob-badge is-done',
        text: `${card.pendingTasks}/${card.totalTasks} pendentes`,
      });
    }
    if (isDivergent(card.state, card.status)) {
      parent.createSpan({ cls: 'aob-badge is-warning', text: `status ${card.status.value}` });
    } else if (card.status.kind === 'missing') {
      parent.createSpan({ cls: 'aob-badge is-warning', text: 'sem status' });
    }
    const severity = highestSeverity(validateCard(card));
    if (severity === 'error') parent.createSpan({ cls: 'aob-badge is-error', text: 'validação' });
    else if (severity === 'warning') parent.createSpan({ cls: 'aob-badge is-warning', text: 'aviso' });
    if (card.prUrl !== null && !card.prInvalid) parent.createSpan({ cls: 'aob-badge', text: 'PR' });
  }

  private renderList(parent: HTMLElement): void {
    const cards = this.visibleCards();
    const table = parent.createEl('table', { cls: 'aob-table' });
    const head = table.createEl('thead').createEl('tr');
    for (const label of ['Título', 'Projeto', 'Estado', 'Feature', 'Data', 'Pendentes', 'PR']) {
      head.createEl('th', { text: label });
    }

    const body = table.createEl('tbody');
    for (const card of cards) {
      const row = body.createEl('tr');
      if (card.path === this.selectedPath) row.addClass('is-selected');
      if (this.isActiveCard(card)) row.addClass('is-active');
      row.createEl('td', { text: card.basename });
      row.createEl('td', { text: card.repo ?? '—' });
      row.createEl('td', { text: card.state });
      row.createEl('td', { text: card.feature ?? '—' });
      const dateCell = row.createEl('td');
      if (this.sortField === 'mtime') dateCell.setText(new Date(card.mtime).toISOString().slice(0, 10));
      else if ((DATE_FIELDS as readonly string[]).includes(this.sortField)) {
        dateCell.setText(formatDateValue(card.dates[this.sortField as DateField]) || '—');
      } else {
        dateCell.setText('—');
      }
      row.createEl('td', { text: `${card.pendingTasks}/${card.totalTasks}` });
      const pr = row.createEl('td');
      if (card.prUrl !== null && !card.prInvalid) {
        const link = pr.createEl('a', { text: 'abrir', href: card.prUrl });
        link.setAttribute('target', '_blank');
      } else {
        pr.setText(card.prInvalid ? 'inválido' : '—');
      }
      row.addEventListener('click', () => {
        this.selectedPath = card.path;
        this.render();
      });
    }

    if (cards.length === 0) parent.createDiv({ cls: 'aob-empty', text: 'nenhum card com esses filtros' });
  }

  private renderDetail(parent: HTMLElement): void {
    if (this.scan === null) return;
    const card = this.selectedPath === null ? undefined : cardByPath(this.scan, this.selectedPath);

    if (card === undefined) {
      parent.createDiv({ cls: 'aob-aside-title', text: 'Nenhum card selecionado' });
      parent.createDiv({
        cls: 'aob-empty',
        text: 'Clique em um card para ver detalhes, dependências e ações.',
      });
      return;
    }

    const head = parent.createDiv({ cls: 'aob-aside-head' });
    const titles = head.createDiv({ cls: 'aob-aside-titles' });
    titles.createDiv({ cls: 'aob-aside-title', text: card.basename });
    if (this.isActiveCard(card)) {
      titles.createSpan({ cls: 'aob-badge is-active', text: 'ativo' });
    }
    const close = head.createEl('button', { cls: 'aob-close', text: '×' });
    close.setAttribute('aria-label', 'Fechar detalhe do card');
    close.addEventListener('click', () => {
      this.selectedPath = null;
      this.render();
    });
    parent.createDiv({ cls: 'aob-aside-path', text: card.path });

    const open = parent.createEl('button', { cls: 'aob-button', text: 'Abrir no Obsidian' });
    open.addEventListener('click', () => void this.openCard(card.path));
    parent.createEl('h4', { text: 'Dados' });
    const data = parent.createDiv({ cls: 'aob-kv' });
    kv(data, 'estado (pasta)', card.state);
    kv(data, 'status', card.status.value ?? '—');
    kv(data, 'projeto', card.repo ?? '—');
    kv(data, 'feature', card.feature ?? '—');
    for (const field of DATE_FIELDS) kv(data, field, formatDateValue(card.dates[field]) || '—');
    kv(data, 'modificado', new Date(card.mtime).toISOString().slice(0, 10));
    kv(data, 'tarefas', `${card.pendingTasks} pendentes de ${card.totalTasks}`);

    const issues = validateCard(card);
    parent.createEl('h4', { text: `Validação (${issues.length})` });
    this.renderIssues(parent, issues);

    this.renderDependencies(parent, card);
    this.renderCardActions(parent, card);
  }

  private renderIssues(parent: HTMLElement, issues: Issue[]): void {
    if (issues.length === 0) {
      parent.createDiv({ cls: 'aob-empty', text: 'nenhum problema encontrado' });
      return;
    }
    const list = parent.createEl('ul', { cls: 'aob-issues' });
    for (const issue of issues) {
      const item = list.createEl('li', { cls: `is-${issue.severity}`, text: issue.message });
      item.setAttribute('data-code', issue.code);
    }
  }

  private linkContext(): LinkContext | null {
    if (this.scan === null) return null;
    const scan = this.scan;
    return {
      cardsByBasename: scan.byBasename,
      featureExists: (slug: string) =>
        this.app.vault.getAbstractFileByPath(`${FEATURES_FOLDER}/${slug}.md`) !== null,
      attachmentExists: (name: string) =>
        scan.vaultFileNames.has(name.toLowerCase()) ||
        this.app.vault.getAbstractFileByPath(`${scan.attachmentsFolder}/${name}`) !== null,
    };
  }

  private renderDependencies(parent: HTMLElement, card: BoardCard): void {
    const context = this.linkContext();
    if (context === null) return;

    parent.createEl('h4', { text: 'Dependências e dependentes' });

    const dependencies = parent.createEl('ul', { cls: 'aob-links' });
    dependencies.createEl('li', { cls: 'aob-links-header', text: 'depende de:' });
    for (const link of card.dependencies) {
      const resolution = classifyLink(link, context);
      const item = dependencies.createEl('li');
      item.createSpan({ cls: 'aob-link-name', text: link });
      item.createSpan({ cls: `aob-badge is-${resolution.kind}`, text: describeLinkKind(resolution.kind) });
      if (resolution.kind === 'card' || resolution.kind === 'ambiguous') {
        for (const target of resolution.targets) {
          item.createSpan({ cls: 'aob-badge', text: target.state });
        }
      }
    }
    if (card.dependencies.length === 0) {
      dependencies.createEl('li', { cls: 'aob-hint', text: 'nenhuma' });
    }

    const dependents = dependentsOf(this.scan as BoardScan, card);
    const dependentsList = parent.createEl('ul', { cls: 'aob-links' });
    dependentsList.createEl('li', { cls: 'aob-links-header', text: 'dependem deste:' });
    for (const dependent of dependents) {
      const item = dependentsList.createEl('li');
      item.createSpan({ cls: 'aob-link-name', text: dependent.basename });
      item.createSpan({ cls: 'aob-badge', text: dependent.state });
      item.addEventListener('click', () => {
        this.selectedPath = dependent.path;
        this.render();
      });
    }
    if (dependents.length === 0) {
      dependentsList.createEl('li', { cls: 'aob-hint', text: 'nenhum' });
    }
  }

  private renderCardActions(parent: HTMLElement, card: BoardCard): void {
    const hasPr = card.prUrl !== null && !card.prInvalid;
    const actions = actionsForCard(this.actions, { state: card.state, hasPr });
    parent.createEl('h4', { text: 'Ações' });

    if (actions.length === 0) {
      parent.createDiv({ cls: 'aob-empty', text: 'nenhuma ação configurada para este estado' });
      return;
    }

    for (const action of actions) {
      const text = substitutePlaceholders(action.text, {
        name: card.basename,
        path: this.absoluteVaultPath(card.path),
        link: this.obsidianLink(card.path),
        wikilink: `[[${card.basename}]]`,
        pr: card.basename,
        pr_url: hasPr ? (card.prUrl ?? '') : '',
        project: card.repo ?? '',
        feature: card.feature ?? '',
        branch: this.branchOf(card),
      });
      const button = parent.createEl('button', {
        cls: 'aob-button aob-copy',
        text: `Copiar — ${action.label}`,
      });
      button.addEventListener('click', () => void this.copyAction(button, text));
    }
  }

  private branchOf(card: BoardCard): string {
    const file = this.app.vault.getAbstractFileByPath(card.path);
    if (!(file instanceof TFile)) return '';
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as
      | Record<string, unknown>
      | undefined;
    const branch = frontmatter?.branch;
    return typeof branch === 'string' ? branch : '';
  }

  private absoluteVaultPath(vaultRelativePath: string): string {
    const base = this.vaultBasePath;
    if (base === '') return vaultRelativePath;
    return nodePath.join(base, ...vaultRelativePath.split('/'));
  }

  private obsidianLink(vaultRelativePath: string): string {
    const vaultName = this.app.vault.getName();
    const filePath = vaultRelativePath.replace(/\.md$/i, '');
    return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
  }

  private async copyAction(button: HTMLElement, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      const previous = button.getText();
      button.setText('Copiado');
      window.setTimeout(() => button.setText(previous), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Não foi possível copiar: ${message}\nTexto: ${text}`, 8000);
    }
  }

  private renderProjects(parent: HTMLElement): void {
    if (this.registry === null) return;

    const toolbar = parent.createDiv({ cls: 'aob-filters' });
    toolbar.createSpan({
      cls: 'aob-field-label',
      text: `${this.projectStatuses.length} projeto(s) · raízes: ${this.host.settings.roots.length}`,
    });

    if (this.registry.errors.length > 0) {
      const errors = parent.createDiv({ cls: 'aob-error-block' });
      errors.createEl('strong', { text: 'Erros de descoberta' });
      const list = errors.createEl('ul');
      for (const error of this.registry.errors) {
        list.createEl('li', { text: `${error.scope} ${error.path}: ${error.message}` });
      }
    }

    if (this.registry.duplicates.length > 0) {
      parent.createDiv({
        cls: 'aob-hint',
        text: `Caminhos duplicados (uma entrada venceu): ${this.registry.duplicates.join(', ')}`,
      });
    }

    if (this.projectStatuses.length === 0) {
      parent.createDiv({
        cls: 'aob-empty',
        text: 'Nenhum projeto registrado. Configure as raízes nas settings do plugin.',
      });
      return;
    }

    const table = parent.createEl('table', { cls: 'aob-table' });
    const head = table.createEl('thead').createEl('tr');
    for (const label of ['Projeto', 'State', 'Card ativo', 'Ações']) head.createEl('th', { text: label });

    const body = table.createEl('tbody');
    for (const status of this.projectStatuses) this.renderProjectRow(body, status);
  }

  private renderProjectRow(body: HTMLElement, status: ProjectStatus): void {
    const row = body.createEl('tr');

    const nameCell = row.createEl('td');
    nameCell.createDiv({ cls: 'aob-card-title', text: status.entry.name });
    nameCell.createDiv({ cls: 'aob-aside-path', text: status.entry.path });

    const stateCell = row.createEl('td');
    stateCell.createSpan({
      cls: `aob-badge is-${status.verdict === 'ok' ? 'done' : 'warning'}`,
      text: status.version === null ? status.verdict : `v${status.version}`,
    });
    stateCell.createDiv({ cls: 'aob-hint', text: status.message });

    const cardCell = row.createEl('td');
    if (status.currentCardName === null) {
      cardCell.setText('nenhum');
    } else {
      cardCell.createDiv({ cls: 'aob-card-title', text: status.currentCardName });
      if (status.targetProblem !== null) {
        cardCell.createDiv({ cls: 'aob-badge is-error', text: status.targetProblem });
      }
      cardCell.createDiv({ cls: 'aob-aside-path', text: status.currentCardPath ?? '' });
    }

    const actions = row.createEl('td', { cls: 'aob-actions' });
    this.renderProjectActions(actions, status);
  }

  private renderProjectActions(parent: HTMLElement, status: ProjectStatus): void {
    if (status.currentCardPath !== null && status.targetProblem === null) {
      const open = parent.createEl('button', { cls: 'aob-button', text: 'Abrir card' });
      open.addEventListener('click', () => void this.openAbsoluteCard(status));
    }

    const openFolder = parent.createEl('button', { cls: 'aob-button', text: 'Abrir pasta' });
    openFolder.addEventListener('click', () => void openInSystem(status.entry.path));

    const repair = parent.createEl('button', { cls: 'aob-button', text: 'Reparar state' });
    repair.disabled = status.exists === false || status.verdict === 'blocked';
    repair.addEventListener('click', () => void this.repairProject(status));

    const clear = parent.createEl('button', { cls: 'aob-button', text: 'Limpar current_card' });
    clear.disabled = status.currentCardName === null || status.verdict === 'blocked';
    clear.addEventListener('click', () => void this.confirmClear(status));
  }

  private async repairProject(status: ProjectStatus): Promise<void> {
    const outcome = repairStateFile(status.statePath, {
      vaultPath: this.vaultBasePath,
      projectName: normalizeProjectName(status.entry.path),
    });
    new Notice(`${status.entry.name}: ${outcome.message}`, outcome.kind === 'blocked' ? 8000 : 4000);
    await this.refresh();
  }

  private async confirmClear(status: ProjectStatus): Promise<void> {
    if (status.snapshot === null) return;

    const snapshot = status.snapshot;
    const confirmed = await confirmDestructive(
      this.app,
      `Limpar current_card de ${status.entry.name}?`,
      `Será removido: ${status.currentCardName ?? '(sem nome)'}\n${status.currentCardPath ?? ''}\n\nO restante do arquivo não muda.`,
    );
    if (!confirmed) return;

    const outcome = clearCurrentCard(status.statePath, snapshot, {
      vaultPath: this.vaultBasePath,
      projectName: normalizeProjectName(status.entry.path),
    });
    new Notice(`${status.entry.name}: ${outcome.message}`, outcome.kind === 'blocked' ? 8000 : 4000);
    await this.refresh();
  }

  private async openCard(vaultRelativePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(vaultRelativePath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }
    new Notice('O arquivo não está neste vault.');
  }

  private async openAbsoluteCard(status: ProjectStatus): Promise<void> {
    if (status.currentCardPath === null) return;

    const vaultRelative = this.vaultRelativePath(status.currentCardPath);
    if (vaultRelative !== null) {
      await this.openCard(vaultRelative);
      return;
    }

    await openInSystem(status.currentCardPath);
  }

  private vaultRelativePath(absolutePath: string): string | null {
    const base = this.vaultBasePath;
    if (base === '' || !isPathInside(absolutePath, base)) return null;
    return nodePath.relative(base, absolutePath).split(nodePath.sep).join('/');
  }

  private collectActiveCardPaths(): Set<string> {
    const home = process.env.USERPROFILE ?? os.homedir();
    const paths = new Set<string>();
    for (const status of this.projectStatuses) {
      if (status.currentCardPath === null || status.currentCardPath === '') continue;
      paths.add(nodePath.resolve(expandHome(status.currentCardPath, home)).toLowerCase());
    }
    return paths;
  }

  private isActiveCard(card: BoardCard): boolean {
    if (this.activeCardPaths.size === 0) return false;
    const absolute = nodePath.resolve(this.absoluteVaultPath(card.path)).toLowerCase();
    return this.activeCardPaths.has(absolute);
  }

  private openCreateCardModal(): void {
    new CreateCardModal(this.app, (title, state, feature) => {
      void this.createCard(title, state, feature);
    }).open();
  }

  private async createCard(title: string, state: CardState, feature: string): Promise<void> {
    const name = sanitizeCardName(title);
    if (name === '') {
      new Notice('Informe um título para o card.');
      return;
    }

    const targetPath = `${BOARD_FOLDER}/${state}/${name}.md`;
    if (this.app.vault.getAbstractFileByPath(targetPath) !== null) {
      new Notice(`Já existe um arquivo em ${targetPath}.`);
      return;
    }

    const templateFile = this.app.vault.getAbstractFileByPath(TEMPLATE_PATH);
    if (!(templateFile instanceof TFile)) {
      new Notice(`Template não encontrado: ${TEMPLATE_PATH}`);
      return;
    }

    const template = await this.app.vault.cachedRead(templateFile);
    const content = fillCardTemplate(template, {
      repo: '',
      branch: '',
      status: STATUS_BY_STATE[state],
      feature: feature.trim(),
      created: todayIso(),
    });

    const created = await this.app.vault.create(targetPath, content);
    new Notice(`Card criado em ${state}.`);
    this.selectedPath = created.path;
    await this.refresh();
  }
}

function kv(parent: HTMLElement, label: string, value: string): void {
  const row = parent.createDiv({ cls: 'aob-kv-row' });
  row.createSpan({ cls: 'aob-kv-label', text: label });
  row.createSpan({ cls: 'aob-kv-value', text: value });
}

function uniqueValues(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function isoFromTime(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function midnight(time: number): number {
  const date = new Date(time);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function probePath(target: string): FsProbe {
  try {
    return fs.statSync(target).isDirectory() ? 'dir' : 'file';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'missing';
    return 'denied';
  }
}

function listDirectories(target: string): string[] {
  return fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function blockedStatus(
  entry: ProjectEntry,
  statePath: string,
  message: string,
  snapshot: StateSnapshot | null,
): ProjectStatus {
  return {
    entry,
    statePath,
    exists: true,
    verdict: 'blocked',
    message,
    version: null,
    currentCardName: null,
    currentCardPath: null,
    targetProblem: null,
    snapshot,
  };
}

function checkCardTarget(cardPath: string, declaredVault: string): string | null {
  const expanded = expandHome(cardPath, process.env.USERPROFILE ?? os.homedir());

  let real: string;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    return 'path do card não existe';
  }

  if (!real.toLowerCase().endsWith('.md')) return 'path do card não é .md';

  const boardRoot = nodePath.join(declaredVault, 'board');
  if (!isPathInside(real, boardRoot)) return 'path do card fora do board do vault do projeto';

  const relative = nodePath.relative(boardRoot, real).split(nodePath.sep);
  if (relative.length < 2 || relative.length > 3) return 'path do card fora das pastas de estado';

  const state = relative[0];
  if (!(CARD_STATES as readonly string[]).includes(state)) {
    return `pasta de estado desconhecida (${state})`;
  }

  return null;
}

async function openInSystem(target: string): Promise<void> {
  try {
    const electron = require('electron') as { shell?: { openPath?: (path: string) => Promise<string> } };
    const result = await electron.shell?.openPath?.(target);
    if (result !== undefined && result !== '') new Notice(`Não foi possível abrir: ${result}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`Não foi possível abrir ${target}: ${message}`);
  }
}

function confirmDestructive(app: App, title: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new ConfirmModal(app, title, body, resolve);
    modal.open();
  });
}

class ConfirmModal extends Modal {
  private readonly title: string;
  private readonly body: string;
  private readonly resolve: (value: boolean) => void;
  private answered = false;

  constructor(app: App, title: string, body: string, resolve: (value: boolean) => void) {
    super(app);
    this.title = title;
    this.body = body;
    this.resolve = resolve;
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: this.body });
    this.contentEl.createEl('p', {
      cls: 'aob-hint',
      text: 'O arquivo `.agent_obsidian` é regravado de forma atômica; nenhuma cópia de backup é criada.',
    });

    const buttons = this.contentEl.createDiv({ cls: 'aob-modal-buttons' });
    const cancel = buttons.createEl('button', { cls: 'aob-button', text: 'Cancelar' });
    cancel.addEventListener('click', () => this.finish(false));
    const confirm = buttons.createEl('button', { cls: 'aob-button is-danger', text: 'Limpar' });
    confirm.addEventListener('click', () => this.finish(true));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.resolve(false);
  }

  private finish(value: boolean): void {
    this.answered = true;
    this.resolve(value);
    this.close();
  }
}

class CreateCardModal extends Modal {
  private readonly onSubmit: (title: string, state: CardState, feature: string) => void;
  private titleValue = '';
  private stateValue: CardState = '1.not_started';
  private featureValue = '';

  constructor(app: App, onSubmit: (title: string, state: CardState, feature: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.titleEl.setText('Novo card');
    this.contentEl.createEl('p', {
      cls: 'aob-hint',
      text: 'O card nasce de `templates/card template.md`, com o frontmatter preenchido para a pasta escolhida.',
    });

    const titleField = this.contentEl.createDiv({ cls: 'aob-form-row' });
    titleField.createEl('label', { cls: 'aob-form-label', text: 'Título' });
    const titleInput = titleField.createEl('input', {
      cls: 'aob-input aob-input-wide',
      type: 'text',
    });
    titleInput.placeholder = 'nome do card';
    titleInput.value = this.titleValue;
    titleInput.addEventListener('input', () => {
      this.titleValue = titleInput.value;
    });

    const stateField = this.contentEl.createDiv({ cls: 'aob-form-row' });
    stateField.createEl('label', { cls: 'aob-form-label', text: 'Pasta' });
    const stateSelect = stateField.createEl('select', { cls: 'aob-select' });
    for (const state of CREATABLE_STATES) stateSelect.createEl('option', { value: state, text: state });
    stateSelect.value = this.stateValue;
    stateSelect.addEventListener('change', () => {
      this.stateValue = stateSelect.value as CardState;
    });

    const featureField = this.contentEl.createDiv({ cls: 'aob-form-row' });
    featureField.createEl('label', { cls: 'aob-form-label', text: 'Feature (opcional)' });
    const featureInput = featureField.createEl('input', {
      cls: 'aob-input aob-input-wide',
      type: 'text',
    });
    featureInput.placeholder = 'slug-da-feature';
    featureInput.value = this.featureValue;
    featureInput.addEventListener('input', () => {
      this.featureValue = featureInput.value;
    });

    const submit = (): void => {
      this.onSubmit(this.titleValue, this.stateValue, this.featureValue);
      this.close();
    };

    titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    featureInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });

    const buttons = this.contentEl.createDiv({ cls: 'aob-modal-buttons' });
    const cancel = buttons.createEl('button', { cls: 'aob-button', text: 'Cancelar' });
    cancel.addEventListener('click', () => this.close());
    const create = buttons.createEl('button', { cls: 'aob-button is-primary', text: 'Criar' });
    create.addEventListener('click', submit);

    window.setTimeout(() => titleInput.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
