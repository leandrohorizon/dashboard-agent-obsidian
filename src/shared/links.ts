import type { CardRef } from './types';

export type LinkKind = 'card' | 'feature' | 'attachment' | 'broken' | 'ambiguous';

export interface LinkResolution {
  link: string;
  kind: LinkKind;
  targets: CardRef[];
}

export interface LinkContext {
  cardsByBasename: Map<string, CardRef[]>;
  featureExists: (slug: string) => boolean;
  attachmentExists: (name: string) => boolean;
}

export function classifyLink(link: string, context: LinkContext): LinkResolution {
  const key = link.trim().toLowerCase();
  const cards = context.cardsByBasename.get(key) ?? [];

  if (cards.length > 1) return { link, kind: 'ambiguous', targets: cards };
  if (cards.length === 1) return { link, kind: 'card', targets: cards };
  if (context.featureExists(link.trim())) return { link, kind: 'feature', targets: [] };
  if (context.attachmentExists(link.trim())) return { link, kind: 'attachment', targets: [] };

  return { link, kind: 'broken', targets: [] };
}

export function describeLinkKind(kind: LinkKind): string {
  switch (kind) {
    case 'card':
      return 'card';
    case 'feature':
      return 'feature memory';
    case 'attachment':
      return 'anexo';
    case 'ambiguous':
      return 'ambíguo';
    default:
      return 'quebrado';
  }
}
