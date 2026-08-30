/**
 * cloudConfig – zentrale Cloud-Konfiguration (Supabase + Cloudflare R2)
 * ---------------------------------------------------------------------
 * Liest die Anbindungswerte aus den VITE-Umgebungsvariablen. Alle Zugriffe
 * sind robust: Bei fehlenden/leeren Werten wird `null` zurückgegeben und die
 * App fällt auf die eingebauten, lokalen Presets/Daten zurück (voller
 * Offline-/Cloud-freier Betrieb bleibt erhalten).
 *
 * ACHTUNG (Sicherheit):
 * - Hier landen ausschließlich PUBLISHABLE/ANON-Werte (für den Browser).
 * - Service-Role-/Secret-Keys gehören NUR in Server-module (server/*), nie
 *   in dieses Client-Modul.
 */

const env: Record<string, string | undefined> =
  (typeof import.meta !== 'undefined' ? (import.meta.env as Record<string, string | undefined>) : {});

/** Trimmt einen Env-Wert; liefert `null` bei leer/fehlend. */
const nonEmpty = (v: string | undefined): string | null => {
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

/** Wie nonEmpty, prüft zusätzlich auf gültige http(s)-URL. */
const nonEmptyUrl = (v: string | undefined): string | null => {
  const t = nonEmpty(v);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'https:' || u.protocol === 'http:' ? t : null;
  } catch {
    return null;
  }
};

/** Supabase-Projekt-URL (z.B. https://xxx.supabase.co). */
export const SUPABASE_URL: string | null = nonEmptyUrl(env.VITE_SUPABASE_URL);
/** Supabase für den Browser berechtigter (publishable/anon) Key. */
export const SUPABASE_ANON_PUB: string | null = nonEmpty(env.VITE_SUPABASE_ANON_PUB);

/** Observability: sind die externen Dienste für den Client konfiguriert? */
export const cloudEnabled = !!(SUPABASE_URL && SUPABASE_ANON_PUB);

// --- Cloudflare R2 (öffentliche Read-URL, falls der Bucket Public-Read ist) ---
// Objekt-Pfad-Muster für R2-gehostete Assets.
export const r2PublicBaseUrl = (() => {
  const acct = nonEmpty(env.VITE_CFR2_ACCOUNT_ID);
  const bucket = nonEmpty(env.VITE_CFR2_BUCKET);
  if (acct && bucket) {
    return `https://${bucket}.${acct}.r2.cloudflarestorage.com`;
  }
  return null;
})();
