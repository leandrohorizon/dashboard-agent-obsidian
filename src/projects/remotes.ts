import * as fs from 'fs';
import * as nodePath from 'path';

import { normalizeRepo } from '../shared/repo';

function gitDirectory(projectPath: string): string | null {
  const dotGit = nodePath.join(projectPath, '.git');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;

  try {
    const text = fs.readFileSync(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)$/im.exec(text);
    return match === null ? null : nodePath.resolve(projectPath, match[1].trim());
  } catch {
    return null;
  }
}

function remoteUrl(configText: string): string | null {
  let remoteName: string | null = null;
  let originUrl: string | null = null;
  let firstUrl: string | null = null;

  for (const line of configText.split(/\r?\n/)) {
    const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line);
    if (section !== null) {
      remoteName = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      remoteName = null;
      continue;
    }

    const url = /^\s*url\s*=\s*(.+)$/.exec(line);
    if (url === null || remoteName === null) continue;

    if (firstUrl === null) firstUrl = url[1].trim();
    if (remoteName === 'origin' && originUrl === null) originUrl = url[1].trim();
  }

  return originUrl ?? firstUrl;
}

export function readRepoSlug(projectPath: string): string | null {
  const directory = gitDirectory(projectPath);
  if (directory === null) return null;

  try {
    const config = fs.readFileSync(nodePath.join(directory, 'config'), 'utf8');
    const url = remoteUrl(config);
    return url === null ? null : normalizeRepo(url);
  } catch {
    return null;
  }
}
