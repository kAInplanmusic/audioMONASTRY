#!/usr/bin/env node
// =============================================================================
// midi-bridge – audioMONASTRY MIDI-Sidecar
// -----------------------------------------------------------------------------
// Verbindet Hardware-MIDI mit der Web-App und OSC-fähigen Controllern:
//
//   MIDI-IN  (Controller/Keyboard)  ->  WebSocket-Broadcast + OSC-Send
//   WebSocket (Browser-Automation)  ->  MIDI-OUT
//
// Konfiguration (Env):
//   MIDI_IN_NAME     Substring des gewünschten MIDI-Inputs  (sonst Port 0)
//   MIDI_OUT_NAME    Substring des gewünschten MIDI-Outputs (sonst Port 0)
//   WS_PORT          WebSocket-Port (Default 9100)
//   OSC_HOST         OSC-Ziel (z. B. 127.0.0.1) – deaktiviert, wenn leer
//   OSC_PORT         OSC-Port (Default 9000)
//
// WebSocket-Protokoll (JSON):
//   Client -> Server:
//     { type:'cc', channel:0..15, controller:0..127, value:0..127 }
//     { type:'noteOn'|'noteOff', channel, note, velocity }
//     { type:'pitchBend', channel, value:0..16383 }
//     { type:'nrpn', channel, nrpn:0..16383, value:0..16383 }
//     { type:'sysex', bytes:[0x7d, ...] }          (F0/F7 werden ergänzt)
//   Server -> Client:
//     { type:'midi', bytes:[...] }                  (rohe MIDI-Bytes)
// =============================================================================
const http = require('http');
const { WebSocketServer } = require('ws');

const WS_PORT = Number(process.env.WS_PORT || 9100);
const OSC_HOST = process.env.OSC_HOST || '';
const OSC_PORT = Number(process.env.OSC_PORT || 9000);
const OSC_LISTEN_PORT = Number(process.env.OSC_LISTEN_PORT || 0);

const log = (...a) => console.log(`[midi-bridge ${new Date().toISOString()}]`, ...a);

// --- MIDI (native RtMidi-Binding; auf Systemen ohne Ports deaktiviert) --------
let midi = null;
try {
  midi = require('midi');
} catch (e) {
  log('midi-Paket nicht verfügbar – Bridge läuft nur als WS/OSC-Relay:', e.message);
}

const input = midi ? new midi.Input() : null;
const output = midi ? new midi.Output() : null;

function pickPort(port, nameSubstring) {
  if (!port) return null;
  const count = port.getPortCount();
  if (count === 0) return null;
  if (nameSubstring) {
    for (let i = 0; i < count; i++) {
      if (port.getPortName(i).toLowerCase().includes(nameSubstring.toLowerCase())) return i;
    }
  }
  return 0;
}

const midiInPort = input ? pickPort(input, process.env.MIDI_IN_NAME) : null;
const midiOutPort = output ? pickPort(output, process.env.MIDI_OUT_NAME) : null;

if (input && midiInPort !== null) {
  input.openPort(midiInPort);
  log(`MIDI-IN geöffnet: ${input.getPortName(midiInPort)}`);
} else {
  log('Kein MIDI-IN verfügbar (oder Port-Name nicht gefunden).');
}
if (output && midiOutPort !== null) {
  output.openPort(midiOutPort);
  log(`MIDI-OUT geöffnet: ${output.getPortName(midiOutPort)}`);
} else {
  log('Kein MIDI-OUT verfügbar (oder Port-Name nicht gefunden).');
}

// --- OSC (optional, senden) ---------------------------------------------------
let oscClient = null;
if (OSC_HOST && OSC_PORT) {
  try {
    const { Client } = require('osc');
    oscClient = new Client(OSC_HOST, OSC_PORT);
    log(`OSC aktiv: ${OSC_HOST}:${OSC_PORT}`);
  } catch (e) {
    log('osc-Paket nicht verfügbar – OSC deaktiviert:', e.message);
  }
}

function sendOsc(address, ...args) {
  if (!oscClient) return;
  try { oscClient.send({ address, args }); } catch { /* UDP best effort */ }
}

// --- OSC-UDP-Listener (optional, empfangen) -----------------------------------
// OSC_LISTEN_PORT=9010 node index.js
// Eingehende OSC-Messages werden an alle WebSocket-Clients broadcastet und
// /midi/cc/...-Adressen zusätzlich an MIDI-OUT gesendet (OSC -> MIDI).
let oscServer = null;
if (OSC_LISTEN_PORT > 0) {
  try {
    const { UDPPort } = require('osc');
    oscServer = new UDPPort({ localAddress: '0.0.0.0', localPort: OSC_LISTEN_PORT, metadata: true });
    oscServer.on('message', (oscMsg) => {
      const data = { type: 'osc', address: oscMsg.address, args: oscMsg.args };
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(JSON.stringify(data));
      }
      // OSC -> MIDI (CC-Konvention /midi/cc/<channel>/<cc>)
      const m = /^\/midi\/cc\/(\d+)\/(\d+)$/.exec(oscMsg.address);
      if (m) {
        const value = oscMsg.args && typeof oscMsg.args[0]?.value === 'number' ? oscMsg.args[0].value : 0;
        sendMidi(cc(Number(m[1]) || 0, Number(m[2]) || 0, Math.round(value * 127)));
      }
    });
    oscServer.open();
    log(`OSC-UDP lauscht auf :${OSC_LISTEN_PORT}`);
  } catch (e) {
    log('osc-UDP-Listener nicht verfügbar:', e.message);
  }
}

// --- MIDI-Kodierung (deckungsgleich mit src/utils/midi.ts) --------------------
const clamp7 = (v) => Math.max(0, Math.min(127, Math.round(v)));
const cc = (ch, c, v) => [0xb0 | (ch & 0x0f), clamp7(c), clamp7(v)];
const noteOn = (ch, n, v) => [0x90 | (ch & 0x0f), clamp7(n), clamp7(v)];
const noteOff = (ch, n, v) => [0x80 | (ch & 0x0f), clamp7(n), clamp7(v)];
const pitchBend = (ch, v) => [0xe0 | (ch & 0x0f), v & 0x7f, (v >> 7) & 0x7f];
const nrpn = (ch, nrpnNum, value) => {
  const c = ch & 0x0f;
  return [
    0xb0 | c, 99, (nrpnNum >> 7) & 0x7f,
    0xb0 | c, 98, nrpnNum & 0x7f,
    0xb0 | c, 6, (value >> 7) & 0x7f,
    0xb0 | c, 38, value & 0x7f,
    0xb0 | c, 101, 0x7f,
    0xb0 | c, 100, 0x7f,
  ];
};
const sysex = (bytes) => [0xf0, ...bytes.map((b) => b & 0x7f), 0xf7];

function sendMidi(bytes) {
  if (!output || midiOutPort === null) return false;
  try { output.sendMessage(bytes); return true; } catch (e) { log('MIDI-OUT Fehler:', e.message); return false; }
}

// --- WebSocket ----------------------------------------------------------------
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ service: 'midi-bridge', wsPort: WS_PORT, midiIn: midiInPort, midiOut: midiOutPort }));
});
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  log('WS-Client verbunden');
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    try {
      let bytes = null;
      switch (msg.type) {
        case 'cc': bytes = cc(msg.channel ?? 0, msg.controller ?? 0, msg.value ?? 0); break;
        case 'noteOn': bytes = noteOn(msg.channel ?? 0, msg.note ?? 60, msg.velocity ?? 100); break;
        case 'noteOff': bytes = noteOff(msg.channel ?? 0, msg.note ?? 60, msg.velocity ?? 0); break;
        case 'pitchBend': bytes = pitchBend(msg.channel ?? 0, msg.value ?? 8192); break;
        case 'nrpn': bytes = nrpn(msg.channel ?? 0, msg.nrpn ?? 0, msg.value ?? 0); break;
        case 'sysex': bytes = sysex(Array.isArray(msg.bytes) ? msg.bytes : []); break;
        default: return;
      }
      sendMidi(bytes);
    } catch (e) { log('WS-Message verworfen:', e.message); }
  });
});

// --- MIDI-IN -> WS + OSC -------------------------------------------------------
if (input && midiInPort !== null) {
  input.on('message', (_deltaTime, bytes) => {
    const data = { type: 'midi', bytes: [...bytes] };
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(JSON.stringify(data));
    }

    // OSC-Mapping: CC -> /midi/cc/{channel}/{cc}, Notes -> /midi/note
    if (bytes.length >= 3) {
      const status = bytes[0];
      const channel = status & 0x0f;
      const kind = status & 0xf0;
      if (kind === 0xb0) sendOsc(`/midi/cc/${channel}/${bytes[1]}`, bytes[2] / 127);
      if (kind === 0x90 && bytes[2] > 0) sendOsc(`/midi/note/${channel}`, bytes[1], bytes[2] / 127);
      if (kind === 0xe0) sendOsc(`/midi/pitchbend/${channel}`, ((bytes[2] << 7) | bytes[1]) / 16383);
    }
  });
}

server.listen(WS_PORT, '127.0.0.1', () => {
  log(`WebSocket lauscht auf :${WS_PORT}`);
  log(`MIDI-IN: ${midiInPort !== null && input ? input.getPortName(midiInPort) : 'keiner'}`);
  log(`MIDI-OUT: ${midiOutPort !== null && output ? output.getPortName(midiOutPort) : 'keiner'}`);
});
