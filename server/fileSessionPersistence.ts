/**
 * audioMONASTRY · Datei-Persistenz des Session-Zustands (RT-AUDIT-P1-008)
 * =====================================================================
 * Rückfall, wenn kein Redis läuft: Ohne ihn lag der Session-Zustand
 * (Locks, Plugin-Settings, Studio-Store) nur im RAM. Weil auf den Geräten
 * nichts gespeichert werden darf, war nach jedem Neustart/Deploy ALLES weg.
 *
 * Schreibweise: atomar über `writeFile(tmp)` + `rename` – ein Absturz mitten im
 * Schreiben hinterlässt nie eine halbe Datei. Schreibvorgänge werden
 * hintereinander ausgeführt (Promise-Kette), sodass nie zwei gleichzeitig auf
 * dieselbe Temp-Datei zugreifen. Eine beschädigte Datei wird beim Laden
 * beiseitegelegt (`.corrupt-<zeit>`) statt den Start zu blockieren.
 *
 * Asynchron und vom Aufrufer bereits entprellt (sessionRuntime.persist, 250 ms):
 * die Event-Loop des Signalings wird nicht blockiert.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuthoritativeSessionPersistence, SerializedAuthoritativeSession } from '../src/core/session/authoritativeSession';

export class FileSessionPersistence implements AuthoritativeSessionPersistence {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
  ) {}

  async load(): Promise<SerializedAuthoritativeSession | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.warn(`[session] Zustandsdatei nicht lesbar (${this.filePath}): ${(error as Error).message}`);
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as SerializedAuthoritativeSession;
      if (!parsed || typeof parsed !== 'object') throw new Error('kein Objekt');
      return parsed;
    } catch (error) {
      const aside = `${this.filePath}.corrupt-${Date.now()}`;
      this.warn(`[session] Zustandsdatei beschaedigt (${(error as Error).message}) – beiseitegelegt als ${aside}`);
      await rename(this.filePath, aside).catch(() => { /* best effort */ });
      return null;
    }
  }

  save(state: SerializedAuthoritativeSession): Promise<void> {
    const json = JSON.stringify(state);
    const next = this.chain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      await writeFile(tmp, json, 'utf8');
      await rename(tmp, this.filePath);
    });
    // Die Kette darf an einem Fehler nicht hängen bleiben; der Fehler geht an den Aufrufer.
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/**
 * Pfad der Zustandsdatei. `SESSION_STATE_FILE=off` schaltet die Datei-Persistenz
 * ab. In Tests (NODE_ENV=test/VITEST) ist sie ohne ausdrückliche Angabe aus,
 * damit Testläufe keine Dateien im Repo hinterlassen.
 */
export function resolveSessionStateFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = (env.SESSION_STATE_FILE ?? '').trim();
  if (explicit.toLowerCase() === 'off') return null;
  if (explicit) return path.resolve(explicit);
  if (env.NODE_ENV === 'test' || env.VITEST) return null;
  return path.resolve('data/state/session-state.json');
}
