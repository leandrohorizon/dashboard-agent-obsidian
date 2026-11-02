import * as nodePath from 'path';
import { expandHome, normalizeProjectName, resolveProjectKey } from '../shared/paths';

export type FsProbe = 'dir' | 'file' | 'missing' | 'denied';

export interface RegistryDeps {
  homeDir: string;
  probe: (absolutePath: string) => FsProbe;
  listDirectories: (absolutePath: string) => string[];
}

export interface ProjectError {
  scope: 'root' | 'project';
  path: string;
  message: string;
}

export interface ProjectEntry {
  key: string;
  path: string;
  name: string;
  source: 'root' | 'manual';
}

export interface RegistryResult {
  projects: ProjectEntry[];
  errors: ProjectError[];
  duplicates: string[];
}

export interface RegistryInput {
  roots: string[];
  extraProjects: string[];
  excludedPaths: string[];
}

const SKIPPED_DIRECTORIES = new Set(['node_modules']);

export function discoverProjects(input: RegistryInput, deps: RegistryDeps): RegistryResult {
  const projects = new Map<string, ProjectEntry>();
  const errors: ProjectError[] = [];
  const duplicates: string[] = [];

  const excluded = new Set(
    input.excludedPaths
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => resolveProjectKey(expandHome(entry, deps.homeDir))),
  );

  const register = (directory: string, source: ProjectEntry['source']): void => {
    const key = resolveProjectKey(directory);
    if (excluded.has(key)) return;
    if (projects.has(key)) {
      duplicates.push(directory);
      return;
    }
    projects.set(key, { key, path: directory, name: normalizeProjectName(directory), source });
  };

  for (const rawRoot of input.roots) {
    if (rawRoot.trim() === '') continue;
    const root = nodePath.resolve(expandHome(rawRoot, deps.homeDir));
    const probe = deps.probe(root);

    if (probe === 'missing') {
      errors.push({ scope: 'root', path: root, message: 'raiz não existe' });
      continue;
    }
    if (probe === 'denied') {
      errors.push({ scope: 'root', path: root, message: 'sem permissão de leitura' });
      continue;
    }
    if (probe !== 'dir') {
      errors.push({ scope: 'root', path: root, message: 'não é diretório' });
      continue;
    }

    let entries: string[];
    try {
      entries = deps.listDirectories(root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ scope: 'root', path: root, message: `falha ao listar: ${message}` });
      continue;
    }

    for (const name of entries) {
      if (name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)) continue;
      const child = nodePath.join(root, name);
      if (deps.probe(child) !== 'dir') continue;
      if (deps.probe(nodePath.join(child, '.agent_obsidian')) !== 'file') continue;
      register(child, 'root');
    }
  }

  for (const rawManual of input.extraProjects) {
    if (rawManual.trim() === '') continue;
    const directory = nodePath.resolve(expandHome(rawManual, deps.homeDir));
    const probe = deps.probe(directory);

    if (probe === 'missing') {
      errors.push({ scope: 'project', path: directory, message: 'projeto incluído manualmente não existe' });
      continue;
    }
    if (probe === 'denied') {
      errors.push({ scope: 'project', path: directory, message: 'sem permissão de leitura' });
      continue;
    }
    if (probe !== 'dir') {
      errors.push({ scope: 'project', path: directory, message: 'não é diretório' });
      continue;
    }
    if (deps.probe(nodePath.join(directory, '.agent_obsidian')) !== 'file') {
      errors.push({ scope: 'project', path: directory, message: 'sem `.agent_obsidian`' });
      continue;
    }

    register(directory, 'manual');
  }

  return {
    projects: [...projects.values()].sort((left, right) => left.name.localeCompare(right.name)),
    errors,
    duplicates,
  };
}
