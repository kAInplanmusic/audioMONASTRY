/**
 * audioMONASTRY · Wavetable-Oszillator (Surge-XT-Referenz, eigener Code)
 * ======================================================================
 * Mip-Map-Wavetable mit linearer Interpolation gegen Aliasing:
 *   * `createBandlimitedTable(harmonics, size)` – additive, aliasfreie Tabelle
 *   * `createMipMaps(table)` – Halbierungsstufen
 *   * `sampleWavetable(mipMaps, position01, phase01)` – Morph zwischen zwei
 *     Wellen (Position) mit Mip-Auswahl nach Grundton-Höhe
 * Kein Fremdcode; deterministisch, serverlos testbar.
 */

export type Wavetable = Float32Array;
export type MipMaps = Wavetable[];

export function createBandlimitedTable(harmonics: number[], size = 2048): Wavetable {
  const table = new Float32Array(size);
  const maxHarmonic = Math.max(1, harmonics.length);
  for (let i = 0; i < size; i++) {
    const phase = i / size;
    let sum = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const amp = harmonics[h];
      if (amp === 0) continue;
      sum += amp * Math.sin(2 * Math.PI * (h + 1) * phase);
    }
    table[i] = sum;
  }
  // Normalisieren auf -1..1.
  let peak = 0;
  for (let i = 0; i < size; i++) peak = Math.max(peak, Math.abs(table[i]));
  if (peak > 0) {
    for (let i = 0; i < size; i++) table[i] /= peak;
  }
  void maxHarmonic;
  return table;
}

export function createMipMaps(table: Wavetable): MipMaps {
  const levels: MipMaps = [];
  let current = table;
  while (current.length >= 8) {
    levels.push(current);
    const half = new Float32Array(current.length / 2);
    for (let i = 0; i < half.length; i++) half[i] = (current[i * 2] + current[i * 2 + 1]) * 0.5;
    current = half;
  }
  return levels;
}

/** Lineare Interpolation in einer Tabelle. */
function readTable(table: Wavetable, phase01: number): number {
  const x = Math.max(0, Math.min(1, phase01)) * table.length;
  const i0 = Math.floor(x) % table.length;
  const i1 = (i0 + 1) % table.length;
  const f = x - Math.floor(x);
  return table[i0] + (table[i1] - table[i0]) * f;
}

/**
 * Sample mit Morph (position01 = Crossfade zwischen zwei Mip-Sets) und
 * Mip-Auswahl (mip = Grundton relativ zu Nyquist, 0 = höchste Auflösung).
 */
export function sampleWavetable(
  mipsA: MipMaps,
  mipsB: MipMaps,
  position01: number,
  phase01: number,
  mip = 0,
): number {
  const a = readTable(mipsA[Math.min(mip, mipsA.length - 1)], phase01);
  const b = readTable(mipsB[Math.min(mip, mipsB.length - 1)], phase01);
  const t = Math.max(0, Math.min(1, position01));
  return a + (b - a) * t;
}

/** Convenience: Sinus/Sägezahn-Morph als Mip-Maps-Paar. */
export function createMorphWavetables(size = 2048): { sine: MipMaps; saw: MipMaps } {
  const sine = createBandlimitedTable([1], size);
  const saw: number[] = [];
  for (let h = 1; h <= 32; h++) saw.push(1 / h);
  const sawTable = createBandlimitedTable(saw, size);
  return { sine: createMipMaps(sine), saw: createMipMaps(sawTable) };
}
