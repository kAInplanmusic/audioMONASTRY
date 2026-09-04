// Deep-Audit-System – robuste Subprozess-Ausführung.

import { execFile } from 'node:child_process';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  cwd?: string;
}

export function runCommand(
  command: string,
  args: string[] = [],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const { timeoutMs = 180_000, maxBuffer = 64 * 1024 * 1024, cwd } = options;
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer,
        cwd,
        env: process.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        let exitCode = 0;
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          exitCode = typeof code === 'number' && Number.isFinite(code) ? code : 1;
        }
        resolve({ exitCode, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

export async function runCommandOrThrow(
  command: string,
  args: string[] = [],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `Kommando fehlgeschlagen: ${command} ${args.join(' ')}\n${result.stderr.slice(0, 2000)}`,
    );
  }
  return result;
}

export function parseJsonLoose<T>(text: string): T | null {
  const cleaned = text.trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    const braceStart = cleaned.indexOf('{');
    const braceEnd = cleaned.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      try {
        return JSON.parse(cleaned.slice(braceStart, braceEnd + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
