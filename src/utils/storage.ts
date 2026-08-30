/**
 * audioMONASTRY · Storage-Adapter (Plattform-Kapsel)
 * ===================================================
 * Einziger Ort, an dem localStorage berührt wird. Alle anderen Module nutzen
 * diese Funktionen, damit die Kernmodule keine direkte Plattform-API mehr
 * verwenden (Interface-Boundary-Regel 1.1).
 */
export function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* Quota/blockiert – nicht kritisch */
  }
}

export function storageRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function storageGetJson<T>(key: string): T | null {
  const raw = storageGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function storageSetJson(key: string, value: unknown): void {
  try {
    storageSet(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
