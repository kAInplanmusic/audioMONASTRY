// Deep-Audit-System – Datei-Auswahl (full/diff/files), Risiko-Einstufung, Batching.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { matchesAny } from './pattern.js';
import { runCommand } from './process.js';
import type { AuditConfig } from './types.js';

export interface SelectedFile {
  path: string;
  risk: 'hot' | 'risk' | 'normal';
  size: number;
}

export interface FileBatch {
  files: SelectedFile[];
  content: string;
}

export async function listGitFiles(root: string): Promise<string[]> {
  const result = await runCommand('git', ['ls-files'], { cwd: root });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function listDiffFiles(root: string): Promise<string[]> {
  const candidates = [
    ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'origin/main...HEAD'],
    ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD~1'],
  ];
  for (const args of candidates) {
    const result = await runCommand('git', args, { cwd: root });
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
  }
  const status = await runCommand('git', ['status', '--porcelain'], { cwd: root });
  return status.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0 && !line.startsWith('!!'));
}

export function classifyFile(config: AuditConfig, filePath: string): SelectedFile['risk'] {
  if (matchesAny(config.hotPatterns, filePath)) return 'hot';
  if (matchesAny(config.riskPatterns, filePath)) return 'risk';
  return 'normal';
}

export async function selectFiles(
  root: string,
  config: AuditConfig,
  mode: 'full' | 'diff' | 'files',
  explicitFiles: string[] = [],
  smoke = false,
): Promise<SelectedFile[]> {
  let rawFiles: string[] = [];
  if (mode === 'files') {
    rawFiles = explicitFiles.length > 0 ? explicitFiles : config.smokeFiles;
  } else if (mode === 'diff') {
    rawFiles = await listDiffFiles(root);
  } else if (smoke) {
    rawFiles = config.smokeFiles;
  } else {
    rawFiles = await listGitFiles(root);
  }

  const seen = new Set<string>();
  const selected: SelectedFile[] = [];
  for (const raw of rawFiles) {
    const filePath = raw.replaceAll('\\', '/');
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    if (matchesAny(config.exclusions, filePath)) continue;
    const absolute = path.join(root, filePath);
    if (!existsSync(absolute)) continue;
    let size = 0;
    try {
      size = statSync(absolute).size;
    } catch {
      // Datei kann z. B. gerade gelöscht worden sein.
    }
    if (size === 0) continue;
    selected.push({
      path: filePath,
      risk: classifyFile(config, filePath),
      size,
    });
  }

  // Für Full-Mode nur sinnvolle Quell- und Konfigurationsdateien behalten.
  return selected.filter((file) =>
    /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|sql|yml|yaml|json|sh|toml|html|css|md)$/.test(file.path),
  );
}

const SOURCE_EXTENSION = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.sql', '.yml', '.yaml', '.json', '.sh', '.toml', '.html', '.css', '.md',
]);

export function isSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_EXTENSION.has(ext);
}

export function redactSecrets(content: string): string {
  let out = content;
  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (!value || value.length < 8) continue;
    const upper = key.toUpperCase();
    if (
      /(TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|API_KEY|PRIVATE)/.test(upper) ||
      upper.startsWith('HF_') ||
      upper.startsWith('DEEPSEEK_') ||
      upper === 'API_KEY'
    ) {
      out = out.split(value).join(`[REDACTED:${key}]`);
    }
  }
  return out;
}

export function readFileContent(root: string, filePath: string, maxChars: number): string {
  const raw = readFileSync(path.join(root, filePath), 'utf8');
  return redactSecrets(raw.slice(0, maxChars));
}

export function buildBatches(
  root: string,
  files: SelectedFile[],
  maxChars: number,
): FileBatch[] {
  const batches: FileBatch[] = [];
  let currentFiles: SelectedFile[] = [];
  let currentLength = 0;

  const flush = () => {
    if (currentFiles.length === 0) return;
    const content = currentFiles
      .map((file) => {
        const body = readFileContent(root, file.path, maxChars);
        return `\n===== DATEI: ${file.path} (Risiko: ${file.risk}) =====\n${body}\n`;
      })
      .join('\n');
    batches.push({ files: [...currentFiles], content });
    currentFiles = [];
    currentLength = 0;
  };

  for (const file of files) {
    const fileLength = file.size;
    if (currentFiles.length > 0 && currentLength + fileLength > maxChars) flush();
    currentFiles.push(file);
    currentLength += fileLength;
  }
  flush();
  return batches;
}
