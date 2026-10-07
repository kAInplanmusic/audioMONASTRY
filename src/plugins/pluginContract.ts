/**
 * audioMONASTRY · AUDIO-VERTRAG (B0, Plan 2026-10-07)
 * ===================================================
 * DIE EINE QUELLE für das, was jedes der 16 Plugins im Signalweg IST.
 *
 * Warum diese Datei existiert: Registry (`plugins/registry.ts`), Signalweg
 * (`plugins/signalChain.ts`) und Kanalbelegung (`plugins/pluginChannelMap.ts`)
 * beschrieben bisher drei Ausschnitte derselben Sache an drei Stellen. Wer ein
 * Plugin hinzufügte, musste an drei Orten daran denken. Hier steht der Vertrag
 * einmal; die anderen Stellen leiten daraus ab (oder prüfen dagegen).
 *
 * Was hier NICHT steht: Implementierung. Kein Node-Import, kein Audio-Code -
 * nur der Vertrag. Damit ist die Datei auch in Tests ohne Audio-Kontext nutzbar.
 *
 * Fachliche Grundlage: docs/design/V2_UI_VERKABELUNG.md und die Architektur-Review
 * vom 2026-10-07 (CometAPI/gpt-5.6). Die Review-Punkte, die hier eingelöst sind:
 *   - Kanalformat je Knoten (mono/stereo) statt implizit
 *   - Ein-/Ausgänge explizit (Send/Return, Recorder-Tap, Sidechain)
 *   - Bypass als latenztreuer Dry/Wet-Crossfade, NICHT Disconnect
 *   - `intrinsicLatencyFrames` je Plugin für PDC
 *   - FX-Bus (Return) und Master-Insert klar getrennt - ein Plugin ist nie beides
 */

/** Format eines Ports. `stereo` ist die Summe/der Bus, `mono` eine Einzelquelle. */
export type ChannelFormat = 'mono' | 'stereo';

/**
 * Rolle im Signalweg. Bestimmt, WO der Knoten steht - nicht, was er tut.
 * `source`   = erzeugt Ton (9 Stück, gehen über die Kanalzüge)
 * `channel`  = Kanalzug des Mixers (Summierungspunkt)
 * `insert`   = seriell in der Master-Summe (eq, dsp, master)
 * `fxReturn` = parallele Effektebene (effect, spatial - Send/Return)
 * `recorder` = Abgriff, verändert das Signal nicht (record)
 * `utility`  = kein Ton, lädt nur in andere (biblio)
 */
export type SignalRole = 'source' | 'channel' | 'insert' | 'fxReturn' | 'recorder' | 'utility';

/**
 * Wo der Abgriff für den FX-Send liegt. `pre` = vor dem Fader (unabhängig von
 * der Lautstärke), `post` = nach dem Fader (leiser, wenn der Kanal leiser wird).
 * V2_UI_VERKABELUNG.md legt `post` fest („Send in den FX-Bus (post-fader)").
 */
export type FxSendTap = 'pre' | 'post';

/** Der Vertrag eines Plugins im Signalweg. */
export interface PluginAudioContract {
  /** Kanonische ID - identisch mit Registry, Signalkette und Kanalbelegung. */
  readonly id: string;
  /** Anzeigename („mixerMONK"). */
  readonly name: string;
  readonly role: SignalRole;
  /** Mixer-Kanal 1..8; `null` = kein eigener Kanal (Nachbearbeitung/Utility). */
  readonly channel: number | null;
  readonly format: ChannelFormat;
  readonly inputs: number;
  readonly outputs: number;
  /**
   * Eigene Latenz in Frames bei 48 kHz. Grundlage der PDC: jeder Pfad wird vor
   * dem Summieren auf das Maximum aller Pfade verzögert. `0` = transparent;
   * Werte != 0 MÜSSEN in `latencyNote` begründet sein.
   */
  readonly intrinsicLatencyFrames: number;
  readonly latencyNote?: string;
  /** Darf dieser Knoten umgangen werden? Bypass ist ein Crossfade, kein Disconnect. */
  readonly bypassable: boolean;
  /** Schickt dieser Knoten in den FX-Bus? */
  readonly sendsToFx: boolean;
  readonly fxSendTap?: FxSendTap;
  /** Kann er SYNC gegen Main (UI2-P0-003)? Nur spielende Plugins. */
  readonly syncCapable: boolean;
  /** Geht er durch die Kanalzüge (Quelle) oder direkt in die Summe (Insert)? */
  readonly viaChannel: boolean;
  /**
   * Erzeugt dieser Knoten Ton, ohne dass Audio hineingeht (Generator)?
   *
   * Bewusst NICHT „gibt Audio aus": effect und mixer geben ebenfalls Audio aus,
   * erzeugen aber keines. Gemeint ist der Generator-Fall (Quellen, die aus
   * Samples/Patterns Ton machen). Der Review-Punkt, dass der Name das
   * verwechselbar macht, ist berechtigt - der Kommentar hier ist die Antwort.
   */
  readonly producesAudio: boolean;
  /**
   * Wo greift ein Insert? 'channel' = im Kanalzug (vor der Summe, je Quelle),
   * 'master' = in der Summe (nach dem Merge). `null` fuer Nicht-Inserts.
   * Ohne diese Angabe ist nicht entscheidbar, WO ein Insert sitzt.
   */
  readonly insertScope: 'channel' | 'master' | null;
  /**
   * Ist der Knoten im Audio-Graph 1× instanziiert? IMMER true.
   *
   * Das ist NICHT dasselbe wie „1× von einem Nutzer haltbar" (Besitz, siehe
   * `pluginMode.ts`): der Besitz wechselt zwischen Nutzern, die Instanz bleibt.
   * Die Review hat beides zusammengeworfen; der getrennte Zustand ist wichtig,
   * weil ein Halterwechsel die DSP-Instanz nicht neu bauen darf (Klick).
   */
  readonly singleInstance: true;
}

/**
 * Der Vertrag aller 16 Plugins. Reihenfolge = Kopfreihenfolge der Registry.
 *
 * Kanäle (8): 1 drop · 2 song · 3 drumsampler · 4 syntisampler ·
 *             5 instru · 6 voice · 7 sound · 8 stem
 * `biblio` erzeugt keinen Ton und liegt auf keinem Kanal.
 */
export const PLUGIN_CONTRACTS: readonly PluginAudioContract[] = [
  // ---- DJ ----
  {
    id: 'mixer',
    name: 'mixerMONK',
    role: 'channel',
    channel: null, // er IST die Kanäle, nicht einer davon
    format: 'stereo',
    inputs: 8,     // 8 Kanalzüge
    outputs: 1,    // Summe
    intrinsicLatencyFrames: 0,
    bypassable: false, // immer ON (UI2-P0-001), nicht schließbar
    sendsToFx: false,
    syncCapable: false,
    viaChannel: false,
    producesAudio: true,
    insertScope: null,
    singleInstance: true,
  },
  {
    id: 'drop',
    name: 'dropMONK',
    role: 'source',
    channel: 1,
    format: 'stereo',
    inputs: 0,
    outputs: 1,
    intrinsicLatencyFrames: 0,
    bypassable: true,
    sendsToFx: true,
    fxSendTap: 'post',
    syncCapable: true,
    viaChannel: true,
    producesAudio: true,
    insertScope: null,
    singleInstance: true,
  },
  {
    id: 'song',
    name: 'songMONK',
    role: 'source',
    channel: 2,
    format: 'stereo',
    inputs: 0,
    outputs: 1,
    intrinsicLatencyFrames: 0,
    bypassable: true,
    sendsToFx: true,
    fxSendTap: 'post',
    syncCapable: true,
    viaChannel: true,
    producesAudio: true,
    insertScope: null,
    singleInstance: true,
  },
  {
    id: 'effect',
    name: 'effectMONK',
    role: 'fxReturn',
    channel: null,
    format: 'stereo',
    inputs: 1,   // FX-Bus
    outputs: 1,  // Returns in die Summe
    intrinsicLatencyFrames: 0,
    bypassable: true,
    sendsToFx: false, // er IST der FX-Bus
    syncCapable: false,
    viaChannel: false,
    producesAudio: false,
    insertScope: null,
    singleInstance: true,
  },
  // ---- PRODUCING ----
  {
    id: 'syntisampler',
    name: 'syntisamplerMONK',
    role: 'source',
    channel: 4,
    format: 'stereo',
    inputs: 0,
    outputs: 1,
    intrinsicLatencyFrames: 0,
    bypassable: true,
    sendsToFx: true,
    fxSendTap: 'post',
    syncCapable: true,
    viaChannel: true,
    producesAudio: true,
    insertScope: null,
    singleInstance: true,
  },
  {
    id: 'drumsampler',
    name: 'drumsamplerMONK',
    role: 'source',
    channel: 3,
    format: 'stereo',
    inputs: 0,
    outputs: 1,
    intrinsicLatencyFrames: 0,
    bypassable: true,
    sendsToFx: true,
    fxSendTap: 'post',
    syncCapable: true,
    viaChannel: true,
    producesAudio: true,
    insertScope: null,
    singleInstance: true,
  },
  {
    id: 'instru',
    name: 'instruMONK',
    role: 'source',
    channel: 5,
    format: 'stereo',
    inputs: 0,
    outputs: 1,
    intrinsicLatencyFrames: 0,
    bypassable: true,
    sendsToFx: true,
    fxSendTap: 'post',
    syncCapable: true,
    viaChannel: true,
    producesAudio: true,
    insertScope: null,
    singleInstance: true,
  },
  {
    id: 'biblio',
    name: 'biblioMONK',
    role: 'utility',
    channel: null,
    format: 'stereo',
    inputs: 0,
    outputs: 0, // kein Ton: lädt in andere Plugins
    intrinsicLatencyFrames: 0,
    bypassable: false,
    sendsToFx: false,
    syncCapable: false,
    viaChannel: false,
    producesAudio: false,
    insertScope: null,
    singleInstance: true,
  },
  // ---- AI ----
  {
    id: 'voice',
    name: 'voiceMONK',
    role: 'source',
    channel: 6,
    format: 'mono', // Stimme ist einkanalig, wird im Kanalzug auf Stereo gezogen
    inputs: 0,
    outputs: 1,
    intrinsicLatencyFrames: 0,
    latencyNote: 'TTS/Gesang kommt vom Server; die Latenz liegt in der Erzeugung, nicht im Knoten.',
    bypassable: true,
    sendsToFx: true,
    fxSendTap: 'post',
    syncCapable: true,
    viaChannel: true,
    producesAudio: true,
    insertScope: null,
    singleInstance: true,
  },
  {
    id: 'sound',
    name: 'soundMONK',
    role: 'source',
    channel: 7,
    format: 'stereo',
    inputs: 0,
    outputs: 1,
    intrinsicLatencyFrames: 0,
    bypassable: true,
    sendsToFx: true,
    fxSendTap: 'post',
    syncCapable: true,
    viaChannel: true,
    producesAudio: true,
    insertScope: null,
    singleInstance: true,
  },
  {
    id: 'stem',
    name: 'stemMONK',
    role: 'source',
    channel: 8,
    format: 'stereo',
    inputs: 0,
    outputs: 1,
    intrinsicLatencyFrames: 0,
    latencyNote:
      'Time-Stretch/Warp laeuft im Knoten; die Latenz haengt vom Verfahren ab und ist ' +
      'hier NICHT festgeschrieben, weil sie zur Laufzeit variiert. Ein konkreter Wert ' +
      'gehoert gemessen, nicht geraten (offener Punkt UI2-P0-003-F1).',
    bypassable: true,
    sendsToFx: true,
    fxSendTap: 'post',
    syncCapable: true,
    viaChannel: true,
    producesAudio: true,
    insertScope: null,
    singleInstance: true,
  },
  {
    id: 'spatial',
    name: 'spatialMONK',
    role: 'insert',
    channel: null,
    format: 'stereo',
    inputs: 1,
    outputs: 1,
    intrinsicLatencyFrames: 0,
    latencyNote: 'Pan/Distanz/Hoehe sind reine Gain-/Delay-freie Positionsrechnung im Kanalzug.',
    bypassable: true,
    sendsToFx: false,
    syncCapable: false,
    viaChannel: false,
    producesAudio: false,
    insertScope: 'channel',
    singleInstance: true,
  },
  // ---- MASTERING ----
  {
    id: 'eq',
    name: 'eqMONK',
    role: 'insert',
    channel: null,
    format: 'stereo',
    inputs: 1,
    outputs: 1,
    intrinsicLatencyFrames: 0,
    latencyNote: 'IIR-Biquads sind latenzfrei (kein Lookahead).',
    bypassable: true,
    sendsToFx: false,
    syncCapable: false,
    viaChannel: false,
    producesAudio: false,
    insertScope: 'master',
    singleInstance: true,
  },
  {
    id: 'dsp',
    name: 'dspMONK',
    role: 'insert',
    channel: null,
    format: 'stereo',
    inputs: 1,
    outputs: 1,
    intrinsicLatencyFrames: 0,
    latencyNote:
      'Das Gate ist ein AudioWorklet ohne Lookahead; der Limiter arbeitet mit ' +
      'Lookahead, dessen Tiefe aber im Mastering liegt (siehe `master`).',
    bypassable: true,
    sendsToFx: false,
    syncCapable: false,
    viaChannel: false,
    producesAudio: false,
    insertScope: 'master',
    singleInstance: true,
  },
  {
    id: 'master',
    name: 'masterMONK',
    role: 'insert',
    channel: null,
    format: 'stereo',
    inputs: 1,
    outputs: 1,
    // Der Mastering-Lookahead ist der EINZIGE echte Latenz-Beitrag im System.
    // 5 ms bei 48 kHz = 240 Samples. Quelle: v2Pdc.ts (V2_MASTERING_LOOKAHEAD_SEC).
    intrinsicLatencyFrames: 240,
    latencyNote:
      'Lookahead des Limiters, 5 ms bei 48 kHz. Das ist der Bezugswert, um den ' +
      'alle anderen Pfade kompensiert werden (v2Pdc.ts). Nicht aendern ohne die ' +
      'PDC-Kompensation mitzuziehen.',
    bypassable: true,
    sendsToFx: false,
    syncCapable: false,
    viaChannel: false,
    producesAudio: false,
    insertScope: 'master',
    singleInstance: true,
  },
  {
    id: 'record',
    name: 'recordMONK',
    role: 'recorder',
    channel: null,
    format: 'stereo',
    inputs: 1,
    outputs: 1, // Durchleitung + Abgriff
    intrinsicLatencyFrames: 0,
    latencyNote: 'Reiner Abgriff: das Signal wird durchgeleitet, nicht verzoegert.',
    bypassable: false, // ein Recorder, der "aus" ist, nimmt nicht auf - er verändert nichts
    sendsToFx: false,
    syncCapable: false,
    viaChannel: false,
    producesAudio: false,
    insertScope: null,
    singleInstance: true,
  },
];

/**
 * Die ENGINE-SAMPLERATE, auf die sich `intrinsicLatencyFrames` bezieht.
 *
 * Die Werte im Vertrag sind Frames, keine Sekunden - sie gelten nur bei genau
 * dieser Rate. 48 kHz ist die Invariante des Projekts (gleiche Zahl in
 * `v2Pdc.ts`: 5 ms ≙ 240 Frames). Wer die Engine-Rate aendert, MUSS die
 * Latenzwerte umrechnen; der Test haelt die Kopplung fest.
 */
export const CONTRACT_SAMPLE_RATE = 48000;

/** Der Mastering-Lookahead in Sekunden - die Quelle der 240 Frames. */
export const MASTERING_LOOKAHEAD_SEC = 0.005;

/** Lookahead in Frames bei beliebiger Rate (fuer andere Sampleraten). */
export function masteringLookaheadFrames(sampleRate = CONTRACT_SAMPLE_RATE): number {
  return Math.round(MASTERING_LOOKAHEAD_SEC * sampleRate);
}

/** Nachschlagen per ID. */
export const CONTRACT_BY_ID: Readonly<Record<string, PluginAudioContract>> =
  Object.freeze(Object.fromEntries(PLUGIN_CONTRACTS.map((c) => [c.id, c])));

/** Die 8 Quellen, die über die Kanalzüge laufen (biblio nicht - kein Ton). */
export const CHANNEL_SOURCES: readonly PluginAudioContract[] =
  PLUGIN_CONTRACTS.filter((c) => c.viaChannel);

/** Die Kanalbelegung 1..8 aus dem Vertrag - die EINE Quelle für `pluginChannelMap`. */
export function channelMapFromContract(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const c of PLUGIN_CONTRACTS) {
    if (c.channel !== null) out[c.channel] = c.id;
  }
  return out;
}

/** Alle Plugins, die SYNC gegen Main koennen (UI2-P0-003). */
export function syncCapableIds(): string[] {
  return PLUGIN_CONTRACTS.filter((c) => c.syncCapable).map((c) => c.id);
}

/**
 * Die serielle Master-Kette (Insert-Pfad) und die parallele Effektebene (Return).
 *
 * Die REIHENFOLGE wird hier ausgeschrieben, nicht aus der Vertrags-Reihenfolge
 * gefiltert: Rollen sagen, WAS ein Knoten ist, nicht WO er in der Kette steht.
 * Ein `filter()` ueber PLUGIN_CONTRACTS liefert die Vertrags-Reihenfolge und
 * damit `spatial -> eq -> dsp -> master` - falsch. Gefordert ist die Reihenfolge
 * des Signalwegs (V2_UI_VERKABELUNG.md, signalkette).
 *
 * `insertScope`: 'channel' = im Kanalzug (vor der Summe), 'master' = in der
 * Summe (nach dem Merge). Ohne diese Angabe ist nicht entscheidbar, wo ein
 * Insert greift - und `spatial` braucht beides nicht gleichzeitig.
 */
export function signalTopology(): {
  channelInserts: string[];
  masterInserts: string[];
  fxReturns: string[];
  recorders: string[];
} {
  return {
    // Im Kanalzug, vor der Mixer-Summe: Pan/Distanz/Hoehe je Quelle.
    channelInserts: ['spatial'],
    // In der Master-Summe, nach dem Merge - strikt in dieser Reihenfolge.
    masterInserts: ['eq', 'dsp', 'master'],
    // Parallele Effektebene (Send/Return). NUR effect.
    fxReturns: ['effect'],
    recorders: ['record'],
  };
}

/**
 * PDC: die Pfadverzögerung, um die ein Signal vor dem Summieren zu verzögern,
 * damit es phasengleich mit dem langsamsten Pfad ankommt.
 *
 * Bewusst als reine Funktion: sie beschreibt die REGEL, nicht die Ausführung.
 * Die Ausführung (Verzögerungsleitung im Audio-Thread) gehört in den Graph.
 */
/**
 * Latenz eines SERIELLEN Pfads: die Summen der Knoten auf dem Weg.
 *
 * Ein Pfad ist eine Kette - liegen zwei Knoten mit je 100 Frames hintereinander,
 * verzoegert der Pfad um 200. (Frueher stand hier `Math.max`; das war falsch und
 * fiel nicht auf, weil nur `master` ueberhaupt Latenz hat. Der Review-Punkt ist
 * berechtigt.)
 */
export function pathLatencyFrames(ids: readonly string[]): number {
  return ids.reduce((sum, id) => sum + (CONTRACT_BY_ID[id]?.intrinsicLatencyFrames ?? 0), 0);
}

/**
 * Latenz am MERGE: das Maximum der beteiligten Pfade.
 *
 * Erst hier wird `max` richtig: parallele Pfade (Kanal i gegen Kanal j, Dry
 * gegen Wet) kommen unterschiedlich spaet an; der laengsamste gibt das Mass, um
 * das alle anderen verzoegert werden.
 */
export function mergeLatencyFrames(pathLatencies: readonly number[]): number {
  return pathLatencies.reduce((max, l) => Math.max(max, l), 0);
}

/** Kompensation, die ein Pfad gegenüber der Merge-Referenz braucht (nie negativ). */
export function compensationFrames(pathLatency: number, referenceFrames: number): number {
  return Math.max(0, referenceFrames - pathLatency);
}
