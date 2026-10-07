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
  /** Erzeugt selbst Ton (im Gegensatz zu reiner Steuerung wie biblio). */
  readonly producesAudio: boolean;
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
    singleInstance: true,
  },
];

/** Nachschlagen per ID. */
export const CONTRACT_BY_ID: Readonly<Record<string, PluginAudioContract>> =
  Object.freeze(Object.fromEntries(PLUGIN_CONTRACTS.map((c) => [c.id, c])));

/** Die 9 Quellen, die über die Kanalzüge laufen (in Signalreihenfolge). */
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
 * Die serielle Master-Kette (Insert-Pfad) und die parallele Effektebene (Return)
 * - getrennt, weil ein Plugin nie beides sein darf (Review-Punkt 6.5).
 */
export function signalTopology() {
  const inserts = PLUGIN_CONTRACTS.filter((c) => c.role === 'insert').map((c) => c.id);
  const fxReturns = PLUGIN_CONTRACTS.filter((c) => c.role === 'fxReturn').map((c) => c.id);
  const recorders = PLUGIN_CONTRACTS.filter((c) => c.role === 'recorder').map((c) => c.id);
  return { inserts, fxReturns, recorders };
}

/**
 * PDC: die Pfadverzögerung, um die ein Signal vor dem Summieren zu verzögern,
 * damit es phasengleich mit dem langsamsten Pfad ankommt.
 *
 * Bewusst als reine Funktion: sie beschreibt die REGEL, nicht die Ausführung.
 * Die Ausführung (Verzögerungsleitung im Audio-Thread) gehört in den Graph.
 */
export function pathLatencyFrames(ids: readonly string[]): number {
  return ids.reduce((max, id) => {
    const c = CONTRACT_BY_ID[id];
    // Bypass-ter Knoten zaehlt MIT: sein Crossfade haelt die Latenz (Review 6.3).
    return Math.max(max, c?.intrinsicLatencyFrames ?? 0);
  }, 0);
}

/** Kompensation, die ein Pfad gegenüber dem Referenzpfad braucht (nie negativ). */
export function compensationFrames(ids: readonly string[], referenceFrames: number): number {
  return Math.max(0, referenceFrames - pathLatencyFrames(ids));
}
