import { App, PluginSettingTab, Setting, type Plugin } from 'obsidian';
import { validateActions, type CopyAction } from './shared/actions';

export interface DashboardSettings {
  roots: string[];
  extraProjects: string[];
  excludedPaths: string[];
  actionsJson: string;
}

export const DEFAULT_ACTIONS_JSON = JSON.stringify(
  [
    { id: 'start-card', label: 'iniciar o card', states: ['1.not_started'], text: '/start-card "{{name}}"' },
    { id: 'work-on-card', label: 'trabalhar no card', states: ['2.in_progress'], text: '/work-on-card "{{name}}"' },
    { id: 'complete-card', label: 'concluir o card', states: ['3.in_review'], text: '/complete-card "{{name}}"' },
    {
      id: 'copy-pr',
      label: 'nome e link do PR',
      states: ['0.backlog', '1.not_started', '2.in_progress', '3.in_review', '4.done', '5.archived'],
      onlyWithPr: true,
      text: '{{pr}} -> {{pr_url}}',
    },
  ],
  null,
  2,
);

export const DEFAULT_SETTINGS: DashboardSettings = {
  roots: [],
  extraProjects: [],
  excludedPaths: [],
  actionsJson: DEFAULT_ACTIONS_JSON,
};

export interface SettingsHost extends Plugin {
  settings: DashboardSettings;
  saveSettings(): Promise<void>;
  refreshViews(): void;
}

export function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function parseActionSettings(json: string): { actions: CopyAction[]; errors: string[] } {
  if (json.trim() === '') return { actions: [], errors: [] };
  try {
    const parsed: unknown = JSON.parse(json);
    return validateActions(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { actions: [], errors: [`JSON inválido: ${message}`] };
  }
}

export class DashboardSettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;

  constructor(app: App, host: SettingsHost) {
    super(app, host);
    this.host = host;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Dashboard do Agent Obsidian' });
    containerEl.createEl('p', {
      text: 'As raízes são varridas apenas nos filhos diretos. Um diretório só é projeto se tiver `.agent_obsidian` na raiz.',
    });

    new Setting(containerEl)
      .setName('Raízes')
      .setDesc('Um caminho absoluto por linha.')
      .addTextArea((text) =>
        text
          .setValue(this.host.settings.roots.join('\n'))
          .setPlaceholder('C:\\Users\\voce\\workspace')
          .onChange(async (value) => {
            this.host.settings.roots = parseLines(value);
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Projetos incluídos manualmente')
      .setDesc('Projetos fora das raízes. Um caminho absoluto por linha.')
      .addTextArea((text) =>
        text
          .setValue(this.host.settings.extraProjects.join('\n'))
          .onChange(async (value) => {
            this.host.settings.extraProjects = parseLines(value);
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Projetos ignorados')
      .setDesc('Caminhos que a varredura deve ignorar. Um por linha.')
      .addTextArea((text) =>
        text
          .setValue(this.host.settings.excludedPaths.join('\n'))
          .onChange(async (value) => {
            this.host.settings.excludedPaths = parseLines(value);
            await this.host.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'Ações de copiar' });
    containerEl.createEl('p', {
      text: 'Lista JSON. Campos: id, label, states e text. Placeholders: {{name}}, {{path}}, {{project}}, {{feature}}, {{branch}}. O botão sempre mostra o verbo "Copiar".',
    });

    const errorsEl = containerEl.createDiv({ cls: 'aob-settings-errors' });

    const renderErrors = (errors: string[]): void => {
      errorsEl.empty();
      if (errors.length === 0) return;
      errorsEl.createEl('strong', { text: 'Configuração com erro:' });
      const list = errorsEl.createEl('ul');
      for (const error of errors) list.createEl('li', { text: error });
    };

    renderErrors(parseActionSettings(this.host.settings.actionsJson).errors);

    new Setting(containerEl).addTextArea((text) => {
      text.inputEl.rows = 14;
      text.inputEl.addClass('aob-settings-actions');
      text.setValue(this.host.settings.actionsJson).onChange(async (value) => {
        this.host.settings.actionsJson = value;
        renderErrors(parseActionSettings(value).errors);
        await this.host.saveSettings();
      });
    });
  }
}
