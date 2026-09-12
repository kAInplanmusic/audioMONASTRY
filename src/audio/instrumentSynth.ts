/**
 * audioMONASTRY · Instrument-Synth (AUDIO-P1-002 · aus `audioEngine` ausgelagert)
 * =============================================================================
 * Der physikalische/additive InstrumentMONK-Synth (#14) samt Tone.js-Fallback-
 * Stimmen. Moved 1:1 aus `audioEngine`, ohne Verhaltensänderung: dieselben
 * Tone-Ketten, dieselbe Dispose-Gruppe, dasselbe Channel-Routing (channel4
 * bzw. channel2). Nur `ensureChannelNode`/Kanal-Eingang/Master-Bus/Zeit werden
 * hereingereicht – der Zustand (Oszillatoren, Filter, Envelope, Vibrato, Noise)
 * liegt jetzt hier.
 */
import * as Tone from '../core/audio/compat/nativeAudioKit';
import type { InstrumentPatch } from '../data/instrumentSynths';
import type { TrackType } from '../types';

export interface InstrumentSynthDeps {
  ensureChannelNode(track: TrackType): void;
  getChannelInput(track: TrackType): AudioNode | null;
  getMasterBus(): AudioNode | null;
  getCurrentTime(): number;
}

/** Eine fertige Tone-Fallback-Kette (aus `playSynthesisInstrument`). */
export interface InstrumentSynthVoice {
  oscs?: Tone.Oscillator[];
  partialRatios?: number[];
  noise?: Tone.Noise | null;
  vibrato?: Tone.Oscillator | null;
  filter?: Tone.Filter | null;
  envOut?: Tone.Gain | null;
}

export class InstrumentSynth {
  private oscs: Tone.Oscillator[] = [];
  private partialRatios: number[] = [];
  private noise: Tone.Noise | null = null;
  private vibrato: Tone.Oscillator | null = null;
  private filter: Tone.Filter | null = null;
  private envOut: Tone.Gain | null = null;

  constructor(private readonly deps: InstrumentSynthDeps) {}

  /** Ist eine Stimme aufgebaut (Additiv-Patch oder Fallback)? */
  get isReady(): boolean {
    return this.oscs.length > 0;
  }

  /** Baut den additiven Synthesizer aus einem Patch neu auf (channel4). */
  async build(patch: InstrumentPatch): Promise<void> {
    try {
      const vol = new Tone.Gain(0);
      // F1: Instrument-Stimmen über den Kanalzug (channel4) führen.
      this.deps.ensureChannelNode('channel4');
      vol.connect((this.deps.getChannelInput('channel4') ?? this.deps.getMasterBus()) as never);

      const [a, d, s, r] = patch.env;
      const baseEnv = new Tone.AmplitudeEnvelope(a, d, s, r).connect(vol);

      // Additive Obertöne (Sinus je Partial) mit Anblas-/Anschlag-Kurve.
      const partialNodes: Tone.Oscillator[] = [];
      const ratios: number[] = [];
      patch.partials.forEach((p, _i) => {
        // Bei eingebauten Oszillator-Wellen ist die Teilwelle genug;
        // multi-sample-Pattials werden als Detune-Spread additiv gemischt.
        const osc = new Tone.Oscillator(patch.osc);
        osc.frequency.value = 220; // Platzhalter; wird in noteOn präzise gesetzt.
        const g = new Tone.Gain(p.amp / Math.max(1, patch.partials.length));
        osc.connect(g);
        g.connect(baseEnv);
        osc.start();
        partialNodes.push(osc);
        ratios.push(p.ratio);
      });

      // Filter (Resonanz nach Bauart) – Q wird separat am Filter gesetzt
      // (Tone.Filter: drittes Argument ist der Rolloff, nicht die Resonanz-Q).
      const filt = new Tone.Filter(patch.filterFreq, patch.filterType, -12);
      try { (filt as never as { Q: { value: number } }).Q.value = patch.filterQ; } catch { /* Q ggf. nicht verfügbar */ }
      baseEnv.disconnect(vol);
      baseEnv.connect(filt);
      filt.connect(vol);

      // Vibrato: LFO moduliert die Detune aller akustischen Oszillatoren
      // (physiologisch korrekt – Frequenz-Vibrato statt purer Lautheits-Tremolo).
      if (patch.vibratoAmt > 0.01) {
        const lfoOsc = new Tone.Oscillator(patch.vibratoHz, 'sine');
        const lfoGain = new Tone.Gain(patch.vibratoAmt * 80); // Detune in Cents
        lfoOsc.connect(lfoGain);
        partialNodes.forEach((o) => lfoGain.connect((o as never as { detune: never }).detune));
        lfoOsc.start();
        this.vibrato = lfoOsc;
      }

      // Anblas-NOISE für Bläser/Reibung (hochpassgefiltert)
      if (patch.noise > 0.03) {
        const noise = new Tone.Noise('white');
        const noiseEnv = new Tone.AmplitudeEnvelope(a * 0.5, d, s * 0.4, r);
        const hp = new Tone.Filter(patch.filterFreq * 0.6, 'highpass');
        noise.chain(hp, noiseEnv, vol);
        noise.start();
        this.noise = noise;
      }

      this.oscs = partialNodes;
      this.partialRatios = ratios;
      this.filter = filt;
      this.envOut = vol;

      // Basis-Envelope wird beim Note-On getriggert; hier als stabile baseline.
      vol.gain.value = 0.0001;
    } catch (e) {
      console.warn('Instrument-Synth nicht aufgebaut:', e);
      this.dispose();
    }
  }

  /** Übernimmt eine fertige Fallback-Kette aus `playSynthesisInstrument`. */
  adopt(voice: InstrumentSynthVoice): void {
    if (voice.oscs !== undefined) this.oscs = voice.oscs;
    if (voice.partialRatios !== undefined) this.partialRatios = voice.partialRatios;
    if (voice.noise !== undefined) this.noise = voice.noise;
    if (voice.vibrato !== undefined) this.vibrato = voice.vibrato;
    if (voice.filter !== undefined) this.filter = voice.filter;
    if (voice.envOut !== undefined) this.envOut = voice.envOut;
  }

  dispose(): void {
    this.oscs.forEach((o) => { try { o.stop(); o.disconnect(); } catch { /* ignore */ } });
    this.noise?.stop();
    this.noise?.disconnect();
    this.vibrato?.stop?.();
    this.vibrato?.disconnect?.();
    this.filter?.disconnect();
    this.envOut?.disconnect();
    this.oscs = [];
    this.partialRatios = [];
    this.noise = null;
    this.vibrato = null;
    this.filter = null;
    this.envOut = null;
  }

  /** Spielt eine Note am aufgebauten Synth (MIDI-Nummer oder Name wie 'A4'). */
  noteOn(note: string | number): void {
    if (this.oscs.length === 0) return;
    const freq = typeof note === 'number'
      ? Tone.Frequency(note, 'midi').toFrequency()
      : Tone.Frequency(note).toFrequency();
    const t = this.deps.getCurrentTime();
    // Additive Synthese: jede Partial-Oszillator-Frequenz = Grundfrequenz * ratio.
    this.oscs.forEach((osc, i) => {
      const ratio = this.partialRatios[i] ?? 1;
      try { osc.frequency.setValueAtTime(freq * ratio, t); } catch { /* ignore */ }
    });
    // Envelope/Gain anheben (trigger).
    this.envOut?.gain.cancelScheduledValues(t);
    try { this.envOut?.gain.setValueAtTime(0.0001, t); } catch { /* ignore */ }
    try { this.envOut?.gain.exponentialRampToValueAtTime(1, t + 0.01); } catch { /* ignore */ }
  }

  /** Regression des Ausgangs-Gains (Release). */
  release(time?: number): void {
    const t = time ?? this.deps.getCurrentTime();
    this.envOut?.gain.cancelScheduledValues(t);
    this.envOut?.gain.setTargetAtTime(0.0001, t, 0.15);
  }
}
