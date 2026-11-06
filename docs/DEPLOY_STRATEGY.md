# Produktionsstart: Deploy-Strategie (Stand 2026-11-06)

Diese Datei ist die *eine* Reihenfolge, in der der Start abläuft – mit Abbruch­punkten,
Kosten und den Prüfungen, die ohne Server laufen. `docs/DEPLOY_READINESS.md` beschreibt
den Inhalt (Gewichte, Kostenbremse, Secrets); hier steht der Ablauf.

## Zielbild

```
Browser ──HTTPS──> Caddy ──> audiomonastry (Node + REST + WebRTC/mediasoup)   [1 Hetzner-Knoten]
                                    │  └── redis  (Locks, Signaling-Adapter, Session-Restore)
                                    │  └── volume uploads_data (lokale Uploads)
                                    ├──> Supabase      (Metadaten, RLS dicht, Lesen über /api/library)
                                    ├──> R2 (privat)   (460 Visual-Clips, 244 Tracks, Gewichte)
                                    └──> RunPod-Pods   (brain, ears, voice, stems, music)
```

Ein Knoten, kein Vier-Knoten-Verbund. Grund: die Rollen `sfu`/`media`/`edge` waren für
Skalierung gedacht, nicht für den Start – und der Account hat effektiv 3 Primary-IPv4s
(gemessen 2026-10-25). Die Flotte bleibt die Option, wenn Last es verlangt.

### Zwei Startprofile – die Wahl entscheidet, ob Mobilfunk-Nutzer überhaupt rein kommen

| | A: Minimal | B: **empfohlen** |
|---|---|---|
| Compose | `docker-compose.hetzner.yml` | zusätzlich `-f docker-compose.sfu.yml -f docker-compose.turn.yml` |
| Rollen | App + Caddy + redis + master-player | dieselben **+ mediasoup (SFU) + coturn** |
| WebRTC | Peer-to-Peer, nur Host-Kandidaten | SFU + TURN-Relay |
| Netz | funktioniert in „freundlichen" Netzen | funktioniert auch hinter Carrier-NAT (Mobilfunk) |
| Firewall | 22/80/443 + ICMP | zusätzlich UDP 40000–40099 (RTP), 3478, 49152–49201 (TURN-Relay) |
| Knoten | cx23/cx33 | cx33 Minimum, cx43 bei 4 hörbaren Streams + SFU |

**Warum B:** ohne TURN gibt es keinen Relay. Zwei Nutzer hinter demselben Mobilfunk-CGNAT
sehen sich nicht – und genau das ist der häufigste Öffnungsfall einer Web-App, die man
auf dem Handy testet. Der Aufpreis ist ein Knoten-Typ (cx33 → cx43 = +0,0143 €/h), die
Arbeit ist ein Provisioning-Flag: `provision.py --role sfu` öffnet die Ports.

## Kosten (gemessen, nicht geschätzt)

Hetzner-Preise aus `/v1/pricing` am 2026-11-06 (fsn1, brutto):

| Posten | €/h | €/Monat |
|---|---|---|
| cx23 (2 vCPU / 4 GB) | 0,010472 | 6,53 |
| cx33 (4 vCPU / 8 GB) ← Empfehlung | 0,016184 | 10,10 |
| cx43 (8 vCPU / 16 GB) | 0,030464 | 19,03 |
| Primary IPv4 | 0,000952 | 0,60 |
| Snapshot | – | 0,0119 / GB |

RunPod: `scripts/runpod-pods.py plan` rechnet den aktuellen Satz aus
`deploy/runpod/pod-fleet.json`; zuletzt ≈ 1,75 $/h für 5 Pods (A40 0,35 / RTX 0,34–0,69).

Beispielrechnung für einen Launch-Tag (4 h):

```
Knoten cx33   4 h × 0,016184 = 0,065 €
IPv4          4 h × 0,000952 = 0,004 €
Pods          4 h × 1,75 $   = 7,00 $
```

Läuft der Knoten dauerhaft, ist der Monatspreis gedeckelt (10,10 €), nicht 720 h × Satz.
**Hetzner rechnet ab Erstellung, nicht ab „läuft"**: ein gestoppter Server kostet weiter.
0 €/h gibt es nur durch Löschen (`scripts/hetzner/delete-fleet.sh`, danach
`python3 scripts/apptest-gate.py --group cost --run`).

## Was seit dem letzten Deploy neu ist (und den Start bricht, wenn man es übersieht)

| Änderung | Commit | Konsequenz für den Start |
|---|---|---|
| `.env*` ist aus dem Build-Kontext raus | `d720c97b` | VITE-Werte kommen als `--build-arg`. **Heute gefunden:** der Knoten führt `VITE_SB_URL`/`VITE_SB_ANON_PUB`, durchgereicht wurden nur `VITE_SUPABASE_*` → Bundle ohne Supabase-URL, `cloudEnabled=false`, Bibliothek/Cloud tot, ohne Fehlermeldung. Gefixt in `Dockerfile*`, `docker-compose.hetzner.yml`, `deploy.sh`; Nachweis: Build ohne `.env`, URL steht im Bundle. |
| `AI_POD_TOKEN` rotiert | `d720c97b` | Knoten-`.env` muss den neuen Wert bekommen (`DEPLOY_SYNC_ENV=1`), sonst 401 an jeder Pod-Route. Laufende Pods ebenso. |
| R2-Bucket privat | Betreiber, 2026-11-06 | Kein `pub-*.r2.dev` mehr im Code; Bank/Clips signiert, Medien über `/api/media/r2/<key>`. Knoten braucht die `CFS3_*`-Werte (sonst 503 `R2_MISSING`). |
| anon-RLS geschlossen | `88323dd8` | Bibliothek liest ausschließlich über `GET /api/library` (Studio-Token, service_role). Ein Client ohne Token sieht keine Metadaten. |
| Upload-Volume + Init-Profil | `44c2314e`, `a4b5fa2d`, `bd270639` | `docker compose up` legt `uploads_data` an; Eigentümer erbt aus dem Image (`node`). `uploads-init` nur für Alt-Volumes (Profil `uploads-init`). |
| Locks/Signaling mehrinstanzfähig | `09054580` | `REDIS_URL` (compose-Default `redis://redis:6379`) aktiviert Redis-Lock-Store **und** Socket.IO-Adapter. Ohne Redis bleibt alles wie vorher; Fallback ist sichtbar im Log. |
| MJPEG ohne Master-Token in der URL | `fce621a9`, `49ffd397` | Beamer-URLs sind Einmal-Tickets (`POST /api/visual/mjpeg-ticket`). Alte Lesezeichen mit `?token=` liefern 401 – gewollt. |

## Phase 0 — Preflight, kostet nichts

```bash
cd /mnt/wd-elements/Medien/Projekte/audioMONASTRY
bash scripts/hetzner/launch-preflight.sh --build --full
```

Neun Stufen: Arbeitsbaum sauber, Deploy-Variablen vollständig, Compose gültig und
Default-Profil unverändert, **keine echte `.env` im Build-Kontext**, VITE-Werte kommen im
Bundle an, R2 erreichbar, RunPod-Plan ohne `PROBLEM:`, Gewichte vollständig, 0 Pods,
0 `app=audiomonastry`-Server, Image-Größe (Upload-Zeit). Exit 0 = weiter.

Abbruchpunkt: alles außer „PREFLIGHT GRUEN" heißt **nicht** starten.

## Phase 1 — Image einmal bauen und nach GHCR (kostet nichts)

Die Leitung Betreiber → Knoten macht ~1 MB/s; das App-Image ist ~1,4 GB. `docker save |
ssh` wären 25–40 min **pro Knoten**. Deshalb einmal pushen, danach zieht der Knoten im
Rechenzentrumstempo.

```bash
bash scripts/hetzner/registry-push.sh            # baut + pusht App- und master-player-Image
```

Danach ist `DEPLOY_IMAGE_SOURCE=registry` der Deploy-Weg.

## Phase 2 — Knoten erstellen (ab hier läuft die Uhr)

```bash
set -a; . ./.env.deploy; set +a
# Profil B (empfohlen): Rolle sfu oeffnet RTP- und TURN-Ports auf DEMSELBEN Knoten
python3 scripts/hetzner/provision.py --type cx43 --location fsn1 --role sfu
# Profil A (sparsam): nur 22/80/443
python3 scripts/hetzner/provision.py --type cx33 --location fsn1 --role app
# bzw. Wiederaufnahme aus dem letzten Stand:
python3 scripts/hetzner/restore-from-snapshots.py
```

Danach `DEPLOY_HOST=<ip>` in `.env.deploy` eintragen und den A-Record der Ziel-Domain
auf die IP setzen (`scripts/hetzner/cf-dns-ensure.py`). **HTTPS/Mikrofon am iPhone
braucht die echte Domain** – ohne sie kein `getUserMedia` außerhalb von localhost.

Abbruchpunkt: DNS-Auflösung prüfen (`dig +short <domain>`), bevor Phase 3 startet.

## Phase 3 — App deployen

```bash
set -a; . ./.env.deploy; set +a
export DEPLOY_IMAGE_SOURCE=registry DEPLOY_SYNC_ENV=1 DEPLOY_SMOKE=1
bash deploy.sh                                   # Basis-Stack (Profil A)

# Profil B: zusaetzlich SFU + TURN auf demselben Knoten verdrahten
ssh root@$DEPLOY_HOST 'cd /opt/audiomonastry && bash scripts/hetzner/wire-rtc.sh sfu'
ssh root@$DEPLOY_HOST 'cd /opt/audiomonastry && docker compose \
  -f docker-compose.hetzner.yml -f docker-compose.sfu.yml -f docker-compose.turn.yml \
  up -d caddy audiomonastry coturn'
```

`wire-rtc.sh sfu` schreibt `ENABLE_SFU=1`, `SFU_ANNOUNCED_IP` und die `TURN_*`-Werte in
die Knoten-`.env` (die `TURN_URLS` in `.env.deploy` zeigen noch auf `46.225.168.233`, die
IP eines früheren SFU-Knotens - sie werden dort neu gesetzt; danach **kein** zweiter
`DEPLOY_SYNC_ENV=1`-Lauf, sonst überschreibt er sie wieder), erzeugt `runtime/coturn/turnserver.conf` (0640, eigenes Secret) und
setzt die Client-URLs. Danach Gegentest im Browser: zwei Geräte in **verschiedenen**
Netzen (eines im Mobilfunk) müssen sich in derselben Session sehen.

Was dabei passiert (und worauf man schaut):

1. `chmod 600 .env` auf dem Knoten (neu, `d720c97b`).
2. Compose zieht das Image statt zu bauen; `build.args` interpolieren die VITE-Werte aus
   der Knoten-`.env` (beide Namenspaare).
3. Health: `/api/health` muss `status: ok` und den **richtigen Commit** melden –
   ein Snapshot-Restore liefert sonst den Code von vor Tagen.
4. Smoke: `DEPLOY_SMOKE=1 ./deploy.sh` prüft Studio, Store, Session, Medien.

Falls R2-Werte abgeschnitten ankommen (bekanntes Muster): `scripts/hetzner/push-node-env.sh`
und `docker compose up -d --force-recreate audiomonastry` (env_file wird nur bei
Container-Erzeugung gelesen). Beweis: `/api/cloud/health` → `"r2":{"status":"ok"}`.

## Phase 4 — RunPod-Pods

```bash
python3 scripts/runpod-pods.py plan
python3 scripts/runpod-pods.py up --yes --only brain --wait 900   # erst EIN Pod
# /health 200 + ein /runsync (warmup + echte Inferenz)
python3 scripts/runpod-pods.py up --yes --wait 900                # dann der Rest
```

`--only brain` ist die Kostenbremse: ein Pod, der nie `/ready` erreicht, kostet
0,35 $/h statt 1,75 $/h. Kalte Pods brauchen 8–15 min (25 GB Gewichte aus R2) –
404 auf `/health` ist in dieser Zeit normal, nicht kaputt.

Danach `RP_POD_ID_*` in die Knoten-`.env` und `docker compose up -d --force-recreate
audiomonastry`.

## Phase 5 — Abnahme (die Liste, die „fertig" definiert)

```bash
curl -fsS https://<domain>/api/health                       # status ok, richtiger Commit
curl -fsS https://<domain>/api/online                       # Session 1/4
curl -fsS https://<domain>/api/cloud/health                 # r2: ok
curl -fsS -o /dev/null -w '%{http_code}\n' https://<domain>/            # 200
curl -fsS -o /dev/null -w '%{http_code}\n' \
  https://<domain>/api/ai/vision/bank/m01a -H "x-studio-token: $STUDIO_ACCESS_TOKEN"   # 200 video/mp4
```

Dazu im Browser (mit Studio-Cookie, `scripts/prod-smoke-2026-10-25.cjs` als Vorlage):
Mixer rendert, Session zeigt 1/4, Visual-Show startet und liefert Frames, Bibliothek
listet 244 Tracks, ein Upload landet in `uploads_data` und überlebt einen Neustart
(`/api/library/uploads` → `status: ok`).

## Phase 6 — Beenden

```bash
python3 scripts/runpod-pods.py down --yes      # Pods: 0 $/h
bash scripts/hetzner/delete-fleet.sh           # Knoten löschen (stoppen reicht NICHT)
python3 scripts/apptest-gate.py --group cost --run   # Beweis: 0 Server, 0 Floating IPs
```

Snapshots nur, wenn der Stand wiederkommen soll: der letzte je Rolle, alte löschen
(0,0119 €/GB/Monat).

## Restrisiken, die der Start nicht löst

- **Redis auf dem Knoten ist Single-Instance.** Der Lock-Store ist mehrinstanzfähig
  gebaut, aber hier läuft genau ein App-Container; ein zweiter Knoten bräuchte einen
  gemeinsamen Redis (nicht der compose-Dienst).
- **Pod-Kaltstart** ist der längste unbekannte Posten (8–15 min, am 2026-11-02 nicht
  mit echten R2-Gewichten bestätigt).
- **mediasoup** braucht UDP-Ports in der Firewall (`scripts/hetzner/firewall-ensure.py`);
  ohne sie verbindet WebRTC nicht, obwohl die App „ok" meldet.
- **Vier Nutzer** sind die getestete Grenze; mehr ist nicht gemessen.
