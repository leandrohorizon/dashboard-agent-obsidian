import { isEmptySection } from './text';
import { isDivergent } from './status';
import type { BoardCard, DateField } from './types';
export type Severity = 'error' | 'warning';

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
}

const DATE_LABELS: Record<DateField, string> = {
  created: 'created',
  started: 'started',
  reviewed: 'reviewed',
  completed: 'completed',
};

export function validateCard(card: BoardCard): Issue[] {
  const issues: Issue[] = [];
  const sections = card.sections;

  const hasSection = (name: string) => sections[name] !== undefined && sections[name] !== null;
  const sectionEmpty = (name: string) => isEmptySection(sections[name]);

  if (!hasSection('Descrição') || sectionEmpty('Descrição')) {
    issues.push({
      code: 'missing-description',
      severity: 'error',
      message: '`### Descrição` ausente ou vazia.',
    });
  }

  const hasTasksSection = hasSection('Tarefas');
  if (!hasTasksSection || card.totalTasks === 0) {
    issues.push({
      code: 'missing-tasks',
      severity: 'error',
      message: '`### Tarefas` ausente ou sem nenhum checkbox.',
    });
  }

  const hasDone = card.doneTasks > 0;

  if (hasDone && sectionEmpty('Descrição Técnica do que Foi Feito')) {
    issues.push({
      code: 'missing-technical-notes',
      severity: 'error',
      message: 'Há tarefa concluída e `### Descrição Técnica do que Foi Feito` está vazia.',
    });
  }

  if (hasDone && sectionEmpty('Conhecimento Adquirido pela IA')) {
    issues.push({
      code: 'missing-knowledge',
      severity: 'warning',
      message: 'Há tarefa concluída e `### Conhecimento Adquirido pela IA` está vazia.',
    });
  }

  if (!hasSection('Discussões')) {
    issues.push({
      code: 'missing-discussions',
      severity: 'warning',
      message: '`### Discussões` ausente.',
    });
  }

  if (card.featureInvalid) {
    issues.push({
      code: 'invalid-feature',
      severity: 'error',
      message: `\`feature:\` inválido (\`${card.feature}\`): usar slug lowercase com hífen.`,
    });
  } else if (card.feature === null) {
    issues.push({
      code: 'missing-feature',
      severity: 'warning',
      message: 'Sem `feature:`: não há roteamento de memória para este card.',
    });
  }

  if (card.status.kind === 'missing') {
    issues.push({
      code: 'missing-status',
      severity: 'warning',
      message: '`status:` ausente no frontmatter.',
    });
  } else if (card.status.kind !== 'ok') {
    issues.push({
      code: 'unknown-status',
      severity: 'warning',
      message: `\`status:\` desconhecido (\`${card.status.value}\`).`,
    });
  } else if (isDivergent(card.state, card.status)) {
    issues.push({
      code: 'divergent-status',
      severity: 'warning',
      message: `\`status: ${card.status.value}\` diverge da pasta \`${card.state}\`.`,
    });
  }

  for (const field of Object.keys(DATE_LABELS) as DateField[]) {
    const value = card.dates[field];
    if (value.kind === 'invalid') {
      issues.push({
        code: `invalid-date-${field}`,
        severity: 'warning',
        message: `\`${DATE_LABELS[field]}: ${value.raw}\` não é \`YYYY-MM-DD\`.`,
      });
    }
  }

  if (card.prInvalid) {
    issues.push({
      code: 'invalid-pr',
      severity: 'warning',
      message: `\`pr_url\` não é URL (\`${card.prUrl ?? ''}\`).`,
    });
  }

  return issues;
}

export function highestSeverity(issues: Issue[]): Severity | null {
  if (issues.some((issue) => issue.severity === 'error')) return 'error';
  if (issues.some((issue) => issue.severity === 'warning')) return 'warning';
  return null;
}
