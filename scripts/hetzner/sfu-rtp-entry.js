// =============================================================================
// sfu-rtp-entry.js – Echter SFU-RTP-Pfad-Test (Browser, Mediasoup)
// -----------------------------------------------------------------------------
// Wird mit esbuild zu einem IIFE gebundelt und als /sfu-rtp-test.js im
// App-Webroot ausgeliefert (siehe sfu-rtp-test.html).
//
// Modi (URL-Parameter):
//   ?server=http://IP&mode=producer            Mikrofon produzieren (bleibt offen)
//   ?server=http://IP&mode=consumer&producerId=ID   fremden Producer konsumieren
//   ?server=http://IP&mode=echo                eigener Producer -> Echo (Standard)
//
// Ergebnis steht in window.__SFU_RTP_RESULT; Titel wird SFU-RTP-OK/FAIL.
// =============================================================================
import { io } from 'socket.io-client';
import { Device } from 'mediasoup-client';

const params = new URLSearchParams(location.search);
const serverUrl = params.get('server') || undefined;
const mode = params.get('mode') || 'echo';
const targetProducerId = params.get('producerId') || undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readInboundStats(consumer) {
  const stats = await consumer.getStats();
  let bytesReceived = 0;
  let packetsReceived = 0;
  for (const s of stats.values()) {
    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
      bytesReceived = s.bytesReceived || 0;
      packetsReceived = s.packetsReceived || 0;
    }
  }
  return { bytesReceived, packetsReceived };
}

async function main() {
  const result = { ok: false, steps: [], error: null, mode, producerId: null, bytesReceived: 0, packetsReceived: 0 };
  try {
    const socket = io(serverUrl, { path: '/sfu-signaling', query: { sessionId: 'rtp-multi' } });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', (e) => reject(new Error(e.message)));
    });
    result.steps.push('socket-connected');

    const ack = (event, payload = {}) =>
      new Promise((resolve, reject) => {
        socket.emit(event, payload, (resp) => {
          if (resp && !resp.error) resolve(resp);
          else reject(new Error((resp && resp.error) || `keine Antwort auf ${event}`));
        });
      });

    const device = new Device();
    const { rtpCapabilities } = await ack('getRouterRtpCapabilities');
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    result.steps.push('device-loaded');

    if (mode === 'consumer') {
      const recvParams = await ack('createTransport');
      const recvTransport = device.createRecvTransport(recvParams);
      recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          await ack('connectTransport', { transportId: recvTransport.id, dtlsParameters });
          result.steps.push('dtls-recv-connected');
          callback();
        } catch (e) { errback(e); }
      });
      const { id, kind, rtpParameters } = await ack('consume', {
        transportId: recvTransport.id,
        producerId: targetProducerId,
        rtpCapabilities: device.rtpCapabilities,
      });
      const consumer = await recvTransport.consume({ id, producerId: targetProducerId, kind, rtpParameters });
      result.steps.push('consumer-created ' + consumer.id + ' track=' + (consumer.track ? consumer.track.kind : 'none'));

      await sleep(2000);
      const stats = await readInboundStats(consumer);
      result.bytesReceived = stats.bytesReceived;
      result.packetsReceived = stats.packetsReceived;
      result.steps.push(`rtp-stats bytes=${stats.bytesReceived} packets=${stats.packetsReceived}`);
      result.ok = stats.bytesReceived > 0;

      consumer.close();
      recvTransport.close();
      socket.disconnect();
    } else {
      // producer (oder echo) – Send-Transport + Fake-Mic produzieren
      const sendParams = await ack('createTransport');
      const sendTransport = device.createSendTransport(sendParams);
      sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          await ack('connectTransport', { transportId: sendTransport.id, dtlsParameters });
          result.steps.push('dtls-connected');
          callback();
        } catch (e) { errback(e); }
      });
      sendTransport.on('produce', async (p, callback, errback) => {
        try {
          const { id } = await ack('produce', { transportId: sendTransport.id, ...p, kind: 'audio' });
          callback({ id });
        } catch (e) { errback(e); }
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      result.steps.push('mic-track ' + stream.getAudioTracks()[0].label);
      const producer = await sendTransport.produce({ track: stream.getAudioTracks()[0] });
      result.producerId = producer.id;
      result.steps.push('producer-created ' + producer.id);

      if (mode === 'producer') {
        // Produzent bleibt offen; der Runner schliesst die Seite spaeter.
        result.ok = true;
      } else {
        // echo: eigenen Producer ueber separaten Recv-Transport konsumieren.
        const recvParams = await ack('createTransport');
        const recvTransport = device.createRecvTransport(recvParams);
        recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
          try {
            await ack('connectTransport', { transportId: recvTransport.id, dtlsParameters });
            result.steps.push('dtls-recv-connected');
            callback();
          } catch (e) { errback(e); }
        });
        const { id, kind, rtpParameters } = await ack('consume', {
          transportId: recvTransport.id,
          producerId: producer.id,
          rtpCapabilities: device.rtpCapabilities,
        });
        const consumer = await recvTransport.consume({ id, producerId: producer.id, kind, rtpParameters });
        result.steps.push('consumer-created ' + consumer.id + ' track=' + (consumer.track ? consumer.track.kind : 'none'));

        await sleep(2000);
        const stats = await readInboundStats(consumer);
        result.bytesReceived = stats.bytesReceived;
        result.packetsReceived = stats.packetsReceived;
        result.steps.push(`rtp-stats bytes=${stats.bytesReceived} packets=${stats.packetsReceived}`);
        result.ok = stats.bytesReceived > 0;

        consumer.close();
        producer.close();
        sendTransport.close();
        recvTransport.close();
        socket.disconnect();
      }
    }
  } catch (e) {
    result.error = e.message;
  }
  window.__SFU_RTP_RESULT = result;
  document.title = result.ok ? 'SFU-RTP-OK' : 'SFU-RTP-FAIL';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
}

main();
