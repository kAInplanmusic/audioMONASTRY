/**
 * audioMONASTRY · v2SinkProcessor
 * ================================
 * AudioWorklet-Processor des V2-Live-Output-Sinks (Phase 1).
 *
 * Der Processor hostet eine `V2SinkEngine` (inkl. `V2StudioGraph`) direkt im
 * AudioWorklet-Thread. Jeder `process()`-Aufruf rendert genau einen 128er-Block
 * durch den V2-Graph und schreibt das Ergebnis auf die AudioWorklet-Outputs,
 * die vom Main-Thread mit der AudioContext-Destination verbunden sind.
 *
 * Steuerung über Port-Nachrichten (V2SinkMessage):
 *   { type: 'test-tone',  active, freq?, amplitude? }
 *   { type: 'gain-db',    channel, db }
 *   { type: 'pan',        channel, pan }
 *   { type: 'master-gain', value }
 */
import { V2SinkEngine } from '../../core/audio/live/V2SinkEngine';
import type { V2SinkMessage } from '../../core/audio/live/V2SinkEngine';

class V2SinkProcessor extends AudioWorkletProcessor {
  private readonly engine = new V2SinkEngine(sampleRate, 128);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<V2SinkMessage>) => {
      const msg = e.data;
      if (!msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'test-tone':
          this.engine.setTestTone(Boolean(msg.active), msg.freq, msg.amplitude);
          break;
        case 'gain-db':
          if (msg.channel && typeof msg.db === 'number') this.engine.setChannelGainDb(msg.channel, msg.db);
          break;
        case 'pan':
          if (msg.channel && typeof msg.pan === 'number') this.engine.setChannelPan(msg.channel, msg.pan);
          break;
        case 'master-gain':
          if (typeof msg.value === 'number') this.engine.setMasterGain(msg.value);
          break;
        default:
          break;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const length = output[0].length;
    const rendered = this.engine.render({
      sampleRate,
      bufferSize: length,
      quantum: length / sampleRate,
      currentTime,
    });

    const channels = Math.min(output.length, rendered.length);
    for (let ch = 0; ch < channels; ch++) {
      const src = rendered[ch] ?? rendered[0];
      output[ch].set(src);
    }
    for (let ch = channels; ch < output.length; ch++) {
      output[ch].fill(0);
    }
    return true;
  }
}

registerProcessor('v2-sink-processor', V2SinkProcessor);
