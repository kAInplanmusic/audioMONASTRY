// @vitest-environment node
/**
 * RT-AUDIT-P1-010: keine großen Daten im Audio-Thread klonen
 * ==========================================================
 * Vorher: `V2LiveSink.post()` schickte `sample-set` (L/R-Arrays) und `sfz-load`
 * (SFZ-Text + Quellen) ohne Transfer-Liste → strukturiertes Klonen, das im
 * Audio-Thread deserialisiert wird; der Prozessor parste SFZ-Text im
 * Message-Handler; `audioEngine.triggerEvent()` schickte bei JEDEM Pad-Schlag
 * das komplette Sample.
 *
 * Geprüft wird:
 *   - `sample-load` nutzt Transfer: das gesendete Array ist danach abgekoppelt
 *     (`byteLength === 0`), der AudioBuffer bleibt intakt (Fake-Port bildet
 *     `structuredClone(msg, { transfer })` nach, wie der echte MessagePort).
 *   - `triggerEvent` sendet bei unverändertem Sample weder `sample-load` noch
 *     `sample-set` (Spy auf `post`), nur `sample-trigger`.
 *   - Pool-Buchführung: neuer Prozessor → einmal neu laden; Rückwechsel nach
 *     einer Hörprobe → nur `sample-assign`; Budget verdrängt Unbenutztes.
 *   - echter Prozessor: Pool + Zuordnung spielen hörbar; SFZ als fertige
 *     Regionen-Tabelle spielt hörbar; der Prozessor-Modulgraph erreicht den
 *     SFZ-Text-Parser nicht mehr.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { V2LiveSink, copyAudioBufferChannels } from '../src/core/audio/backends/V2LiveSink';
import { V2SampleUploader } from '../src/audio/v2SampleUploader';
import { parseSfz } from '../src/core/instrument/sfzParser';

const SR = 48000;
const N = 128;

// ---------------------------------------------------------------------------
// Fakes: AudioBuffer, Port mit echter Transfer-Semantik, AudioWorkletNode
// ---------------------------------------------------------------------------
class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly data: Float32Array[];
  constructor(channels: Float32Array[], sampleRate = 44100) {
    this.data = channels;
    this.numberOfChannels = channels.length;
    this.length = channels[0].length;
    this.sampleRate = sampleRate;
  }
  getChannelData(ch: number): Float32Array { return this.data[ch]; }
  copyFromChannel(dest: Float32Array, ch: number): void { dest.set(this.data[ch].subarray(0, dest.length)); }
}

function ramp(frames: number, scale = 1): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin(i * 0.05) * 0.5 * scale;
  return out;
}

function fakeBuffer(frames: number, channels = 2): AudioBuffer {
  const chans = Array.from({ length: channels }, (_, c) => ramp(frames, c + 1));
  return new FakeAudioBuffer(chans) as unknown as AudioBuffer;
}

type Msg = Record<string, unknown> & { type: string };

class TransferPort {
  /** Was beim Empfänger ankommt (Klon NACH Transfer, wie beim echten MessagePort). */
  readonly received: Msg[] = [];
  /** Angehängter Empfänger (z. B. echter Prozessor). */
  deliver: ((data: Msg) => void) | null = null;
  postMessage(message: Msg, transfer?: Transferable[]): void {
    const clone = structuredClone(message, { transfer: (transfer ?? []) as Transferable[] }) as Msg;
    this.received.push(clone);
    this.deliver?.(clone);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  start(): void {}
}

class FakeNode {
  static created: FakeNode[] = [];
  readonly port = new TransferPort();
  onprocessorerror: unknown = null;
  constructor() { FakeNode.created.push(this); }
  connect(): void {}
  disconnect(): void {}
}

function fakeContext(): AudioContext {
  return { audioWorklet: { addModule: vi.fn(async () => {}) }, destination: {} } as unknown as AudioContext;
}

async function connectedSink(options: ConstructorParameters<typeof V2LiveSink>[0] = {}): Promise<{ sink: V2LiveSink; port: TransferPort }> {
  vi.stubGlobal('AudioWorkletNode', FakeNode);
  const sink = new V2LiveSink(options);
  await expect(sink.connect(fakeContext())).resolves.toBe(true);
  const port = FakeNode.created[FakeNode.created.length - 1].port;
  port.received.length = 0; // output-layout ausblenden
  return { sink, port };
}

function types(port: TransferPort): string[] {
  return port.received.map((m) => m.type);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeNode.created = [];
});

// ---------------------------------------------------------------------------
// Transfer statt Klonen
// ---------------------------------------------------------------------------
describe('RT-AUDIT-P1-010: sample-load per Transfer', () => {
  it('loadSample überträgt die Arrays: danach byteLength === 0, Empfänger hat die Daten', async () => {
    const { sink, port } = await connectedSink();
    const left = ramp(4096);
    const right = ramp(4096, 2);
    const expectL = Array.from(left);
    expect(sink.loadSample('kick', left, right, 44100)).toBe(true);

    expect(left.byteLength).toBe(0);
    expect(right.byteLength).toBe(0);
    expect(types(port)).toEqual(['sample-load']);
    const msg = port.received[0];
    expect(msg.id).toBe('kick');
    expect(msg.sourceRate).toBe(44100);
    expect(Array.from(msg.left as Float32Array)).toEqual(expectL);
    expect((msg.right as Float32Array).length).toBe(4096);
  });

  it('AudioBuffer bleibt intakt: copyFromChannel-Kopien werden übertragen, nie getChannelData-Ansichten', async () => {
    const { sink, port } = await connectedSink();
    const buffer = fakeBuffer(48000);
    const viewL = buffer.getChannelData(0);
    const before = Array.from(viewL.subarray(0, 64));
    const uploader = new V2SampleUploader({ getSink: () => sink });

    expect(uploader.bridgeAudioBuffer('channel1', buffer)).toBe(true);
    expect(types(port)).toEqual(['sample-load', 'sample-assign']);
    // AudioBuffer unverändert und nicht abgekoppelt.
    expect(buffer.getChannelData(0).byteLength).toBe(48000 * 4);
    expect(buffer.getChannelData(1).byteLength).toBe(48000 * 4);
    expect(Array.from(buffer.getChannelData(0).subarray(0, 64))).toEqual(before);
    // Empfänger hat die gleichen Daten.
    const sent = port.received[0].left as Float32Array;
    expect(sent.length).toBe(48000);
    expect(Array.from(sent.subarray(0, 64))).toEqual(before);
  });

  it('copyAudioBufferChannels liefert eigene Arrays (Mono: right = null)', () => {
    const buffer = fakeBuffer(256, 1);
    const { left, right } = copyAudioBufferChannels(buffer);
    expect(left).not.toBe(buffer.getChannelData(0));
    expect(Array.from(left)).toEqual(Array.from(buffer.getChannelData(0)));
    expect(right).toBeNull();
  });

  it('eine Ansicht auf einen größeren Puffer wird kopiert statt den Fremdpuffer abzugeben', async () => {
    const { sink, port } = await connectedSink();
    const big = ramp(1000);
    const view = big.subarray(100, 300);
    expect(sink.loadSample('v', view)).toBe(true);
    expect(big.byteLength).toBe(4000); // Fremdpuffer bleibt beim Aufrufer
    expect((port.received[0].left as Float32Array).length).toBe(200);
  });

  it('Kompatibilitätsweg setSampleBuffer: Aufrufer behält seine Arrays, gesendet wird per Transfer', async () => {
    const { sink, port } = await connectedSink();
    const left = ramp(512);
    expect(sink.setSampleBuffer('channel3', left, null, 48000)).toBe(true);
    expect(left.byteLength).toBe(512 * 4);
    expect(types(port)).toEqual(['sample-load', 'sample-assign']);
    expect(types(port)).not.toContain('sample-set');
    // Zweiter Aufruf ersetzt das anonyme Sample und gibt das alte frei.
    port.received.length = 0;
    expect(sink.setSampleBuffer('channel3', ramp(256), null, 48000)).toBe(true);
    expect(types(port)).toEqual(['sample-load', 'sample-assign', 'sample-unload']);
  });

  it('SFZ: loadSfzBank parst im Main-Thread und überträgt Kopien der Quellen', async () => {
    const { sink, port } = await connectedSink();
    const a = ramp(300);
    const sources = { 'a.wav': a, 'alias.wav': a };
    expect(sink.loadSfzBank('channel4', '<region> sample=a.wav key=60', sources)).toBe(true);
    expect(a.byteLength).toBe(300 * 4); // Aufrufer behält das Original
    const msg = port.received[0];
    expect(msg.type).toBe('sfz-regions');
    expect(msg).not.toHaveProperty('sfzText');
    expect((msg.regions as Array<{ sample?: string }>)[0].sample).toBe('a.wav');
    const sent = msg.sources as Record<string, Float32Array>;
    expect(sent['a.wav'].length).toBe(300);
    expect(sent['alias.wav']).toBe(sent['a.wav']); // gleiche Quelle → ein Array, ein Transfer
  });

  it('loadSfzRegions überträgt die übergebenen Quellen (danach abgekoppelt)', async () => {
    const { sink } = await connectedSink();
    const src = ramp(64);
    const { regions } = parseSfz('<region> sample=s key=60');
    expect(sink.loadSfzRegions('channel4', regions, { s: src })).toBe(true);
    expect(src.byteLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Kein Sample-Versand pro Trigger / Pool-Buchführung
// ---------------------------------------------------------------------------
describe('RT-AUDIT-P1-010: Sample nur beim Laden/Wechsel senden', () => {
  it('Uploader: unverändertes Sample → keine Nachricht; Rückwechsel → nur sample-assign', async () => {
    const { sink, port } = await connectedSink();
    const uploader = new V2SampleUploader({ getSink: () => sink });
    const a = fakeBuffer(2000);
    const b = fakeBuffer(1000);
    uploader.bridgeAudioBuffer('channel1', a);
    port.received.length = 0;

    for (let i = 0; i < 50; i++) expect(uploader.bridgeAudioBuffer('channel1', a)).toBe(true);
    expect(port.received).toHaveLength(0);

    // Hörprobe b auf demselben Kanal, dann zurück zu a: a bleibt im Pool.
    uploader.bridgeAudioBuffer('channel1', b);
    expect(types(port)).toEqual(['sample-load', 'sample-assign']);
    port.received.length = 0;
    uploader.bridgeAudioBuffer('channel1', a);
    expect(types(port)).toEqual(['sample-assign']);

    // Gleiches Sample auf zweitem Kanal: keine Daten, nur Zuordnung.
    port.received.length = 0;
    uploader.bridgeAudioBuffer('channel2', a);
    expect(types(port)).toEqual(['sample-assign']);
  });

  it('neuer Prozessor (Neuaufbau) → Sample wird genau einmal neu geladen', async () => {
    const { sink } = await connectedSink();
    const uploader = new V2SampleUploader({ getSink: () => sink });
    const a = fakeBuffer(1000);
    uploader.bridgeAudioBuffer('channel1', a);
    sink.disconnect();
    expect(sink.hasPooledSample('smp:1')).toBe(false);
    await sink.connect(fakeContext());
    const port = FakeNode.created[FakeNode.created.length - 1].port;
    port.received.length = 0;
    uploader.bridgeAudioBuffer('channel1', a);
    uploader.bridgeAudioBuffer('channel1', a);
    expect(types(port)).toEqual(['sample-load', 'sample-assign']);
  });

  it('prepare-Hook (Einfügepunkt Resampling P1-009) läuft einmal pro Ladevorgang vor loadSample', async () => {
    const { sink, port } = await connectedSink();
    const prepare = vi.fn((s: { left: Float32Array; right: Float32Array | null; sourceRate: number }) => ({ ...s, sourceRate: 48000 }));
    const uploader = new V2SampleUploader({ getSink: () => sink, prepare });
    const a = fakeBuffer(500);
    uploader.bridgeAudioBuffer('channel1', a);
    uploader.bridgeAudioBuffer('channel1', a);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(port.received[0].sourceRate).toBe(48000);
  });

  it('Pool-Budget verdrängt nicht zugeordnete Samples, nie zugeordnete', async () => {
    const { sink, port } = await connectedSink({ samplePoolBudgetBytes: 10_000 });
    const uploader = new V2SampleUploader({ getSink: () => sink });
    const a = fakeBuffer(1000, 1); // 4000 B
    const b = fakeBuffer(1000, 1);
    const c = fakeBuffer(1000, 1);
    uploader.bridgeAudioBuffer('channel1', a);
    uploader.bridgeAudioBuffer('channel1', b); // a unbenutzt, 8000 B
    expect(types(port)).not.toContain('sample-unload');
    uploader.bridgeAudioBuffer('channel2', c); // 12000 B > Budget → a raus
    expect(port.received.filter((m) => m.type === 'sample-unload').map((m) => m.id)).toEqual(['smp:1']);
    expect(sink.hasPooledSample('smp:1')).toBe(false);
    expect(sink.hasPooledSample('smp:2')).toBe(true);
    expect(sink.hasPooledSample('smp:3')).toBe(true);
    expect(sink.pooledSampleBytes).toBe(8000);
  });

  it('audioEngine.triggerEvent: 100 Pad-Schläge ohne sample-load/sample-set (Spy auf post)', async () => {
    const { audioEngine } = await import('../src/utils/audioEngine');
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    const sink = audioEngine.v2LiveSink;
    await expect(sink.connect(fakeContext())).resolves.toBe(true);
    const internals = audioEngine as unknown as {
      samplePlayers: Record<string, unknown>;
      monitor: { isMainHolderActive(): boolean };
    };
    const buffer = fakeBuffer(48000 * 5 / 4); // ~1,9 MB Stereo-Float32
    const previous = internals.samplePlayers.channel1;
    internals.samplePlayers.channel1 = { buffer: { get: () => buffer } };
    vi.spyOn(internals.monitor, 'isMainHolderActive').mockReturnValue(true);
    const post = vi.spyOn(sink as unknown as { post: (m: Msg, t?: Transferable[]) => boolean }, 'post');
    try {
      // Laden (wie loadTrackSample): einmal Daten.
      expect(audioEngine.bridgeAudioBufferToV2('channel1', buffer)).toBe(true);
      // (Der V2-Proxy schickt vor jedem Methodenaufruf zusätzlich den Mix-Abgleich
      // `syncV2FromV1` – hier zählen nur die Sample-Nachrichten.)
      const sampleTypes = (): string[] => post.mock.calls.map((c) => c[0].type).filter((t) => t.startsWith('sample-'));
      expect(sampleTypes()).toEqual(['sample-load', 'sample-assign']);
      post.mockClear();

      for (let i = 0; i < 100; i++) audioEngine.triggerEvent('channel1', 1);
      const sent = sampleTypes();
      expect(sent.filter((t) => t === 'sample-load' || t === 'sample-set')).toHaveLength(0);
      expect(sent.filter((t) => t === 'sample-assign')).toHaveLength(0);
      expect(sent.filter((t) => t === 'sample-trigger')).toHaveLength(100);
      // Der AudioBuffer ist nach 100 Schlägen intakt.
      expect(buffer.getChannelData(0).byteLength).toBe(48000 * 5 / 4 * 4);

      // syncV2SamplesToLiveSink (play()) bei unverändertem Sample: ebenfalls nichts.
      post.mockClear();
      audioEngine.syncV2SamplesToLiveSink();
      expect(sampleTypes()).toEqual([]);
    } finally {
      if (previous === undefined) delete internals.samplePlayers.channel1;
      else internals.samplePlayers.channel1 = previous;
      sink.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Echter Prozessor: Pool + Zuordnung + SFZ-Regionen
// ---------------------------------------------------------------------------
interface ProcessorInstance {
  port: { onmessage: ((e: { data?: unknown }) => void) | null; postMessage: (m: Record<string, unknown>) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorCtor = new () => ProcessorInstance;
let Processor: ProcessorCtor | null = null;

function rms(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / Math.max(1, a.length));
}

function renderBlocks(p: ProcessorInstance, blocks: number, startFrame = 0): number {
  const g = globalThis as unknown as Record<string, number>;
  let energy = 0;
  for (let b = 0; b < blocks; b++) {
    g.currentFrame = startFrame + b * N;
    g.currentTime = g.currentFrame / SR;
    const out = [new Float32Array(N), new Float32Array(N)];
    p.process([], [out]);
    energy = Math.max(energy, rms(out[0]));
  }
  return energy;
}

describe('RT-AUDIT-P1-010: v2SinkProcessor mit Sample-Pool und fertigen SFZ-Regionen', () => {
  beforeAll(async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.sampleRate = SR;
    g.currentFrame = 0;
    g.currentTime = 0;
    g.AudioWorkletProcessor = class {
      port = { onmessage: null, postMessage: () => {} };
    };
    g.registerProcessor = (_name: string, ctor: ProcessorCtor) => { Processor = ctor; };
    await import('../src/audio/worklets/v2SinkProcessor.ts');
    expect(Processor).not.toBeNull();
  });

  async function sinkWithProcessor(): Promise<{ sink: V2LiveSink; p: ProcessorInstance; errors: Record<string, unknown>[] }> {
    const { sink, port } = await connectedSink();
    const p = new Processor!();
    const errors: Record<string, unknown>[] = [];
    p.port.postMessage = (m) => { if (m.type === 'message-error' || m.type === 'render-error') errors.push(m); };
    port.deliver = (data) => p.port.onmessage?.({ data });
    return { sink, p, errors };
  }

  it('sample-load + sample-assign + sample-trigger spielt hörbar; Trigger ohne Daten', async () => {
    const { sink, p, errors } = await sinkWithProcessor();
    const uploader = new V2SampleUploader({ getSink: () => sink });
    const buffer = fakeBuffer(24000);
    expect(uploader.bridgeAudioBuffer('channel1', buffer)).toBe(true);
    expect(renderBlocks(p, 4)).toBe(0); // noch kein Trigger → still
    expect(sink.triggerSample('channel1')).toBe(true);
    expect(renderBlocks(p, 4, 4 * N)).toBeGreaterThan(1e-3);
    // Erneuter Trigger (ohne Daten) spielt wieder.
    sink.stopSample('channel1');
    // RT-AUDIT-P0-004: der Mastering-Limiter verzögert MAIN um seinen echten
    // Lookahead (240 Samples bei 48 kHz) – erst danach muss es exakt still sein.
    renderBlocks(p, 2, 8 * N);
    expect(renderBlocks(p, 2, 10 * N)).toBe(0);
    expect(sink.triggerSample('channel1')).toBe(true);
    expect(renderBlocks(p, 4, 12 * N)).toBeGreaterThan(1e-3);
    expect(errors).toEqual([]);
  });

  it('Zuordnung eines unbekannten Pool-Samples ändert nichts (kein Fehler)', async () => {
    const { p, errors } = await sinkWithProcessor();
    p.port.onmessage?.({ data: { type: 'sample-assign', channel: 'channel2', id: 'gibt-es-nicht' } });
    p.port.onmessage?.({ data: { type: 'sample-trigger', channel: 'channel2' } });
    expect(renderBlocks(p, 2)).toBe(0);
    expect(errors).toEqual([]);
  });

  it('sfz-regions (im Main-Thread geparst) + Note-On spielt hörbar', async () => {
    const { sink, p, errors } = await sinkWithProcessor();
    expect(sink.loadSfzBank('channel4', '<region> sample=a.wav lokey=0 hikey=127', { 'a.wav': ramp(12000) })).toBe(true);
    expect(sink.sfzNoteOn('channel4', 60, 120)).toBe(true);
    expect(renderBlocks(p, 6)).toBeGreaterThan(1e-3);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Kein SFZ-Text-Parser im Audio-Thread (statischer Importgraph)
// ---------------------------------------------------------------------------
describe('RT-AUDIT-P1-010: Prozessor-Modul erreicht den SFZ-Text-Parser nicht', () => {
  const ROOT = path.resolve(__dirname, '..');

  function resolveImport(from: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(from), spec);
    for (const cand of [`${base}.ts`, `${base}.tsx`, base, path.join(base, 'index.ts')]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
    return null;
  }

  /** Nur Laufzeit-Importe (`import type` fällt beim Bündeln weg). */
  function runtimeImports(file: string): string[] {
    const src = readFileSync(file, 'utf8');
    const out: string[] = [];
    const re = /^\s*(import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // `import { type A, type B } from` ist ebenfalls rein typisch.
      const onlyBraces = /^\s*(?:import|export)\s*\{([^}]*)\}\s*from/.exec(m[0]);
      if (onlyBraces) {
        const names = onlyBraces[1].split(',').map((s) => s.trim()).filter(Boolean);
        if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
      }
      const resolved = resolveImport(file, m[2]);
      if (resolved) out.push(resolved);
    }
    return out;
  }

  it('transitiver Laufzeit-Importgraph enthält weder sfzParser.ts noch sfzVoice.ts', () => {
    const entry = path.join(ROOT, 'src/audio/worklets/v2SinkProcessor.ts');
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const dep of runtimeImports(file)) stack.push(dep);
    }
    const rel = [...seen].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    expect(rel).toContain('src/core/instrument/sfzVoiceBankCore.ts');
    expect(rel).not.toContain('src/core/instrument/sfzParser.ts');
    expect(rel).not.toContain('src/core/instrument/sfzVoice.ts');
  });

  it('Prozessor-Quelltext: kein parseSfz, kein bank.load(Text), kein sample-set/sfz-load', () => {
    const src = readFileSync(path.join(ROOT, 'src/audio/worklets/v2SinkProcessor.ts'), 'utf8');
    expect(src).not.toMatch(/parseSfz/);
    expect(src).not.toMatch(/\.load\(\s*msg\./);
    expect(src).not.toMatch(/case 'sample-set'/);
    expect(src).not.toMatch(/case 'sfz-load'/);
    expect(src).toMatch(/loadParsed\(/);
  });
});
