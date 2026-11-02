const REMOTE_URL = /^(?:git@[^:]+:|https?:\/\/[^/]+\/|ssh:\/\/[^/]+\/)(.+?)(?:\.git)?$/;

export function normalizeRepo(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  const text = String(raw).trim();
  if (text === '') return null;

  const match = REMOTE_URL.exec(text);
  if (!match) return null;

  const slug = match[1].replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = slug.split('/').filter((entry) => entry !== '');
  if (parts.length < 2) return null;

  return parts.slice(-2).join('/').toLowerCase();
}

export function isSentinelRepo(raw: string): boolean {
  if (raw.trim() === '') return false;
  return normalizeRepo(raw) === null;
}
