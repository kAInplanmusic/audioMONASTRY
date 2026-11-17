import type { PluginAudioBlock } from '../../plugins/plugin_interface';
import type { BackendMainPublisher } from './backendMainPublisher';

/** Acquire a fresh server timeline when real source audio starts, rather than during a cold UI load. */
export function createBackendMainLazyPublisher(open: () => Promise<BackendMainPublisher>, onError: (error: Error) => void): BackendMainPublisher {
  let transport: BackendMainPublisher | null = null, opening = false, closed = false, seconds = 0;
  let pending: PluginAudioBlock[] = [];
  let silentSeconds = 0;
  const close = () => { if (!closed) { closed = true; pending = []; transport?.close(); transport = null; } };
  const fail = (error: unknown) => { if (!closed) { close(); onError(error instanceof Error ? error : new Error(String(error))); } };
  return { close, send(block) {
    if (closed) return;
    const silent = !block.channels.some(channel => channel.some(sample => sample !== 0));
    if (transport) {
      silentSeconds = silent ? silentSeconds + block.frameCount / block.sampleRate : 0;
      if (silentSeconds >= 2) {
        transport.close(); transport = null; opening = false; seconds = 0; pending = []; silentSeconds = 0;
        return;
      }
      transport.send(block); return;
    }
    // Exact digital silence contributes nothing to a sum. Do not open an idle stream with an aging clock.
    if (!opening && silent) return;
    seconds += block.frameCount / block.sampleRate;
    if (!Number.isFinite(seconds) || seconds > 1) { fail(new Error('Main source start queue exceeded 1000ms')); return; }
    pending.push(block);
    if (opening) return;
    opening = true;
    void open().then(value => {
      if (closed) { value.close(); return; }
      transport = value;
      const queue = pending; pending = [];
      try { for (const item of queue) { if (closed) break; value.send(item); } } catch (error) { fail(error); }
    }).catch(fail);
  } };
}
