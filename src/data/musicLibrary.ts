/**
 * audioMONASTRY – Musik-Bibliothek
 * -----------------------------
 * Zentraler Katalog aller im Projekt abgelegten Audio-Lieder (`/music/*.mp3`).
 * Diese Tracks werden in Mischpult, Sampler & Library verfügbar gemacht.
 */
export interface MusicTrack {
  id: string;
  name: string;       // Anzeigename
  artist: string;     // Interpret (aus Dateiname extrahiert)
  url: string;        // Web-Pfad unter /public -> z.B. "/music/....mp3"
  bpm?: number;       // optional
}

const L = (file: string): MusicTrack => {
  const fp = `/music/${file}`;
  // Interpret = Teil vor erstem ' - ', Rest Titel (best effort)
  const dash = file.indexOf(' - ');
  const artist = dash > 0 ? file.substring(0, dash).trim() : 'Unknown';
  let title = dash > 0 ? file.substring(dash + 3).replace(/\.mp3$/i, '').trim() : file.replace(/\.mp3$/i, '').trim();
  return {
    id: fp,
    name: `${artist} - ${title}`,
    artist,
    url: fp,
  };
};

export const MUSIC_LIBRARY: MusicTrack[] = [
  L('Kotelett & Zadak - Hut Ab.mp3'),
  L('Kotelett & Zadak - Just Wait (Original Mix).mp3'),
  L('Kraak ＆ Smaak - No Sun In The Sky (Henrik Schwarz Remix).mp3'),
  L('Landser - Freiheit (Rock gegen oben).mp3'),
  L('Lass mich gehn Mutter - Lunikoff.mp3'),
  L('Leghau - Herborn Ep - Power - (Mike Wall Remix) - Flicker Rhythm.mp3'),
  L('Len Faki - Death by House.mp3'),
  L('Len Faki - figure 2.3 (original mix).mp3'),
  L('Len Faki - Kraft und Licht (Ostgut Ton).mp3'),
  L('len faki - my black sheep (radio slave remix).mp3'),
  L('Len Faki - Obliteration of the Berghain.mp3'),
  L('Rich Jones - Depth Charge (Sasha Carassi Remix).mp3'),
  L('Sabb & Luca Albano - Del Sol (Original Mix).mp3'),
  L('Sabb & S. Elezi - Sax On Wax (Original Mix) [HD].mp3'),
  L('Sascha Funke - We are facing the sun (chromotherapy video).mp3'),
  L('Seq - Glaster City (Original Mix).mp3'),
  L('Sido feat. Haftbefehl - Das war 2010_ das beste kommt zum Schluss [official Video].mp3'),
  L('Simone Tavazzi - Jazz Back (Original Mix).mp3'),
  L('SIS - bubu (original mix).mp3'),
  L('SIS - Nu Wim De Wa (Original Mix).mp3'),
  L('Skudge - Melodrama (Original Mix).mp3'),
  L('Snap! - The Power 2010 (DJ Pomeha Remix) DL LINK.mp3'),
  L('Spektre - Flux (original mix).mp3'),
  L('Super Flu - Sambalg.mp3'),
  L('Techno House Dance Trance mix.mp3'),
  L('Tensnake - Coma Cat.mp3'),
  L('The Time Is Here - Robert Noise & Ploughman.mp3'),
  L('thomas fehlmann - radeln (sascha funke rmx).mp3'),
  L('Tiefschwarz & Cassy - Find Me (Sis Remix).mp3'),
  L('Tim Sanchez - Bogota Express (Infected Culture Cocaina Remix) DL LINK.mp3'),
  L('Tommy Four Seven - Armed 3 (Original Mix).mp3'),
  L('Tommy Four Seven - Ratu (Monoloc Remix).mp3'),
  L('Tommy Four Seven - Ratu.mp3'),
  L('Tommy Four Seven - Sevals.mp3'),
  L('Tommy Four Seven - Sevals (Terence Fixmers Mental Drive Mix).mp3'),
  L('Tommy Four Seven Smoke Original Mix.mp3'),
  L('Tommy Four Seven - Snout (Chris Liebing Remix).mp3'),
  L('Tommy Four Seven-Sor ♪♫.mp3'),
  L('Tommy Four Seven - Surma (Chris Liebing Rmx) 2011.mp3'),
  L('Traversable Wormhole-Transducer(Brian Sanhaji Remix).mp3'),
  L('Two Em - Manjala (Spektre remix).mp3'),
  L('Waffen SS - Erika (Marching song).flv.mp3'),
  L('Younger Brother - Crumblenaut (04).mp3'),
  L('Younger Brother - Crystalline.mp3'),
  L('Younger Brother - Even Dwarves Start Small.mp3'),
  L('Younger Brother - Finger.mp3'),
  L('Younger Brother - Night Lead me Astray . official video.mp3'),
  L('Younger Brother - Train.mp3'),
];

/** P1-5: Automatische Sortierung – Artist, dann Titel, dann BPM. */
export function sortMusicLibrary(tracks: MusicTrack[]): MusicTrack[] {
  return [...tracks].sort((a, b) =>
    String(a.artist ?? 'Unknown').localeCompare(String(b.artist ?? 'Unknown'))
    || a.name.localeCompare(b.name)
    || (a.bpm ?? 0) - (b.bpm ?? 0),
  );
}

/** Vorsortierte Bibliothek für Dropdowns/Library (P1-5). */
export const SORTED_MUSIC_LIBRARY: MusicTrack[] = sortMusicLibrary(MUSIC_LIBRARY);

/** Künstler-Dedupe für Filter. */
export const MUSIC_ARTISTS = Array.from(new Set(MUSIC_LIBRARY.map((t) => t.artist))).sort((a, b) => String(a).localeCompare(String(b)));
