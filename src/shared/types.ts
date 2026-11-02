export const CARD_STATES = [
  '0.backlog',
  '1.not_started',
  '2.in_progress',
  '3.in_review',
  '4.done',
  '5.archived',
] as const;

export type CardState = (typeof CARD_STATES)[number];

export const DATE_FIELDS = ['created', 'started', 'reviewed', 'completed'] as const;

export type DateField = (typeof DATE_FIELDS)[number];

export type DateValue =
  | { kind: 'valid'; iso: string; time: number }
  | { kind: 'empty' }
  | { kind: 'invalid'; raw: string };

export type StatusKind = 'ok' | 'missing' | 'unknown' | 'list';

export interface StatusInfo {
  value: string | null;
  kind: StatusKind;
}

export type SectionMap = Partial<Record<string, string | null>>;

export interface BoardCard {
  path: string;
  basename: string;
  state: CardState;
  repo: string | null;
  repoRaw: string;
  status: StatusInfo;
  feature: string | null;
  featureInvalid: boolean;
  dates: Record<DateField, DateValue>;
  mtime: number;
  pendingTasks: number;
  doneTasks: number;
  totalTasks: number;
  prUrl: string | null;
  prInvalid: boolean;
  sections: SectionMap;
  outgoingLinks: string[];
}

export interface CardRef {
  basename: string;
  state: CardState;
  path: string;
}
