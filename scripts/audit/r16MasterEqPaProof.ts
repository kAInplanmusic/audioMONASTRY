import http from 'node:http';
import { WebSocket } from 'ws';
import { attachBackendMainTransport } from '../../server/backendMainTransport';
import { BACKEND_MAIN_HEADER_BYTES, BACKEND_MAIN_PATH } from '../../src/core/transport/backendMainProtocol';

/**
 * R16 §P2/P3 hörbarer Nachweis ohne Menschenohren: derselbe 1-kHz-Ton läuft über den
 * echten Backend-Transport zum PA-Empfänger. Einmal neutral, einmal mit +12 dB im
 * 1-kHz-Band des 12-Band-Masters. Gemessen wird, was die PA tatsächlich bekommt:
 * PCM24-Amplitude und die waveform-peak-Telemetrie.
 */
const SR = 96_000;
const FRAMES = 960; // 10 ms
const HZ = 1000;

const pcmPacket = (sequence: number, startFrame: number, gain: number): Buffer => {
  const buf = Buffer.alloc(BACKEND_MAIN_HEADER_BYTES + FRAMES * 6);
  buf.write('BMA1', 0, 'ascii');
  buf.writeUInt32LE(sequence, 4);
  buf.writeUInt32LE(startFrame, 8);
  buf.writeUInt32LE(FRAMES, 12);
  for (let f = 0; f < FRAMES; f++) {
    const v = Math.round(Math.sin((2 * Math.PI * HZ * (startFrame + f)) / SR) * 0.25 * gain * 8388608);
    buf.writeIntLE(Math.max(-8388608, Math.min(8388607, v)), BACKEND_MAIN_HEADER_BYTES + f * 6, 3);
    buf.writeIntLE(Math.max(-8388608, Math.min(8388607, v)), BACKEND_MAIN_HEADER_BYTES + f * 6 + 3, 3);
  }
  return buf;
};

type Measured = { peak: number; rms: number; chunkPeaks: number[]; waveform: { count: number; peakL: number[]; clipped: number; maxPeakL: number; maxPeakR: number }; first: number; last: number };

async function run(label: string, master: Record<string, unknown> | null, seconds = 4, inputGain = 1): Promise<Measured> {
  const server = http.createServer();
  const transport = attachBackendMainTransport(server, {
    authenticate: () => 'local',
    authorize: () => true,
    sampleRate: () => SR,
    encoding: 'pcm24',
    processorSnapshot: () => (master ? { master: { active: true, epoch: 1, parameters: master } } : {}),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `ws://127.0.0.1:${port}${BACKEND_MAIN_PATH}?session=r16-proof`;
  const pa = new WebSocket(`${base}&role=pa`);
  const metered: Measured = { peak: 0, rms: 0, chunkPeaks: [], waveform: { count: 0, peakL: [], clipped: 0, maxPeakL: 0, maxPeakR: 0 } as Measured['waveform'], first: 0, last: 0 };
  let energy = 0, count = 0;
  pa.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      for (let i = 0; i < data.length; i += 6) {
        const v = data.readIntLE(i, 3) / 8388608;
        const a = Math.abs(v);
        if (a > metered.peak) metered.peak = a;
        energy += v * v; count += 1;
      }
      metered.chunkPeaks.push(metered.peak);
      metered.last = Date.now();
      return;
    }
    const msg = JSON.parse(data.toString());
    if (msg.type === 'waveform-peak') {
      metered.waveform.count += 1; metered.waveform.peakL.push(msg.peakL);
      if (msg.peakL > (metered.waveform as any).maxPeakL) (metered.waveform as any).maxPeakL = msg.peakL;
      if (msg.peakR > (metered.waveform as any).maxPeakR) (metered.waveform as any).maxPeakR = msg.peakR;
      if (msg.clipped > 0) metered.waveform.clipped += 1;
      if (!metered.first) metered.first = Date.now();
    }
  });
  await new Promise(resolve => pa.once('open', resolve));
  const contributor = new WebSocket(`${base}&role=contributor&plugin=song`);
  await new Promise(resolve => contributor.once('open', resolve));

  const packets = Math.round((seconds * 1000) / 10);
  for (let i = 0; i < packets; i++) {
    contributor.send(pcmPacket(i, i * FRAMES, inputGain));
    await new Promise(r => setTimeout(r, 10));
  }
  await new Promise(r => setTimeout(r, 600));
  metered.rms = Math.sqrt(energy / Math.max(count, 1));
  contributor.close(); pa.close(); transport.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  console.log(`RUN ${label} ${JSON.stringify({ peak: metered.peak, rms: metered.rms, chunks: metered.chunkPeaks.length, waveform: metered.waveform.count, clippedMessages: metered.waveform.clipped })}`);
  return metered;
}

const bands = [0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0];
const neutral = await run('neutral', null);
const boosted = await run('master-1k-+12dB', { gain: 1, bands });
const clipping = await run('master-1k-clipping', { gain: 1, bands }, 2, 1.6);

const ratio = neutral.peak > 0 ? boosted.peak / neutral.peak : 0;
const waveformRatio = neutral.waveform.maxPeakL > 0 ? boosted.waveform.maxPeakL / neutral.waveform.maxPeakL : 0;
const result = {
  status: ratio > 3.5 && waveformRatio > 3.5 && boosted.waveform.count >= 5 && neutral.waveform.count >= 5 && clipping.waveform.clipped > 0 ? 'pass' : 'fail',
  neutralPeak: Number(neutral.peak.toFixed(4)), boostedPeak: Number(boosted.peak.toFixed(4)),
  amplitudeRatio: Number(ratio.toFixed(3)),
  expectedRatio: 'about 4 (+12 dB = factor 3.98)',
  neutralWaveformMessages: neutral.waveform.count, boostedWaveformMessages: boosted.waveform.count,
  waveformPeakLNeutral: Number(neutral.waveform.maxPeakL.toFixed(4)),
  waveformPeakLBoosted: Number(boosted.waveform.maxPeakL.toFixed(4)),
  clippingCase: { inputGain: 1.6, clippedWaveformMessages: clipping.waveform.clipped, paPeak: Number(clipping.peak.toFixed(4)) },
  waveformRatio: Number(waveformRatio.toFixed(3)),
  scope: 'real WebSocket transport, real mixer, real PCM24 to a PA receiver; synthetic 1 kHz tone, no browser and no human listening test',
};
console.log(JSON.stringify(result));
process.exit(result.status === 'pass' ? 0 : 1);
