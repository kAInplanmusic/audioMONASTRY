import { describe, expect, it } from 'vitest';
import { AudioBuffer, AudioGraph, AudioParameter, AudioPort } from '../src/core/audio/AudioGraph';
import type { IAudioNode, IProcessingContext } from '../src/core/audio/types';
import { SpatialScene } from '../src/core/spatial/SpatialScene';
import { OUTPUT_LAYOUTS, getOutputLayout } from '../src/core/spatial/layouts';
import { RuleBasedSpeechToIntent } from '../src/core/voice/SpeechToIntent';
import { AutomationAgent } from '../src/core/voice/AutomationAgent';
import { OfflineRenderer } from '../src/core/render/OfflineRenderer';
import { createOutputConfig, listSupportedLayoutIds } from '../src/core/output/OutputConfig';
import { createIpcMessage } from '../src/core/audio/runtime/ipc';

class MockNode implements IAudioNode {
  readonly id: string;
  readonly type = 'mock';
  readonly inputs: AudioPort[];
  readonly outputs: AudioPort[];
  readonly parameters: AudioParameter[];
  processed = 0;

  constructor(id: string, inputs = 1, outputs = 1) {
    this.id = id;
    this.inputs = Array.from({ length: inputs }, (_, i) => new AudioPort(this, 'input', `${id}:in${i}`));
    this.outputs = Array.from({ length: outputs }, (_, i) => new AudioPort(this, 'output', `${id}:out${i}`));
    this.parameters = [];
  }

  process(_ctx: IProcessingContext): void {
    this.processed++;
  }

  reset(): void {
    this.processed = 0;
  }
}

describe('AudioRuntime-Abstraktion (Phase 1)', () => {
  it('AudioBuffer clone/createEmpty sind deterministisch', () => {
    const buf = new AudioBuffer(48000, 8, 2);
    buf.channelData[0][0] = 0.5;
    const copy = buf.clone();
    expect(copy.channelData[0][0]).toBe(0.5);
    const empty = buf.createEmpty();
    expect(empty.channelData).toHaveLength(2);
    expect(empty.channelData[0][0]).toBe(0);
  });

  it('AudioGraph kompiliert in topologischer Reihenfolge', () => {
    const graph = new AudioGraph();
    const a = new MockNode('a', 0, 1);
    const b = new MockNode('b', 1, 1);
    const c = new MockNode('c', 1, 0);
    graph.addNode(a);
    graph.addNode(b);
    graph.addNode(c);
    graph.connect(a.outputs[0], b.inputs[0]);
    graph.connect(b.outputs[0], c.inputs[0]);

    const plan = graph.compile();
    expect(plan.validated).toBe(true);
    expect(plan.order).toEqual(['a', 'b', 'c']);
  });

  it('AudioGraph erkennt Zyklen', () => {
    const graph = new AudioGraph();
    const a = new MockNode('a', 1, 1);
    const b = new MockNode('b', 1, 1);
    graph.addNode(a);
    graph.addNode(b);
    graph.connect(a.outputs[0], b.inputs[0]);
    graph.connect(b.outputs[0], a.inputs[0]);
    expect(graph.compile().validated).toBe(false);
    expect(() => graph.process({ sampleRate: 48000, bufferSize: 128, quantum: 128 / 48000, currentTime: 0 })).toThrow();
  });
});

describe('SpatialScene (Phase 3)', () => {
  it('AudioObjects sind vom Track entkoppelt und automatisierbar', () => {
    const scene = new SpatialScene();
    scene.addAudioObject({
      id: 'obj-1', name: 'Kick', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      gain: 1, sourceRef: 'channel1', automation: { position: [], gain: [] },
    });
    scene.setAudioObjectPosition('obj-1', { x: 1, y: -0.5, z: 0 }, 1.5);
    expect(scene.getAudioObject('obj-1')?.position.x).toBe(1);
    expect(scene.getAudioObject('obj-1')?.automation.position).toHaveLength(1);
    expect(scene.snapshot().mode).toBe('stereo');
  });

  it('unterstützt Layouts bis 24.2', () => {
    const layout = getOutputLayout('24.2');
    expect(layout?.channelCount).toBe(26);
    expect(OUTPUT_LAYOUTS.some((l) => l.id === '24.2')).toBe(true);
  });
});

describe('VoiceMONK + Automation (Phase 4)', () => {
  it('Speech-to-Intent erkennt Tempo-Befehle', async () => {
    const parser = new RuleBasedSpeechToIntent();
    const intent = await parser.parse('Setze Tempo auf 128 BPM');
    expect(intent.action).toBe('set_tempo');
    expect(intent.parameters.bpm).toBe(128);
  });

  it('AutomationAgent erzeugt Curves aus Intents', async () => {
    const parser = new RuleBasedSpeechToIntent();
    const agent = new AutomationAgent();
    const intent = await parser.parse('Tempo 140');
    const plan = agent.plan(intent, 0);
    expect(plan.curves[0].parameterId).toBe('transport.bpm');
    expect(plan.curves[0].points[0].value).toBe(140);
  });
});

describe('Offline Render + Output + IPC (Phase 2/5)', () => {
  it('OfflineRenderer arbeitet mit derselben Graph-Struktur', async () => {
    const graph = new AudioGraph();
    const node = new MockNode('src', 0, 1);
    graph.addNode(node);
    const output = new AudioBuffer(48000, 256, 2);
    const result = await new OfflineRenderer().render({
      graph, sampleRate: 48000, durationSeconds: 256 / 48000, channels: 2, factor: 4,
    }, output);
    expect(result.deterministic).toBe(true);
    expect(node.processed).toBeGreaterThan(0);
  });

  it('OutputConfig listet alle Layouts inkl. 24.2', () => {
    const ids = listSupportedLayoutIds();
    expect(ids).toContain('stereo');
    expect(ids).toContain('24.2');
    expect(createOutputConfig('24.2').channels).toHaveLength(26);
  });

  it('IPC-Nachrichten sind versioniert und serialisierbar', () => {
    const msg = createIpcMessage('ping', { hello: 'runtime' });
    expect(msg.protocol).toBe(1);
    expect(JSON.parse(JSON.stringify(msg)).channel).toBe('ping');
  });
});
