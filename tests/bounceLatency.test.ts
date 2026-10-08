// @vitest-environment node
/**
 * RT-AUDIT-P0-004-F2: Offline-Bounce ist sample-genau zur Eingangs-Zeitachse
 * ==========================================================================
 * Seit RT-AUDIT-P0-004 hat die Masterkette einen echten Lookahead-Limiter
 * (240 Frames @48 kHz). Ein Bounce durch diese Kette war deshalb um die Latenz
 * verschoben: 5 ms Stille am Anfang, bei tailSeconds 0 fehlten die letzten 5 ms.
 * `bounceNodeChain` rendert jetzt `latency` Frames zusätzlich und schneidet sie
 * vorne ab.
 */
import { describe, expect, it } from 'vitest';
import { OfflineBounceEngine } from '../src/audio/bounce/OfflineBounceEngine';
import { MasteringNode } from '../src/core/audio/nodes/processingNodes';
import { masteringLookaheadSamples } from '../src/core/dsp/masteringDynamics';

const SR = 48000;

function impulseImpulse(frames: number, amp = 0.05): Float32Array {
  const b = new Float32Array(frames);
  b[0] = amp;
  return b;
}

describe('RT-AUDIT-P0-004-F2 · Bounce-Latenzausgleich', () => {
  it('Impuls bei Frame 0 erscheint im Bounce bei Frame 0 (Lookahead vorne abgeschnitten)', () => {
    const frames = 4800;
    const engine = new OfflineBounceEngine(SR);
    const node = new MasteringNode('m', SR);
    const r = engine.bounceNodeChain([impulseImpulse(frames)], [node], { tailSeconds: 0 });

    const look = masteringLookaheadSamples(SR);
    expect(look).toBe(240);
    // Länge exakt wie die Quelle.
    expect(r.output[0].length).toBe(frames);
    // Kein 5-ms-Stille-Kopf mehr: der Impuls steht bei Frame 0.
    expect(Math.abs(r.output[0][0])).toBeGreaterThan(0.01);
    // Und der Kopf füllt sich nicht erst nach 240 Frames.
    let firstNonZero = -1;
    for (let i = 0; i < r.output[0].length; i++) {
      if (Math.abs(r.output[0][i]) > 1e-4) { firstNonZero = i; break; }
    }
    expect(firstNonZero).toBe(0);
  });

  it('ohne Latenz-Node wird nicht abgeschnitten (neutrale Kette unverändert)', () => {
    const frames = 256;
    const engine = new OfflineBounceEngine(SR);
    // Leere Kette = reine Quelle → Länge und Inhalt bleiben exakt.
    const src = [impulseImpulse(frames, 0.5)];
    const r = engine.bounceNodeChain(src, [], { tailSeconds: 0 });
    expect(r.output[0].length).toBe(frames);
    expect(r.output[0][0]).toBeCloseTo(0.5, 6);
  });
});
