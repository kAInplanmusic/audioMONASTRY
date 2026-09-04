/**
 * audioMONASTRY · Zentrales Fehler-Register (GAP-8)
 * ==================================================
 * Sammelt Laufzeit-/Audit-Fehler im Speicher (Ring, max 500 Einträge),
 * damit CI/Logs/UI ein gemeinsames Register speisen können. Kein
 * Netzwerk-/Storage-Zwang – Serverless testbar.
 */

export interface ErrorEntry {
  id: string;
  source: string;
  message: string;
  ts: number;
  context?: unknown;
}

const MAX_ENTRIES = 500;

class ErrorRegisterImpl {
  private entries: ErrorEntry[] = [];
  private seq = 0;

  add(source: string, message: string, context?: unknown): ErrorEntry {
    const entry: ErrorEntry = {
      id: `err-${Date.now().toString(36)}-${++this.seq}`,
      source,
      message,
      ts: Date.now(),
      context,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    return entry;
  }

  list(filter?: { source?: string; since?: number }): ErrorEntry[] {
    return this.entries.filter(
      (e) => (!filter?.source || e.source === filter.source) && (!filter?.since || e.ts >= filter.since),
    );
  }

  recent(limit = 10): ErrorEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  get count(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

export const errorRegister = new ErrorRegisterImpl();
