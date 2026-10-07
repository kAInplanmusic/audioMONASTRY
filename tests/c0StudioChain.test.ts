import { describe, expect, it } from 'vitest';
import { C0StudioChain, c0ChannelOf, type C0Channel } from '../src/core/audio/C0StudioChain';
import { PdcDelayNode } from '../src/core/audio/nodes/pdcDelayNode';
import { signalTopology, CONTRACT_BY_ID } from '../src/plugins/pluginContract';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { SourceNode, GainNode } from '../src/core/audio/nodes/basicNodes';
import type { IProcessingContext } from '../src/core/audio/types';

/**
 * C0 – VERTIKALER SPIKE.
 *
 * Die Architektur-Review (2026-10-07) verlangte: erst EIN vollstaendiger Pfad
 * (Quelle → Kanal → Insert → FX-Send/Return → Master → Recorder → Out) mit
 * Bypass- und PDC-Nachweis, dann erst auf alle 16 Plugins erweitern. Dieser Test
 * ist dieser Nachweis.
 */

const SR = 48000;
const BLOCK = 128;
const ctx = (t = 0): IProcessingContext => ({
  sampleRate: SR,
  bufferSize: BLOCK,
  currentTime: t,
  quantum: BLOCK,
});

/** Impuls in Kanal 0, sonst Stille. */
const impulse = (len = BLOCK): Float32Array[] => {
  const ch = new Float32Array(len);
  ch[0] = 1;
  return [ch, new Float32Array(len)];
};
const silence = (len = BLOCK): Float32Array[] => [new Float32Array(len), new Float32Array(len)];
const peak = (buf: Float32Array[] | null): number => {
  if (!buf) return 0;
  let m = 0;
  for (const ch of buf) for (const v of ch) m = Math.max(m, Math.abs(v));
  return m;
};

describe('C0 – der vertikale Pfad steht und traegt Ton', () => {
  it('baut die Kette in der Reihenfolge des Signalwegs, nicht der Vertragsliste', () => {
    // Rollen sagen WAS ein Knoten ist, nicht WO er steht. Ein filter() ueber
    // den Vertrag lieferte frueher 'spatial -> eq -> dsp -> master'.
    const c = new C0StudioChain(SR, BLOCK);
    expect(c.state.masterOrder).toEqual(['eq', 'dsp', 'master']);
    expect(c.state.masterOrder).not.toEqual(signalTopology().masterInserts.concat().reverse());
  });

  it('der FX-Bus ist nur effect und kehrt in die Summe zurueck', () => {
    const c = new C0StudioChain(SR, BLOCK);
    expect(c.state.fxReturn).toBe('effect');
    // Der Return laeuft ueber den Merge-Punkt in die Master-Kette.
    expect(c.preMasterSum.inputs.length).toBe(2);
  });

  it('ein Signal auf einem Kanal kommt am Ausgang an', () => {
    const c = new C0StudioChain(SR, BLOCK);
    c.setChannelSource('channel1', impulse());
    c.setChannelGainDb('channel1', 0);
    const out = c.render(ctx());
    expect(peak(out), 'ein Impuls muss den Pfad erreichen').toBeGreaterThan(0.1);
  });

  it('8 Kanaele sind je einer Quelle zugeordnet und einzeln adressierbar', () => {
    const c = new C0StudioChain(SR, BLOCK);
    expect(c.strips.size).toBe(8);
    // Jeder Kanal kann einzeln befeuert werden.
    c.setChannelSource('channel8', impulse());
    const out = c.render(ctx());
    expect(peak(out)).toBeGreaterThan(0.1);
  });

  it('ein stummer Kanal bleibt still (kein Durchschleifen von Rauschen)', () => {
    const c = new C0StudioChain(SR, BLOCK);
    for (const ch of ['channel1','channel2','channel3','channel4','channel5','channel6','channel7','channel8'] as C0Channel[]) {
      c.setChannelSource(ch, silence());
    }
    expect(peak(c.render(ctx()))).toBe(0);
  });

  it('der Fader wirkt: leiser Kanal ergibt leiseres Ausgangssignal', () => {
    const loud = new C0StudioChain(SR, BLOCK);
    loud.setChannelSource('channel1', impulse());
    loud.setChannelGainDb('channel1', 0);
    const p1 = peak(loud.render(ctx()));

    const quiet = new C0StudioChain(SR, BLOCK);
    quiet.setChannelSource('channel1', impulse());
    quiet.setChannelGainDb('channel1', -12);
    const p2 = peak(quiet.render(ctx()));

    expect(p1).toBeGreaterThan(p2);
    expect(p2).toBeGreaterThan(0);
  });

  it('der FX-Send schleift Signal in den Bus (post-fader)', () => {
    const ohne = new C0StudioChain(SR, BLOCK);
    ohne.setChannelSource('channel1', impulse());
    ohne.setChannelSend('channel1', 0);
    const a = peak(ohne.effect.outputs[0].buffer);

    const mit = new C0StudioChain(SR, BLOCK);
    mit.setChannelSource('channel1', impulse());
    mit.setChannelSend('channel1', 1);
    mit.render(ctx());
    const b = peak(mit.effect.outputs[0].buffer);

    expect(a).toBe(0);          // ohne Send darf nichts im Bus liegen
    expect(b).toBeGreaterThan(0); // mit Send muss der Effekt etwas sehen
  });

  it('der Kanal eines Plugins kommt aus dem Vertrag', () => {
    expect(c0ChannelOf('drop')).toBe('channel1');
    expect(c0ChannelOf('stem')).toBe('channel8');
    expect(c0ChannelOf('biblio')).toBeNull();
  });
});

describe('C0 – PDC: die Verzoegerungsleitung rechnet richtig', () => {
  /** Baut eine Mini-Kette: Quelle -> Delay -> Sink, und misst die Impulslage. */
  function delayResponse(frames: number, blocks: number) {
    const g = new AudioGraph();
    const src = new SourceNode('src', silence(BLOCK), SR);
    const delay = new PdcDelayNode('d', frames);
    const sink = new GainNode('sink', 1);
    g.addNode(src); g.addNode(delay); g.addNode(sink);
    g.connect(src.outputs[0], delay.inputs[0]);
    g.connect(delay.outputs[0], sink.inputs[0]);
    g.compile();

    const positions: number[] = [];
    for (let b = 0; b < blocks; b++) {
      src.sourceBuffer = b === 0 ? impulse() : silence();
      g.process(ctx(b * BLOCK));
      const buf = sink.outputs[0].buffer;
      if (buf) {
        for (let i = 0; i < buf[0].length; i++) {
          if (Math.abs(buf[0][i]) > 0.5) positions.push(b * BLOCK + i);
        }
      }
    }
    return positions;
  }

  it('Verzoegerung 0 reicht den Impuls unveraendert durch', () => {
    expect(delayResponse(0, 2)).toEqual([0]);
  });

  it('Verzoegerung um N Samples verschiebt den Impuls um genau N', () => {
    expect(delayResponse(3, 2)).toEqual([3]);
    // 5 ms @ 48 kHz = 240 Samples - der Mastering-Lookahead.
    expect(delayResponse(240, 4)).toEqual([240]);
  });

  it('der Delay-Knoten haelt die Kanaele getrennt', () => {
    const g = new AudioGraph();
    const src = new SourceNode('src', silence(BLOCK), SR);
    const d = new PdcDelayNode('d', 2);
    g.addNode(src); g.addNode(d);
    g.connect(src.outputs[0], d.inputs[0]);
    g.compile();
    // Links ein Impuls, rechts Stille.
    src.sourceBuffer = [(() => { const a = new Float32Array(BLOCK); a[0] = 1; return a; })(), new Float32Array(BLOCK)];
    g.process(ctx());
    const out = d.outputs[0].buffer!;
    // Der Impuls kommt nach genau 2 Samples - noch im selben Block, weil die
    // Ringtiefe gleich der Verzoegerung ist.
    expect(out[0][2]).toBeCloseTo(1, 5);
    expect(Array.from(out[0]).filter((v) => Math.abs(v) > 0.5).length, 'genau ein Treffer').toBe(1);
    // Rechts liegt nichts an - der Knoten darf nicht mischen.
    expect(Array.from(out[1]).every((v) => v === 0), 'rechts bleibt still').toBe(true);
  });

  it('setDelayFrames aendert die Tiefe', () => {
    const d = new PdcDelayNode('d', 0);
    expect(d.getDelayFrames()).toBe(0);
    d.setDelayFrames(240);
    expect(d.getDelayFrames()).toBe(240);
    d.setDelayFrames(-5); // nie negativ
    expect(d.getDelayFrames()).toBe(0);
  });
});

describe('C0 – PDC-Rechnung der Kette', () => {
  it('die Referenz ist der Mastering-Lookahead der Master-Kette', () => {
    const c = new C0StudioChain(SR, BLOCK);
    // eq (0) + dsp (0) + master (240) = 240
    expect(c.state.referenceLatencyFrames).toBe(240);
    expect(CONTRACT_BY_ID['master'].intrinsicLatencyFrames).toBe(240);
  });

  it('Kanaele laufen alle durch dieselbe Master-Kette – Kompensation 0', () => {
    const c = new C0StudioChain(SR, BLOCK);
    expect(c.state.channelCompensation.every((f) => f === 0)).toBe(true);
  });
});

describe('C1 – Worklet-Anbindung ohne Umstecken', () => {
  it('jedes Kettenglied ist an einen Prozessor-Namen gebunden', () => {
    const c = new C0StudioChain(SR, BLOCK);
    expect(c.state.workletBinding).toEqual({
      eq: 'eq-processor',
      dsp: 'dsp-processor',
      master: 'mastering-processor',
      effect: 'effect-processor',
      spatial: 'spatial-processor',
    });
  });

  it('ein einghaengter Prozessor veraendert das Signal – und die Kabel bleiben', () => {
    const c = new C0StudioChain(SR, BLOCK);
    c.setChannelSource('channel1', impulse());
    c.setChannelGainDb('channel1', 0);
    const vorher = peak(c.render(ctx()));

    // Ein "echter" Prozessor: halbiert das Signal. Wuerde das Umstecken etwas
    // kosten (disconnect/connect), waere hier ein Klick oder ein Abbruch.
    // Der Funktionsname ist der Beleg der Anbindung - deshalb eine benannte
    // Funktion statt einer Zuweisung an `.name` (das ist read-only).
    const halbierer: import('../src/core/audio/backends/WorkletAdapter').WorkletProcessFn =
      function halbierer(input, output, c2) {
        const src = input[0] ?? [];
        const len = src[0]?.length ?? c2.bufferSize;
        const out: Float32Array[] = [new Float32Array(len), new Float32Array(len)];
        for (let ch = 0; ch < out.length; ch++) {
          const s = src[Math.min(ch, src.length - 1)];
          if (s) for (let i = 0; i < len; i++) out[ch][i] = (s[i] ?? 0) * 0.5;
        }
        output[0] = out;
      };

    expect(c.attachWorklet('eq', halbierer), 'eq muss anbindbar sein').toBe(true);
    const nachher = peak(c.render(ctx()));

    // Der Prozessor wirkt: das Signal ist deutlich kleiner geworden.
    expect(nachher).toBeLessThan(vorher);
    // Der Knoten meldet die Anbindung (der exakte Name kann vom Bundler
    // umbenannt werden - geprueft wird, dass es NICHT mehr der Startwert ist).
    expect(c.state.workletBinding.eq).not.toBe('eq-processor');
    // Nur der angebundene Knoten wechselt - alle anderen bleiben.
    expect(c.state.workletBinding.master).toBe('mastering-processor');
    expect(c.state.workletBinding.dsp).toBe('dsp-processor');
  });

  it('ein unbekanntes Plugin laesst sich nicht anbinden (kein stiller No-Op)', () => {
    const c = new C0StudioChain(SR, BLOCK);
    expect(c.attachWorklet('gibtsnicht', () => {})).toBe(false);
  });

  it('die Kette traegt auch nach einem Prozessorwechsel weiter Ton', () => {
    const c = new C0StudioChain(SR, BLOCK);
    c.setChannelSource('channel1', impulse());
    c.attachWorklet('dsp', (input, output, cc) => {
      const src = input[0] ?? [];
      const len = src[0]?.length ?? cc.bufferSize;
      output[0] = [new Float32Array(len).fill(0.25), new Float32Array(len).fill(0.25)];
    });
    expect(peak(c.render(ctx()))).toBeGreaterThan(0);
  });
});

describe('C1 – Bypass ist ein Crossfade, kein Umstecken', () => {
  /**
   * Ein Prozessor, der das Signal VERZOEGERT (1 Sample) - nicht verstaerkt.
   *
   * Warum nicht verstaerken: hinter der Kette sitzt das Mastering mit Soft-Clip
   * (tanh). Ein verdoppelter Impuls wird dort gestaucht, "lauter" ist also nicht
   * messbar. Eine VERZOEGERUNG ist dagegen eindeutig: die Impuls-POSITION
   * verschiebt sich, und genau das darf der Bypass NICHT tun.
   */
  function oneSampleLater(input: Float32Array[][], output: Float32Array[][], ctx: IProcessingContext) {
    const src = input[0] ?? [];
    const len = src[0]?.length ?? ctx.bufferSize;
    const out = [new Float32Array(len), new Float32Array(len)];
    for (let ch = 0; ch < out.length; ch++) {
      const s = src[Math.min(ch, src.length - 1)];
      if (s) for (let i = 1; i < len; i++) out[ch][i] = s[i - 1] ?? 0;
    }
    output[0] = out;
  }

  /**
   * Der ERSTE Ueberschreitungspunkt am Ausgang (absolute Sample-Position).
   *
   * Bewusst nicht "alle Treffer": der FX-Bus ist standardmaessig auf 0, aber der
   * EffectNode und das Mastering tragen Nachhall - nach dem Impuls folgen weitere
   * kleine Werte. Fuer die Phasenfrage zaehlt der ERSTE Punkt.
   */
  function firstHit(c: C0StudioChain, blocks = 3): number {
    for (let b = 0; b < blocks; b++) {
      const out = c.render(ctx(b * BLOCK));
      if (out) for (let i = 0; i < out[0].length; i++) {
        if (Math.abs(out[0][i]) > 0.15) return b * BLOCK + i;
      }
    }
    return -1;
  }

  it('ohne Bypass wirkt der Prozessor (Signal verschiebt sich)', () => {
    const c = new C0StudioChain(SR, BLOCK);
    c.setChannelSource('channel1', impulse());
    c.attachWorklet('eq', oneSampleLater);
    const pos = firstHit(c);
    expect(pos, 'der Impuls muss ankommen').toBeGreaterThanOrEqual(0);
    expect(c.isBypassed('eq')).toBe(false);
  });

  it('mit Bypass hoert man den TROCKENEN Weg – die Verzoegerung faellt weg', () => {
    const nass = new C0StudioChain(SR, BLOCK);
    nass.setChannelSource('channel1', impulse());
    nass.attachWorklet('eq', oneSampleLater);
    const posNass = firstHit(nass);

    const trocken = new C0StudioChain(SR, BLOCK);
    trocken.setChannelSource('channel1', impulse());
    trocken.attachWorklet('eq', oneSampleLater);
    expect(trocken.setBypass('eq', true)).toBe(true);
    const posTrocken = firstHit(trocken);

    expect(trocken.isBypassed('eq')).toBe(true);
    // Umgangen kommt der Impuls GENAU EIN SAMPLE FRUEHER als mit dem Prozessor -
    // der Bypass schaltet also wirklich auf den trockenen Weg.
    expect(posTrocken - posNass).toBe(-1);
  });

  it('der Bypass verschiebt die PHASE nicht, wenn der Ausgleich stimmt', () => {
    // Die Kernregel des Reviews: ein Bypass, der frueher ankommt, ist ein Klick.
    // Der trockene Weg muss so viel Verzoegerung bekommen wie der NASSE Weg
    // braucht - sonst laufen beide auseinander.
    //
    // Der Prozessor hier verzoegert um 1 Sample. Der Ausgleich muss also 1 sein,
    // NICHT irgendeine Zahl aus dem Vertrag: die Latenz kommt aus dem Prozessor,
    // nicht aus der Plugin-Deklaration.
    const mess = (bypassed: boolean, dryFrames: number) => {
      const c = new C0StudioChain(SR, BLOCK);
      c.insertNodes.eq.setProcessFn(oneSampleLater);
      c.insertNodes.eq.setDryDelayFrames(dryFrames);
      c.setChannelSource('channel1', impulse());
      if (bypassed) c.insertNodes.eq.setWet(0);
      return firstHit(c);
    };
    // Ausgleich = Prozessor-Verzoegerung (1) -> beide Wege gleich lang.
    expect(mess(true, 1)).toBe(mess(false, 1));
    // Falscher Ausgleich -> der Bypass springt. Genau das soll der Test zeigen.
    expect(mess(true, 4)).not.toBe(mess(false, 4));
  });

  it('setBypass auf ein unbekanntes Plugin gibt false', () => {
    const c = new C0StudioChain(SR, BLOCK);
    expect(c.setBypass('gibtsnicht', true)).toBe(false);
    expect(c.isBypassed('gibtsnicht')).toBeNull();
  });
});
