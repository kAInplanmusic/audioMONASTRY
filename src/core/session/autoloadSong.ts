/**
 * audioMONASTRY – Autoload-Lied für Kanal 1 (mixerMONK)
 * ----------------------------------------------------
 * Ein Lied, das beim Start des Studios automatisch auf Kanal 1 des Mixers
 * liegt und anläuft, sobald der Browser nach der ersten Nutzergeste Audio
 * erlaubt (Autoplay-Sperre). Gespeichert wird nur die *Absicht* – nicht der
 * Transportzustand: Wer den Mixer hat, entscheidet, ob gespielt wird.
 *
 * Bewusst reine Speicher-/Validierungslogik ohne Engine- oder React-Bezug,
 * damit sie ohne Browser-Kontext prüfbar bleibt.
 */

/** Ein Eintrag, eine Wahrheit: der Schlüssel steht nirgends sonst als Literal. */
export const AUTOLOAD_STORAGE_KEY = 'audiomonastry_autoload_channel1';

/** Die Felder, die zum Wiederfinden in der Bibliothek und zum Anzeigen genügen. */
export interface AutoloadSong {
  /** Web-Pfad unter /public, z. B. "/music/Len Faki - Death by House.mp3" */
  url: string;
  /** Anzeigename wie in der Bibliothek („Interpret - Titel“). */
  name: string;
  artist: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Prüft eine beliebige Nutzlast aus dem Speicher auf Verträglichkeit.
 * Unbekannte/fehlende Felder führen zu `null` – lieber kein Autoload als ein
 * Eintrag, der auf eine fehlende Datei zeigt.
 */
export function parseAutoloadSong(raw: unknown): AutoloadSong | null {
  if (!isRecord(raw)) return null;
  const { url, name, artist } = raw;
  if (typeof url !== 'string' || url.length === 0) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  return { url, name, artist: typeof artist === 'string' && artist.length > 0 ? artist : 'Unknown' };
}

/** Gespeichertes Autoload-Lied oder `null`. Wirft nie. */
export function loadAutoloadSong(): AutoloadSong | null {
  try {
    const raw = globalThis.localStorage?.getItem(AUTOLOAD_STORAGE_KEY);
    if (!raw) return null;
    return parseAutoloadSong(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Setzt (oder überschreibt) das Autoload-Lied. Ungültige Eingaben werden ignoriert. */
export function saveAutoloadSong(song: AutoloadSong): void {
  try {
    const clean = parseAutoloadSong(song);
    if (!clean) return;
    globalThis.localStorage?.setItem(AUTOLOAD_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    /* Speicher gesperrt oder voll – die Sitzung laeuft trotzdem weiter. */
  }
}

/** Entfernt das Autoload-Lied: beim naechsten Start laeuft nichts von allein. */
export function clearAutoloadSong(): void {
  try {
    globalThis.localStorage?.removeItem(AUTOLOAD_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
