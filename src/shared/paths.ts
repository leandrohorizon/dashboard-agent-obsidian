import * as nodePath from 'path';

export function normalizeProjectName(projectDir: string): string {
  const basename = nodePath.basename(nodePath.resolve(projectDir));
  return basename.toLowerCase().replace(/[-\s]+/g, '_');
}

export function resolveProjectKey(projectDir: string): string {
  const resolved = nodePath.resolve(projectDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isSamePath(left: string, right: string): boolean {
  return resolveProjectKey(left) === resolveProjectKey(right);
}

export function isPathInside(child: string, parent: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(parent), nodePath.resolve(child));
  if (relative === '') return true;
  if (nodePath.isAbsolute(relative)) return false;
  return !relative.startsWith('..');
}

export function depthBelow(parent: string, child: string): number {
  const relative = nodePath.relative(nodePath.resolve(parent), nodePath.resolve(child));
  if (relative === '' || nodePath.isAbsolute(relative)) return 0;
  return relative.split(nodePath.sep).filter((entry) => entry !== '').length;
}

export function expandHome(input: string, home: string): string {
  const text = input.trim();
  if (text === '~') return home;
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return nodePath.join(home, text.slice(2));
  }
  return text;
}

export function toPosix(path: string): string {
  return path.split(nodePath.sep).join('/');
}
