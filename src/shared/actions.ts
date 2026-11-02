import { CARD_STATES, type CardState } from './types';

export const PLACEHOLDERS = [
  'name',
  'path',
  'link',
  'wikilink',
  'pr',
  'pr_url',
  'project',
  'feature',
  'branch',
] as const;

export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface CopyAction {
  id: string;
  label: string;
  states: CardState[];
  text: string;
  onlyWithPr: boolean;
}

export interface ActionSet {
  actions: CopyAction[];
  errors: string[];
}

const ID_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function placeholdersIn(text: string): string[] {
  const found = new Set<string>();
  const pattern = /\{\{(\w+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  return [...found];
}

export function unknownPlaceholders(text: string): string[] {
  return placeholdersIn(text).filter(
    (name) => !(PLACEHOLDERS as readonly string[]).includes(name),
  );
}

export function substitutePlaceholders(text: string, values: Record<Placeholder, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) return whole;
    return values[name as Placeholder];
  });
}

function isCardState(value: unknown): value is CardState {
  return typeof value === 'string' && (CARD_STATES as readonly string[]).includes(value);
}

export function validateActions(raw: unknown): ActionSet {
  if (raw === undefined || raw === null) return { actions: [], errors: [] };

  if (!Array.isArray(raw)) {
    return { actions: [], errors: ['`actions` precisa ser uma lista.'] };
  }

  const actions: CopyAction[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();

  raw.forEach((entry, index) => {
    const position = `actions[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${position}: precisa ser um objeto.`);
      return;
    }

    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    const text = typeof record.text === 'string' ? record.text : '';
    const states = record.states;

    if (!ID_SLUG.test(id)) {
      errors.push(`${position}: \`id\` ausente ou fora do formato slug (a-z, 0-9, hífen).`);
      return;
    }
    if (seenIds.has(id)) {
      errors.push(`${position}: \`id\` duplicado (${id}).`);
      return;
    }
    if (label === '') {
      errors.push(`${position} (${id}): \`label\` vazio.`);
      return;
    }
    if (!Array.isArray(states) || states.length === 0) {
      errors.push(`${position} (${id}): \`states\` precisa listar ao menos uma pasta.`);
      return;
    }
    const invalidStates = states.filter((state) => !isCardState(state));
    if (invalidStates.length > 0) {
      errors.push(
        `${position} (${id}): estado inválido (${invalidStates.map((s) => String(s)).join(', ')}). Válidos: ${CARD_STATES.join(', ')}.`,
      );
      return;
    }
    if (text.trim() === '') {
      errors.push(`${position} (${id}): \`text\` vazio.`);
      return;
    }
    const unknown = unknownPlaceholders(text);
    if (unknown.length > 0) {
      errors.push(
        `${position} (${id}): placeholder desconhecido (${unknown.map((name) => `{{${name}}}`).join(', ')}). Válidos: ${PLACEHOLDERS.map((name) => `{{${name}}}`).join(', ')}.`,
      );
      return;
    }

    seenIds.add(id);
    const onlyWithPr = record.onlyWithPr;
    if (onlyWithPr !== undefined && typeof onlyWithPr !== 'boolean') {
      errors.push(`${position} (${id}): \`onlyWithPr\` precisa ser booleano.`);
      return;
    }
    actions.push({ id, label, states: states as CardState[], text, onlyWithPr: onlyWithPr === true });
  });

  return { actions, errors };
}

export function actionsForCard(
  actions: CopyAction[],
  context: { state: CardState; hasPr: boolean },
): CopyAction[] {
  return actions.filter((action) => {
    if (!action.states.includes(context.state)) return false;
    if (action.onlyWithPr && !context.hasPr) return false;
    return true;
  });
}
