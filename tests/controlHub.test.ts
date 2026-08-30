import { describe, expect, it } from 'vitest';
import { ControlHub } from '../src/core/hardware/ControlHub';
import type { ControlEvent, ControlMessage, IHardwareAdapter } from '../src/core/interfaces';

class FakeAdapter implements IHardwareAdapter {
  readonly id: string;
  private eventCb: ((ev: ControlEvent) => void) | null = null;
  private controlCb: ((msg: ControlMessage) => void) | null = null;
  connected = false;
  failConnect = false;

  constructor(id: string) { this.id = id; }

  async connect(): Promise<void> {
    if (this.failConnect) throw new Error(`${this.id}: verbinden fehlgeschlagen`);
    this.connected = true;
  }

  disconnect(): void { this.connected = false; }

  onControl(cb: (msg: ControlMessage) => void): void { this.controlCb = cb; }
  onControlEvent(cb: (ev: ControlEvent) => void): void { this.eventCb = cb; }
  send(_msg: ControlMessage): void {}

  emit(ev: ControlEvent): void { this.eventCb?.(ev); }
  emitControl(msg: ControlMessage): void { this.controlCb?.(msg); }
}

const ev = (proto: ControlEvent['sourceProtocol']): ControlEvent => ({
  sourceDevice: 'dev-1', sourceProtocol: proto, channel: 1,
  parameter: 21, value: 64, resolution: 127, messageType: 'cc', timestamp: 0,
});

describe('ControlHub', () => {
  it('registriert Adapter und verteilt ControlEvents an Subscriber', () => {
    const hub = new ControlHub();
    const adapter = new FakeAdapter('midi');
    hub.register(adapter);

    const seen: ControlEvent[] = [];
    const off = hub.onControlEvent((e) => seen.push(e));
    adapter.emit(ev('midi'));

    expect(seen).toHaveLength(1);
    expect(seen[0].parameter).toBe(21);
    off();
    adapter.emit(ev('midi'));
    expect(seen).toHaveLength(1);
  });

  it('verbindet Adapter mit Fehlerisolierung', async () => {
    const hub = new ControlHub();
    const ok = new FakeAdapter('ok');
    const broken = new FakeAdapter('broken');
    broken.failConnect = true;
    hub.register(ok);
    hub.register(broken);

    const result = await hub.connectAll();
    expect(result.ok).toEqual(['ok']);
    expect(result.failed).toEqual(['broken']);
    expect(hub.listStatus().find((s) => s.adapterId === 'ok')?.connected).toBe(true);
    expect(hub.listStatus().find((s) => s.adapterId === 'broken')?.connected).toBe(false);
  });

  it('trennt Adapter sauber', async () => {
    const hub = new ControlHub();
    const adapter = new FakeAdapter('midi');
    hub.register(adapter);
    await hub.connect('midi');
    expect(adapter.connected).toBe(true);
    hub.disconnect('midi');
    expect(adapter.connected).toBe(false);
  });
});
