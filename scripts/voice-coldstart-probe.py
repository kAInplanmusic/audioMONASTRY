#!/usr/bin/env python3
"""Messlauf fuer INFRA-RUNPOD-010: ein einzelner TTS-Job mit Zeitachse.

Sendet EINEN kurzen Text an den voice-Endpoint (async /run), fragt /status/<id>
und /health alle 5 s ab und protokolliert Zeitstempel je Phase (Queue, Kaltstart,
Ausfuehrung) sowie Worker-Zustaende. Kein Pod, keine Dauerlast - ein Job.
"""
import json
import re
import time
import urllib.parse
import urllib.request

ENV = {}
for line in open('.env', encoding='utf-8', errors='replace'):
    m = re.match(r'\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$', line)
    if m and m.group(1) not in ENV:
        ENV[m.group(1)] = m.group(2).strip().strip('"').strip("'")

KEY = ENV['RP_API_KEY']
EP = ENV.get('RP_ENDPOINT_ID_VOICE') or 'gajmangfldpzrk'
BASE = f'https://api.runpod.ai/v2/{EP}'
H = {'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}


def call(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=H, method='POST' if data else 'GET')
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


start = time.time()
job = call('/run', {'input': {'task': 'tts', 'model': 'qwen3-tts-17b',
                              'input': {'text': 'Zwischenstand: ein einzelner Messtext.', 'language': 'DE'}}})
jid = job.get('id')
print(f"t=0s  Job angelegt: {jid} (Status {job.get('status')})", flush=True)

last = None
while time.time() - start < 1200:
    time.sleep(5)
    st = call(f'/status/{jid}')
    s = st.get('status')
    if s != last:
        print(f"t={int(time.time()-start)}s  Job-Status: {s}  outputStatus={st.get('outputStatus')} delayTime={st.get('delayTime')} executionTime={st.get('executionTime')}", flush=True)
        last = s
    if s in ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'):
        out = st.get('output') or {}
        audio = out.get('audio') or out.get('result') or ''
        print(f"t={int(time.time()-start)}s  ENDE: {s}, Audio-Bytes: {len(audio) if isinstance(audio, str) else 'n/a'}", flush=True)
        break
    if int(time.time() - start) % 60 < 5:
        try:
            hl = call('/health')
            print(f"t={int(time.time()-start)}s  health: {json.dumps(hl.get('workers'))}", flush=True)
        except Exception as exc:
            print(f"t={int(time.time()-start)}s  health-Fehler: {exc}", flush=True)
print(f"Gesamtdauer: {int(time.time()-start)}s", flush=True)
