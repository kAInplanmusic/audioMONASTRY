/**
 * audioMONASTRY · Tonewheel-Orgel + Leslie (setBfree/Open-B3-Referenz, eigener Code)
 * =================================================================================
 *   * `createTonewheelTable(drawbars)` – additive 9-Drawbar-Mischung (Sinussatz)
 *   * `LeslieSim` – Rotationslautsprecher: Tremolo (AM) + Doppler (FM) mit
 *     langsamer/schneller Geschwindigkeit und Beschleunigungs-Rampe.
 * Kein Fremdcode; deterministisch, serverlos testbar.
 */

export type Drawbars = [number, number, number, number, number, number, number, number, number];

/** Fußlagen der 9 Drawbars (16', 5⅓', 8', 4', 2⅔', 2', 1⅗', 1⅓', 1'). */
const DRAWBAR_RATIOS: Drawbars = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8];

export function createTonewheelTable(drawbars: Drawbars, size = 2048): Float32Array {
  const table = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const phase = i / size;
    let sum = 0;
    for (let d = 0; d < 9; d++) {
      const level = Math.max(0, Math.min(8, drawbars[d])) / 8;
      if (level === 0) continue;
      sum += level * Math.sin(2 * Math.PI * DRAWBAR_RATIOS[d] * phase);
    }
    table[i] = sum;
  }
  let peak = 0;
  for (let i = 0; i < size; i++) peak = Math.max(peak, Math.abs(table[i]));
  if (peak > 0) {
    for (let i = 0; i < size; i++) table[i] /= peak;
  }
  return table;
}

export interface LeslieParams {
  slowHz: number;
  fastHz: number;
  rampSec: number;
  amDepth: number;
  fmDepth: number;
}

const DEFAULT_LESLIE: LeslieParams = { slowHz: 0.8, fastHz: 6.2, rampSec: 0.8, amDepth: 0.5, fmDepth: 0.012 };

export class LeslieSim {
  private params: LeslieParams;
  private sampleRate: number;
  private speed = 0.8;
  private targetSpeed = 0.8;
  private phase = 0;

  constructor(sampleRate = 48000, params: Partial<LeslieParams> = {}) {
    this.sampleRate = Math.max(8000, sampleRate);
    this.params = { ...DEFAULT_LESLIE, ...params };
    this.speed = this.params.slowHz;
    this.targetSpeed = this.params.slowHz;
  }

  setFast(fast: boolean): void {
    this.targetSpeed = fast ? this.params.fastHz : this.params.slowHz;
  }

  getSpeed(): number {
    return this.speed;
  }

  /** Verarbeitet ein Mono-Sample durch den Rotor (AM + Doppler-FM). */
  process(input: number): number {
    const ramp = this.params.rampSec > 0 ? 1 / (this.params.rampSec * this.sampleRate) : 1;
    if (this.speed < this.targetSpeed) this.speed = Math.min(this.targetSpeed, this.speed + ramp);
    else if (this.speed > this.targetSpeed) this.speed = Math.max(this.targetSpeed, this.speed - ramp);

    this.phase += this.speed / this.sampleRate;
    if (this.phase >= 1) this.phase -= 1;

    const tremolo = 1 - this.params.amDepth * 0.5 * (1 + Math.cos(2 * Math.PI * this.phase));
    const doppler = 1 + this.params.fmDepth * Math.sin(2 * Math.PI * this.phase);
    return input * tremolo * doppler;
  }
}
