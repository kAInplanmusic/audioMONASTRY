/**
 * audioMONASTRY · Sample-Resampling (RT-AUDIT-P1-009)
 * ===================================================
 * Wandelt dekodierte Samples auf die Rate des AudioContext um, BEVOR sie in
 * den V2-Sample-Pool gehen. Vorher las der Sink die Rohdaten per
 * Nearest-Neighbor (44,1-kHz-Samples klangen bei 48 kHz verzerrt, SINAD ~14 dB).
 *
 * Zwei Wege:
 *   - `resampleToRate` (async): im Browser über `OfflineAudioContext` (hoch-
 *     wertige, bandbegrenzte Umrechnung der Plattform). Ist kein
 *     OfflineAudioContext verfügbar (Node/Tests), fällt es auf den portablen
 *     Sinc-Resampler zurück – so ist dieselbe Funktion überall messbar.
 *   - `resampleSincToRate` (sync): 33-Tap-Blackman-Sinc (polyphase, 512 Phasen).
 *     Portabel und deterministisch; dient als Node-Pfad und als Referenz.
 *
 * Für den Realtime-Pfad (Pitch-Shift rate != 1) bleibt im Sink zusätzlich die
 * billige 4-Punkt-Hermite-Interpolation (V2SinkEngine.renderSampleBlock); nach
 * dem Laden hier ist `sourceRate === ctxSampleRate` und der Normalfall läuft
 * ohne Interpolation (advance === 1).
 *
 * Keine Allokation im Audio-Thread: diese Funktionen laufen nur auf dem
 * Main-Thread beim Laden.
 */

/** Halbe Sinc-Länge (33 Taps gesamt). */
const SINC_R = 16;
/** Anzahl Phasen der polyphasen Tabelle (512 → Fehler < 1 dB unter dem Taps-Limit). */
const SINC_PHASES = 512;
/** Grenzfrequenz der Sinc (1.0 = Nyquist). */
const SINC_CUTOFF = 1.0;

export interface ResampledSample {
  left: Float32Array;
  right: Float32Array | null;
  /** Quell-Rate des Ergebnisses (bei erfolgreichem Resampling == toRate). */
  sourceRate: number;
}

let sincTables: Float32Array[] | null = null;

/**
 * Polyphase-Tabelle der Blackman-gewichteteten Sinc-Koeffizienten. Jede Phase
 * ist auf Summe 1 normiert (keine DC-Verstärkung). Einmalig berechnet.
 */
function getSincTables(): Float32Array[] {
  if (sincTables) return sincTables;
  const taps = 2 * SINC_R + 1;
  const tables: Float32Array[] = [];
  for (let p = 0; p < SINC_PHASES; p++) {
    const t = p / SINC_PHASES;
    const h = new Float32Array(taps);
    let sum = 0;
    for (let k = -SINC_R; k <= SINC_R; k++) {
      const d = k - t;
      const sinc = d === 0 ? SINC_CUTOFF : Math.sin(Math.PI * SINC_CUTOFF * d) / (Math.PI * d);
      const win = 0.42 + 0.5 * Math.cos((Math.PI * d) / SINC_R) + 0.08 * Math.cos((2 * Math.PI * d) / SINC_R);
      const v = sinc * win;
      h[k + SINC_R] = v;
      sum += v;
    }
    if (sum !== 0) for (let i = 0; i < taps; i++) h[i] /= sum;
    tables.push(h);
  }
  sincTables = tables;
  return tables;
}

function resampleChannel(src: Float32Array, nOut: number, ratio: number): Float32Array {
  const tables = getSincTables();
  const out = new Float32Array(nOut);
  const n = src.length;
  for (let i = 0; i < nOut; i++) {
    const pos = i * ratio;
    const base = Math.floor(pos);
    const t = pos - base;
    const h = tables[Math.min(SINC_PHASES - 1, (t * SINC_PHASES) | 0)];
    let acc = 0;
    for (let k = -SINC_R; k <= SINC_R; k++) {
      const idx = base + k;
      acc += (idx < 0 || idx >= n ? 0 : src[idx]) * h[k + SINC_R];
    }
    out[i] = acc;
  }
  return out;
}

/**
 * Synchrones, portables Resampling auf `toRate`. Nutzt 33-Tap-Blackman-Sinc.
 * `fromRate === toRate` → unverändert zurückgegeben (keine Kopie).
 */
export function resampleSincToRate(
  left: Float32Array,
  right: Float32Array | null | undefined,
  fromRate: number,
  toRate: number,
): ResampledSample {
  const r = right && right.length > 0 ? right : null;
  if (fromRate === toRate || left.length === 0 || fromRate <= 0 || toRate <= 0) {
    return { left, right: r, sourceRate: fromRate };
  }
  const ratio = fromRate / toRate;
  const nOut = Math.max(1, Math.floor(left.length / ratio));
  const outLeft = resampleChannel(left, nOut, ratio);
  const outRight = r ? resampleChannel(r, nOut, ratio) : null;
  return { left: outLeft, right: outRight, sourceRate: toRate };
}

interface OfflineCtxCtor {
  new (channels: number, length: number, sampleRate: number): OfflineAudioContext;
}

function offlineCtor(): OfflineCtxCtor | null {
  const g = globalThis as unknown as Record<string, unknown>;
  const c = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  return typeof c === 'function' ? (c as OfflineCtxCtor) : null;
}

async function resampleViaOfflineContext(
  left: Float32Array,
  right: Float32Array | null,
  fromRate: number,
  toRate: number,
): Promise<ResampledSample | null> {
  const Ctor = offlineCtor();
  if (!Ctor) return null;
  try {
    const channels = right ? 2 : 1;
    const ratio = fromRate / toRate;
    const nOut = Math.max(1, Math.floor(left.length / ratio));
    const ctx = new Ctor(channels, nOut, toRate);
    const buf = ctx.createBuffer(channels, left.length, fromRate);
    buf.getChannelData(0).set(left);
    if (right) buf.getChannelData(1).set(right);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    const rendered = await ctx.startRendering();
    return {
      left: rendered.getChannelData(0).slice(),
      right: right ? rendered.getChannelData(1).slice() : null,
      sourceRate: toRate,
    };
  } catch {
    return null;
  }
}

/**
 * Asynchrones Resampling auf `toRate`. Im Browser via `OfflineAudioContext`,
 * sonst (Node/Tests) über den portablen Sinc-Resampler. `fromRate === toRate`
 * → unverändert.
 */
export async function resampleToRate(
  left: Float32Array,
  right: Float32Array | null | undefined,
  fromRate: number,
  toRate: number,
): Promise<ResampledSample> {
  const r = right && right.length > 0 ? right : null;
  if (fromRate === toRate || left.length === 0) return { left, right: r, sourceRate: fromRate };
  const viaCtx = await resampleViaOfflineContext(left, r, fromRate, toRate);
  return viaCtx ?? resampleSincToRate(left, r, fromRate, toRate);
}
