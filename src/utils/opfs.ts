// ============================================================================
// biblioMONK – ehemaliger OPFS-Cache
// ----------------------------------------------------------------------------
// Betreiber 2026-10-06: „NICHTS wird auf den Geräten der Nutzer gespeichert.
// Keine Sounds, keine Audio, nichts." Audio liegt nur noch auf dem Server
// (Upload/Bibliothek). Dieses Modul schreibt nichts mehr; `purgeDeviceFiles`
// löscht beim Start, was frühere Versionen im Gerät abgelegt haben.
// ============================================================================

/** Löscht alle Dateien im privaten Dateisystem dieser Seite (OPFS). */
export async function purgeDeviceFiles(): Promise<number> {
  try {
    if (typeof navigator === 'undefined') return 0;
    const nav = navigator as Navigator & { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } };
    if (!nav.storage?.getDirectory) return 0;
    const root = await nav.storage.getDirectory();
    const names: string[] = [];
    // @ts-expect-error entries ist im Standard-Typ mal nicht enthalten.
    for await (const [name] of root.entries()) names.push(name);
    await Promise.all(names.map((n) => root.removeEntry(n, { recursive: true }).catch(() => undefined)));
    return names.length;
  } catch {
    return 0;
  }
}
