// ============================================================================
// spatialMath.ts – Mehrkanal-Spatial-Panning (2/4.0/6/8/10/12/14/16/18.x)
// ============================================================================
// - Konfigurierbares Amplituden-Panning (VBAP-artig) auf einer 360°-Ebene.
// - `x` = links(-1)…rechts(+1), `y` = hinten(-1)…vorne(+1).
// - LFE (`.1`, `.2`): separate Tiefenakkumulation, additiv auf letzten Kanal(en).
// - HRTF-Stereo-Modell für Kopfhörer-Cue bleibt erhalten.

export interface SpatialSetup {
  id: string;           // z.B. '10.0'
  label: string;        // z.B. '10.0 Kanäle'
  numChannels: number;  // Anzahl diskreter (Ring-)Hauptkanäle
  lfe: number;          // 0 | 1 | 2 zusätzliche LFE-Kanäle
}

export const SPATIAL_SETUPS: SpatialSetup[] = [
  { id: '2.0',   label: '2.0 (Stereo)',         numChannels: 2, lfe: 0 },
  { id: '2.2',   label: '2.2 (Stereo + 2×LFE)', numChannels: 2, lfe: 2 },
  { id: '4.0',   label: '4.0 (Quad)',           numChannels: 4, lfe: 0 },
  { id: '4.1',   label: '4.1 (Quad + LFE)',     numChannels: 4, lfe: 1 },
  { id: '4.2',   label: '4.2 (Quad + 2×LFE)',   numChannels: 4, lfe: 2 },
  { id: '6.0',   label: '6.0 (5.1 ohne LFE)',   numChannels: 6, lfe: 0 },
  { id: '8.0',   label: '8.0',                  numChannels: 8, lfe: 0 },
  { id: '10.0',  label: '10.0',                 numChannels: 10, lfe: 0 },
  { id: '12.0',  label: '12.0',                 numChannels: 12, lfe: 0 },
  { id: '12.1',  label: '12.1 (+ LFE)',         numChannels: 12, lfe: 1 },
  { id: '12.2',  label: '12.2 (+ 2×LFE)',       numChannels: 12, lfe: 2 },
  { id: '14.0',  label: '14.0',                 numChannels: 14, lfe: 0 },
  { id: '16.0',  label: '16.0',                 numChannels: 16, lfe: 0 },
  { id: '18.0',  label: '18.0',                 numChannels: 18, lfe: 0 },
  { id: '18.1',  label: '18.1 (+ LFE)',         numChannels: 18, lfe: 1 },
  { id: '18.2',  label: '18.2 (+ 2×LFE)',       numChannels: 18, lfe: 2 },
  { id: '24.0',  label: '24.0',                 numChannels: 24, lfe: 0 },
  { id: '24.1',  label: '24.1 (+ LFE)',         numChannels: 24, lfe: 1 },
  { id: '24.2',  label: '24.2 (+ 2×LFE)',       numChannels: 24, lfe: 2 },
];

export interface PanningResult {
  channels: number[];     // Gewichte pro diskretem (Haupt-)Kanal
  lfe: number[];          // Gewichte pro LFE-Kanal (0..lfe-1)
  totalChannels: number;  // numChannels + lfe
}

export function getSetup(id: string): SpatialSetup {
  return SPATIAL_SETUPS.find((s) => s.id === id)
    ?? SPATIAL_SETUPS.find((s) => s.id === '10.0')
    ?? SPATIAL_SETUPS[0];
}

/**
 * Berechnet gleichmäßige Winkel (in Radiant) für `n` Ring-Kanäle über 360°.
 * Kanal 0 = vorne (Azimut 0), dann im Uhrzeigersinn Richtung rechts/hinten.
 */
function ringAngles(n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((i / n) * 2 * Math.PI);
  }
  return out;
}

/**
 * VBAP-artiges Amplituden-Panning: gewichtet die zwei nächstliegenden Lautsprecher
 * auf einer 360°-Ebene um die Quellrichtung. Rückgabe: N Gewichte (Summe ≈ 1).
 */
export function calculateChannelPan(x: number, y: number, setupId: string): PanningResult {
  const setup = getSetup(setupId);
  const n = setup.numChannels;
  const weights = new Array(n).fill(0);
  if (n === 0) return { channels: [], lfe: [], totalChannels: 0 };

  // Quellrichtung im Bogenmaß (0 = vorne, positiv rechts, gegen UZS).
  // x: links(-1)..rechts(+1) -> Azimut steigt, y: hinten(-1)..vorne(+1).
  const srcAz = Math.atan2(x || 0, y || 0); // atan2(links-rechts, hinten-vorne)

  // 2-Kanal sauber (L=Kanal0, R=Kanal1) via Sinuslaw-Pan (SSP):
  if (n === 2) {
    const theta = Math.sin(srcAz); // -1..1
    const s = (theta / 2) * Math.PI / 2;
    const g = 0.7071 * (Math.cos(s) - Math.sin(s));
    const l = Math.max(0, g);
    const gR = 0.7071 * (Math.cos(s) + Math.sin(s));
    const r = Math.max(0, gR);
    const m = (l + r) || 1;
    weights[0] = r / m; // rechts
    weights[1] = l / m; // links
    return { channels: weights, lfe: lfeWeights(y, setup.lfe), totalChannels: weights.length + setup.lfe };
  }

  const angles = ringAngles(n);
  // Nächstliegende zwei Lautsprecher (Ring-Logik, mod n)
  let best = [0, 1] as [number, number];
  let bestScore = -Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d1 = Math.min(Math.abs(angDiff(srcAz, angles[i])), Math.abs(angDiff(srcAz, angles[i]) - 2 * Math.PI));
      const d2 = Math.min(Math.abs(angDiff(srcAz, angles[j])), Math.abs(angDiff(srcAz, angles[j]) - 2 * Math.PI));
      const pairwise = (Math.PI - Math.abs(angDiff(angles[i], angles[j])));
      const score = -(d1 * d1 + d2 * d2) - pairwise;
      if (score > bestScore) { bestScore = score; best = [i, j]; }
    }
  }

  const [i, j] = best;
  const spread = Math.abs(angDiff(angles[i], angles[j]));
  const dI = angDiff(srcAz, angles[i]);
  const alpha = Math.max(0, Math.min(1, dI / (spread || 1)));
  // Gleichheits-Power-Law: cos/sin zwischen den zwei Lautsprechern (Summe der
  // Squares = 1); so bleibt die Energie über den Ring stabil.
  weights[i] = Math.cos((alpha * Math.PI) / 2);
  weights[j] = Math.sin((alpha * Math.PI) / 2);
  const mag = Math.sqrt(weights[i] ** 2 + weights[j] ** 2) || 1;
  weights[i] = weights[i] / mag;
  weights[j] = weights[j] / mag;

  return {
    channels: weights,
    lfe: lfeWeights(y, setup.lfe),
    totalChannels: weights.length + setup.lfe,
  };
}

function lfeWeights(y: number, lfeCount: number): number[] {
  // LFE bekommt Energie hauptsächlich, wenn die Quelle hinten/zentriert ist.
  // `y` = hinten(-1)..vorne(+1) → mehr LFE bei hinten (negativ) und tiefem Bass.
  const base = Math.max(0, 1 - Math.max(0, y)); // vorne→0, hinten→1
  const out: number[] = [];
  for (let k = 0; k < lfeCount; k++) {
    out.push(Math.min(1, base));
  }
  return out;
}

/** Winkel-Differenz in [0, Pi]. */
function angDiff(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export interface HrtfResult {
  azimuth: number;
  elevation: number;
  itdSamples: number;
  ildDb: number;
  leftGain: number;
  rightGain: number;
}

const HEAD_RADIUS_NORM = 0.24;

export function toAzimuthElevation(x: number, y: number): { azimuth: number; elevation: number } {
  const azimuth = Math.atan2(x, y) * 180 / Math.PI;
  return { azimuth, elevation: 0 };
}

export function calculateHRTF(x: number, y: number, sampleRate = 48000): HrtfResult {
  const { azimuth } = toAzimuthElevation(x, y);
  const rad = azimuth * Math.PI / 180;
  const itdMs = HEAD_RADIUS_NORM * Math.sin(rad);
  let itdSamples = Math.round(sampleRate * itdMs * 0.001);
  const maxSamples = Math.round(sampleRate * 0.0007);
  itdSamples = Math.max(-maxSamples, Math.min(maxSamples, itdSamples));
  const ildDb = -10 * Math.sin(rad);
  const rightGain = Math.min(1, Math.max(0, 0.5 + 0.5 * Math.sin(rad)));
  const leftGain = Math.min(1, Math.max(0, 0.5 - 0.5 * Math.sin(rad)));
  return { azimuth, elevation: 0, itdSamples, ildDb, leftGain, rightGain };
}
