/**
 * audioMONASTRY · Orchestrale CC0-Library – Metadaten-Katalog (VSCO 2 CE)
 * ========================================================================
 * B-Klasse Audio-Audit: kleine Subset-Auswahl (Streicher/Bläser/Holz) aus der
 * VSCO 2 Community Edition (CC0). Hier NUR Metadaten – die Audio-Dateien
 * werden separat heruntergeladen und unter `public/data/orchestral/` abgelegt
 * (Betreiber-Schritt, Lizenz: VSCO 2 CE = CC0, unproblematisch).
 *
 * Das Format folgt dem bestehenden `AudioSample`-Schema, damit die Einträge
 * später direkt in `SampleContext`/`PRESET_SAMPLE_DATABASE` gemerged werden
 * können. VPO/Sonatina/Berlin = LICENSE_REVIEW_REQUIRED → NICHT bündeln.
 */

import type { AudioSample } from './samples';

export interface OrchestralSampleMeta {
  id: string;
  name: string;
  category: 'bass' | 'mids' | 'highs';
  type: string;
  /** Relativer Pfad unter public/data/orchestral/ – Datei kommt vom Download. */
  file: string;
  description: string;
  tags: string[];
  parameters: AudioSample['parameters'];
}

export const ORCHESTRAL_CC0_CATALOG: OrchestralSampleMeta[] = [
  { id: 'orch-vsco-violin', name: 'Violin (VSCO 2 CE)', category: 'highs', type: 'Strings', file: 'violin_c4.wav', description: 'Solo-Violine, kurze Artikulation', tags: ['strings', 'violin', 'cc0'], parameters: { frequency: 261.63, decay: 0.4 } },
  { id: 'orch-vsco-viola', name: 'Viola (VSCO 2 CE)', category: 'mids', type: 'Strings', file: 'viola_c3.wav', description: 'Solo-Viola, warme Mittellage', tags: ['strings', 'viola', 'cc0'], parameters: { frequency: 196.0, decay: 0.4 } },
  { id: 'orch-vsco-cello', name: 'Cello (VSCO 2 CE)', category: 'bass', type: 'Strings', file: 'cello_c2.wav', description: 'Solo-Cello, tiefe Lage', tags: ['strings', 'cello', 'cc0'], parameters: { frequency: 130.81, decay: 0.5 } },
  { id: 'orch-vsco-bass', name: 'Contrabass (VSCO 2 CE)', category: 'bass', type: 'Strings', file: 'bass_c1.wav', description: 'Kontrabass-Pizzicato', tags: ['strings', 'bass', 'cc0'], parameters: { frequency: 65.41, decay: 0.5 } },
  { id: 'orch-vsco-string-ensemble', name: 'String Ensemble (VSCO 2 CE)', category: 'mids', type: 'Strings', file: 'strings_ensemble_c3.wav', description: 'Gestreicheltes Streicherensemble', tags: ['strings', 'ensemble', 'cc0'], parameters: { frequency: 261.63, decay: 0.8 } },
  { id: 'orch-vsco-trumpet', name: 'Trumpet (VSCO 2 CE)', category: 'highs', type: 'Brass', file: 'trumpet_c4.wav', description: 'Trompete, angeblasen', tags: ['brass', 'trumpet', 'cc0'], parameters: { frequency: 261.63, decay: 0.35 } },
  { id: 'orch-vsco-horn', name: 'French Horn (VSCO 2 CE)', category: 'mids', type: 'Brass', file: 'horn_c3.wav', description: 'Waldhorn, weich', tags: ['brass', 'horn', 'cc0'], parameters: { frequency: 196.0, decay: 0.45 } },
  { id: 'orch-vsco-trombone', name: 'Trombone (VSCO 2 CE)', category: 'bass', type: 'Brass', file: 'trombone_c2.wav', description: 'Posaune, mitteltief', tags: ['brass', 'trombone', 'cc0'], parameters: { frequency: 110.0, decay: 0.4 } },
  { id: 'orch-vsco-flute', name: 'Flute (VSCO 2 CE)', category: 'highs', type: 'Woodwinds', file: 'flute_c5.wav', description: 'Querflöte, klar', tags: ['woodwinds', 'flute', 'cc0'], parameters: { frequency: 523.25, decay: 0.4 } },
  { id: 'orch-vsco-clarinet', name: 'Clarinet (VSCO 2 CE)', category: 'mids', type: 'Woodwinds', file: 'clarinet_c4.wav', description: 'Klarinette, rund', tags: ['woodwinds', 'clarinet', 'cc0'], parameters: { frequency: 261.63, decay: 0.4 } },
  { id: 'orch-vsco-oboe', name: 'Oboe (VSCO 2 CE)', category: 'mids', type: 'Woodwinds', file: 'oboe_c4.wav', description: 'Oboe, nasal-singend', tags: ['woodwinds', 'oboe', 'cc0'], parameters: { frequency: 261.63, decay: 0.4 } },
  { id: 'orch-vsco-bassoon', name: 'Bassoon (VSCO 2 CE)', category: 'bass', type: 'Woodwinds', file: 'bassoon_c2.wav', description: 'Fagott, tief', tags: ['woodwinds', 'bassoon', 'cc0'], parameters: { frequency: 110.0, decay: 0.45 } },
];

/** Konvertiert den Metadaten-Katalog in `AudioSample`-Einträge (für SampleContext). */
export function orchestralSamples(): AudioSample[] {
  return ORCHESTRAL_CC0_CATALOG.map((m) => ({
    id: m.id,
    name: m.name,
    category: m.category,
    type: m.type,
    url: `/data/orchestral/${m.file}`,
    description: m.description,
    tags: m.tags,
    parameters: m.parameters,
  }));
}
