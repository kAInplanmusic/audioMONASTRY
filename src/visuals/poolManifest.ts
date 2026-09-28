/**
 * VisualMONK · Pool-Manifest (der „Topf") — Schema + Tagging + Auswahl
 * =====================================================================
 * Ein einziger Ort, an dem ALLES liegt, was der Visualizer schöpfen kann:
 * KI-Bilder, eigene Fotos/Videos, erzeugte Clips, fertige Visuals und (später)
 * öffentliche Quellen. Der Regisseur (`visualDirector.ts`) wählt daraus
 * beatsynced aus; diese Datei stellt nur das Manifest + die puren Helfer
 * (Tagging, Filtern, Seed-Auswahl).
 *
 * Bewusst rein und serialisierbar: dasselbe Manifest ergibt mit demselben Seed
 * dieselbe Auswahl (Determinismus = Beweisweg). Kein DOM, keine GPU.
 */

/** Woher ein Eintrag stammt — entscheidet Lizenz-/Datenschutz-Behandlung. */
export type PoolSource =
  | 'ki-bild'          // generiert (FLUX/SDXL), gehört uns
  | 'eigenes-foto'     // privates Foto des Users
  | 'eigenes-video'    // privates Video des Users
  | 'erzeugtes-video'  // Wan 2.2 Image-to-Video, gehört uns
  | 'fertig-visual'    // fertige Visuals/Vorlagen
  | 'oeffentlich'      // Pexels/Pixabay/Wikimedia … (Lizenz im Feld `license`);

/** Grobe Stimmung — steuert die Rotation (düster ↔ cool ↔ lustig). */
export type PoolMood = 'duester' | 'cool' | 'lustig' | 'neutral';

/** Energie-Profil, das die Quelle am besten begleitet. */
export type PoolEnergy = 'ruhig' | 'mittel' | 'hart';

/** Ein Eintrag des Pools. */
export interface PoolEntry {
  /** Stabiler Schlüssel (z. B. `psy_techno-53885489`). */
  id: string;
  /** Datei-URL: same-origin (`/api/ai/vision/bank/…`) oder R2/HTTP. */
  src: string;
  /** `image` = Standbild, `clip` = Video (mp4). */
  kind: 'image' | 'clip';
  source: PoolSource;
  mood: PoolMood;
  energy: PoolEnergy;
  /** Freie Tags (Themen/Kombinationen, z. B. `neon`, `fire`, `lego`). */
  tags: readonly string[];
  /** Dauer in Sekunden (Clip) bzw. gewünschte Standzeit (Bild). */
  durationS: number;
  /** Lizenz, wenn `source === 'oeffentlich'` (z. B. `pexels`, `cc0`). */
  license?: string;
  /** Kurzbezeichnung für UI/Log. */
  label?: string;
}

/**
 * Die 32 Themen des Datensatzes, grob in die drei Stimmungen einsortiert.
 * Das ist eine VORLAGE (Agent-Vorschlag) — der User kann sie umsortieren;
 * die Zuordnung ist Inhalt und gehört ihm, nicht dem Agenten.
 */
export const MOOD_BY_THEME: Readonly<Record<string, PoolMood>> = {
  // düster
  horror_zombie: 'duester',
  krieg_tod: 'duester',
  dark_ornament: 'duester',
  industrial_techno: 'duester',
  brainfuck_unmoeglich_surrealismus: 'duester',
  vorsintflutliche_hochkultur: 'duester',
  gewitter_raining_day: 'duester',
  feuer_flammen: 'duester',
  licht_rauch: 'duester',
  schwarz_weiss_schwarz_weiss_rot: 'duester',
  // cool
  geometric: 'cool',
  hdr_sternenhimmel: 'cool',
  street_art_graffiti: 'cool',
  tattoos_frauen: 'cool',
  tattoo_maschinen: 'cool',
  dj_club: 'cool',
  abstrakt: 'cool',
  natur_echt: 'cool',
  natur_makro: 'cool',
  natur_tiere: 'cool',
  drohnenflug: 'cool',
  wikinger_samurai: 'cool',
  taenzer: 'cool',
  // lustig
  comic: 'lustig',
  lego: 'lustig',
  dinosaurier: 'lustig',
  _8_bit_retro_spiel: 'lustig',
  zitate_inspirationssprueche: 'lustig',
  fantasy: 'lustig',
  geheimbund_moenche: 'lustig',
  natur_fake: 'lustig',
};

/** Kombinations-Präfixe des Vorratslaufs → Stimmung (nach Motiv). */
export const MOOD_BY_KOMBO: Readonly<Record<string, PoolMood>> = {
  psy_techno: 'cool',
  flux_alien: 'duester',
  alien_techno: 'duester',
  traumraum: 'duester',
  eskalation: 'cool',
  dark_techno: 'duester',
  metal_flow: 'duester',
  feuer_organik: 'duester',
  vhs_night: 'duester',
};

/** Energie aus BPM/Onset ableiten — reiner Helfer. */
export function energyFromBpm(bpm: number): PoolEnergy {
  if (!Number.isFinite(bpm) || bpm <= 0) return 'mittel';
  if (bpm <= 100) return 'ruhig';
  if (bpm <= 138) return 'mittel';
  return 'hart';
}

/** Gewichtete Zufallsauswahl (deterministisch über `rng`). */
export function pickWeighted<T>(items: readonly T[], weights: readonly number[], rng: () => number): T {
  if (items.length === 0) throw new Error('pickWeighted: leere Liste');
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let roll = rng() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= Math.max(0, weights[i]);
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}
