import { Platform, TFile, TFolder, type App } from 'obsidian';
import {
  CARD_STATES,
  DATE_FIELDS,
  type BoardCard,
  type CardRef,
  type CardState,
  type SectionMap,
} from '../shared/types';
import { CANONICAL_SECTIONS, countTasks, extractLinks, extractSection } from '../shared/text';
import { parseDateMap } from '../shared/dates';
import { normalizeStatus } from '../shared/status';
import { normalizeFeature } from '../shared/features';
import { normalizeRepo } from '../shared/repo';

export const BOARD_FOLDER = 'board';
export const FEATURES_FOLDER = 'condensed memory/features';

export interface BoardScan {
  cards: BoardCard[];
  byBasename: Map<string, CardRef[]>;
  existingStates: CardState[];
  vaultFileNames: Set<string>;
  attachmentsFolder: string;
}

function collectCardFiles(folder: TFolder): TFile[] {
  const files: TFile[] = [];

  for (const child of folder.children) {
    if (child instanceof TFolder) {
      for (const grandChild of child.children) {
        if (grandChild instanceof TFile && grandChild.extension === 'md') files.push(grandChild);
      }
      continue;
    }
    if (child instanceof TFile && child.extension === 'md') files.push(child);
  }

  return files;
}

function readVersion(attachmentFolderConfig: unknown): string {
  if (typeof attachmentFolderConfig === 'string' && attachmentFolderConfig.trim() !== '') {
    return attachmentFolderConfig.trim().replace(/\/+$/, '');
  }
  return 'resources';
}

function validHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/.test(value);
}

async function buildCard(app: App, file: TFile, state: CardState): Promise<BoardCard> {
  const content = await app.vault.cachedRead(file);
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as
    | Record<string, unknown>
    | undefined;
  const stat = await app.vault.adapter.stat(file.path);

  const sections: SectionMap = {};
  for (const heading of CANONICAL_SECTIONS) sections[heading] = extractSection(content, heading);

  const tasks = countTasks(sections['Tarefas']);
  const repoRaw = typeof frontmatter?.repo === 'string' ? frontmatter.repo.trim() : '';
  const feature = normalizeFeature(frontmatter?.feature);

  const prRaw = typeof frontmatter?.pr_url === 'string' ? frontmatter.pr_url.trim() : '';
  const prValid = prRaw !== '' && validHttpUrl(prRaw);
  const prTitleRaw = typeof frontmatter?.pr_title === 'string' ? frontmatter.pr_title.trim() : '';

  const dependencyLinks = [
    ...extractLinks(sections['Dependências']),
    ...extractLinks(sections['Dependentes']),
  ];

  return {
    path: file.path,
    basename: file.basename,
    state,
    repo: normalizeRepo(repoRaw),
    repoRaw,
    status: normalizeStatus(frontmatter?.status),
    feature: feature.value,
    featureInvalid: feature.invalid,
    dates: parseDateMap(frontmatter, DATE_FIELDS),
    mtime: stat?.mtime ?? file.stat.mtime,
    pendingTasks: tasks.pending,
    doneTasks: tasks.done,
    totalTasks: tasks.total,
    prUrl: prRaw === '' ? null : prRaw,
    prTitle: prTitleRaw === '' ? null : prTitleRaw,
    prInvalid: prRaw !== '' && !prValid,
    sections,
    outgoingLinks: [...new Set(dependencyLinks)],
  };
}

export async function scanBoard(app: App): Promise<BoardScan> {
  const cards: BoardCard[] = [];
  const existingStates: CardState[] = [];

  for (const state of CARD_STATES) {
    const folder = app.vault.getAbstractFileByPath(`${BOARD_FOLDER}/${state}`);
    if (!(folder instanceof TFolder)) continue;
    existingStates.push(state);

    for (const file of collectCardFiles(folder)) {
      cards.push(await buildCard(app, file, state));
    }
  }

  const byBasename = new Map<string, CardRef[]>();
  for (const card of cards) {
    const key = card.basename.toLowerCase();
    const list = byBasename.get(key) ?? [];
    list.push({ basename: card.basename, state: card.state, path: card.path });
    byBasename.set(key, list);
  }

  const vaultFileNames = new Set(app.vault.getFiles().map((file) => file.name.toLowerCase()));

  return {
    cards,
    byBasename,
    existingStates,
    vaultFileNames,
    attachmentsFolder: readVersion(getAttachmentFolder(app)),
  };
}

function getAttachmentFolder(app: App): unknown {
  if (!Platform.isDesktopApp) return null;
  const vault = app.vault as unknown as { getConfig?: (key: string) => unknown };
  return vault.getConfig?.('attachmentFolderPath') ?? null;
}

export function cardByPath(scan: BoardScan, path: string): BoardCard | undefined {
  return scan.cards.find((card) => card.path === path);
}

export function dependentsOf(scan: BoardScan, card: BoardCard): BoardCard[] {
  const key = card.basename.toLowerCase();
  return scan.cards.filter((candidate) => {
    if (candidate.path === card.path) return false;
    return candidate.outgoingLinks.some((link) => link.toLowerCase() === key);
  });
}
