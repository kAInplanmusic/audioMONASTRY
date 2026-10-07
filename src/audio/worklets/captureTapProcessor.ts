/**
 * audioMONASTRY · captureTapProcessor (IDEA-2026-10-07-A „Capture“)
 * =================================================================
 * Paralleler Abgriff am hörbaren V2-Ausgang (`V2LiveSink.connectExtra`).
 * Schreibt jedes Render-Quantum in einen SharedArrayBuffer-Ring (60 s Stereo),
 * aus dem der Main-Thread beim Capture-Klick liest.
 *
 * - 1 Eingang (Stereo, Mono → L auf beide), 1 Ausgang (immer Nullen). Der
 *   Ausgang hängt nur an `ctx.destination`, damit Chromium den Knoten sicher
 *   rendert; er trägt nichts zum Signal bei und fügt dem Hauptpfad KEINE
 *   Latenz hinzu (reiner Fan-out).
 * - Einmalige Port-Nachricht: `{ type: 'capture-sab', data, header, frames }`
 *   (Layout: src/core/capture/captureRing.ts). `{ type: 'capture-stop' }`
 *   beendet den Knoten.
 * - `process()`: keine Allokation, kein Netzwerk/Storage/console.
 */
import { CAPTURE_CHANNELS, writeCaptureBlock } from '../../core/capture/captureRing';

interface CaptureSabMessage {
  type: 'capture-sab';
  data: SharedArrayBuffer;
  header: SharedArrayBuffer;
  frames: number;
}

class CaptureTapProcessor extends AudioWorkletProcessor {
  private ringL: Float32Array | null = null;
  private ringR: Float32Array | null = null;
  private header: Int32Array | null = null;
  private alive = true;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<CaptureSabMessage | { type: 'capture-stop' }>) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'capture-stop') {
        this.ringL = null;
        this.ringR = null;
        this.header = null;
        this.alive = false;
        return;
      }
      if (msg.type !== 'capture-sab' || !msg.data || !msg.header) return;
      const frames = Math.floor(msg.frames);
      if (!(frames > 0) || msg.data.byteLength < frames * CAPTURE_CHANNELS * 4) return;
      this.ringL = new Float32Array(msg.data, 0, frames);
      this.ringR = new Float32Array(msg.data, frames * 4, frames);
      this.header = new Int32Array(msg.header);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (out) for (let c = 0; c < out.length; c++) out[c].fill(0);
    if (!this.alive) return false;
    const ringL = this.ringL;
    const ringR = this.ringR;
    const header = this.header;
    if (!ringL || !ringR || !header) return true;
    const input = inputs[0];
    const inL = input && input.length > 0 ? input[0] : null;
    const inR = input && input.length > 1 ? input[1] : null;
    const frames = inL ? inL.length : out && out.length > 0 ? out[0].length : 128;
    writeCaptureBlock(ringL, ringR, header, inL, inR, frames);
    return true;
  }
}

registerProcessor('capture-tap-processor', CaptureTapProcessor);
