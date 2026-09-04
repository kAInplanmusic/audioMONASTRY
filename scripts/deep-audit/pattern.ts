// Deep-Audit-System – kleine Glob-Engine für Pfad-Muster.

export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replaceAll('\\', '/');
  if (pattern.startsWith('./')) pattern = pattern.slice(2);
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '@@GLOBSTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/@@GLOBSTAR@@/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function matchesAny(patterns: string[], filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  return patterns.some((raw) => {
    const pattern = raw.replaceAll('\\', '/');
    if (pattern === normalized) return true;
    if (pattern.endsWith('/**') && normalized.startsWith(pattern.slice(0, -3))) return true;
    if (pattern.includes('**')) return globToRegExp(pattern).test(normalized);
    if (pattern.endsWith('/')) return normalized.startsWith(pattern);
    // Einfacher Prefix-Match für Verzeichnis-Muster wie "server/**"
    if (pattern.endsWith('/**')) return normalized.startsWith(pattern.slice(0, -3));
    if (pattern.includes('*')) return globToRegExp(pattern).test(normalized);
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
