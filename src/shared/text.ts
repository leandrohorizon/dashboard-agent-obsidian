export const CANONICAL_SECTIONS = [
  'Descrição',
  'Dependências',
  'Dependentes',
  'Tarefas',
  'Discussões',
  'Descrição Técnica do que Foi Feito',
  'Conhecimento Adquirido pela IA',
] as const;

export type CanonicalSection = (typeof CANONICAL_SECTIONS)[number];

interface ScannedLine {
  text: string;
  inFence: boolean;
}

function splitLines(content: string): ScannedLine[] {
  const lines: ScannedLine[] = [];
  let inFence = false;
  for (const text of content.split('\n')) {
    const isFence = /^\s*(```|~~~)/.test(text);
    lines.push({ text, inFence });
    if (isFence) inFence = !inFence;
  }
  return lines;
}

function stripInlineCode(text: string): string {
  return text.replace(/`[^`]*`/g, '');
}

export function extractSection(content: string, heading: string): string | null {
  const lines = splitLines(content);
  const target = heading.trim().toLowerCase();
  const canonical = new Set(CANONICAL_SECTIONS.map((name) => name.toLowerCase()));
  let start = -1;
  let level = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.inFence) continue;

    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line.text);
    if (!match) continue;

    const currentLevel = match[1].length;
    const title = match[2].toLowerCase();

    if (start < 0) {
      if (title === target) {
        start = index + 1;
        level = currentLevel;
      }
      continue;
    }

    const closesSection =
      currentLevel === level || (currentLevel < level && canonical.has(title));

    if (closesSection) {
      return lines
        .slice(start, index)
        .map((entry) => entry.text)
        .join('\n');
    }
  }

  if (start < 0) return null;
  return lines
    .slice(start)
    .map((entry) => entry.text)
    .join('\n');
}

export function isEmptySection(section: string | null | undefined): boolean {
  if (section === null || section === undefined) return true;
  return section.split('\n').every((line) => {
    const trimmed = line.trim();
    return trimmed === '' || trimmed.startsWith('>') || trimmed === '---';
  });
}

export function countTasks(section: string | null | undefined): {
  pending: number;
  done: number;
  total: number;
} {
  if (!section) return { pending: 0, done: 0, total: 0 };

  let pending = 0;
  let done = 0;

  for (const line of splitLines(section)) {
    if (line.inFence) continue;
    const match = /^\s*[-*]\s+\[(.)\]\s/.exec(line.text);
    if (!match) continue;
    if (match[1] === ' ') pending += 1;
    else done += 1;
  }

  return { pending, done, total: pending + done };
}

export function extractLinks(section: string | null | undefined): string[] {
  if (!section) return [];

  const links: string[] = [];
  for (const line of splitLines(section)) {
    if (line.inFence) continue;
    const text = stripInlineCode(line.text);
    const pattern = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1].trim();
      if (value !== '') links.push(value);
    }
  }
  return links;
}
