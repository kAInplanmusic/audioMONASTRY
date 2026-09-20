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

/**
 * mixerMONK ist die EINZIGE Main-Einspeisung und darf nie geschlossen werden:
 * ein OFF trennt die Signalkette und stoppt Main UND Clock
 * (`pluginAudioRouter.deactivatePlugin`: `if (id === 'mixer') stopMainAndClock()`).
 *
 * Betreiberregel 2026-09-17: „die anderen spielen zu, mixerMONK entscheidet".
 * Die anderen 15 Module starten weiterhin OFF (P0-1), mixerMONK startet aktiv.
 */
export const MIXER_NEVER_CLOSES = 'mixer';

/** Ergebnis einer Zustandspruefung fuer ein Modul (rein, ohne Seiteneffekte). */
export interface ModuleStateDecision {
  allowed: boolean;
  /** Grund der Ablehnung - fuer Konsole UND Nutzer-Oberflaeche. */
  reason?: string;
}

/**
 * Darf `id` in den Zustand `state` gebracht werden?
 *
 * Zwei Regeln, beide aus dem Main-Out-Schutz:
 *  1. mixerMONK laesst sich nie schliessen (OFF) - es ist die Main-Einspeisung.
 *  2. mixer/master darf nur der Main-Out-Halter schalten (sonst kein falsches
 *     Feedback einer nicht-autoritativen Aenderung).
 */
export function canSetModuleState(
  id: string,
  state: string,
  options: { isMainOutOwner: boolean },
): ModuleStateDecision {
  if (id === MIXER_NEVER_CLOSES && state === 'OFF') {
    return {
      allowed: false,
      reason: 'mixerMONK entscheidet den Main-Out und laesst sich nicht schliessen (OFF wuerde Main und Clock stoppen)',
    };
  }
  if (isMainOutPlugin(id) && !options.isMainOutOwner) {
    return {
      allowed: false,
      reason: 'Nur der Halter (Main-Out) darf dieses Modul schalten',
    };
  }
  return { allowed: true };
}

/** Payload-Schema (semantisch) für `main-out-update`-Events. */
export interface MainOutUpdate {
  /** z. B. `masterVolume`, `channelGain`, `fadeInSeconds`, `bpm`. */
  param: string;
  /** JSON-kompatibler Wert (number|string|boolean|null). */
  value: number | string | boolean | null;
}

/**
 * COLLAB-P1-005: erlaubte Main-Out-Parameter mit Wertebereich.
 *
 * Der Main-Out-Pfad lief bisher am Server vorbei (Mixer-/Master-Terminal
 * schrieben direkt in die AudioEngine). Damit der Server ihn inspizieren kann,
 * braucht er eine Allow-List mit Bereichen - ein unbekannter Parameter oder ein
 * Wert ausserhalb des Bereichs wird abgelehnt, statt blind an alle Peers
 * weitergereicht zu werden.
 *
 *   masterVolume    linearer Mixer-Level (0..2; 1 = neutral) - mixerMONK "LEVEL"
 *   masterVolumeDb  Main-Out-Pegel in dB (-48..12) - masteringMONK
 *   fadeInSeconds   Fade-In-Zeit des Main-Out (0..30 s)
 */
export const MAIN_OUT_PARAM_SPECS = {
  masterVolume: { min: 0, max: 2, kind: 'number' },
  masterVolumeDb: { min: -48, max: 12, kind: 'number' },
  fadeInSeconds: { min: 0, max: 30, kind: 'number' },
} as const;

type MainOutParamName = keyof typeof MAIN_OUT_PARAM_SPECS;

type MainOutRejectReason = 'invalid-payload' | 'unknown-param' | 'value-out-of-range';

export type MainOutPayloadResult =
  | { ok: true; param: MainOutParamName; value: number }
  | { ok: false; reason: MainOutRejectReason };

/**
 * Prueft einen `main-out-update`-Payload gegen die Allow-List und die Bereiche.
 *
 * Die BERECHTIGUNG bleibt bewusst bei `canControlMainOut` (nur der Halter) -
 * diese Funktion ergaenzt genau das, was vorher fehlte: ein formal gueltiger
 * Payload mit unbekanntem Namen (`bpm`) oder einem Wert ausserhalb des Bereichs
 * (`masterVolumeDb = 99`) wurde ungeprueft an alle Peers gespiegelt und dort
 * blind auf den Main-Out angewandt.
 */
export function validateMainOutPayload(data: unknown): MainOutPayloadResult {
  const parsed = parseMainOutUpdate(data);
  if (!parsed) return { ok: false, reason: 'invalid-payload' };

  const spec = (MAIN_OUT_PARAM_SPECS as Record<string, { min: number; max: number }>)[parsed.param];
  if (!spec) return { ok: false, reason: 'unknown-param' };
  if (typeof parsed.value !== 'number' || !Number.isFinite(parsed.value)) {
    return { ok: false, reason: 'value-out-of-range' };
  }
  if (parsed.value < spec.min || parsed.value > spec.max) {
    return { ok: false, reason: 'value-out-of-range' };
  }
  return { ok: true, param: parsed.param as MainOutParamName, value: parsed.value };
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
