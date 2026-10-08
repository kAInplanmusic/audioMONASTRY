/**
 * audioMONASTRY · SFZ-Voice-Management (LinuxSampler-Vorbild, eigener Code)
 * =========================================================================
 * Polyphone Stimmenverwaltung für SFZ-Instrumente (Main-Thread-Fassade):
 *   * `load(sfzText, sources)` parst den SFZ-Text (`parseSfz`) und lädt die
 *     fertige Regionen-Tabelle in die parserfreie `SfzVoiceBankCore`
 *   * Region-Auswahl, Voice-Pool, Hüllkurve, Loops, Render: `sfzVoiceBankCore.ts`
 *
 * RT-AUDIT-P1-010: Parser und Bank sind getrennt. Der Audio-Thread
 * (`v2SinkProcessor`) importiert nur `SfzVoiceBankCore` und bekommt fertige
 * Regionen – dieses Modul (mit Text-Parser) läuft ausschließlich im Main-Thread.
 */
import { parseSfz } from './sfzParser';
import { SfzVoiceBankCore, type SfzSourceMap } from './sfzVoiceBankCore';

export type { SfzSourceMap } from './sfzVoiceBankCore';

export class SfzVoiceBank extends SfzVoiceBankCore {
  /** Lädt SFZ-Text + Sample-Buffer und ersetzt das Instrument (Main-Thread). */
  load(sfzText: string, sources: SfzSourceMap): string[] {
    const parsed = parseSfz(sfzText);
    this.loadParsed(parsed.regions, sources);
    return parsed.errors;
  }
}
