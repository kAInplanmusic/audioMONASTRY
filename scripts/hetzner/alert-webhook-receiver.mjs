#!/usr/bin/env node
/**
 * audioMONASTRY · lokaler Alarm-Empfaenger fuer den Alarmzustellungs-Nachweis
 * =====================================================================
 * PROD-P1-004 verlangt: "ein kuenstlich erzeugter Fehler loest sichtbar einen
 * Alarm aus". Sichtbar heisst hier: die Kette
 *
 *   Prometheus-Regel -> Alertmanager -> POST /api/alerts/webhook (App)
 *                    -> Weiterleitung an DISCORD_WEBHOOK/SLACK_WEBHOOK
 *
 * landet tatsaechlich bei einem Empfaenger. Dieses Skript ist dieser Empfaenger:
 * es lauscht lokal, schreibt jeden eingehenden Alarm als JSON-Zeile nach stdout
 * und (optional) in eine Datei. Im Betrieb wird es NICHT gebraucht - dort zeigen
 * Discord/Slack/Telegram die Alarme; es ist das Messinstrument fuer den Nachweis.
 *
 * Aufruf:
 *   node scripts/hetzner/alert-webhook-receiver.mjs --port 9099 --out /tmp/alerts.jsonl
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const port = Number(argOf('--port', '9099'));
const out = argOf('--out', '');

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('nur POST');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const line = JSON.stringify({ ts: new Date().toISOString(), path: req.url, bytes: body.length, body });
    console.log(`[alarm-receiver] ${line}`);
    if (out) {
      try {
        appendFileSync(out, `${line}\n`);
      } catch (error) {
        console.error(`[alarm-receiver] konnte ${out} nicht schreiben: ${error.message}`);
      }
    }
    res.writeHead(204).end();
  });
});

server.listen(port, () => {
  console.log(`[alarm-receiver] lauscht auf http://127.0.0.1:${port}${out ? ` (Datei: ${out})` : ''}`);
});
