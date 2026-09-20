/**
 * FIX F3 · Master-Payload: Grenzen, Klartext-Fehler, WAV-Dauer, Drift zur Dienst-Seite
 * ===================================================================================
 * Die Prüfung des Audio-Wegs besteht aus zwei Teilen, die hier getrennt belegt werden:
 *   * `src/types/masterPayload.ts` – Grenzen, Messwerte, Antwortform (läuft auch im Client),
 *   * `server/masterPayload.ts`     – Auswertung des echten Bodys (Base64-Länge, RIFF-Kopf).
 * Die HTTP-Grenzen selbst belegt `tests/masterRoutes.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MASTER_PAYLOAD_LIMITS,
  describeMasterHttpError,
  describeMasterPayloadViolation,
  formatBytesDe,
  formatNumberDe,
  masterLimitsHint,
  masterTrackEntries,
  masterViolationResponse,
} from '../src/types/masterPayload';
import {
  decodedBase64Bytes,
  inspectMasterPayload,
  stripDataUrlPrefix,
  wavDurationSeconds,
} from '../server/masterPayload';
import { wavBase64 } from './fixtures/masterAudio';

describe('FIX F3 · Master-Grenzen und Klartext-Fehler', () => {
  it('lässt Werte bis genau auf die Kante durch und meldet erst darüber', () => {
    const onEdge = describeMasterPayloadViolation({
      bytes: MASTER_PAYLOAD_LIMITS.maxBytes,
      tracks: MASTER_PAYLOAD_LIMITS.maxTracks,
      longestTrackSeconds: MASTER_PAYLOAD_LIMITS.maxSecondsPerTrack,
    });
    expect(onEdge).toBeNull();

    const overSize = describeMasterPayloadViolation({ bytes: MASTER_PAYLOAD_LIMITS.maxBytes + 1, tracks: 4 });
    expect(overSize?.code).toBe('payload_too_large');
    expect(overSize?.status).toBe(413);

    // Genau eine Spur über der Grenze bzw. eine Sekunde zu lang.
    expect(describeMasterPayloadViolation({ bytes: 1000, tracks: 9 })?.code).toBe('too_many_tracks');
    expect(describeMasterPayloadViolation({ bytes: 1000, tracks: 8, longestTrackSeconds: 120.001 })?.code)
      .toBe('track_too_long');
    expect(describeMasterPayloadViolation({ bytes: 1000, tracks: 8, longestTrackSeconds: 120 })).toBeNull();
  });

  it('nennt Größe, Grenze, Ist-Spurzahl und Soll-Spurzahl im Klartext', () => {
    const v = describeMasterPayloadViolation({ bytes: 70 * 1024 * 1024, tracks: 4 });
    expect(v?.message).toBe('Payload zu gross: Gesamtgröße 70 MB, erlaubt 64 MB; 4 Spuren, erlaubt 8.');
    expect(v?.actual).toEqual({ bytes: 70 * 1024 * 1024, tracks: 4, longestTrackSeconds: null });
    expect(v?.limits).toEqual(MASTER_PAYLOAD_LIMITS);

    const many = describeMasterPayloadViolation({ bytes: 5.3 * 1024 * 1024, tracks: 9 });
    expect(many?.message).toBe('Zu viele Spuren: 9 Spuren, erlaubt 8; Gesamtgröße 5,3 MB, erlaubt 64 MB.');
    expect(many?.status).toBe(400);

    const long = describeMasterPayloadViolation({ bytes: 1024, tracks: 1, longestTrackSeconds: 245 });
    expect(long?.message).toBe('Spur zu lang: 245 s, erlaubt 120 s pro Spur; 1 Spur, erlaubt 8.');
    expect(long?.status).toBe(400);
  });

  it('formatiert Größen/Zahlen deutsch und ohne überflüssige Nullen', () => {
    expect(formatBytesDe(64 * 1024 * 1024)).toBe('64 MB');
    expect(formatBytesDe(262_144)).toBe('256 kB');
    expect(formatBytesDe(Math.round(5.3 * 1024 * 1024))).toBe('5,3 MB');
    expect(formatBytesDe(0)).toBe('0 kB');
    expect(formatNumberDe(245.44, 1)).toBe('245,4');
    expect(formatNumberDe(30, 1)).toBe('30');
    expect(masterLimitsHint()).toBe('64 MB JSON · 8 Spuren · 120 s je Spur');
  });

  it('antwortet in der 413-Form mit status/error/message/limits/actual', () => {
    const v = describeMasterPayloadViolation({ bytes: MASTER_PAYLOAD_LIMITS.maxBytes + 1024, tracks: 2 });
    expect(v).not.toBeNull();
    const response = masterViolationResponse(v!);
    expect(Object.keys(response).sort()).toEqual(['actual', 'error', 'limits', 'message', 'status']);
    expect(response.status).toBe('error');
    expect(response.error).toBe('payload_too_large');
    expect(response.limits).toEqual({ maxBytes: 67_108_864, maxTracks: 8, maxSecondsPerTrack: 120 });
    expect(response.actual.bytes).toBe(MASTER_PAYLOAD_LIMITS.maxBytes + 1024);
    expect(response.actual.tracks).toBe(2);
    // Die Antwort ist JSON-serialisierbar und enthält nur Zahlen/Text.
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it('schreibt keine Nutzdaten in Antwort oder Logzeile (nur Zahlen)', () => {
    const marker = 'QUJDRAEINMALIGER-AUDIO-MARKER';
    const payload = { tracks: [{ data: marker.repeat(5000) }, { data: marker.repeat(5000) }] };
    const serialized = JSON.stringify(payload);
    const v = describeMasterPayloadViolation({ bytes: MASTER_PAYLOAD_LIMITS.maxBytes + serialized.length, tracks: 2 });
    const response = JSON.stringify(masterViolationResponse(v!));
    expect(response).not.toContain(marker);
    // Kein Feld trägt den Body nach: weder die Spurliste noch das data-Feld.
    expect(response).not.toContain('"data"');
    expect(v?.message).not.toContain(marker);
    // Auch der Klartext-Fehler trägt nur Zahlen.
    expect(describeMasterHttpError(413, masterViolationResponse(v!))).not.toContain(marker);
  });

  it('übersetzt Serverantworten in Sätze mit Grenze und Ist-Wert', () => {
    // 1) eigene Guard-Antwort: Wortlaut wird übernommen, kein doppeltes „Grenzen:".
    const guard = describeMasterHttpError(413, masterViolationResponse(describeMasterPayloadViolation({
      bytes: 70 * 1024 * 1024,
      tracks: 4,
    })!));
    expect(guard).toContain('Gesamtgröße 70 MB, erlaubt 64 MB');
    expect(guard.match(/Grenzen:/g)).toBeNull();

    // 2) Body-Parser-413 (ohne Zahlen) - Ursache wird genannt, Grenzen angehängt.
    const parser = describeMasterHttpError(413, { error: 'payload too large', cause: 'request entity too large' });
    expect(parser).toContain('HTTP 413');
    expect(parser).toContain('request entity too large');
    expect(parser).toContain('Grenzen: 64 MB JSON · 8 Spuren · 120 s je Spur');

    // 3) HTML/leere Antwort (Reverse-Proxy) - immer noch ein Satz mit Status.
    expect(describeMasterHttpError(413, null)).toContain('HTTP 413');
    expect(describeMasterHttpError(502, { status: 'error', message: 'master-player Proxy fehlgeschlagen: fetch failed' }))
      .toBe('master-player Proxy fehlgeschlagen: fetch failed');
  });

  it('findet die Spuren in beiden Body-Formen (Mix-Array und Einzel-Data)', () => {
    expect(masterTrackEntries({ tracks: [{ data: 'a' }, { data: 'b' }] })).toHaveLength(2);
    expect(masterTrackEntries({ data: 'a' })).toHaveLength(1);
    expect(masterTrackEntries({})).toHaveLength(0);
    expect(masterTrackEntries(null)).toHaveLength(0);
  });
});

describe('FIX F3 · Serverprüfung des echten Bodys', () => {
  it('rechnet die dekodierte Länge ohne zu dekodieren', () => {
    for (const bytes of [0, 1, 2, 3, 4, 1000, 192_044, 5_292_078]) {
      const b64 = Buffer.alloc(bytes, 7).toString('base64');
      expect(decodedBase64Bytes(b64)).toBe(bytes);
    }
    expect(stripDataUrlPrefix('data:audio/wav;base64,QUJD')).toBe('QUJD');
    expect(stripDataUrlPrefix('  QUJD  ')).toBe('QUJD');
  });

  it('liest die Spielzeit aus dem RIFF-Kopf', () => {
    // 1 s, 48 kHz, Stereo, 16 Bit (192 000 B Nutzdaten).
    expect(wavDurationSeconds(wavBase64({ sampleRate: 48_000, channels: 2, bits: 16, seconds: 1 }))).toBe(1);
    // 245 s bei 2 000 B/s - klein im Test, lang in der Spielzeit.
    expect(wavDurationSeconds(wavBase64({ sampleRate: 1000, channels: 1, bits: 16, seconds: 245 }))).toBe(245);
    // Lügender Header (data-Größe 10x größer als die Datei): die Dauer wird auf die
    // tatsächlich vorhandenen Bytes gekappt - eine gültige Spur darf nicht fliegen.
    const lying = wavBase64({ sampleRate: 1000, channels: 1, bits: 16, seconds: 1, declaredDataSize: 20_000 });
    expect(wavDurationSeconds(lying)).toBe(1);
    // Kopf ohne Nutzdaten -> keine Dauer.
    expect(wavDurationSeconds(wavBase64({ sampleRate: 1000, channels: 1, bits: 16, seconds: 0 }))).toBeNull();
    // Kein WAV -> keine erfundene Dauer.
    expect(wavDurationSeconds(Buffer.from('ID3\x04\0\0\0\0\0\0mp3', 'latin1').toString('base64'))).toBeNull();
    expect(wavDurationSeconds('')).toBeNull();
  });

  it('prüft 4 Spuren à 30 s (~30 MB Base64) durch und weist die Überhänge ab', () => {
    const trackB64 = wavBase64({ sampleRate: 48_000, channels: 2, bits: 16, seconds: 30 });
    // 4 × 30 s: die Größe wird als Messwert übergeben - genau das, was der Proxy
    // aus der serialisierten Zeichenkette berechnet (kein 30-MB-Blob im Test).
    const realistic = { tracks: [0, 1, 2, 3].map(() => ({ data: trackB64, gain: -6, pan: 0 })) };
    const bytes = trackB64.length * 4 + 200;
    // 4 × 30 s = 120 s Audio -> ~30 MB Base64-JSON (die Größe, an der die alte
    // 256-kB-Hülle gescheitert ist, laut Fixplan „realistische Größe").
    expect(bytes).toBeGreaterThan(30_000_000);
    expect(bytes).toBeLessThan(MASTER_PAYLOAD_LIMITS.maxBytes);
    expect(inspectMasterPayload(realistic, bytes)).toBeNull();

    // Dieselben Spuren, aber 8× -> weiterhin erlaubt (Grenze ist 8).
    expect(inspectMasterPayload({ tracks: [0, 1, 2, 3, 4, 5, 6, 7].map(() => ({ data: trackB64 })) }, bytes)).toBeNull();
    // 9 Spuren -> 400 mit Zahlen.
    const nine = inspectMasterPayload({ tracks: new Array(9).fill({ data: trackB64 }) }, bytes);
    expect(nine?.code).toBe('too_many_tracks');
    expect(nine?.message).toContain('9 Spuren, erlaubt 8');
    // Eine Spur von 245 s (klein gehalten) -> 400 mit Dauer.
    const longTrack = wavBase64({ sampleRate: 1000, channels: 1, bits: 16, seconds: 245 });
    const tooLong = inspectMasterPayload({ tracks: [{ data: longTrack }] }, longTrack.length);
    expect(tooLong?.code).toBe('track_too_long');
    expect(tooLong?.message).toContain('245 s, erlaubt 120 s pro Spur');
    // Mastering/Analyse (Einzel-Data) wird genauso geprüft.
    expect(inspectMasterPayload({ data: longTrack }, longTrack.length)?.code).toBe('track_too_long');
    expect(inspectMasterPayload({ data: trackB64 }, MASTER_PAYLOAD_LIMITS.maxBytes + 1)?.code).toBe('payload_too_large');
  });

  it('bleibt mit den Konstanten des master-player-Dienstes synchron', () => {
    const source = readFileSync(resolve(__dirname, '../services/master-player/server.py'), 'utf8');
    const pyInt = (name: string): number | null => {
      const match = new RegExp(`^\\s*${name}\\s*=\\s*([0-9*()\\s]+)`, 'm').exec(source);
      if (!match) return null;
      return match[1].split('*').reduce((acc, part) => acc * Number(part.trim()), 1);
    };
    // Die Python-Seite schreibt MAX_INPUT_BYTES als 64 * 1024 * 1024 - beide
    // Seiten müssen dieselben Zahlen nennen, sonst lügt die 413-Antwort.
    expect(pyInt('MAX_INPUT_BYTES')).toBe(MASTER_PAYLOAD_LIMITS.maxBytes);
    expect(pyInt('MAX_TRACKS')).toBe(MASTER_PAYLOAD_LIMITS.maxTracks);
    expect(pyInt('MAX_DURATION_SEC')).toBe(MASTER_PAYLOAD_LIMITS.maxSecondsPerTrack);
  });
});
