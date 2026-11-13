/** Local V2 renderer fixture, NOT a browser/session mixer holder. */
import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';
import { V2SinkEngine } from '../../src/core/audio/live/V2SinkEngine';

const engine = new V2SinkEngine(48000, 128);
engine.setTestTone(true, 440, .2);
engine.setMasterDsp(6000, .6, .5, .8);
let blocks = 0;
let checksum = 0;
const ctx = { sampleRate: 48000, bufferSize: 128, quantum: 128 / 48000, currentTime: 0 };
const origin = performance.now();
// Render every elapsed 128-frame quantum; never replace elapsed time with audio duration.
const render = setInterval(() => {
  const due = Math.floor((performance.now() - origin) * 48000 / 128000);
  while (blocks < due) {
    ctx.currentTime = blocks * 128 / 48000;
    checksum += engine.render(ctx)[0][0];
    blocks++;
  }
}, 2);
const socket = dgram.createSocket('udp4');
socket.on('message', (packet, remote) => socket.send(packet, remote.port, remote.address));
socket.bind(0, '127.0.0.1', () => {
  const address = socket.address();
  console.log(JSON.stringify({ pid: process.pid, port: address.port, workload: 'V2SinkEngine tone + master DSP, 48000 Hz/128 frames' }));
});
process.on('SIGTERM', () => {
  clearInterval(render);
  console.log(JSON.stringify({ blocks, audioSeconds: blocks * 128 / 48000, checksum }));
  socket.close();
});
