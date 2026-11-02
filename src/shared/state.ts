import * as nodePath from 'path';

export const SUPPORTED_VERSION = '2.0';
export const OBSOLETE_KEYS = ['code_guidelines_path', 'conduct_path'] as const;

export interface StateContext {
  vaultPath: string;
  projectName: string;
}

export type StateVerdict =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'repair'; data: Record<string, unknown>; changes: string[] }
  | { kind: 'blocked'; code: 'invalid-json' | 'future-version'; message: string };

export function guidelinesPath(vaultPath: string): string {
  return nodePath.join(vaultPath, 'guidelines');
}

export function condensedMemoryPath(vaultPath: string, projectName: string): string {
  return nodePath.join(vaultPath, 'condensed memory', 'projects', `${projectName}.md`);
}

function samePath(left: unknown, right: string): boolean {
  if (typeof left !== 'string') return false;
  const normalize = (value: string) => {
    const resolved = nodePath.normalize(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function versionText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number') return String(raw);
  return '';
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function evaluateAgentState(text: string, context: StateContext): StateVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'blocked', code: 'invalid-json', message: `JSON inválido: ${message}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      kind: 'blocked',
      code: 'invalid-json',
      message: 'O conteúdo não é um objeto JSON.',
    };
  }

  const data = { ...(parsed as Record<string, unknown>) };
  const storedVersion = versionText(data.version);

  if (storedVersion !== '' && storedVersion !== SUPPORTED_VERSION) {
    const major = Number.parseInt(storedVersion.split('.')[0] ?? '', 10);
    if (Number.isFinite(major) && major > 2) {
      return {
        kind: 'blocked',
        code: 'future-version',
        message: `version ${storedVersion} é mais nova que a suportada (${SUPPORTED_VERSION}); o arquivo não foi tocado.`,
      };
    }
  }

  const changes: string[] = [];

  const desiredGuidelines = guidelinesPath(context.vaultPath);
  if (!samePath(data.guidelines_path, desiredGuidelines)) {
    data.guidelines_path = desiredGuidelines;
    changes.push('guidelines_path');
  }

  for (const key of OBSOLETE_KEYS) {
    if (key in data) {
      delete data[key];
      changes.push(`remove ${key}`);
    }
  }

  const desiredMemory = condensedMemoryPath(context.vaultPath, context.projectName);
  if (!samePath(data.condensed_memory_path, desiredMemory)) {
    data.condensed_memory_path = desiredMemory;
    changes.push('condensed_memory_path');
  }

  if (storedVersion !== SUPPORTED_VERSION) {
    data.version = SUPPORTED_VERSION;
    changes.push('version');
  }

  if (changes.length > 0) return { kind: 'repair', data, changes };
  return { kind: 'ok', data };
}

export function serializeAgentState(data: Record<string, unknown>): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

export interface CurrentCardInfo {
  name: string | null;
  path: string | null;
}

export function readCurrentCard(data: Record<string, unknown>): CurrentCardInfo {
  const raw = data.current_card;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { name: null, path: null };
  }
  const record = raw as Record<string, unknown>;
  return {
    name: typeof record.name === 'string' ? record.name : null,
    path: typeof record.path === 'string' ? record.path : null,
  };
}
