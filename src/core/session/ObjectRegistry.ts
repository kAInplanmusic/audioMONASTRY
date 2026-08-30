import { random } from '../../utils/random';
/**
 * audioMONASTRY · 1.2.1 – Objekt-Identitätssystem (ObjectRegistry)
 * =================================================================
 * UUID-basiertes, versioniertes Identitätssystem für alle Session-Objekte.
 * Jedes Objekt besitzt eine stabile ID, eine monoton steigende Version und
 * Zeitstempel. Die Registry ist der einzige Ort, an dem Session-Objekte
 * erzeugt/gelesen/mutiert werden – Voraussetzung für das Replikations-
 * protokoll (1.2.2) und das Locking (1.2.3).
 */

export interface SessionObject<T = unknown> {
  /** Stabile, eindeutige Identität (UUID v4). */
  id: string;
  /** Objekt-Typ (z. B. 'plugin', 'pattern', 'preset', 'lock'). */
  type: string;
  /** Monoton steigende Versionsnummer. */
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Nutzdaten (JSON-serialisierbar). */
  data: T;
}

/** UUID v4 (crypto.randomUUID mit Fallback). */
export function uuidV4(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* unsichere Umgebung */ }
  // Fallback: RFC-4122-konform aus Math.random (nur für Non-Crypto-Kontexte).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.trunc(random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class ObjectRegistry<T = unknown> {
  private objects = new Map<string, SessionObject<T>>();
  private versions = new Map<string, number>();

  /** Erzeugt ein neues Session-Objekt mit Version 1. */
  create(type: string, data: T): SessionObject<T> {
    const now = Date.now();
    const obj: SessionObject<T> = {
      id: uuidV4(),
      type,
      version: 1,
      createdAt: now,
      updatedAt: now,
      data,
    };
    this.objects.set(obj.id, obj);
    this.versions.set(obj.id, 1);
    return obj;
  }

  /**
   * Übernimmt ein repliziertes Objekt mit fester ID (aus dem CRDT-Protokoll).
   * Die Version wird auf max(lokale Version, replizierte Version) angehoben.
   */
  applyReplicated(id: string, type: string, data: T, version: number): SessionObject<T> {
    const existing = this.objects.get(id);
    const now = Date.now();
    const obj: SessionObject<T> = {
      id,
      type,
      version: Math.max(version, existing?.version ?? 0, 1),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      data: structuredCloneSafe(data),
    };
    this.objects.set(id, obj);
    this.versions.set(id, obj.version);
    return { ...obj, data: structuredCloneSafe(obj.data) };
  }

  /** Liest ein Objekt (oder `undefined`). */
  get(id: string): SessionObject<T> | undefined {
    const obj = this.objects.get(id);
    return obj ? { ...obj, data: structuredCloneSafe(obj.data) } : undefined;
  }

  /** Mutiert ein Objekt und erhöht die Version (kopiert Daten defensiv). */
  update(id: string, data: T): SessionObject<T> | undefined {
    const obj = this.objects.get(id);
    if (!obj) return undefined;
    const next: SessionObject<T> = {
      ...obj,
      data: structuredCloneSafe(data),
      version: obj.version + 1,
      updatedAt: Date.now(),
    };
    this.objects.set(id, next);
    this.versions.set(id, next.version);
    return { ...next, data: structuredCloneSafe(next.data) };
  }

  /** Entfernt ein Objekt aus der Registry. */
  delete(id: string): boolean {
    this.versions.delete(id);
    return this.objects.delete(id);
  }

  /** Existenz-Check ohne Daten-Kopie. */
  has(id: string): boolean {
    return this.objects.has(id);
  }

  /** Aktuelle Version eines Objekts (oder `undefined`). */
  versionOf(id: string): number | undefined {
    return this.versions.get(id);
  }

  /** Alle Objekte als flache Kopie (für Snapshots/Export). */
  snapshot(): SessionObject<T>[] {
    return [...this.objects.values()].map((o) => ({ ...o, data: structuredCloneSafe(o.data) }));
  }

  /** Anzahl verwalteter Objekte. */
  get size(): number {
    return this.objects.size;
  }
}

function structuredCloneSafe<T>(value: T): T {
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch { /* Fallback unten */ }
  return JSON.parse(JSON.stringify(value)) as T;
}
