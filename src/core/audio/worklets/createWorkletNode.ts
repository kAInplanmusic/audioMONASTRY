/**
 * audioMONASTRY · Worklet-Factory
 * ===============================
 * Zentraler, robust erzeugter `AudioWorkletNode`.
 *
 * Verhalten:
 * - Wenn kein gültiger AudioContext existiert, wird ein neutraler Gain-Knoten
 *   als Platzhalter geliefert, damit Audio-Ketten nicht hart abbrechen.
 * - Wenn auch das nicht möglich ist, wird `null` (als Node getarnt) geliefert.
 *   Aufrufer müssen weiterhin Port-/Connect-Zugriffe absichern.
 */

export function createAudioWorkletNode(
  ctx: AudioContext | null,
  name: string,
  opts?: AudioWorkletNodeOptions,
): AudioWorkletNode {
  try {
    if (!ctx || typeof ctx.createGain !== 'function') {
      throw new Error('kein AudioContext');
    }
    return new AudioWorkletNode(ctx, name, opts);
  } catch (e) {
    console.warn(`AudioWorklet '${name}' nicht verfügbar – nutze neutralen Gain-Fallback.`, e);
    try {
      if (ctx && typeof ctx.createGain === 'function') {
        return ctx.createGain() as unknown as AudioWorkletNode;
      }
    } catch { /* kontextloses Silent */ }
    // Minimaler, never-connectbarer Stand-in damit der Rest nicht crasht.
    return null as unknown as AudioWorkletNode;
  }
}
