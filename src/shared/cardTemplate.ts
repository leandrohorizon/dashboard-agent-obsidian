import type { CardState } from './types';

export const WORK_TYPES = [
  'implementation',
  'report',
  'investigation',
  'experiment',
  'epic',
] as const;

export type WorkType = (typeof WORK_TYPES)[number];

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
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const VALUE_KEYS = ['repo', 'branch', 'feature', 'created'] as const;
const STATUS_LIST_ITEM = /^\s+-\s/;

export function templatePathForWorkType(workType: WorkType): string {
  return `templates/card/${workType}.md`;
}

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
  const block = FRONTMATTER_BLOCK.exec(template);
  if (block === null) return template;

  const lines = patchFrontmatter(block[1].split(/\r?\n/), values);
  return `---\n${lines.join('\n')}\n---\n${template.slice(block[0].length)}`;
}

function patchFrontmatter(lines: string[], values: CardTemplateValues): string[] {
  const patched: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const key = frontmatterKey(lines[index]);

    if (key === 'status') {
      patched.push('status:', `  - ${values.status}`);
      while (index + 1 < lines.length && STATUS_LIST_ITEM.test(lines[index + 1])) index += 1;
      continue;
    }
    if (key !== null && (VALUE_KEYS as readonly string[]).includes(key)) {
      patched.push(`${key}: ${values[key as (typeof VALUE_KEYS)[number]]}`);
      continue;
    }
    patched.push(lines[index]);
  }

  return patched;
}

function frontmatterKey(line: string): string | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
  return match === null ? null : match[1];
}

export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
