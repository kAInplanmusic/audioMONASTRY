#!/usr/bin/env python3
"""Hetzner Firewall via apply_to_resources richtig anhaengen."""
import json
import os
import urllib.request
import urllib.error

token = os.environ['HCLOUD_TOKEN']

def api(method, path, payload=None):
    req = urllib.request.Request(f'https://api.hetzner.cloud/v1{path}',
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}, method=method)
    try:
        return json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {'error': body[:300], 'status': e.code}

# Alle Flotten-Server holen
servers = api('GET', '/servers?label_selector=app%3Daudiomonastry').get('servers', [])
for s in servers:
    role = s.get('labels', {}).get('role', '?')
    fw_name = f'audiomonastry-{role}'
    fws = api('GET', f'/firewalls?name={fw_name}').get('firewalls', [])
    if not fws:
        print(f"{s['name']}: firewall {fw_name} nicht gefunden")
        continue
    fw_id = fws[0]['id']

    # Korrektes Format: apply_to_resources action
    result = api('POST', f'/firewalls/{fw_id}/actions/apply_to_resources', {
        'apply_to': [
            {
                'server': {'id': s['id']},
                'type': 'server'
            }
        ]
    })
    if 'error' in result:
        print(f"{s['name']} ({role}): ERR {result['error']}")
    else:
        actions = result.get('actions', [])
        status = actions[0].get('status', '?') if actions else '?'
        print(f"{s['name']} ({role}): firewall {fw_id} apply_to -> {status}")

# Verifizieren
for fw_name in ('audiomonastry-app', 'audiomonastry-sfu', 'audiomonastry-media', 'audiomonastry-edge'):
    fws = api('GET', f'/firewalls?name={fw_name}').get('firewalls', [])
    if fws:
        applied = fws[0].get('applied_to', [])
        print(f"{fw_name}: applied_to={json.dumps(applied)[:120]}")
