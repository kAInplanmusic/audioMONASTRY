# Deploy-Snapshot 2026-10-07 — Flotte auf Commit 605f587

**Auftrag:** 4-Server-Strategie inkl. neuester Builds deployen, testen, loggen, Snapshot.
**Ergebnis:** Erledigt. Alle 4 Knoten laufen, Live-Domain verifiziert, E2E grün.

## 1. Was deployed ist

| | |
|---|---|
| **Commit** | `605f587` (feat(audio): 9 Quellen als eigene Plugin-Knoten + B0/B1/C0/C1) |
| **Image** | `ghcr.io/kainplanmusic/audiomonastry:605f587` |
| **Build** | 2026-10-07T01:46:08Z |
| **Version** | 1.210.001 |
| **Domain** | https://anunnakitools.de → `{"status":"ok","commit":"605f587"}` |

Vor diesem Deploy lief auf den Knoten ein Image vom **6.10. 14:50** — also der Stand
VOR dem Pluginpool-/v2-Auftrag. Der Sprung ist damit vollzogen.

## 2. Die 4 Knoten

| Rolle | Knoten | Typ | IP | Container | Zustand |
|---|---|---|---|---|---|
| app | `audiomonastry-app-1` | cx33 | 78.47.65.129 | audiomonastry, caddy | healthy, Caddy seit 11 h |
| sfu | `audiomonastry-sfu-1` | cx33 | 162.55.185.245 | audiomonastry, caddy, **coturn** | healthy, `ENABLE_SFU=1` |
| media | `audiomonastry-media-1` | cx43 | 2.28.133.48 | audiomonastry, caddy | healthy |
| edge | `audiomonastry-edge-1` | cx33 | 2.29.46.13 | prometheus, grafana, alertmanager, node-exporter, cadvisor | alle laufen seit 12 h |

Rollen-Verteilung laut `docs/SERVER_FLEET.md` und `bring-up-fleet.sh --print-config`.
`master-player` läuft in v2 auf sfu-1 mit; es gibt keine eigene `ai`/`master`-Rolle mehr.

**Platz:** app/sfu/edge 9 GB von 75 GB (13 %), media 8,9 GB von 150 GB (7 %). Kein Engpass.

## 3. Test — E2E gegen die Live-Instanz

`E2E_BASE_URL=https://anunnakitools.de playwright test smoke + audio-smoke + aiNegative`

**12 passed, 3 skipped, 0 failed, EXIT=0** (44,9 s). Die 3 Skips sind Live-Gates:
V2-Live/Audio braucht einen audio-fähigen Browser, die zwei AI-Negativ-Fälle
brauchen `AI_OFF_PROOF=1`.

Belegt darunter: App lädt mit korrektem Titel und allen Nav-Buttons; Mixer-Terminal
rendert, MOA-Leiste sichtbar; **Audio RUNNING ohne Worklet-Crash**; Session zeigt 1/4;
Modus-Button schaltet dropMONK ON und wieder OFF (ohne React-Crash); Startansicht ist
mixerMONK; masterplayer ist view-only sichtbar. AI-OFF: `/api/health` offen (200),
geschützte API ohne Token fail-closed (401/403), RunPod-Routen nie 2xx.

**Nebenbefund, der die Arbeit an `studioAuth.ts` bestätigt:** Der Reset-Hook ist in
Produktion 404 (wie vorgesehen). Der Lauf meldet das jetzt und fährt fort, statt die
Suite abzubrechen — genau die Änderung aus `8fd62b2`.

## 4. Fehler, die beim Deploy auftraten und behoben sind

1. **`fleet-deploy-live.sh` kennt nur app-1.** Es startet überall denselben Dienst-
   satz und beginnt mit `caddy`. Auf sfu-1 und media-1 fehlte dadurch
   `/opt/audiomonastry/Caddyfile`; Docker legte sie als **Verzeichnis** an, der
   Bind-Mount scheiterte (`not a directory`). Behoben: rollenspezifische Caddyfile
   installiert (`scripts/hetzner/Caddyfile.sfu`); das leere Verzeichnis entfernt.
2. **Caddy-Restart-Schleife** auf sfu-1/media-1: `acme_dns: missing API token`.
   Ursache: Die Caddyfile erwartet `CF_DNS_API_TOKEN`, die Container-Umgebung hatte ihn
   nicht (app-1 umgeht das über ein Origin-Zertifikat). Behoben: Variable auf beiden
   Knoten ergänzt und Caddy neu erzeugt.

## 5. OFFEN — braucht den Betreiber

1. **Alle drei Cloudflare-Token in der `.env` sind ungültig** (`CF_API_TOKEN`,
   `CF_TOKEN_UT`, `CF_TOKEN_ACCOUNT` → HTTP 401 `Invalid API Token`). Folge: Caddy kann
   auf sfu-1/media-1 kein Let's-Encrypt-Zertifikat über DNS-01 holen. app-1 ist nicht
   betroffen (Origin-Zertifikat in `/opt/audiomonastry/certs/origin.crt`).
2. **DNS-Eintrag falsch:** `sfu.anunnakitools.de` zeigt auf **2.28.133.48** — das ist
   **media-1**. sfu-1 ist `162.55.185.245`. Nicht geändert: eine Live-Domain und dafür
   fehlt ein gültiger Token.
3. Ein `Floating IP` ist laut API **nicht** zugewiesen (0 Einträge), obwohl
   `docs/SERVER_FLEET.md` eine für app-1 vorsieht.

**Gute Nachricht:** Die SFU-Verdrahtung selbst stimmt — sfu-1 hat `ENABLE_SFU=1` und
`SFU_ANNOUNCED_IP=162.55.185.245`, app-1 `ENABLE_SFU=0`, **TURN-Port 3478 von außen
offen**. Nur der TLS-Terminator der SFU steht an den zwei Punkten oben.

## 6. Rollback

Das vorherige Image liegt als `audiomonastry:hetzner-rollback` auf **allen** Knoten.

```bash
ssh root@<ip> 'docker tag audiomonastry:hetzner audiomonastry:hetzner-ROLL && \
  cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=audiomonastry \
  docker compose -f docker-compose.hetzner.yml up -d --no-build --force-recreate audiomonastry'
```

## 7. Wiederaufsetzpunkt

- Flotten-Zustand als JSON: `~/.hermes/cache/scratch/fleet-snapshot-20261007/flotte.json`
- Logs je Knoten: `~/.hermes/cache/scratch/fleet-snapshot-20261007/logs/*.txt`
- E2E-Lauf: `~/.hermes/cache/scratch/e2e_live.log`
- Deploy-Logs: `deploy_app1.log`, `deploy_sfu.log`, `deploy_media.log`, `registry_push.log`
- **Kostenhinweis:** Die 4 Server kosten ~39 €/Monat, solange sie EXISTIEREN — auch
  ausgeschaltet (Hetzner rechnet ab Erstellung). Beenden:
  `bash scripts/hetzner/delete-fleet.sh`.
