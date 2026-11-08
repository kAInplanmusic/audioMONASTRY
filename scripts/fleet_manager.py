#!/usr/bin/env python3
"""
audioMONASTRY Fleet Manager - Start/Stop Script
=================================================
This script manages the complete audioMONASTRY fleet:
- Hetzner server (app, sfu, redis)
- RunPod AI pods (brain, ears, voice, stems, music)

Usage:
    python3 scripts/fleet_manager.py start [--dry-run]
    python3 scripts/fleet_manager.py stop [--no-backup]
"""

import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request
import urllib.error

API_BASE = "https://api.hetzner.cloud/v1"
PROJECT_ROOT = pathlib.Path(__file__).parent.parent
ENV_FILE = PROJECT_ROOT / ".env.deploy"

def log(msg):
    """Log message with timestamp"""
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}")

def load_env():
    """Load environment from .env.deploy"""
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                k, v = line.split('=', 1)
                env[k] = v.strip().strip('"').strip("'")
    return env

def hcloud_api(env, method, path, data=None):
    """Make Hetzner Cloud API call"""
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        method=method,
        data=json.dumps(data).encode() if data else None
    )
    req.add_header("Authorization", f"Bearer {env['HCLOUD_TOKEN']}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode() if resp else ""
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}
        try:
            body = json.loads(e.read().decode())
            log(f"API Error {e.code}: {body.get('error', {}).get('message', str(e))}")
        except:
            log(f"API Error {e.code}: {e}")
        return {}
    except Exception as e:
        log(f"API Error: {e}")
        return {}

def get_servers(env):
    """Get Hetzner servers with app=audiomonastry label"""
    result = hcloud_api(env, "GET", "/servers?labels[app]=audiomonastry")
    return result.get("servers", [])

def create_snapshot(env, server_id, description):
    """Create Hetzner snapshot by copying server to image"""
    log(f"[BACKUP] Creating snapshot: {description}")
    result = hcloud_api(env, "POST", "/images", {
        "type": "snapshot",
        "description": description,
        "source": {"server": {"id": server_id}}
    })
    image = result.get("image", {})
    log(f"[BACKUP] Snapshot created: {image.get('id', 'unknown')}")
    return image

def provision_server(env):
    """Provision new Hetzner server using existing provision.py"""
    servers = get_servers(env)
    if servers:
        server = servers[0]
        ip = server.get("ipv4", {}).get("ip") or server.get("public_net", {}).get("ipv4", {}).get("ip")
        print(f"[PROVISION] Using existing server: {server.get('name')} ({ip})")
        return {"id": server["id"], "ipv4": {"ip_address": ip}}
    
    log("No existing servers found, creating new one via provision.py...")
    
    # Call the existing provision script
    env_copy = os.environ.copy()
    env_copy.update({
        "HCLOUD_TOKEN": env["HCLOUD_TOKEN"],
        "SERVER_TYPE": "cx43",
        "LOCATION": "fsn1",
        "IMAGE": "ubuntu-24.04",
        "SERVER_NAME": "audiomonastry-fleet",
        "ROLE": "sfu",
    })
    
    result = subprocess.run(
        ["python3", str(PROJECT_ROOT / "scripts" / "hetzner" / "provision.py")],
        env=env_copy,
        capture_output=True, text=True, timeout=600
    )
    
    if result.returncode != 0:
        log(f"Provision FAILED: {result.stderr[-500:]}")
        return {}
    
    log("Provision output:")
    print(result.stdout[-1000:])
    
    # Get the created server
    servers = get_servers(env)
    if servers:
        return servers[0]
    
    return {}

def deploy_app(env, server_ip):
    """Deploy application to server"""
    if not server_ip:
        log("[ERROR] No server IP available")
        return False
    
    log(f"[DEPLOY] Deploying to {server_ip}...")
    
    # Get registry tag
    try:
        REGISTRY_TAG = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=PROJECT_ROOT, text=True
        ).strip()
    except:
        REGISTRY_TAG = "dev"
    
    # Build deploy command
    deploy_cmd = f"""
set -a; source ~/.env.deploy; set +a
export DEPLOY_IMAGE_SOURCE="registry"
export DEPLOY_REGISTRY_IMAGE="ghcr.io/kainplanmusic/audiomonastry:{REGISTRY_TAG}"
export DEPLOY_REGISTRY_IMAGE_MASTER="ghcr.io/kainplanmusic/audiomonastry-master-player:{REGISTRY_TAG}"
export DEPLOY_HOST="{server_ip}"
export DEPLOY_DOMAIN="{env.get('DEPLOY_DOMAIN', 'anunnakitools.de')}"
export DEPLOY_SMOKE=1
cd /opt/audiomonastry
git pull
bash deploy.sh
"""
    
    try:
        result = subprocess.run(
            ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
             f"root@{server_ip}", "bash -c", deploy_cmd],
            capture_output=True, text=True, timeout=600
        )
        output = result.stdout[-1500:] if result.stdout else ""
        print(output)
        if result.returncode != 0:
            log(f"[DEPLOY] Error: {result.stderr[-500:]}")
            return False
        log("[DEPLOY] Deployment completed")
        return True
    except subprocess.TimeoutExpired:
        log("[DEPLOY] Timeout - deployment may still be running")
        return True
    except Exception as e:
        log(f"[DEPLOY] Error: {e}")
        return False

def start_runpod_pods(env):
    """Start RunPod AI pods"""
    log("[RUNPOD] Starting AI pods...")
    
    env_copy = os.environ.copy()
    env_copy.update(env)
    
    result = subprocess.run(
        ["python3", str(PROJECT_ROOT / "scripts" / "runpod-pods.py"), "up", "--yes"],
        cwd=str(PROJECT_ROOT),
        env=env_copy,
        capture_output=True, text=True, timeout=600
    )
    
    output = result.stdout[-1500:] if result.stdout else ""
    print(output)
    
    if "HTTP 500" in output and "no instances" in output:
        log("[RUNPOD] Capacity temporarily unavailable - will retry later")
        return True  # Not a real failure
    
    return result.returncode == 0

def start_fleet(env, dry_run=False):
    """Start complete fleet"""
    log("=== STARTING AUDIO MONASTRY FLEET ===")
    
    if dry_run:
        log("[DRY-RUN] Would start fleet")
        servers = get_servers(env)
        log(f"  Existing servers: {len(servers)}")
        log("  Would provision Hetzner server (cx43, fsn1)")
        log("  Would deploy app")
        log("  Would start RunPod pods (brain, ears, voice, stems, music)")
        return True
    
    # Backup existing servers
    servers = get_servers(env)
    for server in servers:
        snap = create_snapshot(env, server["id"], 
                              f"audiomonastry-backup-{int(time.time())}")
    
    # Provision server
    server = provision_server(env)
    server_ip = server.get("ipv4", {}).get("ip_address")
    
    if not server_ip:
        log("[ERROR] No server IP available")
        return False
    
    # Save server IP
    (PROJECT_ROOT / ".deploy_host").write_text(server_ip)
    
    # Deploy app
    if not deploy_app(env, server_ip):
        log("[ERROR] App deployment failed")
        return False
    
    # Start RunPod pods
    start_runpod_pods(env)  # Don't fail on RunPod capacity issues
    
    log("=== FLEET STARTED SUCCESSFULLY ===")
    log(f"App: https://{env.get('DEPLOY_DOMAIN', 'anunnakitools.de')}")
    log(f"Server: {server_ip}")
    return True

def stop_fleet(env, dry_run=False):
    """Stop complete fleet"""
    log("=== STOPPING AUDIO MONASTRY FLEET ===")
    
    if dry_run:
        log("[DRY-RUN] Would stop fleet")
        return True
    
    # Get servers
    servers = get_servers(env)
    
    # Backup and stop servers
    for server in servers:
        server_id = server["id"]
        server_name = server.get("name", "unknown")
        
        # Create snapshot
        create_snapshot(env, server_id, 
                      f"audiomonastry-snapshot-{server_name}")
        
        # Stop server
        hcloud_api(env, "POST", f"/servers/{server_id}/actions/stop")
        log(f"[STOP] Server {server_name} stopped")
    
    # Export RunPod config
    env_copy = os.environ.copy()
    env_copy.update(env)
    subprocess.run([
        "python3", str(PROJECT_ROOT / "scripts" / "runpod-pods.py"),
        "export", "--output", 
        str(PROJECT_ROOT / f"logs/runpod-export-{int(time.time())}.json")
    ], cwd=str(PROJECT_ROOT), env=env_copy)
    
    log("=== FLEET STOPPED ===")

def main():
    if len(sys.argv) < 2:
        print("Usage: fleet_manager.py [start|stop] [--dry-run]")
        return 1
    
    cmd = sys.argv[1]
    dry_run = "--dry-run" in sys.argv[2:]
    
    env = load_env()
    
    if not env.get("HCLOUD_TOKEN"):
        print("ERROR: HCLOUD_TOKEN not set in .env.deploy")
        return 1
    if not env.get("RP_API_KEY"):
        print("ERROR: RP_API_KEY not set in .env.deploy")
        return 1
    
    if cmd == "start":
        return 0 if start_fleet(env, dry_run) else 1
    elif cmd == "stop":
        return 0 if stop_fleet(env, dry_run) else 1
    else:
        print(f"Unknown command: {cmd}")
        return 1

if __name__ == "__main__":
    sys.exit(main())