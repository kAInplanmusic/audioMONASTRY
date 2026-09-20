/**
 * audioMONASTRY · Master-Proxy-Payload: Grenzen, Messwerte, Klartext-Fehler (FIX F3)
 * ==================================================================================
 * Befund 2026-09-20 (externer Hetzner-Test): `POST /api/master/mix` scheiterte mit
 * „Payload zu gross (max 256 kB)", sobald eine Spur realistisch lang war (2 Spuren
 * à 1 s 48-kHz-Stereo-WAV ≈ 260 kB Base64-JSON). Ursache war das globale
 * `JsonObjectBodySchema` (262.144 B) im Proxy – der Dienst selbst erlaubt 64 MB,
 * 8 Spuren und 120 s je Spur (`services/master-player/server.py`).
 *
 * Dieses Modul ist die EINE Quelle für die Master-Grenzen und ihre Begründung:
 *
 *   * Es ist frei von Node-/Express-/DOM-Abhängigkeiten und läuft deshalb auf
 *     beiden Seiten. Der Server benutzt die vollständige Prüfung (mit
 *     WAV-Header-Auswertung, siehe `server/masterPayload.ts`), der Client
 *     dieselbe Funktion als VORPRÜFUNG vor dem Upload – so können die Zahlen im
 *     Fehlertext nicht auseinanderlaufen.
 *   * Die Fehlerantwort trägt bewusst NUR Größen und Zählwerte (Bytes, Spurenzahl,
 *     Dauer) – niemals Audio-/Base64-Inhalte. Damit landen Nutzdaten weder in
 *     Logs noch in Telemetrie oder Fehlermeldungen.
 *
 * Warum JSON mit Base64 und keine Binär-/Chunk-Übertragung (die zweite Option aus
 * dem Fixplan)? Der master-player erwartet sein Wire-Format fertig (`tracks[].data`
 * als Base64-String, `body.data` für /master und /analyze). Ein Binärweg hieße:
 * neuen Endpunkt in `server.py` entwerfen, Client umbauen, Serie/Parallel-Mischen
 * über mehrere Requests aufteilen – dreimal mehr Fläche für denselben Nutzen.
 * Der Deckel war nie die Übertragung (Caddy erlaubt 120 MB, der Dienst 64 MB),
 * sondern ausschließlich die 256-kB-Hülle im Proxy. Deshalb: eigene Grenze für
 * genau diese drei Routen statt neues Format (Entscheidung dokumentiert im
 * Abschlussbericht zu F3).
 */

/** Grenzen des master-player-Dienstes (Spiegel von services/master-player/server.py). */
export interface MasterPayloadLimits {
  /** Max. Größe des JSON-Bodys in Bytes (entspricht MAX_INPUT_BYTES im Dienst). */
  maxBytes: number;
  /** Max. Anzahl Spuren (MAX_TRACKS). */
  maxTracks: number;
  /** Max. Dauer je Spur in Sekunden (MAX_DURATION_SEC). */
  maxSecondsPerTrack: number;
}

/**
 * Verbindliche Grenzen für `/api/master/mix|master|analyze`.
 * Ändert sich hier etwas, muss `services/master-player/server.py` mitziehen –
 * `tests/masterPayloadLimits.test.ts` liest die Python-Konstanten und schlägt
 * bei Abweichung fehl (Drift-Wächter statt Kommentar).
 */
export const MASTER_PAYLOAD_LIMITS: MasterPayloadLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxTracks: 8,
  maxSecondsPerTrack: 120,
};

export type MasterPayloadViolationCode = 'payload_too_large' | 'too_many_tracks' | 'track_too_long';

/** Messwerte, die Aufrufer liefern (Server: exakt aus dem Body, Client: über denselben Weg). */
export interface MasterPayloadFacts {
  /** Länge des serialisierten JSON-Bodys in Zeichen (= Bytes bei ASCII-Base64). */
  bytes: number;
  /** Anzahl Spuren; `null`/weggelassen = unbekannt (z. B. Content-Length-Vorprüfung). */
  tracks?: number | null;
  /** Längste Spur in Sekunden; `null` = nicht bestimmbar (Nicht-WAV ohne Decode). */
  longestTrackSeconds?: number | null;
}

/** Ist-Werte, wie sie in Antwort und Logzeile stehen (nur Zahlen, keine Nutzdaten). */
export interface MasterPayloadActual {
  bytes: number;
  tracks: number | null;
  longestTrackSeconds: number | null;
}

export interface MasterPayloadViolation {
  /** 413 für Überschreitung der Gesamtgröße, 400 für Spurzahl/Dauer (= Dienst-Verhalten). */
  status: 413 | 400;
  code: MasterPayloadViolationCode;
  /** Deutscher Klartext MIT Zahlen – genau das, was der Nutzer im Terminal sieht. */
  message: string;
  limits: MasterPayloadLimits;
  actual: MasterPayloadActual;
}

/** Antwortform der 413/400-Antwort des Proxys (Struktur, damit die UI Zahlen zeigen kann). */
export interface MasterViolationResponse {
  status: 'error';
  error: MasterPayloadViolationCode;
  message: string;
  limits: MasterPayloadLimits;
  actual: MasterPayloadActual;
}

/** Zahl mit deutschem Dezimalkomma, ohne überflüssige Null (64 -> „64", 5.25 -> „5,3"). */
export function formatNumberDe(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '?';
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  const text = rounded.toFixed(digits);
  const trimmed = digits > 0 ? text.replace(/\.?0+$/, '') : text;
  return (trimmed === '' ? '0' : trimmed).replace('.', ',');
}

/** Bytes als deutsche Größe („64 MB", „5,3 MB", „256 kB"). */
export function formatBytesDe(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 kB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${formatNumberDe(mb, 1)} MB`;
  return `${formatNumberDe(bytes / 1024, 1)} kB`;
}

/**
 * Die Audio-Träger eines Master-Bodys: entweder `tracks[]` (Mix) oder ein
 * einzelnes `data`-Feld (Mastering/Analyse). Eine Definition für beide Seiten –
 * Server (Dauerprüfung) und Client (Vorprüfung) zählen damit identisch.
 */
export function masterTrackEntries(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.tracks)) return record.tracks;
  if (typeof record.data === 'string') return [record];
  return [];
}

/**
 * Prüft die Messwerte gegen die Grenzen. `null` = alles im Rahmen.
 * Reihenfolge: Größe, dann Spurzahl, dann Dauer. Die Größe zuerst, weil sie die
 * teuerste Ursache ist (der Body liegt dann schon im Speicher).
 */
export function describeMasterPayloadViolation(
  facts: MasterPayloadFacts,
  limits: MasterPayloadLimits = MASTER_PAYLOAD_LIMITS,
): MasterPayloadViolation | null {
  const actual: MasterPayloadActual = {
    bytes: Number.isFinite(facts.bytes) ? Math.max(0, Math.round(facts.bytes)) : 0,
    tracks: facts.tracks === undefined || facts.tracks === null || !Number.isFinite(facts.tracks)
      ? null
      : Math.max(0, Math.round(facts.tracks)),
    longestTrackSeconds: facts.longestTrackSeconds === undefined
      || facts.longestTrackSeconds === null
      || !Number.isFinite(facts.longestTrackSeconds)
      ? null
      : facts.longestTrackSeconds,
  };

  const sizeLine = `Gesamtgröße ${formatBytesDe(actual.bytes)}, erlaubt ${formatBytesDe(limits.maxBytes)}`;
  const trackLine = actual.tracks === null
    ? null
    : `${actual.tracks} ${actual.tracks === 1 ? 'Spur' : 'Spuren'}, erlaubt ${limits.maxTracks}`;
  const withTracks = (text: string) => `${text}${trackLine ? `; ${trackLine}` : ''}.`;

  if (actual.bytes > limits.maxBytes) {
    return {
      status: 413,
      code: 'payload_too_large',
      message: withTracks(`Payload zu gross: ${sizeLine}`),
      limits,
      actual,
    };
  }
  if (trackLine && actual.tracks !== null && actual.tracks > limits.maxTracks) {
    return {
      status: 400,
      code: 'too_many_tracks',
      message: `Zu viele Spuren: ${trackLine}; ${sizeLine}.`,
      limits,
      actual,
    };
  }
  if (actual.longestTrackSeconds !== null && actual.longestTrackSeconds > limits.maxSecondsPerTrack) {
    return {
      status: 400,
      code: 'track_too_long',
      message: withTracks(
        `Spur zu lang: ${formatNumberDe(actual.longestTrackSeconds, 1)} s, erlaubt ${limits.maxSecondsPerTrack} s pro Spur`,
      ),
      limits,
      actual,
    };
  }
  return null;
}

/** Antwortkörper für eine Verletzung – enthält ausschließlich Zahlen, keine Nutzdaten. */
export function masterViolationResponse(violation: MasterPayloadViolation): MasterViolationResponse {
  return {
    status: 'error',
    error: violation.code,
    message: violation.message,
    limits: violation.limits,
    actual: violation.actual,
  };
}

/** Grenzen als Einzeiler für die UI („64 MB JSON · 8 Spuren · 120 s je Spur"). */
export function masterLimitsHint(limits: MasterPayloadLimits = MASTER_PAYLOAD_LIMITS): string {
  return `${formatBytesDe(limits.maxBytes)} JSON · ${limits.maxTracks} Spuren · ${limits.maxSecondsPerTrack} s je Spur`;
}

/**
 * Macht aus einer Fehlerantwort des Proxys einen Satz, der die Grenze UND den
 * Ist-Wert nennt. Drei Fälle:
 *   1. eigene Guard-Antwort (message + limits/actual) -> Meldung wortgleich übernehmen,
 *   2. Body-Parser-Antwort (413 `{error, cause}`, ohne Zahlen) -> Klartext + Grenzen,
 *   3. alles andere (Proxy/Caddy-HTML, Zeitüberschreitung) -> HTTP-Status + Grenzen.
 */
export function describeMasterHttpError(
  status: number,
  body: unknown,
  limits: MasterPayloadLimits = MASTER_PAYLOAD_LIMITS,
): string {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  const error = typeof record.error === 'string' ? record.error.trim() : '';
  const cause = typeof record.cause === 'string' ? record.cause.trim() : '';

  const parts: string[] = [];
  if (message) {
    parts.push(message);
  } else if (status === 413) {
    parts.push(`Upload zu gross – der Server hat den Body abgewiesen (HTTP 413${error ? `, ${error}` : ''}).`);
  } else if (error) {
    parts.push(`Master-Service antwortete mit HTTP ${status} (${error}).`);
  } else {
    parts.push(`Master-Service antwortete mit HTTP ${status}.`);
  }
  if (!message && cause) parts.push(`Ursache: ${cause}`);

  // Zahlen nur ergänzen, wenn die Meldung sie nicht schon selbst nennt.
  if (!/erlaubt/.test(parts.join(' ')) && (status === 413 || status === 400)) {
    parts.push(`Grenzen: ${masterLimitsHint(limits)}`);
  }
  return parts.join(' ');
}
