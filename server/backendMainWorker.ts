import { parentPort, workerData } from 'node:worker_threads';
import { BackendMainMixer } from './backendMainMixer';
import type { MainProcessorSnapshot } from './backendMainProcessors';
import { mainThreadCpu } from './backendMainCpu';
const port = parentPort!;
const audit = process.env.BACKEND_MAIN_AUDIT === '1';
let snapshot: MainProcessorSnapshot = {};
const streamIds = new Map<string,string>();
const mixer = new BackendMainMixer(workerData.sampleRate, () => snapshot);
const frames = mixer.sampleRate / 10;
const origin = process.hrtime.bigint();
let timer: ReturnType<typeof setTimeout>, stopped = false, pendingBytes = 0, blocks = 0;
const initialCpu = mainThreadCpu();
let lastCpuWall = 0;
const elapsed = () => Number(process.hrtime.bigint() - origin) / 1e6;
function schedule() {
  if (stopped) return;
  // Timer only wakes us; the next deadline derives from sample count and immutable origin.
  const nextDeadline = (mixer.frame + frames) / mixer.sampleRate * 1000;
  timer = setTimeout(wake, Math.max(0, nextDeadline - elapsed()));
}
function wake() {
  if (stopped) return;
  try {
    const due = Math.floor(elapsed() / 100) * frames;
    // One block per turn so incoming packets/control remain ordered while catching up.
    if (mixer.frame < due) {
      if (pendingBytes + frames * 6 > 2 * 1024 * 1024) throw new Error('Main output budget exhausted');
      const start = performance.now();
      const result = mixer.mix(frames);
      const renderMs = performance.now() - start;
      const pcm = new Uint8Array(result.pcm); // Dedicated transferable backing, never a pooled Buffer slab.
      pendingBytes += pcm.byteLength;
      const lagMs = Math.max(0, elapsed() - mixer.frame / mixer.sampleRate * 1000);
      port.postMessage({ type: 'block', ...result, pcm: pcm.buffer, snapshot, sourceIds: mixer.processors.lastReport.sourceIds, streamIds:Object.fromEntries(streamIds), renderedFrames: mixer.frame, lagMs, renderMs }, [pcm.buffer]);
      if (audit && ++blocks % 5 === 0) console.log('R13-PROCESS ' + JSON.stringify({ wall: Date.now(), snapshot, report: mixer.processors.lastReport, renderMs, renderedFrames: mixer.frame, lagMs }));
    }
    if (elapsed() - lastCpuWall >= 1000) {
      lastCpuWall = elapsed();
      port.postMessage({ type: 'metrics', wall: Date.now(), elapsedMs: elapsed(), initialCpu, cpu: mainThreadCpu(), renderedFrames: mixer.frame, pendingBytes });
    }
    schedule();
  } catch (error) { port.postMessage({ type: 'fatal', error: String(error) }); stopped = true; port.close(); }
}
port.on('message', message => {
  try {
    switch (message.type) {
      case 'state': port.postMessage({ id: message.id, frame: mixer.frame }); break;
      case 'snapshot': snapshot = message.snapshot; break;
      case 'remove': mixer.removeTrack(message.plugin); streamIds.delete(message.plugin); break;
      case 'prune': mixer.pruneDrainedTracks(new Set(message.active)); break;
      case 'ack': pendingBytes = Math.max(0, pendingBytes - message.bytes); break;
      case 'enqueue': {
        const bytes = new Uint8Array(message.pcm);
        try { mixer.enqueue(message.plugin, message.sequence, message.frame, bytes); streamIds.set(message.plugin,message.streamId); }
        catch (error) {
          if (audit) console.log('R13-REJECT ' + JSON.stringify({plugin:message.plugin, sequence:message.sequence, inputFrame:message.frame, mixerFrame:mixer.frame, wall:Date.now(), error:String(error)}));
          throw error;
        }
        if (audit) {
          const buffer = Buffer.from(bytes.buffer); let energy = 0, nonzero = 0;
          for (let i = 0; i < buffer.length; i += 3) { const value = buffer.readIntLE(i, 3); if (value) nonzero++; energy += (value / 8388608) ** 2; }
          if (nonzero) console.log('R10-ACCEPT ' + JSON.stringify({plugin:message.plugin, nonzero, energy, wall:Date.now()}));
        }
        port.postMessage({ id: message.id, frame: mixer.frame }); break;
      }
      // Explicit test control, never inferred from production ENV or input packets.
      case 'test-delay': clearTimeout(timer); timer = setTimeout(wake, message.ms); break;
      case 'test-crash': throw new Error('Requested worker crash');
      case 'close': stopped = true; clearTimeout(timer); port.close(); break;
      default: throw new Error('Unknown worker message');
    }
  } catch (error) {
    if (message.id !== undefined) port.postMessage({ id: message.id, error: String(error), frame: mixer.frame });
    else throw error;
  }
});
port.postMessage({ type: 'ready', frame: mixer.frame });
schedule();
