import type { PluginAudioBlock } from '../../plugins/plugin_interface';
import { BACKEND_MAIN_PATH, BACKEND_MAIN_RATES, encodeBackendMainInput, type BackendMainReady } from '../transport/backendMainProtocol';
import type { MainTransportTicket } from '../transport/backendMainClient';
import type { BackendMainPluginId } from './backendMainAdapter';
import { BackendMainResampler } from './backendMainResampler';

export interface BackendMainPublisherDependencies {
  requestTicket: (plugin: BackendMainPluginId) => Promise<MainTransportTicket>;
  createSocket: (url: string) => WebSocket;
  origin: string;
  onError?: (error: Error) => void;
}
export interface BackendMainPublisher { send(block: PluginAudioBlock): void; close(): void }
const MAX_PENDING_BYTES = 1024 * 1024;

/** Opens a contributor only after the server supplies its actual format and timeline. */
export async function openBackendMainPublisher(deps: BackendMainPublisherDependencies, plugin: BackendMainPluginId): Promise<BackendMainPublisher> {
  const ticket = await deps.requestTicket(plugin);
  if (ticket.role !== 'contributor' || ticket.plugin !== plugin || !ticket.ticket || !ticket.session) throw new Error('Invalid Main contributor ticket');
  const url = new URL(BACKEND_MAIN_PATH, deps.origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid Main origin');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket.ticket); url.searchParams.set('session', ticket.session);
  url.searchParams.set('role', ticket.role); url.searchParams.set('plugin', plugin);
  const socket = deps.createSocket(url.toString());
  return new Promise((resolve, reject) => {
    let closed = false, ready = false, sequence = 0, frame = 0, rate = 0;
    let resampler: BackendMainResampler | null = null, sourceRate = 0;
    let pending: number[][] = [[], []];
    const timeout = setTimeout(() => fail(new Error('Main contributor ready timeout')), 5000);
    const close = () => { if (!closed) { closed = true; clearTimeout(timeout); socket.close(); } };
    const fail = (error: Error) => {
      if (closed) return;
      close();
      if (!ready) reject(error); else deps.onError?.(error);
    };
    socket.onerror = () => fail(new Error('Main contributor socket error'));
    socket.onclose = () => { if (!closed) { closed = true; clearTimeout(timeout); const error = new Error('Main contributor socket closed'); if (!ready) reject(error); else deps.onError?.(error); } };
    socket.onmessage = event => {
      if (closed || ready) return;
      try {
        if (typeof event.data !== 'string') throw new Error('Invalid Main ready message');
        const value = JSON.parse(event.data) as BackendMainReady;
        if (value.type !== 'ready' || !BACKEND_MAIN_RATES.some(r => r === value.sampleRate) || value.channels !== 2 || value.format !== 's24le' || !Number.isSafeInteger(value.frame) || value.frame < 0) throw new Error('Invalid Main ready message');
        clearTimeout(timeout); rate = value.sampleRate; frame = value.frame + rate; ready = true;
        resolve({ close, send(block) {
          if (closed) return;
          try {
            if (![44100, ...BACKEND_MAIN_RATES].includes(block.sampleRate)) throw new Error('Unsupported source sample rate');
            if (sourceRate && sourceRate !== block.sampleRate) throw new Error('Main source sample rate changed');
            sourceRate = block.sampleRate;
            if (!Number.isSafeInteger(block.frameCount) || block.frameCount <= 0 || block.frameCount > block.sampleRate / 10 || block.channels.length !== 2 || block.channels.some(channel => channel.length < block.frameCount)) throw new Error('Invalid Main audio block');
            if (sourceRate !== rate && !resampler) resampler = new BackendMainResampler(sourceRate, rate);
            const channels = resampler ? resampler.process(block.channels, block.frameCount) : block.channels;
            const outputFrames = resampler ? channels[0].length : block.frameCount;
            // Aggregate 10ms packets so small worklet blocks cannot exhaust the server segment limit.
            for (let i = 0; i < outputFrames; i++) for (let channel = 0; channel < 2; channel++) {
              const sample = channels[channel][i];
              if (!Number.isFinite(sample)) throw new Error('Non-finite Main audio sample');
              pending[channel].push(sample);
            }
            const packetFrames = rate / 100;
            while (pending[0].length >= packetFrames) {
              const pcm = new Uint8Array(packetFrames * 6);
              for (let i = 0; i < packetFrames; i++) for (let channel = 0; channel < 2; channel++) {
                const clamped = Math.max(-1, Math.min(1, pending[channel][i]));
                const value = Math.max(-8388608, Math.min(8388607, Math.round(clamped * 8388608)));
                const offset = i * 6 + channel * 3;
                pcm[offset] = value & 255; pcm[offset + 1] = (value >> 8) & 255; pcm[offset + 2] = (value >> 16) & 255;
              }
              const packet = encodeBackendMainInput(sequence, frame, pcm);
              if (socket.bufferedAmount + packet.byteLength > MAX_PENDING_BYTES) throw new Error('Main contributor backpressure');
              if (socket.readyState !== 1) throw new Error('Main contributor is not open');
              socket.send(packet); sequence++; frame += packetFrames;
              pending = [pending[0].slice(packetFrames), pending[1].slice(packetFrames)];
            }
          } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        } });
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
  });
}
