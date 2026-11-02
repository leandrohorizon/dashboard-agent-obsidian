import type { CardState } from './types';

export const STATUS_BY_STATE: Record<CardState, string> = {
  '0.backlog': 'Not Started',
  '1.not_started': 'Not Started',
  '2.in_progress': 'In Progress',
  '3.in_review': 'In Review',
  '4.done': 'Done',
  '5.archived': 'Done',
};

export const CREATABLE_STATES: CardState[] = ['0.backlog', '1.not_started', '2.in_progress'];

export interface CardTemplateValues {
  repo: string;
  branch: string;
  status: string;
  feature: string;
  created: string;
}

const INVALID_NAME_CHARS = /[\\/:*?"<>|]/g;
const CONTROL_CHARS = /[\u0000-\u001f]/g;

export function sanitizeCardName(input: string): string {
  return input
    .replace(INVALID_NAME_CHARS, ' ')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
}

export function fillCardTemplate(template: string, values: CardTemplateValues): string {
  const frontmatter = [
    '---',
    `repo: ${values.repo}`,
    `branch: ${values.branch}`,
    `status: ${values.status}`,
    `feature: ${values.feature}`,
    `created: ${values.created}`,
    'started:',
    'reviewed:',
    'completed:',
    'pr_url:',
    'pr_title:',
    '---',
  ].join('\n');

  const existing = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(template);
  const body = existing === null ? template : template.slice(existing[0].length);

  return `${frontmatter}\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
