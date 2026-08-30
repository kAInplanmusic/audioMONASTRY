/**
 * audioMONASTRY · 1.2.4 – Deterministisches Random-Seed-Management
 * =================================================================
 * Reproduzierbare generative Prozesse für Session und Preset-System:
 *
 *  - `hashString` (xmur3) leitet aus beliebigen Labels stabile Seeds ab.
 *  - `mulberry32` ist ein schneller, deterministischer PRNG.
 *  - `SeedManager` verwaltet Session- und Preset-Seeds, serialisiert nach
 *    JSON und liefert pro Scope unabhängige, reproduzierbare Zufallsströme.
 *
 * Regel: Generative Algorithmen (AI-Komposition, Pattern-/Preset-Generatoren)
 * nutzen ausschließlich `SeedManager` – niemals `Math.random()` direkt.
 */

/** xmur3-String-Hash: stabiles 32-Bit-Seed aus einem String. */
export function hashString(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32-PRNG: liefert [0,1)-Werte, deterministisch pro Seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; // NOSONAR: absichtliche 32-Bit-Koersion im PRNG (nicht Math.trunc)
    a = (a + 0x6d2b79f5) | 0; // NOSONAR: absichtliche 32-Bit-Koersion im PRNG
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedState {
  sessionSeed: number;
  /** label → Seed (Preset-/Generator-Scopes). */
  presetSeeds: Record<string, number>;
}

export class SeedManager {
  private state: SeedState = { sessionSeed: 0xc0ffee, presetSeeds: {} };
  private streams = new Map<string, () => number>();

  /** Session-Seed setzen (z. B. aus Session-State geladen). */
  setSessionSeed(seed: number): void {
    this.state.sessionSeed = seed >>> 0;
    this.streams.clear();
  }

  get sessionSeed(): number {
    return this.state.sessionSeed;
  }

  /** Preset-Seed holen oder aus dem Label deterministisch erzeugen. */
  presetSeed(label: string, explicitSeed?: number): number {
    if (typeof explicitSeed === 'number') {
      this.state.presetSeeds[label] = explicitSeed >>> 0;
      this.streams.delete(label);
      return explicitSeed >>> 0;
    }
    const existing = this.state.presetSeeds[label];
    if (existing !== undefined) return existing;
    const derived = hashString(`${this.state.sessionSeed}:${label}`);
    this.state.presetSeeds[label] = derived;
    return derived;
  }

  /** Deterministischer Zufallswert [0,1) für einen Scope. */
  random(scope: string): number {
    let stream = this.streams.get(scope);
    if (!stream) {
      stream = mulberry32(hashString(`${this.state.sessionSeed}:${scope}`));
      this.streams.set(scope, stream);
    }
    return stream();
  }

  /** Ganzzahl in [min,max] (inklusiv) für einen Scope. */
  randomInt(scope: string, min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.random(scope) * (max - min + 1));
  }

  /** Element aus einer Liste deterministisch wählen. */
  pick<T>(scope: string, items: readonly T[]): T | undefined {
    if (!items.length) return undefined;
    return items[this.randomInt(scope, 0, items.length - 1)];
  }

  /** Serialisiert den Seed-Zustand (für Session-Export/Preset-System). */
  toJSON(): SeedState {
    return {
      sessionSeed: this.state.sessionSeed,
      presetSeeds: { ...this.state.presetSeeds },
    };
  }

  /** Stellt einen serialisierten Seed-Zustand wieder her. */
  fromJSON(state: Partial<SeedState> | null | undefined): void {
    if (!state) return;
    if (typeof state.sessionSeed === 'number') this.setSessionSeed(state.sessionSeed);
    if (state.presetSeeds && typeof state.presetSeeds === 'object') {
      this.state.presetSeeds = { ...state.presetSeeds };
    }
    this.streams.clear();
  }

  /** Setzt alle Ströme zurück (gleiche Seeds → gleiche Sequenzen). */
  resetStreams(): void {
    this.streams.clear();
  }
}

export const seedManager = new SeedManager();
