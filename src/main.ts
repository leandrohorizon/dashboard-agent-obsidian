import { Plugin } from 'obsidian';
import {
  DEFAULT_SETTINGS,
  DashboardSettingTab,
  parseLines,
  type DashboardSettings,
  type SettingsHost,
} from './settings';
import { DashboardView, VIEW_TYPE_DASHBOARD } from './views/dashboardView';

export default class AgentDashboardPlugin extends Plugin implements SettingsHost {
  settings: DashboardSettings = { ...DEFAULT_SETTINGS };

  private refreshHandle: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_DASHBOARD, (leaf) => new DashboardView(leaf, this));

    this.addRibbonIcon('layout-dashboard', 'Abrir dashboard do Agent Obsidian', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-dashboard',
      name: 'Abrir dashboard',
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: 'refresh-dashboard',
      name: 'Atualizar dashboard',
      checkCallback: (checking) => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD);
        if (leaves.length === 0) return false;
        if (!checking) this.refreshViews();
        return true;
      },
    });

    this.addSettingTab(new DashboardSettingTab(this.app, this));
  }

  onunload(): void {
    if (this.refreshHandle !== null) window.clearTimeout(this.refreshHandle);
  }

  async loadSettings(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<DashboardSettings>;

    this.settings = {
      roots: Array.isArray(stored.roots) ? stored.roots.filter((entry) => typeof entry === 'string') : [],
      extraProjects: Array.isArray(stored.extraProjects)
        ? stored.extraProjects.filter((entry) => typeof entry === 'string')
        : [],
      excludedPaths: Array.isArray(stored.excludedPaths)
        ? stored.excludedPaths.filter((entry) => typeof entry === 'string')
        : [],
      actionsJson:
        typeof stored.actionsJson === 'string' ? stored.actionsJson : DEFAULT_SETTINGS.actionsJson,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.scheduleRefreshViews();
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD)) {
      if (leaf.view instanceof DashboardView) void leaf.view.refresh();
    }
  }

  private scheduleRefreshViews(): void {
    if (this.refreshHandle !== null) window.clearTimeout(this.refreshHandle);
    this.refreshHandle = window.setTimeout(() => {
      this.refreshHandle = null;
      this.refreshViews();
    }, 800);
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_DASHBOARD, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}

export { parseLines };
