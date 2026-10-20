#!/usr/bin/env python3
"""INFRA-HETZNER-022/FLEET-Restore: Flotte aus den Rollen-Snapshots neu anlegen.

Warum nicht bring-up-fleet.sh Schritt 1: Hetzner hat die shared-vCPU-Typen
cx43/cx42/cx52 (und die alten cx22/cx32) abgekündigt - POST /servers mit
cx43 antwortet in ALLEN Locations HTTP 412 'error during placement'. Der
Ersatz fuer app-1/media-1 ist cpx42 (8 dedizierte vCPU, 16 GB, nur in nbg1).

Zweiter Befund: INLINE-Firewalls im Create-Payload liefern ebenfalls 412 -
die Firewall wird deshalb nach dem Anlegen per PUT /servers angehaengt.

Typen (Kosten-Optimierung laut references/hetzner-fleet-operations.md):
  app-1   cpx42 (Snapshot app)    - 8 vCPU / 16 GB / 160 GB SSD
  sfu-1   cx33  (Snapshot sfu)    - 4 vCPU /  8 GB / 80 GB SSD
  media-1 cx33  (Snapshot media)  - Medien-Cache 3 GB passt, 80 GB SSD
  edge-1  cx23  (Snapshot edge)   - 2 vCPU /  4 GB / 40 GB SSD
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

token = os.environ["HCLOUD_TOKEN"]


def api(method: str, path: str, payload: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"https://api.hetzner.cloud/v1{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()
        try:
            msg = json.loads(body).get("error", {})
        except Exception:
            msg = body[:300]
        return {"error": msg, "status": exc.code}


PLAN = [
    # Messung 2026-10-19: cx43/cx42/cx52 sind als shared-Typen abgekündigt
    # (412 placement in allen Locations), cpx* zaehlt am shared-core-Limit mit.
    # app/media brauchen 160-GB-Disks (Snapshot-Groesse), daher cpx42/ccx23.
    ("audiomonastry-app-1", 445415534, "cpx42", "app"),
    ("audiomonastry-sfu-1", 445415535, "cx33", "sfu"),
    ("audiomonastry-media-1", 445676761, "ccx23", "media"),
    ("audiomonastry-edge-1", 445415536, "cx23", "edge"),
]

fws = api("GET", "/firewalls?per_page=50")
fw_by_name = {f["name"]: f["id"] for f in fws.get("firewalls", [])}
print("firewalls im Konto:", fw_by_name)

created: dict[str, int] = {}
for name, snap, typ, role in PLAN:
    existing = api("GET", f"/servers?name={name}")
    if existing.get("servers"):
        s = existing["servers"][0]
        print(f"{name}: existiert bereits (id={s['id']}, {s['status']})")
        created[name] = s["id"]
        continue
    payload = {
        "name": name,
        "server_type": typ,
        "image": snap,
        "location": "nbg1",
        "ssh_keys": [131146761],
        "start_after": True,
        "labels": {
            "app": "audiomonastry",
            "managed-by": "audiomonastry-restore-2026-10-19",
            "role": role,
        },
    }
    r = api("POST", "/servers", payload)
    if "server" not in r:
        print(f"{name}: FEHLER {json.dumps(r)[:300]}")
        continue
    sid = r["server"]["id"]
    created[name] = sid
    print(f"{name}: erstellt id={sid} (snapshot {snap}, typ {typ})")
    fw_id = fw_by_name.get(f"audiomonastry-{role}")
    if fw_id:
        rr = api("PUT", f"/servers/{sid}", {"firewalls": [{"firewall": fw_id}]})
        print(f"  firewall audiomonastry-{role} (id={fw_id}) angehaengt:", "server" in rr)

print("created:", created)

for name, sid in created.items():
    status = "unknown"
    for _ in range(60):
        d = api("GET", f"/servers/{sid}")
        server = d.get("server", {})
        status = server.get("status")
        if status == "running":
            ip = (server.get("public_net") or {}).get("ipv4", {}).get("ip")
            print(f"{name}: RUNNING ip={ip}")
            break
        time.sleep(10)
    else:
        print(f"{name}: WARTEN-Timeout (Status {status})")
