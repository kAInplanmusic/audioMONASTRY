import { describe, expect, it } from 'vitest';
import {
  normalizeForSpeech,
  numberToGermanWords,
  ordinalToGermanWords,
} from '../src/core/audio/speechNormalization';

/**
 * VOICE-P1-001 · Sprach-Normalisierung
 * =====================================================================
 * Der Text, den ein TTS-Modell bekommt, entscheidet über die Aussprache. Diese
 * Tests halten die Fälle fest, die vorher falsch vorgelesen wurden (Ziffern,
 * Abkürzungen, Symbole) — und die Fälle, die BEWUSST unverändert bleiben
 * (technische Tokens, Ports), damit die Normalisierung nicht ins Gegenteil kippt.
 */

describe('VOICE-P1-001 · Zahlwörter', () => {
  it('bildet deutsche Zahlwörter korrekt', () => {
    expect(numberToGermanWords(0)).toBe('null');
    expect(numberToGermanWords(7)).toBe('sieben');
    expect(numberToGermanWords(11)).toBe('elf');
    expect(numberToGermanWords(16)).toBe('sechzehn');
    expect(numberToGermanWords(21)).toBe('einundzwanzig');
    expect(numberToGermanWords(30)).toBe('dreißig');
    expect(numberToGermanWords(71)).toBe('einundsiebzig');
    expect(numberToGermanWords(100)).toBe('einhundert');
    expect(numberToGermanWords(101)).toBe('einhunderteins');
    expect(numberToGermanWords(999)).toBe('neunhundertneunundneunzig');
    expect(numberToGermanWords(1000)).toBe('eintausend');
    expect(numberToGermanWords(2026)).toBe('zweitausendsechsundzwanzig');
    expect(numberToGermanWords(1_000_000)).toBe('eine Million');
    expect(numberToGermanWords(2_500_000)).toBe('zwei Millionen fünfhunderttausend');
    expect(numberToGermanWords(-5)).toBe('minus fünf');
  });

  it('bildet Ordinalzahlen für Datumsangaben', () => {
    expect(ordinalToGermanWords(1)).toBe('erste');
    expect(ordinalToGermanWords(3)).toBe('dritte');
    expect(ordinalToGermanWords(17)).toBe('siebzehnte');
    expect(ordinalToGermanWords(31)).toBe('einunddreißigste');
    expect(ordinalToGermanWords(42)).toBe('zweiundvierzigte');
  });
});

describe('VOICE-P1-001 · Normalisierung', () => {
  it('spricht Datum und Uhrzeit aus', () => {
    expect(normalizeForSpeech('Termin am 17.09.2026 um 14:30 Uhr'))
      .toBe('Termin am siebzehnte September zweitausendsechsundzwanzig um vierzehn Uhr dreißig Uhr');
    expect(normalizeForSpeech('17. September 2026')).toBe('siebzehnte September zweitausendsechsundzwanzig');
    expect(normalizeForSpeech('09:05')).toBe('neun Uhr fünf');
    expect(normalizeForSpeech('18:00')).toBe('achtzehn Uhr');
    // Unmoegliche Uhrzeit bleibt stehen (kein Raten).
    expect(normalizeForSpeech('99:99')).toBe('99:99');
  });

  it('spricht Betraege, Prozente und Einheiten aus', () => {
    expect(normalizeForSpeech('19,99 €')).toBe('neunzehn Komma neun neun Euro');
    expect(normalizeForSpeech('12%')).toBe('zwölf Prozent');
    expect(normalizeForSpeech('3,5 kg')).toBe('drei Komma fünf Kilogramm');
    expect(normalizeForSpeech('44,1 kHz')).toBe('vierundvierzig Komma eins Kilohertz');
    expect(normalizeForSpeech('120 km/h')).toBe('einhundertzwanzig Kilometer pro Stunde');
    expect(normalizeForSpeech('21 °C')).toBe('einundzwanzig Grad Celsius');
    expect(normalizeForSpeech('128 BPM')).toBe('einhundertachtundzwanzig Beats pro Minute');
  });

  it('loest Abkuerzungen auf', () => {
    expect(normalizeForSpeech('z.B. Bass')).toBe('zum Beispiel Bass');
    expect(normalizeForSpeech('z. B. Bass')).toBe('zum Beispiel Bass');
    expect(normalizeForSpeech('bzw.')).toBe('beziehungsweise');
    expect(normalizeForSpeech('max. 5 Versuche')).toBe('maximal fünf Versuche');
    expect(normalizeForSpeech('Nr. 7')).toBe('Nummer sieben');
    expect(normalizeForSpeech('d. h.')).toBe('das heißt');
  });

  it('spricht Bereiche, Vielfache und freistehende Zahlen aus', () => {
    expect(normalizeForSpeech('10-20 Sekunden')).toBe('zehn bis zwanzig Sekunden');
    expect(normalizeForSpeech('3x lauter')).toBe('dreimal lauter');
    expect(normalizeForSpeech('Es sind 7 Spuren')).toBe('Es sind sieben Spuren');
    expect(normalizeForSpeech('1.234 Aufrufe')).toBe('eintausendzweihundertvierunddreißig Aufrufe');
  });

  it('buchstabiert technische Tokens statt sie vorzulesen', () => {
    // In einer Buchstabenfolge wird die Ziffer als Wort gesprochen ("em pe drei").
    expect(normalizeForSpeech('MP3 und AI')).toBe('M P drei und A I');
    // Einheiten werden gesprochen, nicht buchstabiert.
    expect(normalizeForSpeech('500 Hz')).toBe('fünfhundert Hertz');
  });

  it('fasst Zahlen NICHT an, wenn sie Teil eines technischen Kontexts sind', () => {
    // Ports/IDs/Pfade wuerden als Zahlwort falsch klingen.
    expect(normalizeForSpeech('Port 8080')).toContain('8080');
    expect(normalizeForSpeech('Version 1.210.001')).toContain('1.210.001');
  });

  it('ist bei leerer Eingabe still und idempotent bei bereits gesprochenem Text', () => {
    expect(normalizeForSpeech('')).toBe('');
    expect(normalizeForSpeech('   ')).toBe('');
    const once = normalizeForSpeech('Es sind 7 Spuren');
    expect(normalizeForSpeech(once)).toBe(once);
  });

  it('laesst Unbekanntes stehen (kein Raten)', () => {
    expect(normalizeForSpeech('Kanal @#1')).toBe('Kanal @#1');
  });
});
