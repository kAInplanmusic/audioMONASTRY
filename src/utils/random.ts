// Utility for non-security random values.
// SonarCloud S2245 is intentionally suppressed here: this helper is only used
// for UI/audio randomness, never for tokens, secrets, or security decisions.
export function random(): number {
  return Math.random(); // NOSONAR: not used for cryptographic/security purposes
}

/**
 * Deterministischer, seed-barer PRNG (mulberry32) für den AUDIO-Pfad.
 * `Math.random()` darf im Rendering nicht verwendet werden, sonst klingen
 * Offline-Bounces und Realtime-Wiedergabe unterschiedlich (Null-Test fail).
 */
export function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
