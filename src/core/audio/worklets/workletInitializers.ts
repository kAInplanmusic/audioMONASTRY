/**
 * audioMONASTRY · Worklet-Init-Helfer
 * ===================================
 * Erzeugt die Clock-/Synth-/ItSynth-Worklet-Knoten inkl. Modul-Nachladen.
 * Die Verdrahtung in die AudioEngine (Kanalzug/Gain) bleibt in audioEngine.ts,
 * hier liegt nur die Node-Erzeugung.
 */

interface ClockWorkletParams {
  bpm: number;
  swing: number;
  gate: number;
}

export function createClockWorkletNode(
  ctx: AudioContext | null,
  params: ClockWorkletParams,
  onStep: (msg: { time: number; gate: number; swing: number }) => void,
): AudioWorkletNode | null {
  try {
    if (!ctx || typeof ctx.audioWorklet?.addModule !== 'function') return null;
    const node = new AudioWorkletNode(ctx, 'clock-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 0,
      parameterData: { bpm: params.bpm, swing: params.swing, gate: params.gate },
    });
    node.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; time?: number; gate?: number; swing?: number } | undefined;
      if (!msg || msg.type !== 'step') return;
      onStep({ time: Number(msg.time ?? 0), gate: Number(msg.gate ?? 0), swing: Number(msg.swing ?? 0) });
    };
    return node;
  } catch (e) {
    console.warn('clock-processor not loaded; using setTimeout scheduler.', (e as Error).message);
    return null;
  }
}

export function createSynthWorkletNode(ctx: AudioContext | null): AudioWorkletNode | null {
  try {
    if (!ctx || typeof ctx.audioWorklet?.addModule !== 'function') return null;
    return new AudioWorkletNode(ctx, 'synth-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
  } catch (e) {
    console.warn('synth-processor nicht geladen; Statistik-Fallback auf Sampler.', (e as Error).message);
    return null;
  }
}

export async function createItSynthWorkletNode(ctx: AudioContext | null): Promise<AudioWorkletNode | null> {
  try {
    if (!ctx || typeof ctx.audioWorklet?.addModule !== 'function') return null;
    // Falls das Modul (noch) nicht über den Manifest-Pfad geladen wurde,
    // versuchen wir es nachzuladen; idempotent via registerProcessor-Check.
    try {
      new AudioWorkletNode(ctx, 'it-synth-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    } catch {
      await ctx.audioWorklet.addModule('/worklets/itSynthProcessor.js');
    }
    return new AudioWorkletNode(ctx, 'it-synth-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
  } catch (e) {
    console.warn('it-synth-processor nicht verfügbar – instrumentMONK nutzt Tone.js-Fallback.', (e as Error).message);
    return null;
  }
}
