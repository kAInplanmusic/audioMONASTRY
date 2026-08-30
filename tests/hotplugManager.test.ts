import { describe, expect, it } from 'vitest';
import { HotplugManager } from '../src/core/hardware/HotplugManager';

describe('HotplugManager', () => {
  it('meldet CONNECTED und DISCONNECTED', () => {
    const m = new HotplugManager();
    const events: string[] = [];
    m.subscribe((e) => events.push(e.kind));

    m.attach('dev-1', 'Xonar U7');
    m.detach('dev-1');
    expect(events).toEqual(['CONNECTED', 'DISCONNECTED']);
  });

  it('meldet RECONNECTED mit konserviertem Zustand', () => {
    const m = new HotplugManager();
    const kinds: string[] = [];
    let preserved: Record<string, unknown> | undefined;
    m.subscribe((e) => {
      kinds.push(e.kind);
      if (e.kind === 'RECONNECTED') preserved = e.preserved;
    });

    m.attach('dev-1', 'Audio IF');
    m.preserve('dev-1', { sampleRate: 96000, buffer: 256 });
    m.detach('dev-1');
    m.attach('dev-1', 'Audio IF');

    expect(kinds).toEqual(['CONNECTED', 'DISCONNECTED', 'RECONNECTED']);
    expect(preserved).toEqual({ sampleRate: 96000, buffer: 256 });
    expect(m.restore('dev-1')).toEqual({ sampleRate: 96000, buffer: 256 });
  });

  it('meldet CHANGED bei erneutem attach ohne Trennung', () => {
    const m = new HotplugManager();
    const kinds: string[] = [];
    m.subscribe((e) => kinds.push(e.kind));
    m.attach('dev-1', 'A');
    m.attach('dev-1', 'A');
    expect(kinds).toEqual(['CONNECTED', 'CHANGED']);
  });

  it('unterstützt mehrere Listener + Legacy-Callback', () => {
    const m = new HotplugManager();
    let legacy = 0;
    let a = 0;
    let b = 0;
    m.onDeviceChange(() => legacy++);
    m.subscribe(() => a++);
    m.subscribe(() => b++);
    m.attach('dev-1', 'X');
    expect(legacy).toBe(1);
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('ignoriert doppeltes detach', () => {
    const m = new HotplugManager();
    const kinds: string[] = [];
    m.subscribe((e) => kinds.push(e.kind));
    m.attach('dev-1', 'X');
    m.detach('dev-1');
    m.detach('dev-1');
    expect(kinds).toEqual(['CONNECTED', 'DISCONNECTED']);
  });
});
