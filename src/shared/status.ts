import type { CardState, StatusInfo } from './types';

const STATUS_TO_STATE: Record<string, CardState> = {
  'not started': '1.not_started',
  'in progress': '2.in_progress',
  'in review': '3.in_review',
  done: '4.done',
};

export const KNOWN_STATUSES = ['Not Started', 'In Progress', 'In Review', 'Done'] as const;

function classify(value: string): StatusInfo {
  const known = STATUS_TO_STATE[value.toLowerCase()];
  return { value, kind: known ? 'ok' : 'unknown' };
}

export function normalizeStatus(raw: unknown): StatusInfo {
  if (raw === null || raw === undefined) return { value: null, kind: 'missing' };

  if (Array.isArray(raw)) {
    const items = raw.map((entry) => String(entry).trim()).filter((entry) => entry !== '');
    if (items.length === 0) return { value: null, kind: 'missing' };
    if (items.length === 1) return classify(items[0]);
    return { value: items.join(', '), kind: 'list' };
  }

  const text = String(raw).trim();
  if (text === '') return { value: null, kind: 'missing' };
  return classify(text);
}

export function expectedStateForStatus(value: string | null): CardState | null {
  if (value === null) return null;
  return STATUS_TO_STATE[value.toLowerCase()] ?? null;
}

export function isDivergent(state: CardState, status: StatusInfo): boolean {
  if (state === '0.backlog' || state === '5.archived') return false;
  const expected = expectedStateForStatus(status.value);
  if (expected === null) return false;
  return expected !== state;
}
