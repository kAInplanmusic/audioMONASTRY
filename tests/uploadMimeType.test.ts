/**
 * SEC-P2-004 / Angriff 5 - Polyglot-Auslieferung.
 *
 * LIVE BELEGT AM 2026-09-24 gegen die laufende Instanz:
 *   Datei:        harmlos.mp3  (Endung erfuellt die Whitelist)
 *   Inhalt:       <!doctype html>...<script>...</script>
 *   Content-Type: text/html (vom Client)
 *   Ergebnis:     HTTP 200, Content-Type: text/html, HTML-Rumpf unveraendert,
 *                 ohne X-Content-Type-Options (R2 setzt unseren Kopf nicht).
 *
 * Vorher wurde der Client-Wert unveraendert nach R2 geschrieben
 * (`uploadSampleToR2(objectKey, data, input.contentType || 'audio/wav')`).
 * Der Test unten prueft die Ableitung, die das ersetzt: der Typ kommt
 * ausschliesslich aus der Endung. Ohne diese Zusicherung wuerde der Fehler beim
 * naechsten Umbau der Route still zurueckkehren - genau die Klasse, die in
 * dieser Sitzung mehrfach Zeit gekostet hat.
 */
import { describe, expect, it } from 'vitest';
import { audioExtFromFilename, audioMimeForExt } from '../server/routes/uploadRoutes';

describe('audioMimeForExt (Angriff 5: Polyglot-Auslieferung)', () => {
  it('liefert fuer jede erlaubte Audio-Endung einen audio/*-Typ', () => {
    const erwartet: Record<string, string> = {
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      aiff: 'audio/aiff',
      aif: 'audio/aiff',
    };
    for (const [ext, mime] of Object.entries(erwartet)) {
      expect(audioMimeForExt(ext), `Endung ${ext}`).toBe(mime);
      expect(audioMimeForExt(ext).startsWith('audio/'), `Endung ${ext} ist kein audio/*`).toBe(true);
    }
  });

  it('ist gegen Grossschreibung und fuehrenden Punkt unempfindlich', () => {
    expect(audioMimeForExt('MP3')).toBe('audio/mpeg');
    expect(audioMimeForExt('.mp3')).toBe('audio/mpeg');
    expect(audioMimeForExt('  WAV  ')).toBe('application/octet-stream');
  });

  it('GEGENPROBE: eine ausfuehrbare Kategorie ist auf diesem Weg NICHT erreichbar', () => {
    // Der Kern des Angriffs war, dass `text/html` durchkam. Ueber die Endung
    // darf kein Typ entstehen, den ein Browser ausfuehrt oder als Markup liest.
    const gefaehrlich = /^(text\/|application\/(xhtml|javascript|xml)|image\/svg)/i;
    const proben = ['mp3', 'mp4', 'html', 'htm', 'svg', 'js', 'mjs', 'txt', 'xml', 'xhtml', '', 'exe'];
    for (const ext of proben) {
      const mime = audioMimeForExt(ext);
      expect(gefaehrlich.test(mime), `${ext} -> ${mime}`).toBe(false);
    }
  });

  it('unbekannte oder fehlende Endungen fallen auf application/octet-stream', () => {
    expect(audioMimeForExt('unbekannt')).toBe('application/octet-stream');
    expect(audioMimeForExt('')).toBe('application/octet-stream');
    expect(audioMimeForExt('html')).toBe('application/octet-stream');
  });

  it('die Endung wird am ENDE des Namens abgeschnitten, nicht am ersten Punkt', () => {
    // Angriff 5 in seiner schaerfsten Form: der Angreifer waehlt den Namen.
    // Zaehlte der erste Punkt, ergaebe 'harmlos.html.mp3' den Typ 'html'.
    expect(audioExtFromFilename('harmlos.html.mp3')).toBe('mp3');
    expect(audioMimeForExt(audioExtFromFilename('harmlos.html.mp3'))).toBe('audio/mpeg');

    // Umgekehrt: endet der Name auf .html, kommt KEIN Audio-Typ heraus.
    expect(audioExtFromFilename('harmlos.mp3.html')).toBe('html');
    expect(audioMimeForExt(audioExtFromFilename('harmlos.mp3.html'))).toBe('application/octet-stream');

    // Und der ganze Weg fuer die LIVE gemessene Angriffsdatei:
    expect(audioMimeForExt(audioExtFromFilename('polyglot-probe.mp3'))).toBe('audio/mpeg');
  });

  it('nimmt kein ganzes Pfadstueck als Endung', () => {
    expect(audioExtFromFilename('../../etc/passwd')).toBe('');
    expect(audioExtFromFilename('')).toBe('');
    expect(audioExtFromFilename('ohne-punkt')).toBe('');
    expect(audioExtFromFilename('mit.punkt.')).toBe('');
  });
});
