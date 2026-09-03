import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioIdleDetector } from '../src/utils/idleDetection';

describe('AM-E6-5: AudioIdleDetector (Energie-Optimierung)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('feuert onIdle nach timeoutMs ohne Aktivität', () => {
    let idled = 0;
    const d = new AudioIdleDetector({ timeoutMs: 5000, onIdle: () => { idled++; } });
    d.arm();
    expect(d.isIdle()).toBe(false);
    vi.advanceTimersByTime(4999);
    expect(idled).toBe(0);
    vi.advanceTimersByTime(1);
    expect(idled).toBe(1);
    expect(d.isIdle()).toBe(true);
  });

  it('activity setzt den Timer zurück und beendet Idle (onActive)', () => {
    let idled = 0;
    let actived = 0;
    const d = new AudioIdleDetector({ timeoutMs: 5000, onIdle: () => { idled++; }, onActive: () => { actived++; } });
    d.arm();
    vi.advanceTimersByTime(3000);
    d.activity();
    vi.advanceTimersByTime(3000);
    expect(idled).toBe(0); // Timer wurde zurückgesetzt
    vi.advanceTimersByTime(2000);
    expect(idled).toBe(1);

    d.activity();
    expect(actived).toBe(1);
    expect(d.isIdle()).toBe(false);
  });

  it('idleNow schaltet sofort inaktiv (genau ein onIdle)', () => {
    let idled = 0;
    const d = new AudioIdleDetector({ timeoutMs: 5000, onIdle: () => { idled++; } });
    d.idleNow();
    d.idleNow();
    expect(d.isIdle()).toBe(true);
    expect(idled).toBe(1);
  });

  it('dispose stoppt den Timer', () => {
    let idled = 0;
    const d = new AudioIdleDetector({ timeoutMs: 5000, onIdle: () => { idled++; } });
    d.arm();
    d.dispose();
    vi.advanceTimersByTime(10_000);
    expect(idled).toBe(0);
    expect(d.isIdle()).toBe(false);
  });

  it('timeoutMs wird auf mindestens 1 s geclampt', () => {
    let idled = 0;
    const d = new AudioIdleDetector({ timeoutMs: 100, onIdle: () => { idled++; } });
    d.arm();
    vi.advanceTimersByTime(999);
    expect(idled).toBe(0);
    vi.advanceTimersByTime(1);
    expect(idled).toBe(1);
  });
});
