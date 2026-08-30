import { describe, expect, it } from 'vitest';
import { HardwareDiagnostics } from '../src/core/hardware/diagnostics';

describe('HardwareDiagnostics', () => {
  it('loggt Events in den Ring-Puffer (non-blocking)', () => {
    const d = new HardwareDiagnostics();
    d.setConsoleLogging(false);
    d.log('CONNECT', 'Xonar U7', { vid: '0x0b05' });
    d.log('OPEN', 'Xonar U7');
    d.log('SAMPLE_RATE', 'Xonar U7', { sampleRate: 96000 });

    expect(d.last('CONNECT')?.device).toBe('Xonar U7');
    expect(d.last()?.kind).toBe('SAMPLE_RATE');
    expect(d.entriesSince(0)).toHaveLength(3);
  });

  it('benachrichtigt Subscriber und erlaubt Unsubscribe', () => {
    const d = new HardwareDiagnostics();
    const seen: string[] = [];
    const off = d.subscribe((e) => seen.push(e.kind));
    d.log('BACKEND', 'wasapi');
    d.log('DEVICE_ERROR', 'wasapi', { error: 'x' });
    off();
    d.log('CLOSE', 'wasapi');
    expect(seen).toEqual(['BACKEND', 'DEVICE_ERROR']);
  });

  it('kappt den Ring-Puffer (kein unbegrenztes Wachstum)', () => {
    const d = new HardwareDiagnostics();
    for (let i = 0; i < 600; i++) d.log('BUFFER', `dev-${i}`);
    const all = d.entriesSince(0);
    expect(all.length).toBeLessThanOrEqual(256);
    expect(all[all.length - 1].device).toBe('dev-599');
  });
});
