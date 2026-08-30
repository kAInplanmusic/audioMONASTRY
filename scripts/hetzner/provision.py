#!/usr/bin/env python3
# =============================================================================
# sampleMONK – Hetzner Cloud Provisioning
# -----------------------------------------------------------------------------
# Erstellt (idempotent) auf Hetzner Cloud:
#   1. SSH-Key (lokal, z.B. ~/.ssh/id_ed25519.pub)
#   2. Firewall (nur 22/80/443 + ICMP)
#   3. Server: CX23 (2 vCPU / 4 GB / 40 GB) – günstigste x86-Testinstanz,
#      Ubuntu 24.04, fsn1, stündlich abgerechnet, keine Setup-Gebühr
#   4. Cloud-Init: Docker + Docker Compose + UFW
#   5. Wartet auf SSH und gibt die nächsten Deploy-Schritte aus
#
# Voraussetzungen: Python 3.8+, Hetzner-API-Token (HCLOUD_TOKEN)
#
# Aufruf:
#   HCLOUD_TOKEN=xxxxx python3 scripts/hetzner/provision.py
#   # oder mit eigenen Werten:
#   HCLOUD_TOKEN=xxxxx SERVER_TYPE=cx33 LOCATION=nbg1 python3 scripts/hetzner/provision.py
# =============================================================================
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

API_BASE = "https://api.hetzner.cloud/v1"
DEFAULT_CLOUD_INIT = pathlib.Path(__file__).resolve().parent / "cloud-init.yaml"
DEFAULT_FLOATING_SCRIPT = pathlib.Path(__file__).resolve().parent / "configure-floating-ip.sh"


def die(msg: str) -> "NoReturn":
    print(f"[provision] Fehler: {msg}", file=sys.stderr)
    sys.exit(1)


def api(token: str, method: str, path: str, payload: dict | None = None) -> dict:
    req = urllib.request.Request(API_BASE + path, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            err = json.loads(body).get("error", {})
            detail = err.get("message") or err.get("code") or body
        except Exception:
            detail = body
        die(f"HTTP {e.code} {method} {path}: {detail}")
    except urllib.error.URLError as e:
        die(f"Netzwerkfehler {method} {path}: {e.reason}")
    return {}  # unreachable


def get_all(token: str, resource: str) -> list[dict]:
    """Liest eine Hetzner-Ressource mit Pagination ein."""
    items: list[dict] = []
    page = 1
    while True:
        data = api(token, "GET", f"/{resource}?page={page}&per_page=50")
        key = resource
        batch = data.get(key, [])
        items.extend(batch)
        meta = data.get("meta", {}).get("pagination", {})
        if page >= meta.get("last_page", page):
            break
        page += 1
    return items


def find_ssh_key(token: str, public_key: str) -> int | None:
    for key in get_all(token, "ssh_keys"):
        if key.get("public_key") == public_key:
            return key["id"]
    return None


def ensure_ssh_key(token: str, pub_path: pathlib.Path) -> int:
    public_key = pub_path.read_text(encoding="utf-8").strip()
    existing = find_ssh_key(token, public_key)
    if existing:
        print(f"[provision] SSH-Key vorhanden: {pub_path} (id={existing})")
        return existing
    name = f"samplemonk-{pub_path.stem}"
    result = api(token, "POST", "/ssh_keys", {
        "name": name,
        "public_key": public_key,
    })
    key_id = result["ssh_key"]["id"]
    print(f"[provision] SSH-Key angelegt: {name} (id={key_id})")
    return key_id


def ensure_firewall(token: str, name: str, role: str = "app") -> int:
    """Stellt die Firewall bereit. Rolle 'sfu' oeffnet zusaetzlich RTP-Ports."""
    for fw in get_all(token, "firewalls"):
        if fw.get("name") == name:
            print(f"[provision] Firewall vorhanden: {name} (id={fw['id']})")
            return fw["id"]

    all_ips = ["0.0.0.0/0", "::/0"]
    rules = [
        {"direction": "in", "protocol": "tcp", "port": "22",
         "source_ips": all_ips, "description": "SSH"},
        {"direction": "in", "protocol": "tcp", "port": "80",
         "source_ips": all_ips, "description": "HTTP"},
        {"direction": "in", "protocol": "tcp", "port": "443",
         "source_ips": all_ips, "description": "HTTPS"},
        {"direction": "in", "protocol": "icmp",
         "source_ips": all_ips, "description": "ICMP"},
    ]
    if role == "sfu":
        rules += [
            {"direction": "in", "protocol": "udp", "port": "40000-40099",
             "source_ips": all_ips, "description": "Mediasoup RTP (UDP)"},
            {"direction": "in", "protocol": "tcp", "port": "40000-40099",
             "source_ips": all_ips, "description": "Mediasoup RTP (TCP-Fallback)"},
        ]
    if role in ("ai", "master"):
        # Interne Service-Ports nur im Hetzner-Privaten Netz oeffnen;
        # auf Wunsch via FIREWALL_EXTRA_PORTS erweitern.
        pass
    extra = os.environ.get("FIREWALL_EXTRA_PORTS", "")
    if extra:
        for spec in extra.split(","):
            spec = spec.strip()
            if not spec:
                continue
            proto, _, port = spec.partition("/")
            rules.append({"direction": "in", "protocol": proto or "tcp",
                          "port": port, "source_ips": all_ips,
                          "description": f"Extra {proto or 'tcp'}/{port}"})
    result = api(token, "POST", "/firewalls", {
        "name": name,
        "rules": rules,
        "labels": {"app": "samplemonk", "managed-by": "samplemonk-provision"},
    })
    fw_id = result["firewall"]["id"]
    print(f"[provision] Firewall angelegt: {name} (id={fw_id})")
    return fw_id


def ensure_floating_ip(token: str, name: str, location: str) -> dict:
    """Stellt eine feste Floating IP bereit (überlebt Instanz-Wechsel)."""
    for fip in get_all(token, "floating_ips"):
        if fip.get("name") == name:
            print(f"[provision] Floating IP vorhanden: {name} → {fip.get('ip')} (id={fip['id']})")
            return fip
    result = api(token, "POST", "/floating_ips", {
        "name": name,
        "type": "ipv4",
        "home_location": location,
        "description": "sampleMONK feste IP für DNS anunnakitools.de",
        "labels": {"app": "samplemonk", "managed-by": "samplemonk-provision"},
    })
    fip = result["floating_ip"]
    print(f"[provision] Floating IP angelegt: {name} → {fip.get('ip')} (id={fip['id']})")
    return fip


def assign_floating_ip(token: str, floating: dict, server_id: int) -> None:
    """Weist die Floating IP dem Server zu (idempotent)."""
    if floating.get("server") == server_id:
        print(f"[provision] Floating IP {floating.get('ip')} ist bereits zugewiesen")
        return
    api(token, "POST", f"/floating_ips/{floating['id']}/actions/assign", {"server": server_id})
    print(f"[provision] Floating IP {floating.get('ip')} an Server {server_id} zugewiesen")


def find_server(token: str, name: str) -> dict | None:
    for server in get_all(token, "servers"):
        if server.get("name") == name:
            return server
    return None


def wait_for_server(token: str, server_id: int) -> dict:
    print("[provision] Warte auf Serverstatus 'running' ...")
    for _ in range(60):
        server = api(token, "GET", f"/servers/{server_id}")["server"]
        status = server.get("status")
        if status == "running":
            return server
        if status == "off":
            print("[provision] Server ist aus – starte ihn ...")
            api(token, "POST", f"/servers/{server_id}/actions/poweron", {})
        time.sleep(5)
    die("Server wurde nicht rechtzeitig 'running' (Timeout).")


def wait_for_ssh(ip: str, private_key: pathlib.Path, timeout: int = 120) -> None:
    print(f"[provision] Warte auf SSH {ip} ...")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            subprocess.run(
                [
                    "ssh",
                    "-i", str(private_key),
                    "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null",
                    "-o", "ConnectTimeout=5",
                    "-o", "BatchMode=yes",
                    f"root@{ip}",
                    "true",
                ],
                check=True,
                capture_output=True,
                timeout=10,
            )
            print(f"[provision] SSH bereit: root@{ip}")
            return
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            time.sleep(5)
    die(f"SSH zu {ip} nicht erreichbar (Timeout). Prüfe Firewall/Netz.")


def wait_for_cloud_init(ip: str, private_key: pathlib.Path, timeout: int = 600) -> None:
    """Wartet, bis Docker/UFW per Cloud-Init installiert sind (Bootstrap-Marker)."""
    print("[provision] Warte auf Cloud-Init (Docker/UFW/Sysctl) ...")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            result = subprocess.run(
                ["ssh", "-i", str(private_key),
                 "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null",
                 "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
                 f"root@{ip}",
                 "test -f /root/.samplemonk-bootstrap-done"],
                check=True, capture_output=True, timeout=30,
            )
            if result.returncode == 0:
                print("[provision] Cloud-Init abgeschlossen (Docker bereit).")
                return
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass
        time.sleep(10)
    die("Cloud-Init wurde nicht rechtzeitig fertig (Timeout).")


def configure_floating_ip(primary_ip: str, floating_ip: str, private_key: pathlib.Path,
                          script_path: pathlib.Path) -> None:
    """Konfiguriert die Floating-IP im OS des Servers (Hetzner routet ohne NAT)."""
    print(f"[provision] Konfiguriere Floating IP {floating_ip} im OS (via {primary_ip}) ...")
    if not script_path.exists():
        die(f"Floating-IP-Skript nicht gefunden: {script_path}")
    cmd = [
        "ssh",
        "-i", str(private_key),
        "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "BatchMode=yes",
        f"root@{primary_ip}",
        "bash -s --", floating_ip,
    ]
    try:
        subprocess.run(cmd, input=script_path.read_bytes(), check=True, capture_output=True, timeout=60)
        print("[provision] Floating IP im OS konfiguriert.")
    except subprocess.CalledProcessError as e:
        die(f"Floating-IP-Konfiguration fehlgeschlagen: {e.stderr.decode(errors='replace')}")


def main() -> None:
    parser = argparse.ArgumentParser(description="sampleMONK Hetzner Cloud Provisioning")
    parser.add_argument("--token", default=os.environ.get("HCLOUD_TOKEN", ""),
                        help="Hetzner API-Token (oder HCLOUD_TOKEN)")
    parser.add_argument("--name", default=os.environ.get("SERVER_NAME", "samplemonk-test"),
                        help="Servername (Standard: samplemonk-test)")
    parser.add_argument("--type", default=os.environ.get("SERVER_TYPE", "cx23"),
                        help="Servertyp (Standard: cx23 = 2 vCPU/4GB/40GB)")
    parser.add_argument("--location", default=os.environ.get("LOCATION", "fsn1"),
                        help="Standort (Standard: fsn1 = Falkenstein)")
    parser.add_argument("--image", default=os.environ.get("IMAGE", "ubuntu-24.04"),
                        help="Image (Standard: ubuntu-24.04)")
    parser.add_argument("--ssh-key", default=os.environ.get("SSH_KEY_PATH",
                        str(pathlib.Path.home() / ".ssh" / "id_ed25519.pub")),
                        help="Pfad zum öffentlichen SSH-Key")
    parser.add_argument("--firewall", default=os.environ.get("FIREWALL_NAME", "samplemonk-test"),
                        help="Name der Hetzner-Firewall")
    parser.add_argument("--floating-ip", default=os.environ.get("FLOATING_IP_NAME", "samplemonk-floating"),
                        help="Name/ID der festen Floating IP; 'none' = keine Floating IP")
    parser.add_argument("--role", default=os.environ.get("ROLE", "app"),
                        help="Rolle: app (Default), sfu (öffnet RTP-Ports 40000-40099), "
                             "master, ai, edge")
    parser.add_argument("--cloud-init", default=str(DEFAULT_CLOUD_INIT),
                        help="Cloud-Init-Datei (YAML)")
    args = parser.parse_args()

    if not args.token:
        die("HCLOUD_TOKEN fehlt. Token im Hetzner-Console unter Security > API Tokens anlegen.")

    pub_path = pathlib.Path(args.ssh_key).expanduser()
    if not pub_path.exists():
        die(f"SSH-Public-Key nicht gefunden: {pub_path}")
    private_path = pathlib.Path(str(pub_path).removesuffix(".pub")).expanduser()
    if not private_path.exists():
        private_path = pathlib.Path.home() / ".ssh" / "id_ed25519"
    if not private_path.exists():
        die(f"SSH-Private-Key nicht gefunden: {private_path}")

    cloud_init_path = pathlib.Path(args.cloud_init).expanduser()
    if not cloud_init_path.exists():
        die(f"Cloud-Init-Datei nicht gefunden: {cloud_init_path}")
    user_data = cloud_init_path.read_text(encoding="utf-8")

    token = args.token.strip()
    ssh_key_id = ensure_ssh_key(token, pub_path)
    firewall_id = ensure_firewall(token, args.firewall, role=args.role)

    floating: dict | None = None
    if args.floating_ip.strip().lower() not in ("", "none"):
        floating = ensure_floating_ip(token, args.floating_ip, args.location)

    server = find_server(token, args.name)
    if server:
        print(f"[provision] Server existiert bereits: {args.name} (id={server['id']})")
    else:
        payload = {
            "name": args.name,
            "server_type": args.type,
            "image": args.image,
            "location": args.location,
            "ssh_keys": [ssh_key_id],
            "firewalls": [{"firewall": firewall_id}],
            "user_data": user_data,
            "labels": {
                "app": "samplemonk",
                "managed-by": "samplemonk-provision",
                "role": args.role,
            },
        }
        result = api(token, "POST", "/servers", payload)
        server = result["server"]
        print(f"[provision] Server wird erstellt: {args.name} "
              f"({args.type}, {args.image}, {args.location}, role={args.role}, id={server['id']})")

    server = wait_for_server(token, server["id"])
    ipv4 = (server.get("public_net") or {}).get("ipv4") or {}
    primary_ip = ipv4.get("ip")
    if not primary_ip:
        die("Server hat keine öffentliche IPv4 erhalten (Primary-IPv4 nicht aktiv?).")
    print(f"[provision] Server läuft (primäre IP): {primary_ip}")

    # Erst SSH auf der primären IP abwarten, dann Floating-IP im OS konfigurieren.
    # Hetzner routet Floating-IPs ohne NAT -> der Server muss die IP selbst auf eth0 haben.
    wait_for_ssh(primary_ip, private_path)
    wait_for_cloud_init(primary_ip, private_path)

    ip = primary_ip
    if floating:
        assign_floating_ip(token, floating, server["id"])
        ip = floating.get("ip") or primary_ip
        print(f"[provision] Feste Floating IP: {ip}")
        if floating.get("ip") and floating.get("ip") != primary_ip:
            configure_floating_ip(primary_ip, floating["ip"], private_path, DEFAULT_FLOATING_SCRIPT)
            wait_for_ssh(floating["ip"], private_path)

    print()
    print("=" * 72)
    print("sampleMONK Hetzner-Instanz bereit!")
    print("=" * 72)
    print(f"  Feste IP:     {ip}   {'(Floating IP, überlebt Instanz-Wechsel)' if floating else '(primäre IP)'}")
    print(f"  Primäre IP:   {primary_ip}")
    print(f"  SSH:          ssh root@{ip}")
    print(f"  Servertyp:    {args.type} ({args.image}, {args.location})")
    print(f"  Rolle:        {args.role}")
    print(f"  Firewall:     {args.firewall} (22/80/443 + ICMP{' + RTP 40000-40099' if args.role == 'sfu' else ''})")
    print()
    print("  Weiter mit Deploy (im Repo-Verzeichnis samplemonk/):")
    print(f"    DEPLOY_HOST=root@{ip} DEPLOY_DOMAIN=anunnakitools.de bash deploy.sh")
    print()
    print("  DNS (einmalig, siehe scripts/hetzner/dns_setup.py):")
    print(f"    A     @        -> {ip}")
    print("    CNAME www      -> @")
    print("    TXT   _acme-challenge -> PLACEHOLDER")
    print("  WICHTIG:      Für iPhone/iPad-Mikrofon muss DOMAIN gesetzt sein,")
    print("                sonst nur http://IP-Test im Desktop-Browser.")
    print()
    print("  Stunden-Abrechnung sparen (Auto-Shutdown bei Inaktivität):")
    print(f"    ssh root@{ip} 'bash /opt/samplemonk/scripts/hetzner/install-idle-shutdown.sh'")
    print("=" * 72)


if __name__ == "__main__":
    main()
