import { describe, expect, it } from 'vitest';
import {
  PLUGIN_CONTRACTS,
  CONTRACT_BY_ID,
  CHANNEL_SOURCES,
  syncCapableIds,
  signalTopology,
  pathLatencyFrames,
  compensationFrames,
} from '../src/plugins/pluginContract';
import { SIGNAL_CHAIN, SIGNAL_CHAIN_ORDER } from '../src/plugins/signalChain';
import { pluginAudioChannels } from '../src/core/audio/pluginChannelMap';

/**
 * B0: Der Audio-Vertrag ist die EINE Quelle. Dieser Test haelt ihn mit den
 * Stellen zusammen, die ihn bisher getrennt beschrieben (Registry, Signalweg,
 * Kanalbelegung). Driftet eine der drei, faellt es hier auf - statt im Klang.
 */

describe('pluginContract – Vollstaendigkeit', () => {
  it('beschreibt genau 16 Plugins', () => {
    expect(PLUGIN_CONTRACTS).toHaveLength(16);
  });

  it('hat eindeutige IDs', () => {
    const ids = PLUGIN_CONTRACTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('jedes Plugin ist im Audio-Graph genau 1x instanziiert', () => {
    // Review 6.4: "1x haltbar" (Besitz) und "1x instanziiert" (AudioNode) sind
    // zwei Zustaende. Die Instanz ist immer einfach - der Besitz wechselt.
    for (const c of PLUGIN_CONTRACTS) {
      expect(c.singleInstance, `${c.id} muss singleInstance sein`).toBe(true);
    }
  });

  it('nicht-latenzfreie Knoten begruenden ihre Latenz', () => {
    for (const c of PLUGIN_CONTRACTS) {
      if (c.intrinsicLatencyFrames !== 0) {
        expect(c.latencyNote, `${c.id} hat Latenz ohne Begruendung`).toBeTruthy();
      }
    }
  });
});

describe('pluginContract – Kanalbelegung deckt sich mit pluginAudioChannels', () => {
  it('die 8 Kanaele aus dem Vertrag sind identisch mit der Routing-Matrix', () => {
    // Die Routing-Matrix fuehrt `channel1`..`channel8`; der Vertrag fuehrt 1..8.
    // Beide muessen dieselbe Zuordnung nennen - sonst landet Ton auf dem
    // falschen Kanalzug, ohne dass ein Test es merkt.
    for (const c of PLUGIN_CONTRACTS) {
      const targets = pluginAudioChannels(c.id);
      if (c.channel === null) {
        expect(targets, `${c.id} darf keinen Kanal haben`).toEqual([]);
      } else {
        expect(targets, `${c.id} muss auf channel${c.channel} liegen`).toEqual([`channel${c.channel}`]);
      }
    }
  });

  it('genau 8 Kanaele, lueckenlos 1..8', () => {
    const chans = CHANNEL_SOURCES.map((c) => c.channel).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(chans).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('8 spielende Quellen + biblio ohne Ton', () => {
    // V2_UI_VERKABELUNG.md nennt 9 Eintraege in der Stufe "Quellen" - biblio
    // erzeugt aber keinen Ton ("biblio erzeugt keinen Ton; es laedt in die
    // anderen Plugins"). Deshalb: 8 spielende Quellen, jede auf genau einem
    // Kanal, und biblio als Utility daneben.
    const sources = PLUGIN_CONTRACTS.filter((c) => c.role === 'source');
    expect(sources).toHaveLength(8);
    expect(CHANNEL_SOURCES).toHaveLength(8);
    expect(sources.every((c) => c.producesAudio)).toBe(true);
    expect(sources.every((c) => c.channel !== null)).toBe(true);
    const biblio = CONTRACT_BY_ID['biblio'];
    expect(biblio.channel).toBeNull();
    expect(biblio.producesAudio).toBe(false);
    expect(biblio.role).toBe('utility');
  });
});

describe('pluginContract – Signalweg deckt sich mit signalChain', () => {
  it('der Vertrag nennt keinen Knoten, den der Signalweg nicht kennt', () => {
    const imSignalweg = new Set(SIGNAL_CHAIN_ORDER as string[]);
    for (const c of PLUGIN_CONTRACTS) {
      if (c.role === 'utility') continue; // biblio liegt bewusst nicht im Weg
      expect(imSignalweg.has(c.id), `${c.id} fehlt im Signalweg`).toBe(true);
    }
  });

  it('Quellen und Nachbearbeitung stehen in der vom Signalweg erwarteten Stufe', () => {
    const stageOf = (id: string) =>
      SIGNAL_CHAIN.find((s) => (s.plugins as string[]).includes(id))?.id ?? null;
    for (const c of PLUGIN_CONTRACTS) {
      if (c.role === 'source' || c.role === 'utility') continue;
      const stage = stageOf(c.id);
      if (c.role === 'channel') expect(stage, c.id).toBe('mixer');
      if (c.role === 'insert' || c.role === 'fxReturn') {
        expect(stage, `${c.id} muss in der Nachbearbeitung liegen`).toBe('processing');
      }
      if (c.role === 'recorder') expect(stage, c.id).toBe('recorder');
    }
  });
});

describe('pluginContract – fachliche Regeln (Review 2026-10-07)', () => {
  it('FX-Bus ist NUR effect – spatial liegt im Kanalzug (Doku: pan → Distanz → Höhe)', () => {
    // V2_UI_VERKABELUNG.md, Kanalzug: "→ fader → GATE → mute/solo →
    // crossfader → pan → Distanz → Höhe → Mixer-Summe". spatial sitzt damit IM
    // Kanalzug, nicht im FX-Bus. Nur `effect` ist der FX-Bus ("FX-Bus → 5
    // parallele Effekte → Returns → zurück in die Summe"). Ein erster Entwurf
    // dieses Vertrags hatte spatial faelschlich als fxReturn - das haette den
    // Klang geaendert (Spatialisierung als Send statt im Kanal).
    const { inserts, fxReturns } = signalTopology();
    expect(fxReturns).toEqual(['effect']);
    expect(inserts.sort()).toEqual(['dsp', 'eq', 'master', 'spatial']);
  });

  it('mixerMONK ist nicht bypassbar und nicht sync-faehig', () => {
    const mixer = CONTRACT_BY_ID['mixer'];
    expect(mixer.bypassable).toBe(false);
    expect(mixer.syncCapable).toBe(false);
    expect(mixer.role).toBe('channel');
  });

  it('nur spielende Plugins koennen SYNC – und es sind die 8 mit Startlogik', () => {
    // UI2-P0-003: SYNC gehoert zu drop, song, syntisampler, drumsampler,
    // instru, voice, sound, stem. UI2-P0-003-F1: bei song/voice/stem fehlt die
    // Startlogik im Adapter – der Vertrag haelt trotzdem fest, dass sie es SOLLEN.
    expect(syncCapableIds().sort()).toEqual(
      ['drop', 'drumsampler', 'instru', 'song', 'sound', 'stem', 'syntisampler', 'voice'].sort(),
    );
  });

  it('biblio erzeugt keinen Ton und hat keine Ausgaenge', () => {
    const biblio = CONTRACT_BY_ID['biblio'];
    expect(biblio.producesAudio).toBe(false);
    expect(biblio.outputs).toBe(0);
    expect(biblio.role).toBe('utility');
  });

  it('record ist ein Abgriff: er verzoegert nichts', () => {
    const rec = CONTRACT_BY_ID['record'];
    expect(rec.role).toBe('recorder');
    expect(rec.intrinsicLatencyFrames).toBe(0);
  });
});

describe('pluginContract – PDC-Regeln', () => {
  it('der Mastering-Lookahead ist der einzige Latenz-Beitrag', () => {
    const mitLatenz = PLUGIN_CONTRACTS.filter((c) => c.intrinsicLatencyFrames !== 0);
    expect(mitLatenz.map((c) => c.id)).toEqual(['master']);
    expect(CONTRACT_BY_ID['master'].intrinsicLatencyFrames).toBe(240); // 5 ms @ 48 kHz
  });

  it('Pfadlatenz ist das Maximum der beteiligten Knoten', () => {
    expect(pathLatencyFrames(['drop', 'mixer'])).toBe(0);
    expect(pathLatencyFrames(['drop', 'eq', 'master'])).toBe(240);
    expect(pathLatencyFrames([])).toBe(0);
    expect(pathLatencyFrames(['unbekannt'])).toBe(0);
  });

  it('ein Bypass-ter Knoten zaehlt MIT (Crossfade haelt die Latenz)', () => {
    // Review 6.3: Bypass ist ein Dry/Wet-Crossfade, kein Disconnect. Ein
    // disconnecteter Master wuerde die 240 Frames verlieren und alles verschieben.
    const mitMaster = pathLatencyFrames(['drop', 'master']);
    const ohneMaster = pathLatencyFrames(['drop']);
    expect(mitMaster).toBe(240);
    expect(ohneMaster).toBe(0);
  });

  it('Kompensation ist nie negativ und gleicht auf die Referenz an', () => {
    const reference = pathLatencyFrames(['drop', 'eq', 'master']); // 240
    expect(compensationFrames(['drop'], reference)).toBe(240);
    expect(compensationFrames(['drop', 'master'], reference)).toBe(0);
    expect(compensationFrames(['drop', 'eq', 'master'], reference)).toBe(0);
    // Ein "schnellerer" Pfad als die Referenz ergibt keine negative Verzoegerung.
    expect(compensationFrames(['drop'], 0)).toBe(0);
  });
});
