const WIKILINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

export function parseCardRefs(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];

  const source = Array.isArray(raw) ? raw : [raw];
  const names: string[] = [];

  for (const entry of source) {
    if (entry === null || entry === undefined) continue;
    const text = String(entry);
    const wrapped = [...text.matchAll(WIKILINK)].map((match) => match[1].trim());
    const candidates =
      wrapped.length > 0
        ? wrapped
        : text
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '');

    for (const name of candidates) {
      if (name !== '' && !names.includes(name)) names.push(name);
    }
  }

  return names;
}
