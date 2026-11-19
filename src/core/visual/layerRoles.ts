/**
 * audioMONASTRY · VisualMONK: Ebenen mit festen Rollen
 * ====================================================
 * Aus dem Konzept „Ritual": Videos tragen die Atmosphäre und folgen dem Langsamen (Bass, Energie), Fotos sind die Symbole und
 * folgen Mitten/Höhen (Melodie-Näherung), Effekte reagieren hart auf Transienten. Die Rolle wirkt auf die Parameter-Abbildung
 * der Szene (`mapAudioToParams`); Szenenwechsel und Effekt-Regie sehen weiter die unveränderten Features.
 * Ehrlich zur Datenlage: Es gibt noch kein eigenes Melodie-/Stem-Signal im Renderer, Mitten und Höhen sind der Ersatz.
 */
import type { AudioFeatures } from './types';

export type LayerKind = 'image' | 'clip';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Features so gewichten, wie die Ebene der gerade gezeigten Szene sie „hören" soll. */
export function applyLayerRole(features: AudioFeatures, kind: LayerKind | undefined): AudioFeatures {
  if (kind === 'clip') {
    // Atmosphäre: Bass und Gesamtenergie tragen, Höhen und harte Schläge werden gedämpft.
    return { ...features, bass: clamp01(features.bass * 1.15), mid: features.mid * 0.7, treble: features.treble * 0.5, onset: features.onset * 0.4 };
  }
  if (kind === 'image') {
    // Symbole: Mitten und Höhen (Melodie-Näherung) betonen, Bass zurücknehmen.
    return { ...features, bass: features.bass * 0.5, mid: clamp01(features.mid * 1.25), treble: clamp01(features.treble * 1.2), onset: features.onset * 0.6 };
  }
  return features;
}
