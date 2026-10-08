# audioMONASTRY 2-4 Instance Deployment Layouts

This directory contains sensible deployment topologies for audioMONASTRY on Hetzner / RunPod / self-hosted.

Roles referenced in the code base:
- **app** – Caddy + audiomonastry (Express+API+WebRTC Signaling). `ENABLE_SFU=0`
- **sfu** – audiomonastry with `ENABLE_SFU=1` + mediasoup RTP 40000-40099 + coturn TURN/STUN
- **master** – `services/master-player` FFmpeg/NumPy mixing/mastering
- **edge** – monitoring stack only (Prometheus/Grafana/cAdvisor/node-exporter). No app traffic.

Plugin placeholders remain functional in all layouts: UI plugins are static files served by the `audiomonastry` container from `/public`; worklets are loaded via `/worklets/*`. The plugin interface contract (`plugin_interface.py`) is unchanged – only the network location of the host changes.

## Networking principles

- All services talk over Docker internal network `audiomonastry_net`. No inter-service host ports except where required.
- Caddy terminates HTTPS, proxies `/` to `audiomonastry:8080`. WebRTC signaling path `/sfu-signaling` is routed to the SFU node via DNS.
- `MASTER_PLAYER_URL` points to the master-player container, internally `http://master-player:8000`.
- `REDIS_URL` optional for multi-instance signaling; used in 3/4 instance layouts.
- SFU ports are published only on the SFU node via `docker-compose.sfu.yml` overlay.
- coturn runs in `network_mode: host` on SFU node per original design.
- Monitoring on edge runs on 127.0.0.1 only; access via SSH tunnel.

## Files

- `docker-compose.2instance.yml` – Minimal viable production: app+master on node1, sfu+turn on node2
- `docker-compose.3instance.yml` – Balanced: app+master, sfu+turn, edge monitoring
- `docker-compose.4instance.yml` – Full separation: app, sfu+turn, master, edge
- `docker-compose.overrides.*.yml` – per-node compose overrides
- `.env.example.<instance>` – environment variable templates
- `ARCHITECTURE.mmd` – Mermaid diagram
