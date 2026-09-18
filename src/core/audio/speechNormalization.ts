/**
 * audioMONASTRY · Sprach-Normalisierung für die TTS-Kette (VOICE-P1-001)
 * =====================================================================
 * Ein Sprachmodell (Qwen3-TTS in der Flotte, Web-Speech im Browser, RVC/VITS
 * lokal) bekommt hier denselben, vorbereiteten Text. Ohne Normalisierung liest
 * es „17.09.2026, 14:30 Uhr, 19,99 € (z.B. 3,5 kg)" als Zeichenkette vor — die
 * üblichen Fehler sind Ziffern statt Zahlwörter, Buchstaben statt Abkürzung und
 * „Prozent" als Sonderzeichen.
 *
 * Bewusste Entscheidungen:
 *
 * 1. **Rein und deterministisch.** Keine Uhrzeit, kein Zufall, keine Locale-API
 *    (die Zahlwortbildung ist ausgeschrieben) — damit ist das Ergebnis testbar und
 *    auf allen Knoten identisch.
 * 2. **Deutsch als Ziel, technische Tokens bleiben technisch.** „MP3", „4K",
 *    „BPM" werden buchstabiert bzw. als Einheit gesprochen; Zahlen in Ports/IDs
 *    werden nur dann ausgeschrieben, wenn sie allein stehen. Ein Vorlesen von
 *    „8080" als „achttausendachtzig" wäre in einem Studiobericht falsch.
 * 3. **Nichts erfinden.** Was die Regeln nicht kennen, bleibt unverändert stehen
 *    (Tokens werden nicht geraten) — lieber ein Sonderzeichen zu viel als ein
 *    falsch gesprochener Betrag.
 */

const ONES = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'];
const TEENS = ['zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
const ORDINALS: Record<number, string> = {
  0: 'nullte', 1: 'erste', 2: 'zweite', 3: 'dritte', 4: 'vierte', 5: 'fünfte', 6: 'sechste', 7: 'siebte',
  8: 'achte', 9: 'neunte', 10: 'zehnte', 11: 'elfte', 12: 'zwölfte', 13: 'dreizehnte', 14: 'vierzehnte',
  15: 'fünfzehnte', 16: 'sechzehnte', 17: 'siebzehnte', 18: 'achtzehnte', 19: 'neunzehnte', 20: 'zwanzigste',
  21: 'einundzwanzigste', 22: 'zweiundzwanzigste', 23: 'dreiundzwanzigste', 24: 'vierundzwanzigste',
  25: 'fünfundzwanzigste', 26: 'sechsundzwanzigste', 27: 'siebenundzwanzigste', 28: 'achtundzwanzigste',
  29: 'neunundzwanzigste', 30: 'dreißigste', 31: 'einunddreißigste',
};

/** 0..999 als deutsche Wörter. */
function belowThousand(n: number): string {
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  // Hunderter zuerst - ohne diesen Zweig lieferte 100 '' und 1234 'einundundefined'
  // (die Tests haben genau das aufgedeckt).
  if (n >= 100) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    const hundredWord = `${hundreds === 1 ? 'ein' : ONES[hundreds]}hundert`;
    return rest === 0 ? hundredWord : `${hundredWord}${belowThousand(rest)}`;
  }
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  if (ones === 0) return TENS[tens];
  const oneWord = ones === 1 ? 'ein' : ONES[ones];
  return `${oneWord}und${TENS[tens]}`;
}

/** 0..999.999 als EIN Wort ("eintausendzweihundertvierunddreißig"). */
function belowMillion(n: number): string {
  if (n < 1000) return belowThousand(n);
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const thousandWord = `${thousands === 1 ? 'ein' : belowThousand(thousands)}tausend`;
  return rest === 0 ? thousandWord : `${thousandWord}${belowThousand(rest)}`;
}

/** Bis 999.999.999.999 (Billiarden-Grenze, mehr braucht ein Studio nicht). */
export function numberToGermanWords(value: number): string {
  if (!Number.isFinite(value)) return '';
  const negative = value < 0;
  let n = Math.floor(Math.abs(value));
  if (n === 0) return 'null';
  const parts: string[] = [];
  const scales: { limit: number; single: string; plural: string }[] = [
    { limit: 1_000_000_000_000, single: 'eine Billion', plural: 'Billionen' },
    { limit: 1_000_000_000, single: 'eine Milliarde', plural: 'Milliarden' },
    { limit: 1_000_000, single: 'eine Million', plural: 'Millionen' },
    { limit: 1_000, single: 'eintausend', plural: 'tausend' },
  ];
  for (const scale of scales) {
    if (n < scale.limit) continue;
    if (scale.limit === 1_000) {
      // Der Tausenderrest wird VOR der Reduktion verarbeitet: nach `n %= 1_000`
      // waere 2026 zu "sechsundzwanzig" geworden und 1000 zu "null" (beides im
      // Test gesehen). belowMillion() schreibt den Rest als EIN Wort.
      parts.push(belowMillion(n));
      n = 0;
      continue;
    }
    const count = Math.floor(n / scale.limit);
    n %= scale.limit;
    parts.push(count === 1 ? scale.single : `${belowThousand(count)} ${scale.plural}`);
  }
  if (n > 0) parts.push(belowThousand(n));
  const words = parts.join(' ').replace(/\s+/g, ' ').trim();
  return negative ? `minus ${words}` : words;
}

/** Ordinalzahl für Datumsangaben: 17 -> "siebzehnte". */
export function ordinalToGermanWords(value: number): string {
  return ORDINALS[value] ?? `${numberToGermanWords(value)}te`;
}

export interface SpeechNormalizationOptions {
  /** Ordinalzahlen in Datumsangaben ("17. September" -> "siebzehnte September"). */
  ordinals?: boolean;
  /** Technische Tokens (MP3, 4K, BPM) buchstabieren statt vorlesen. */
  spellTechnicalTokens?: boolean;
}

/** Abkürzungen, die im Studio vorkommen (Punkt-Varianten inklusive). */
const ABBREVIATIONS: [RegExp, string][] = [
  [/\bz\.\s?B\./gi, 'zum Beispiel'],
  [/\bzB\b/g, 'zum Beispiel'],
  [/\bbspw\./gi, 'beispielsweise'],
  [/\bbzw\./gi, 'beziehungsweise'],
  [/\busw\./gi, 'und so weiter'],
  [/\bu\.\s?a\./gi, 'unter anderem'],
  [/\bd\.\s?h\./gi, 'das heißt'],
  [/\bgff\./gi, 'gegebenenfalls'],
  [/\bevtl\./gi, 'eventuell'],
  [/\binkl\./gi, 'inklusive'],
  [/\bzzgl\./gi, 'zuzüglich'],
  [/\bca\./gi, 'circa'],
  [/\bmax\./gi, 'maximal'],
  [/\bmin\./gi, 'minimal'],
  [/\bmind\./gi, 'mindestens'],
  [/\bvgl\./gi, 'vergleiche'],
  [/\bNr\./gi, 'Nummer'],
  [/\bAbb\./gi, 'Abbildung'],
  [/\bStk\./gi, 'Stück'],
  [/\bDr\./gi, 'Doktor'],
  [/\bProf\./gi, 'Professor'],
  [/\bStr\./gi, 'Straße'],
  [/\bTel\./gi, 'Telefon'],
  [/\bo\.\s?Ä\./gi, 'oder Ähnliches'],
  [/\bsog\./gi, 'sogenannte'],
  [/\bu\.\s?U\./gi, 'unter Umständen'],
];

/** Einheiten, die ausgesprochen werden (Symbol -> gesprochenes Wort). */
const UNITS: [RegExp, string][] = [
  [/km\/h/gi, 'Kilometer pro Stunde'],
  [/m\/s\b/gi, 'Meter pro Sekunde'],
  [/kbit\/s/gi, 'Kilobit pro Sekunde'],
  [/kbps/gi, 'Kilobit pro Sekunde'],
  [/kHz/gi, 'Kilohertz'],
  [/MHz/gi, 'Megahertz'],
  [/GHz/gi, 'Gigahertz'],
  [/Hz\b/gi, 'Hertz'],
  [/dB\b/g, 'Dezibel'],
  [/°C/g, 'Grad Celsius'],
  [/°F/g, 'Grad Fahrenheit'],
  [/°\s?/g, 'Grad '],
  [/km\b/gi, 'Kilometer'],
  [/cm\b/gi, 'Zentimeter'],
  [/mm\b/gi, 'Millimeter'],
  [/kg\b/gi, 'Kilogramm'],
  [/mg\b/gi, 'Milligramm'],
  [/ml\b/gi, 'Milliliter'],
  [/\bl\b/gi, 'Liter'],
  [/\bms\b/gi, 'Millisekunden'],
  [/\bs\b/g, 'Sekunden'],
  [/\bmin\b/gi, 'Minuten'],
  [/mb\b/gi, 'Megabyte'],
  [/gb\b/gi, 'Gigabyte'],
  [/tb\b/gi, 'Terabyte'],
  [/bpm\b/gi, 'Beats pro Minute'],
];

const PLURAL_UNIT_WORDS = new Set(['Kilogramm', 'Kilometer', 'Zentimeter', 'Millimeter', 'Milligramm', 'Milliliter', 'Liter', 'Sekunden', 'Minuten', 'Millisekunden', 'Dezibel', 'Hertz', 'Beats pro Minute']);

/** Zahlwort für einen Ziffernstring, der Komma-Dezimaltrennung nutzen darf. */
function spellNumberLiteral(literal: string): string {
  const cleaned = literal.replace(/\./g, '').replace(',', '.');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return literal;
  if (Number.isInteger(value)) return numberToGermanWords(value);
  const [whole, fraction] = literal.replace(/\./g, '').split(',');
  const fractionWords = fraction.split('').map((d) => ONES[Number(d)]).join(' ');
  return `${numberToGermanWords(Number(whole))} Komma ${fractionWords}`;
}

function wordsForUnitSpacing(spoken: string): string {
  return PLURAL_UNIT_WORDS.has(spoken) ? spoken : spoken;
}

/**
 * Normalisiert Text für die Sprachausgabe. Idempotent genug für den praktischen
 * Gebrauch: bereits ausgeschriebene Zahlwörter werden nicht wieder verändert.
 */
export function normalizeForSpeech(input: string, options: SpeechNormalizationOptions = {}): string {
  const ordinals = options.ordinals !== false;
  const spellTechnical = options.spellTechnicalTokens !== false;
  let text = String(input ?? '');
  if (!text.trim()) return '';

  // 1) Abkürzungen zuerst (sie enthalten Punkte, die sonst als Satzende gelten).
  for (const [pattern, replacement] of ABBREVIATIONS) text = text.replace(pattern, replacement);

  // 2) Datum 17.09.2026 / 17.9.26 -> "siebzehnte September zweitausendsechsundzwanzig"
  text = text.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/g, (_m, d, m, y) => {
    const day = ordinalToGermanWords(Number(d));
    const months = ['', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    const monthWord = months[Number(m)] ?? 'Monat';
    const year = Number(y) < 100 ? 1900 + Number(y) : Number(y);
    return `${day} ${monthWord} ${numberToGermanWords(year)}`;
  });

  // 3) Uhrzeit 14:30 -> "vierzehn Uhr dreißig"
  text = text.replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h, min) => {
    const hour = Number(h);
    const minute = Number(min);
    if (hour > 23 || minute > 59) return `${h}:${min}`;
    if (minute === 0) return `${numberToGermanWords(hour)} Uhr`;
    return `${numberToGermanWords(hour)} Uhr ${numberToGermanWords(minute)}`;
  });

  // 4) Betrag mit Währung: 19,99 € -> "neunzehn Komma neun neun Euro"
  text = text.replace(/(\d[\d.]*(?:,\d+)?)\s*€/g, (_m, amount) => `${spellNumberLiteral(String(amount))} Euro`);
  text = text.replace(/(\d[\d.]*(?:,\d+)?)\s*\$/g, (_m, amount) => `${spellNumberLiteral(String(amount))} Dollar`);

  // 5) Prozent: 12 % / 12% -> "zwölf Prozent"
  text = text.replace(/(\d[\d.]*(?:,\d+)?)\s*%/g, (_m, amount) => `${spellNumberLiteral(String(amount))} Prozent`);

  // 6) Einheiten: 44,1 kHz -> "vierundvierzig Komma eins Kilohertz"
  for (const [pattern, unit] of UNITS) {
    const withNumber = new RegExp(`(\\d[\\d.]*(?:,\\d+)?)\\s*(${pattern.source})`, 'gi');
    text = text.replace(withNumber, (_m, amount) => `${spellNumberLiteral(String(amount))} ${wordsForUnitSpacing(unit)}`);
    text = text.replace(pattern, wordsForUnitSpacing(unit));
  }

  // 7) Bereiche: 10-20 / 10 – 20 -> "zehn bis zwanzig"
  text = text.replace(/(\d[\d.]*(?:,\d+)?)\s*[-–]\s*(\d[\d.]*(?:,\d+)?)/g,
    (_m, a, b) => `${spellNumberLiteral(String(a))} bis ${spellNumberLiteral(String(b))}`);

  // 8) "3x" / "3 x" -> "dreimal"
  text = text.replace(/\b(\d+)\s?[x×]\b/gi, (_m, n) => `${numberToGermanWords(Number(n))}mal`);

  // 9) Datum mit Ordinalzahl: "17. September" -> "siebzehnte September"
  if (ordinals) {
    text = text.replace(/\b(\d{1,2})\.\s+(?=[A-ZÄÖÜ])/g, (_m, d) => `${ordinalToGermanWords(Number(d))} `);
  }

  // 10) Technische Tokens: MP3, 4K, AI, BPM -> buchstabieren ("M P drei", "vier K")
  if (spellTechnical) {
    text = text.replace(/\b[A-Z0-9ÄÖÜ]{2,}\b/g, (token) => {
      if (/^\d+$/.test(token)) return token; // reine Zahlen regelt Schritt 11
      return token.split('').map((ch) => (/\d/.test(ch) ? ONES[Number(ch)] : ch)).join(' ');
    });
  }

  // 11) Technische Kontexte schuetzen: eine Portnummer, Version oder Kennung
  //     wird NICHT als Zahlwort gesprochen ("Port 8080" != "achttausendachtzig").
  //     Dazu werden solche Zahlen vor Schritt 12 kurz maskiert.
  const protectedNumbers: string[] = [];
  text = text.replace(
    /\b(Port|Version|Revision|Kanal|Kanalnummer|Slot|Track|Kennung|ID|Pin|Checksumme)\s+([\d.,:-]+)/gi,
    (_m, keyword, value) => {
      protectedNumbers.push(String(value));
      // Marke OHNE Ziffern: eine Ziffer im Platzhalter wurde von der
      // Zahlenregel selbst erfasst und zu "null" (im Test gesehen).
      return `${keyword} \u0000${'x'.repeat(protectedNumbers.length)}\u0000`;
    },
  );

  // 12) Freistehende Zahlen (kein technischer Kontext) als Zahlwort.
  text = text.replace(/(?<![\w.,:#@/%-])(\d[\d.]*(?:,\d+)?)(?![\w.,:%-])/g, (m) => spellNumberLiteral(m));

  // 13) Satzzeichen, die gesprochen nichts beitragen, und Mehrfach-Leerzeichen.
  text = text.replace(/[()[\]{}"„“”]/g, ' ');
  // Schutzmarken zurueckersetzen (die Ziffern bleiben Ziffern).
  text = text.replace(/\u0000(x+)\u0000/g, (_m, marks: string) => protectedNumbers[marks.length - 1] ?? '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}
