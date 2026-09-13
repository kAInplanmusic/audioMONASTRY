/**
 * audioMONASTRY · Supabase-Schlüssel: EINE Prioritätsordnung für alle Aufrufer
 * ===========================================================================
 * Warum dieses Modul existiert (live gemessen 2026-09-11):
 *
 * An vier Stellen im Code stand
 *   `process.env.SUPABASE_LEGACY_PAT ?? process.env.SUPABASE_SERVICE_ROLE`
 * — und `??` greift **nur** bei `null`/`undefined`. Ein vorhandener, aber
 * **abgelaufener** Legacy-Key gewann also gegen den gültigen Service-Role-Key:
 * Supabase antwortete „JWT failed verification", alle Schreibpfade liefen still
 * ins Leere (kein Fehler, nur No-Ops) und `server.ts` hielt Supabase für
 * konfiguriert, obwohl kein einziger Aufruf funktionierte.
 *
 * Deshalb hier **eine** Prioritätsordnung, die überall gilt, plus eine
 * Formatprüfung — analog zu `validSupabaseKey()` in `server/cloud.ts`, das
 * bisher als einzige Stelle validiert hat.
 *
 * Namensschema seit 2026-09-13 (Betreiber-Entscheidung): das Supabase-Prefix
 * ist `SB_` (SB_URL, SB_SERVICE_ROLE, SB_SECRET, SB_PAT, SB_ANON_PUB,
 * SB_PUBLISHABLE). Die alten `SUPABASE_*`-Namen bleiben als Fallback lesbar,
 * damit bestehende Deployments nicht brechen; neue Namen gewinnen.
 *
 *   SB_SERVICE_ROLE → SB_SECRET → SB_PAT → SUPABASE_SERVICE_ROLE → …
 *
 * Der Service-Role-Key (Legacy-JWT) und `SB_SECRET` (neues
 * `sb_secret_…`-Format) sind die **richtigen** Server-Schlüssel; der
 * Legacy-PAT steht bewusst zuletzt, damit er nie einen gültigen Key verdeckt.
 *
 * Bewusst rein (kein Netz, kein Supabase-Client) und damit testbar.
 */

/** Reihenfolge, in der Server-Schlüssel gelesen werden. */
export const SUPABASE_SERVER_KEY_ORDER = [
  'SB_SERVICE_ROLE',
  'SB_SECRET',
  'SB_PAT',
  'SUPABASE_SERVICE_ROLE',
  'SUPABASE_SERVICE_ROLE_JWT',
  'SUPABASE_SECRET',
  'SUPABASE_LEGACY_PAT',
] as const;

export type SupabaseServerKeyName = (typeof SUPABASE_SERVER_KEY_ORDER)[number];

/** Anon-/publishable-Schlüssel, in dieser Reihenfolge. */
export const SUPABASE_PUBLIC_KEY_ORDER = ['SB_ANON_PUB', 'SB_PUBLISHABLE', 'SUPABASE_ANON_PUB', 'SUPABASE_PUBLISHABLE'] as const;

type Env = Record<string, string | undefined>;

/** Supabase-Projekt-URL: `SB_URL` (neu) vor `SUPABASE_URL` (Legacy). */
export function supabaseUrl(env: Env = process.env as Env): string {
  return (env.SB_URL ?? env.SUPABASE_URL ?? '').trim();
}

/**
 * Formprüfung. Bewusst tolerant, aber ohne Platzhalter:
 * - leer / `…placeholder` → ungültig
 * - `sb_publishable_…` / `sb_secret_…` → mindestens 40 Zeichen
 * - Legacy-JWT (`eyJ…`) → 3 Segmente, mindestens 80 Zeichen
 * - alles andere → mindestens 32 Zeichen
 */
export function isValidSupabaseKey(key: string | undefined | null): boolean {
  const k = (key ?? '').trim();
  if (!k || k.includes('.placeholder')) return false;
  if (k.startsWith('sb_publishable_') || k.startsWith('sb_secret_')) return k.length >= 40;
  if (k.startsWith('eyJ')) {
    const parts = k.split('.');
    return parts.length === 3 && k.length >= 80;
  }
  return k.length >= 32;
}

export interface PickedSupabaseKey {
  key: string;
  /** Variablenname, der gewonnen hat – für Logs/Diagnose (kein Wert). */
  source: SupabaseServerKeyName;
  /** Namen, die gesetzt, aber ungültig waren (Diagnose). */
  rejected: SupabaseServerKeyName[];
}

/** Erster gültiger Schlüssel nach Prioritätsordnung – oder `null`. */
export function pickSupabaseServerKey(
  env: Env = process.env as Env,
  order: readonly SupabaseServerKeyName[] = SUPABASE_SERVER_KEY_ORDER,
): PickedSupabaseKey | null {
  const rejected: SupabaseServerKeyName[] = [];
  for (const name of order) {
    const raw = (env[name] ?? '').trim();
    if (!raw) continue;
    if (isValidSupabaseKey(raw)) return { key: raw, source: name, rejected };
    rejected.push(name);
  }
  return null;
}

/** Server-Schlüssel oder `''` (Aufrufer prüfen auf Leerstring wie bisher). */
export function supabaseServerKey(env: Env = process.env as Env): string {
  return pickSupabaseServerKey(env)?.key ?? '';
}

/**
 * Name der Quelle des Server-Schlüssels (oder `null`) – für Diagnose-Ausgaben,
 * z. B. „supabase: ok (service_role)“. Gibt nie den Wert zurück.
 */
export function supabaseServerKeySource(env: Env = process.env as Env): SupabaseServerKeyName | null {
  return pickSupabaseServerKey(env)?.source ?? null;
}

const SERVER_KEY_LABELS: Partial<Record<SupabaseServerKeyName, string>> = {
  SB_SERVICE_ROLE: 'service_role',
  SB_SECRET: 'secret (sb_secret_)',
  SB_PAT: 'pat (sbp_)',
  SUPABASE_SERVICE_ROLE: 'service_role',
  SUPABASE_SERVICE_ROLE_JWT: 'service_role_jwt',
  SUPABASE_SECRET: 'secret (sb_secret_)',
  SUPABASE_LEGACY_PAT: 'legacy_pat',
};

/** Kurzbericht für Health-Ausgaben: „service_role" | „secret (sb_secret_)" | „none". */
export function supabaseServerKeyLabel(env: Env = process.env as Env): string {
  const picked = pickSupabaseServerKey(env);
  if (!picked) return 'none';
  return SERVER_KEY_LABELS[picked.source] ?? picked.source.toLowerCase();
}

/** Erster gültiger öffentlicher Schlüssel (anon/publishable). */
export function supabasePublicKey(env: Env = process.env as Env): string {
  for (const name of SUPABASE_PUBLIC_KEY_ORDER) {
    const raw = (env[name] ?? '').trim();
    if (isValidSupabaseKey(raw)) return raw;
  }
  return '';
}
