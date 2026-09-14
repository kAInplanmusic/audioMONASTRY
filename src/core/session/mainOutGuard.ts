/**
 * audioMONASTRY · Main-Out-Guard (P0-1, revidiert 2026-09-13)
 * ================================================================
 * Reine, dependency-freie Regeln für den Schutz des Main-Sound-Out.
 *
 * Grundsatz (Betreiber-Entscheidung, revidiert):
 *   - Es gibt KEINEN Admin und KEINEN Superuser.
 *   - 4 gleichberechtigte Session-User + 2 Listener-URLs (master-out=Ton,
 *     visual-out=Visuals).
 *   - mixerMONK ist der DJ/Mischer/Main-Player. NUR der Halter (Lock-Owner)
 *     des mixerMONK-Plugins hat direkten Einfluss auf den Main-Sound-Out:
 *     Start, Stop, BPM, Fades, Kanalzüge – ALLES.
 *   - produzierendeMONKS arbeiten dem mixerMONK zu (Vorbereitung).
 *   - soundengineeringMONKS verbessern den Ton NACH dem Mischpult.
 *   - masterplayerMONK ist reine Info/Visualisierung ohne Eingaben.
 *
 * `MAIN_OUT_USER_ID` (Env) ist nur ein expliziter Bootstrap-Pin, wenn noch
 * niemand den mixerMONK-Lock hält; im Betrieb gewinnt immer der Lock-Owner.
 */

/**
 * Plugin-IDs, deren Zustand/Parameter den Main-Sound-Out direkt beeinflussen.
 * `mixer`  = Mischpult/DJ/Main-Player (der einzige Mischer im System)
 * `master` = Mastering-Kette im Main-Signalweg
 */
export const MAIN_OUT_PLUGINS: ReadonlySet<string> = new Set<string>(['mixer', 'master']);

/** Ist das Plugin ein Main-Out-relevantes Plugin? */
export function isMainOutPlugin(pluginId: string): boolean {
  return MAIN_OUT_PLUGINS.has(pluginId);
}

/**
 * Darf dieser User den Main-Out steuern?
 *
 * REVIDIERT: Es gibt keinen Rollen-/Admin-Fallback mehr. Main-Out-Kontrolle
 * hat ausschließlich der `mainOutUserId` (der aktuelle mixerMONK-Lock-Owner,
 * serverseitig aufgelöst). Ohne Owner bleibt der Main-Out geschützt.
 */
export function canControlMainOut(userId: string, mainOutUserId?: string | null): boolean {
  return typeof mainOutUserId === 'string' && mainOutUserId.length > 0 && userId === mainOutUserId;
}

/**
 * Löst einen explizit gepinnten Owner auf (Bootstrap, solange kein Lock-Owner
 * existiert). Nur Session-Mitglieder kommen infrage; ohne Pin ''.
 *
 * `roles` ist ein Iterable von `[userId, role]`-Paaren (Map oder Array).
 */
export function resolveMainOutUserId(
  mainOutUserId: string | null | undefined,
  roles: Iterable<readonly [string, string]>,
): string {
  const userIds = new Set<string>();
  for (const [uid] of roles) {
    if (typeof uid === 'string' && uid.length > 0) userIds.add(uid);
  }
  const configured = typeof mainOutUserId === 'string' ? mainOutUserId.trim() : '';
  return configured && userIds.has(configured) ? configured : '';
}

/** Payload-Schema (semantisch) für `main-out-update`-Events. */
export interface MainOutUpdate {
  /** z. B. `masterVolume`, `channelGain`, `fadeInSeconds`, `bpm`. */
  param: string;
  /** JSON-kompatibler Wert (number|string|boolean|null). */
  value: number | string | boolean | null;
}

/** Validiert einen rohen main-out-update Payload. Gibt `null` bei ungültig zurück. */
export function parseMainOutUpdate(data: unknown): MainOutUpdate | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const param = typeof obj.param === 'string' ? obj.param.trim() : '';
  if (!param || param.length > 64 || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(param)) return null;
  const value = obj.value;
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return { param, value: value as string | number | boolean | null };
  }
  return null;
}
