# Plan: Verify and finalize audioMONASTRY Hetzner fleet deployment

## Goal
Ensure all four fleet nodes (app, sfu, media, edge) are running the expected services, health checks pass, and basic operational safeguards (auto-shutdown, backup, monitoring) are active.

## Current context / assumptions
- Four Hetzner servers are provisioned with correct IPs and SSH keys.
- Docker and docker-compose are installed on each node.
- The audioMONASTRY source is synced to `/opt/audiomonastry` on each node.
- Environment variables (DOMAIN, certificates, etc.) are set via `.env` and `.env.deploy`.
- The app node (app-1) is reachable via HTTPS at `https://anunnakitools.de` and returns a healthy JSON response.
- The edge node is intended to run only the monitoring stack (Prometheus, Grafana, etc.).
- The sfu and media nodes run their respective containers (sfu: mediasoup + master-player; media: audiomonastry for R2 sync and caching).

## Architecture / proposed approach
We will verify each node individually via SSH, check running containers, test service endpoints where applicable, and ensure that timers and monitoring are enabled. Where a service is not directly exposed (e.g., internal APIs), we will rely on Docker health status and logs.

## Step-by-step tasks

### 1. Verify app-1 (78.47.65.129)
- Check running containers: expect audiomonastry, audiomonastry-master, audiomonastry-caddy, audiomonastry-redis.
- Confirm health status of each container.
- Test the health endpoint via curl with Host header.
- Ensure Caddy is serving TLS with the self-signed origin certificate.
- Verify that the auto-shutdown timer is installed (systemctl list-timers).

### 2. Verify sfu-1 (2.31.36.78)
- Check running containers: expect audiomonastry (which includes master-player) and audiomonastry-caddy.
- Confirm that mediasoup is listening on UDP ports 40000-40099 (via `ss -uln`).
- Verify that the Caddy reverse proxy is forwarding `/sfu-signaling/*` appropriately (should return 404 with JSON hint because ENABLE_SFU=0 on app-1; but we can check that Caddy is up).

### 3. Verify media-1 (178.105.96.144)
- Check running containers: expect audiomonastry (which runs the R2 sync worker and streaming cache).
- Ensure no extraneous containers (like master-player) are running unless intended.
- Verify that the node has access to the NVMe (check mount points if needed) – optional.

### 4. Verify edge-1 (2.28.101.4)
- Check running containers: expect the monitoring stack (node-exporter, cadvisor, prometheus, alertmanager, grafana).
- Ensure Grafana is bound to localhost only (no external port) – verify via `ss -ltn`.
- Confirm that Prometheus is scraping the app node (check targets via local curl to prometheus on localhost:9090 after port-forward).

### 5. Operational safeguards
- On each node, verify that the idle-shutdown timer is installed and active.
- On app-1, verify that the backup timer is installed and active.
- On each node, verify that the auto-repair watchdog is installed.

### 6. Optional: Enable AI mode (if desired)
- If the user wishes to enable AI, set `AI_MODE=on-no-visuals` or `on-with-visuals` in `.env` on app-1 and redeploy.
- This will trigger the fleet script to start AI containers on sfu-1 (or dedicated AI node if we had one) – but currently we have no dedicated AI node; AI would run on sfu-1 alongside master-player (which may be acceptable for low load).

### 7. Documentation
- Record the final IPs and container versions in a simple markdown file in the repo under `docs/FLEET_STATUS.md`.

## Tests / validation
Each verification step includes a concrete command and expected output.

### 1. App-1 verification
```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@78.47.65.129 "docker ps --format 'table {{.Names}}\t{{.Status}}'"
```
Expected output (table) includes:
```
NAMES                  STATUS
audiomonastry          Up X minutes (healthy)
audiomonastry-master   Up X minutes (healthy)
audiomonastry-caddy    Up X minutes
audiomonastry-redis    Up X minutes (healthy)
```

Health endpoint:
```bash
curl -s -H "Host: anunnakitools.de" https://78.47.65.129/api/health
```
Expected JSON:
```json
{"status":"ok","version":"1.210.001","commit":"54c8c71","buildTime":"2026-10-10T17:41:36Z","killSwitch":false}
```

Auto-shutdown timer:
```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@78.47.65.129 "systemctl list-timers audiomonastry-idle-shutdown.timer"
```
Expected line showing `audiomonastry-idle-shutdown.timer` with a next activation.

### 2. SFU-1 verification
Container check:
```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@2.31.36.78 "docker ps --format 'table {{.Names}}\t{{.Status}}'"
```
Expected:
```
NAMES                  STATUS
audiomonastry          Up X minutes
audiomonastry-caddy    Up X minutes
```

UDP ports for mediasoup:
```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@2.31.36.78 "ss -uln | grep -E ':400[0-9]{2}'"
```
Expected lines showing UDP listeners on ports 40000-40099.

### 3. Media-1 verification
Container check:
```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@178.105.96.144 "docker ps --format 'table {{.Names}}\t{{.Status}}'"
```
Expected:
```
NAMES                  STATUS
audiomonastry          Up X minutes
```
(Any other containers indicate misconfiguration.)

### 4. Edge-1 verification
Container check:
```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@2.28.101.4 "docker ps --format 'table {{.Names}}\t{{.Status}}'"
```
Expected:
```
NAMES                          STATUS
audiomonastry-alertmanager     Up X minutes
audiomonastry-cadvisor         Up X minutes
audiomonastry-grafana          Up X minutes
audiomonastry-node-exporter    Up X minutes
audiomonastry-prometheus       Up X minutes (healthy)
```

Grafana binding (should only be on localhost):
```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@2.28.101.4 "ss -ltn | grep :3000"
```
Expected no output (or only a line with `127.0.0.1:3000`).

### 5. Timers and watchdogs (example for app-1)
Idle-shutdown timer active:
```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@78.47.65.129 "systemctl is-active audiomonastry-idle-shutdown.timer"
```
Expected: `active`

Backup timer:
```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@78.47.65.129 "systemctl is-active audiomonastry-backup.timer"
```
Expected: `active`

Auto-repair watchdog:
```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@78.47.65.129 "systemctl is-active audiomonastry-auto-repair.timer"
```
Expected: `active`

## Risks, tradeoffs, and open questions
- The current setup uses a self-signed origin certificate; browsers will show a warning unless the user adds an exception. For production, a proper certificate from Let's Encrypt or similar should be used, but that requires DNS-01 challenge via Cloudflare API (already possible via the existing CF_TOKEN).
- The edge node currently has no persistent storage for Prometheus/Grafana data; if the node is recreated, monitoring history is lost. Consider adding a Hetzner volume if long-term metrics are needed.
- AI mode is currently off; enabling it will increase cost (GPU via RunPod) and may require adjusting fleet size or budgets.
- The backup timer on app-1 copies data to the local NVMe; there is no off-site backup configured. For critical data, consider configuring R2 sync or snapshots.
- The fleet uses the same SSH key across nodes; if compromised, all nodes are at risk. Consider using separate keys or a certificate‑based SSH setup in the future.

---
*Plan saved to .hermes/plans/2026-10-10_190000-verify-audiomонаstry-fleet.md*