/**
 * audioMONASTRY · DX7-SysEx-Import/Export (unpacked 156-Byte-Voice)
 * =================================================================
 * Nutzt das verbreitete „unpacked“-Layout (6 Operatoren × 21 Bytes + 30
 * Global-Bytes). DX7-SysEx ist ein offenes, dokumentiertes Format – hier als
 * eigener Parser/Serializer (kein Fremdcode).
 *
 * Op-Block (21 Bytes): R1,R2,R3,R4,L1,L2,L3,L4, Breakpoint, LeftDepth,
 * RightDepth, LeftCurve, RightCurve, RateScaling, AmpModSens, KeyVelSens,
 * OutputLevel, OscMode, FreqCoarse, FreqFine, Detune.
 * Global-Block (30 Bytes): PitchEG R1..R4/L1..L4, Algorithm, Feedback,
 * OscSync, LfoSpeed, LfoDelay, LfoPmd, LfoAmd, LfoSync, LfoWave, Pms,
 * Transpose + 6 Füllbytes.
 */
import type { Dx7Patch, Dx7OperatorParams } from './fmEngine';

export const DX7_UNPACKED_SIZE = 156;

function byte(v: number): number {
  return Math.max(0, Math.min(127, Math.round(v)));
}

function num(b: number): number {
  return Math.max(0, Math.min(127, b));
}

/** Patch → 156-Byte-Array. */
export function patchToDx7Sysex(patch: Dx7Patch): Uint8Array {
  const out = new Uint8Array(DX7_UNPACKED_SIZE);
  patch.operators.forEach((op, i) => {
    const o = i * 21;
    out[o + 0] = byte(op.rates[0]);
    out[o + 1] = byte(op.rates[1]);
    out[o + 2] = byte(op.rates[2]);
    out[o + 3] = byte(op.rates[3]);
    out[o + 4] = byte(op.levels[0]);
    out[o + 5] = byte(op.levels[1]);
    out[o + 6] = byte(op.levels[2]);
    out[o + 7] = byte(op.levels[3]);
    out[o + 8] = byte(50);              // Breakpoint
    out[o + 9] = byte(0);               // LeftDepth
    out[o + 10] = byte(op.keyScaling);  // RightDepth (Key-Scaling)
    out[o + 11] = 0;                    // LeftCurve
    out[o + 12] = 0;                    // RightCurve
    out[o + 13] = 0;                    // RateScaling
    out[o + 14] = byte(op.velocitySensitivity * 18); // AmpModSens (0..3 → 0..54)
    out[o + 15] = byte(op.velocitySensitivity);       // KeyVelSens 0..7
    out[o + 16] = byte(op.level * 99);  // OutputLevel
    out[o + 17] = op.fixed ? 1 : 0;     // OscMode
    out[o + 18] = byte(op.fixed ? Math.round(op.fixedHz / 10) : op.ratio); // FreqCoarse
    out[o + 19] = 0;                    // FreqFine
    out[o + 20] = byte(op.detune + 7);  // Detune (0..14 → −7..+7)
  });
  const g = 6 * 21;
  out[g + 0] = 99; out[g + 1] = 99; out[g + 2] = 99; out[g + 3] = 99; // PitchEG Raten
  out[g + 4] = 99; out[g + 5] = 99; out[g + 6] = 99; out[g + 7] = 99; // PitchEG Level
  out[g + 8] = byte(patch.algorithm - 1);  // Algorithm 0..31
  out[g + 9] = byte(patch.feedback);       // Feedback 0..7
  out[g + 10] = 0;                         // OscSync
  out[g + 11] = byte(Math.min(99, Math.round(patch.lfo.speedHz))); // LfoSpeed
  out[g + 12] = byte(Math.min(99, Math.round(patch.lfo.delaySec * 99))); // LfoDelay
  out[g + 13] = byte(patch.lfo.pitchModDepth); // LfoPmd
  out[g + 14] = byte(patch.lfo.ampModDepth);   // LfoAmd
  out[g + 15] = patch.lfo.sync ? 1 : 0;        // LfoSync
  out[g + 16] = 0;                             // LfoWave (0 = Sinus)
  out[g + 17] = 0;                             // Pms
  out[g + 18] = byte((patch.transpose ?? 0) + 24); // Transpose (−24..+24)
  // Restliche Bytes bleiben 0.
  return out;
}

/** 156-Byte-Array → Patch (Roundtrip-kompatibel). */
export function dx7SysexToPatch(data: Uint8Array): Dx7Patch {
  if (data.length < DX7_UNPACKED_SIZE) {
    throw new Error(`DX7-SysEx zu kurz: ${data.length} Bytes (erwartet ${DX7_UNPACKED_SIZE})`);
  }
  const operators = Array.from({ length: 6 }, (_, i): Dx7OperatorParams => {
    const o = i * 21;
    const fixed = num(data[o + 17]) === 1;
    const freqCoarse = num(data[o + 18]);
    return {
      ratio: fixed ? Math.max(0.5, Math.min(15, 1)) : Math.max(0.5, Math.min(15, freqCoarse || 1)),
      fixed,
      fixedHz: fixed ? Math.max(1, freqCoarse * 10) : 0,
      level: num(data[o + 16]) / 99,
      rates: [num(data[o + 0]), num(data[o + 1]), num(data[o + 2]), num(data[o + 3])],
      levels: [num(data[o + 4]), num(data[o + 5]), num(data[o + 6]), num(data[o + 7])],
      detune: num(data[o + 20]) - 7,
      velocitySensitivity: num(data[o + 15]) % 8,
      keyScaling: num(data[o + 10]),
    };
  }) as [Dx7OperatorParams, Dx7OperatorParams, Dx7OperatorParams, Dx7OperatorParams, Dx7OperatorParams, Dx7OperatorParams];

  const g = 6 * 21;
  return {
    name: 'DX7-Import',
    algorithm: num(data[g + 8]) + 1,
    feedback: num(data[g + 9]) % 8,
    transpose: num(data[g + 18]) - 24,
    lfo: {
      speedHz: num(data[g + 11]),
      delaySec: num(data[g + 12]) / 99,
      pitchModDepth: num(data[g + 13]),
      ampModDepth: num(data[g + 14]),
      sync: num(data[g + 15]) === 1,
    },
    operators,
  };
}

/** Roundtrip-Check: Patch → SysEx → Patch (semantisch identisch). */
export function dx7RoundtripStable(patch: Dx7Patch): boolean {
  const bytes = patchToDx7Sysex(patch);
  const back = dx7SysexToPatch(bytes);
  return back.algorithm === patch.algorithm && back.feedback === patch.feedback;
}
