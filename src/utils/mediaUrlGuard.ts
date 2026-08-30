/**
 * audioMONASTRY – Media-URL-Guard (F4-Fix)
 * ========================================
 * Peer-/Cloud-gesteuerte URLs dürfen NUR auf vertrauenswürdige Ziele zeigen,
 * bevor sie in `fetch(...)` oder `new Audio(...)` fließen. Verhindert, dass
 * ein Peer alle Clients zu beliebigen URLs „beaconen" lassen kann.
 */

const TRUSTED_HOST_SUFFIXES = [
  'anunnakitools.de',
  '.r2.cloudflarestorage.com',
  '.supabase.co',
];

/** Prüft, ob eine URL für Medien-/Fetch-Zugriffe erlaubt ist. */
export function isTrustedMediaUrl(raw: unknown): boolean {
  const url = String(raw ?? '').trim();
  if (!url) return false;

  // Lokale Blob-/Data-URIs (vom eigenen Browser erzeugt) sind ok.
  if (url.startsWith('blob:') || url.startsWith('data:')) return true;

  // Relative Pfade (gleiche Origin) sind ok – aber keine Protokoll-relativen.
  if (url.startsWith('/') && !url.startsWith('//')) return true;

  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const u = new URL(url, base);
    if (typeof window !== 'undefined' && u.origin === window.location.origin) return true;
    const host = u.hostname.toLowerCase();
    return TRUSTED_HOST_SUFFIXES.some((s) =>
      s.startsWith('.') ? host.endsWith(s) : host === s,
    );
  } catch {
    return false;
  }
}
