import type { DateField, DateValue } from './types';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function fromParts(year: number, month: number, day: number): DateValue | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { kind: 'valid', iso: `${year}-${pad(month)}-${pad(day)}`, time };
}

function fromDate(date: Date): DateValue {
  if (Number.isNaN(date.getTime())) return { kind: 'invalid', raw: 'Invalid Date' };
  const built = fromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  return built ?? { kind: 'invalid', raw: date.toISOString() };
}

export function parseDateValue(raw: unknown): DateValue {
  if (raw === null || raw === undefined) return { kind: 'empty' };
  if (raw instanceof Date) return fromDate(raw);
  if (typeof raw === 'number') return fromDate(new Date(raw));

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return { kind: 'empty' };
    const match = ISO_DATE.exec(text);
    if (!match) return { kind: 'invalid', raw: text };
    const built = fromParts(Number(match[1]), Number(match[2]), Number(match[3]));
    return built ?? { kind: 'invalid', raw: text };
  }

  return { kind: 'invalid', raw: String(raw) };
}

export function parseDateMap(
  frontmatter: Record<string, unknown> | undefined,
  fields: readonly DateField[],
): Record<DateField, DateValue> {
  const result = {} as Record<DateField, DateValue>;
  for (const field of fields) {
    result[field] = parseDateValue(frontmatter?.[field]);
  }
  return result;
}

export function sortWithEmptyLast<T>(
  items: T[],
  getDate: (item: T) => DateValue,
  direction: 'asc' | 'desc',
): T[] {
  const dated: Array<{ item: T; time: number }> = [];
  const undated: T[] = [];

  for (const item of items) {
    const value = getDate(item);
    if (value.kind === 'valid') dated.push({ item, time: value.time });
    else undated.push(item);
  }

  dated.sort((a, b) => (direction === 'asc' ? a.time - b.time : b.time - a.time));
  return [...dated.map((entry) => entry.item), ...undated];
}

export function isOnOrAfter(value: DateValue, since: DateValue): boolean {
  if (since.kind !== 'valid') return false;
  if (value.kind !== 'valid') return false;
  return value.time >= since.time;
}

export function formatDateValue(value: DateValue): string {
  if (value.kind === 'valid') return value.iso;
  if (value.kind === 'invalid') return `${value.raw} (inválida)`;
  return '';
}
