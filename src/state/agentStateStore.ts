import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  evaluateAgentState,
  guidelinesPath,
  condensedMemoryPath,
  SUPPORTED_VERSION,
  serializeAgentState,
  stripBom,
  type StateContext,
} from '../shared/state';

export interface StateSnapshot {
  text: string;
  hash: string;
  mtimeMs: number;
  size: number;
}

export interface StateReadResult {
  snapshot: StateSnapshot | null;
  error: string | null;
}

export type WriteOutcome =
  | { ok: true }
  | { ok: false; reason: 'changed' | 'write'; message: string };

export interface StateOutcome {
  kind: 'ok' | 'repaired' | 'unchanged' | 'blocked';
  message: string;
  changes: string[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function readState(absolutePath: string): StateReadResult {
  try {
    const stat = fs.statSync(absolutePath);
    const text = stripBom(fs.readFileSync(absolutePath, 'utf8'));
    return {
      snapshot: { text, hash: hashContent(text), mtimeMs: stat.mtimeMs, size: stat.size },
      error: null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { snapshot: null, error: null };
    return { snapshot: null, error: `não foi possível ler o arquivo: ${describeError(error)}` };
  }
}

export function writeStateAtomically(absolutePath: string, text: string): void {
  const temporaryPath = `${absolutePath}.tmp`;
  const handle = fs.openSync(temporaryPath, 'w');
  try {
    fs.writeFileSync(handle, text, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  try {
    fs.renameSync(temporaryPath, absolutePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // o temporário pode não existir mais; o erro relevante é o do rename
    }
    throw error;
  }
}

export function writeWithConcurrencyCheck(
  absolutePath: string,
  text: string,
  expected: StateSnapshot | null,
): WriteOutcome {
  const current = readState(absolutePath);

  if (current.error !== null) {
    return { ok: false, reason: 'write', message: current.error };
  }
  if (expected === null) {
    if (current.snapshot !== null) {
      return { ok: false, reason: 'changed', message: 'o arquivo apareceu depois da leitura' };
    }
  } else if (current.snapshot === null) {
    return { ok: false, reason: 'changed', message: 'o arquivo desapareceu desde a leitura' };
  } else if (current.snapshot.hash !== expected.hash) {
    return { ok: false, reason: 'changed', message: 'o arquivo mudou desde a leitura' };
  }

  try {
    writeStateAtomically(absolutePath, text);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'write', message: `falha ao gravar: ${describeError(error)}` };
  }
}

export function repairStateFile(absolutePath: string, context: StateContext): StateOutcome {
  const read = readState(absolutePath);

  if (read.error !== null) return { kind: 'blocked', message: read.error, changes: [] };
  if (read.snapshot === null) {
    return {
      kind: 'blocked',
      message: '`.agent_obsidian` não existe neste projeto; o plugin não cria o arquivo.',
      changes: [],
    };
  }

  const verdict = evaluateAgentState(read.snapshot.text, context);

  if (verdict.kind === 'blocked') return { kind: 'blocked', message: verdict.message, changes: [] };
  if (verdict.kind === 'ok') return { kind: 'unchanged', message: 'state já está íntegro', changes: [] };

  const write = writeWithConcurrencyCheck(
    absolutePath,
    serializeAgentState(verdict.data),
    read.snapshot,
  );
  if (!write.ok) return { kind: 'blocked', message: write.message, changes: [] };

  return {
    kind: 'repaired',
    message: `state reparado: ${verdict.changes.join(', ')}`,
    changes: verdict.changes,
  };
}

export function clearCurrentCard(
  absolutePath: string,
  expected: StateSnapshot,
  context: StateContext,
): StateOutcome {
  const read = readState(absolutePath);

  if (read.error !== null) return { kind: 'blocked', message: read.error, changes: [] };
  if (read.snapshot === null) {
    return { kind: 'blocked', message: '`.agent_obsidian` não existe mais neste projeto', changes: [] };
  }

  const verdict = evaluateAgentState(read.snapshot.text, context);

  if (verdict.kind === 'blocked') return { kind: 'blocked', message: verdict.message, changes: [] };
  if (verdict.kind === 'repair') {
    return {
      kind: 'blocked',
      message: 'o state precisa de reparo antes de limpar o `current_card`; rode "Reparar state" primeiro',
      changes: [],
    };
  }

  const data = { ...verdict.data, current_card: null };
  const write = writeWithConcurrencyCheck(absolutePath, serializeAgentState(data), expected);
  if (!write.ok) return { kind: 'blocked', message: write.message, changes: [] };

  return { kind: 'ok', message: '`current_card` limpo', changes: ['current_card'] };
}

export interface ActiveCard {
  name: string;
  path: string;
}

export function initializeStateFile(
  absolutePath: string,
  context: StateContext,
  card: ActiveCard,
): StateOutcome {
  const data = {
    version: SUPPORTED_VERSION,
    vault_path: context.vaultPath,
    guidelines_path: guidelinesPath(context.vaultPath),
    condensed_memory_path: condensedMemoryPath(context.vaultPath, context.projectName),
    current_card: { name: card.name, path: card.path },
  };

  try {
    fs.writeFileSync(absolutePath, serializeAgentState(data), {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return {
        kind: 'blocked',
        message: 'o `.agent_obsidian` apareceu desde a varredura; atualize e tente de novo',
        changes: [],
      };
    }
    return { kind: 'blocked', message: `falha ao criar: ${describeError(error)}`, changes: [] };
  }

  return { kind: 'ok', message: `\`.agent_obsidian\` criado e card ativo: ${card.name}`, changes: ['current_card'] };
}

export function parseStateObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stripBom(text));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return { ...(parsed as Record<string, unknown>) };
  } catch {
    return null;
  }
}

export function activateCurrentCard(
  absolutePath: string,
  expected: StateSnapshot,
  context: StateContext,
  card: ActiveCard,
): StateOutcome {
  const read = readState(absolutePath);

  if (read.error !== null) return { kind: 'blocked', message: read.error, changes: [] };
  if (read.snapshot === null) {
    return { kind: 'blocked', message: '`.agent_obsidian` não existe mais neste projeto', changes: [] };
  }

  const verdict = evaluateAgentState(read.snapshot.text, context);
  if (verdict.kind === 'blocked') return { kind: 'blocked', message: verdict.message, changes: [] };

  const data = parseStateObject(read.snapshot.text);
  if (data === null) {
    return { kind: 'blocked', message: 'o conteúdo do state não é um objeto JSON', changes: [] };
  }

  data.current_card = { name: card.name, path: card.path };

  const write = writeWithConcurrencyCheck(absolutePath, serializeAgentState(data), expected);
  if (!write.ok) return { kind: 'blocked', message: write.message, changes: [] };

  return { kind: 'ok', message: `card ativo: ${card.name}`, changes: ['current_card'] };
}
