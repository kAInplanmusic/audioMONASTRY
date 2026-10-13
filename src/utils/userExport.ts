/**
 * audioMONASTRY · Nutzerexport/-import (STORE-P1-001)
 * ====================================================
 * Einzige erlaubte Ausnahme von „Nichts auf den Geräten" (AGENTS.md §2.2,
 * Betreiber 2026-10-12): eigene Presets, recordMONK-Aufnahmen und weitere
 * sinnvolle Nutzerexporte – AUSSCHLIESSLICH als ausdrückliche Nutzeraktion
 * per Datei:
 *
 *   - Speichern: File System Access API mit Nutzerwahl (`showSaveFilePicker`),
 *     sonst klassischer Download über eine kurzlebige Blob-URL, die sofort
 *     nach dem Auslösen wieder freigegeben wird.
 *   - Öffnen: `showOpenFilePicker` bzw. Datei-Auswahl (`<input type=file>`).
 *
 * Kein verdeckter Browser-Speicher: diese Datei benutzt weder localStorage,
 * sessionStorage, IndexedDB noch OPFS (der Boundary-Scan prüft das). Die
 * Quelle der Wahrheit bleibt der Server.
 *
 * Der Boundary-Scan (scripts/validate-interface-boundaries.mjs) erlaubt
 * Datei-Dialoge und Download-Anker NUR in dieser Datei.
 */

export type UserSaveResult = 'saved' | 'downloaded' | 'cancelled';

export interface UserFileType {
  description: string;
  /** MIME → Endungen, z. B. { 'audio/wav': ['.wav'] }. */
  accept: Record<string, string[]>;
}

interface SaveHandle {
  createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }>;
}
interface OpenHandle {
  getFile(): Promise<File>;
}
type FsWindow = Window & {
  showSaveFilePicker?: (opts: { suggestedName?: string; types?: UserFileType[] }) => Promise<SaveHandle>;
  showOpenFilePicker?: (opts: { multiple?: boolean; types?: UserFileType[] }) => Promise<OpenHandle[]>;
};

const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

function fsWindow(): FsWindow | null {
  return typeof window === 'undefined' ? null : (window as FsWindow);
}

/**
 * Klassischer Download: Blob-URL → Anker-Klick → Blob-URL sofort freigeben.
 * Die Datei landet dort, wo der Browser Downloads ablegt (Nutzerentscheidung).
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Der Klick hat den Download bereits übernommen; die URL nicht länger halten.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Speichert einen Blob als Datei – mit Nutzerwahl über die File System Access
 * API, sonst als Download. Abbruch im Dialog ist kein Fehler (`cancelled`).
 */
export async function saveBlobToUserFile(blob: Blob, fileName: string, type?: UserFileType): Promise<UserSaveResult> {
  const w = fsWindow();
  if (w?.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: fileName, ...(type ? { types: [type] } : {}) });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return 'saved';
    } catch (e) {
      if (isAbort(e)) return 'cancelled';
      // Dialog nicht nutzbar (z. B. Iframe/Policy) → klassischer Download.
    }
  }
  downloadBlob(blob, fileName);
  return 'downloaded';
}

/** Text (z. B. Preset-JSON) als Datei speichern. */
export function saveTextToUserFile(text: string, fileName: string, type?: UserFileType): Promise<UserSaveResult> {
  const mime = type ? Object.keys(type.accept)[0] ?? 'application/json' : 'application/json';
  return saveBlobToUserFile(new Blob([text], { type: mime }), fileName, type);
}

/** Datei-Auswahl über ein verstecktes `<input type=file>` (Fallback). */
function pickViaInput(type?: UserFileType): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (type) input.accept = [...Object.keys(type.accept), ...Object.values(type.accept).flat()].join(',');
    input.style.display = 'none';
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Lässt den Nutzer eine Datei wählen und liefert ihren Text. `null` = Abbruch.
 * Gelesen wird nur die gewählte Datei; nichts wird im Browser abgelegt.
 */
export async function pickUserTextFile(type?: UserFileType): Promise<{ name: string; text: string } | null> {
  const w = fsWindow();
  let file: File | null = null;
  if (w?.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({ multiple: false, ...(type ? { types: [type] } : {}) });
      file = handle ? await handle.getFile() : null;
    } catch (e) {
      if (isAbort(e)) return null;
      file = await pickViaInput(type);
    }
  } else {
    file = await pickViaInput(type);
  }
  if (!file) return null;
  return { name: file.name, text: await file.text() };
}

export const PRESET_FILE_TYPE: UserFileType = {
  description: 'audioMONASTRY-Preset',
  accept: { 'application/json': ['.json'] },
};

export const WAV_FILE_TYPE: UserFileType = {
  description: 'WAV-Audio',
  accept: { 'audio/wav': ['.wav'] },
};
