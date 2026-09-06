// Deep-Audit-System – kleine Glob-Engine für Pfad-Muster.

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- bewusst beibehalten (Runde 3)
const GLOB_META = /[*?]/;

// Erlaubte Glob-Zeichen: alphanumerisch, '/', '.', '_', '-', '*', '?'.
// Alles andere wird abgelehnt, um non-literal-regexp-Probleme zu vermeiden.
const VALID_GLOB_RE = /^[a-zA-Z0-9_/.*\-?]+$/;

export class GlobSyntaxError extends Error {
  constructor(public readonly pattern: string) {
    super(`Ungültiges Glob-Muster: ${pattern}`);
  }
}

export function validateGlob(glob: string): void {
  if (!VALID_GLOB_RE.test(glob)) {
    throw new GlobSyntaxError(glob);
  }
}

export function globToRegExp(glob: string): RegExp {
  validateGlob(glob);

  let pattern = glob.trim().replaceAll('\\', '/');
  if (pattern.startsWith('./')) pattern = pattern.slice(2);

  // Zuerst alle wörtlichen Metazeichen escapen, die nicht von uns
  // als Glob-Operatoren interpretiert werden sollen.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '@@GLOBSTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/@@GLOBSTAR@@/g, '.*');

  // RegExp aus einem validierten und escaped String aufbauen.
  return new RegExp(`^${escaped}$`);
}

export function matchesAny(patterns: string[], filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  return patterns.some((raw) => {
    const pattern = raw.replaceAll('\\', '/');
    if (pattern === normalized) return true;
    if (pattern.endsWith('/')) return normalized.startsWith(pattern);
    if (pattern.includes('*') || pattern.includes('?')) {
      return globToRegExp(pattern).test(normalized);
    }
    return normalized === pattern || normalized.startsWith(`${pattern}/`);
  });
}

export function fingerprintFinding(parts: {
  file: string;
  line: number | null;
  category: string;
  message: string;
  source: string;
}): string {
  const line = parts.line ?? 0;
  const message = parts.message.trim().toLowerCase().slice(0, 160);
  return `${parts.file}:${line}:${parts.category.toLowerCase()}:${message}`;
}
