// ============================================================================
// biblioMONK – OPFS (Origin Private File System) Cache
// ----------------------------------------------------------------------------
// Hochperformantes Sample-Caching ohne Browser-Speicherlimit. OPFS erlaubt
// direkten, schreib-optimierten Dateizugriff. Hier kapseln wir:
//  - persistFile(name, blob)  → in OPFS schreiben
//  - readFile(name)           → als Blob/URL lesen
//  - list(), remove()
// ============================================================================

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (typeof navigator === 'undefined' || !('storage' in navigator)) {
    throw new Error('OPFS nicht verfügbar (Feature-Detect).');
  }
  const nav = navigator as Navigator & { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } };
  if (!nav.storage?.getDirectory) throw new Error('OPFS.getDirectory() nicht verfügbar.');
  return nav.storage.getDirectory();
}

const OPFS_DIR = 'samples';

async function ensureSampleDir(root: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> {
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

/** Speichert eine Datei als Blob im OPFS unter `samples/`. */
export async function persistFile(name: string, blob: Blob): Promise<boolean> {
  try {
    const root = await getRoot();
    const dir = await ensureSampleDir(root);
    const handle = await dir.getFileHandle(sanitize(name), { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (e) {
    console.warn('OPFS persist fehlgeschlagen:', (e as Error).message);
    return false;
  }
}

/** Liest eine Datei aus OPFS und liefert eine Object-URL (oder null). */
export async function readFile(name: string): Promise<string | null> {
  try {
    const root = await getRoot();
    const dir = await ensureSampleDir(root);
    const handle = await dir.getFileHandle(sanitize(name));
    const file = await handle.getFile();
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

/** Gibt eine Liste aller gecachten Sample-Namen zurück. */
export async function listSamples(): Promise<string[]> {
  try {
    const root = await getRoot();
    const dir = await ensureSampleDir(root);
    const out: string[] = [];
    // @ts-expect-error entries ist im Standard-Typ mal nicht enthalten.
    for await (const [name] of dir.entries()) out.push(name);
    return out;
  } catch { return []; }
}

/** Entfernt eine Sample-Datei aus OPFS. */
export async function removeSample(name: string): Promise<boolean> {
  try {
    const root = await getRoot();
    const dir = await ensureSampleDir(root);
    await dir.removeEntry(sanitize(name));
    return true;
  } catch { return false; }
}

function sanitize(name: string): string {
  // Entfernt gefährliche Pfad-Teile für OPFS.
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}
