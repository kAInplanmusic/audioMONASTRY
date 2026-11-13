# DEPLOY-TODO: audioMONASTRY Produktionsstart
**Stand:** 2026-11-07 | **Für:** anderen Agenten | **Prinzip:** Erst prüfen → dann optimieren → dann testen | **Jeden Punkt einzeln auf ähnliche Fehler / Querverweis-Probleme prüfen**

---

## LEGENDE & STIL-REGELN

| Symbol | Bedeutung |
|--------|-----------|
| 🔴 | Kritisch — Deployment blockiert |
| 🟡 | Hoch — Risiko, sollte vor Deploy gelöst sein |
| 🟢 | Erledigt / Verifiziert |
| ⬜ | Offen / Noch zu prüfen |
| 🔄 | Querverweis nötig — ähnliches Muster anderswo prüfen |

**Stil-Regeln für den umsetzenden Agenten:**
- **Nie beide Namensvarianten vergessen** — Knoten-Vorlage (`.env.hetzner.example`) nutzt `SB_*`, lokale `.env` nutzt `VITE_SUPABASE_*` / `SUPABASE_*`. Immer beide Pfade durchreichen.
- **Kein `??` bei leeren Strings** — `SB_URL=` liefert leeren String, `??` greift nicht. Immer `.trim()` + explizite Prüfung.
- **Alle Aliasnamen auf Knoten schreiben** — Server liest `SUPABASE_*`, Browser `VITE_*`, Knoten-Vorlage `SB_*`. Auf Knoten *alle* Namen schreiben.
- **Naming-Wächter schreiben** — Für jede neue Env-Variable: Test schreiben, der prüft, ob der Name in allen relevanten Listen steht.
- **Kein `DEPLOY_SYNC_ENV=1` auf frischem Knoten** — Lokale `.env` hat `AI_MODE=off` (Kill-Schalter). Stattdessen `push-node-env.sh` nutzen.
- **Kein Commit ohne Preflight-Grün** — `bash scripts/hetzner/launch-preflight.sh --build --full` muss Exit 0 sein.
- **Jede Änderung an Env-Namen: alle 4 Pfade prüfen** — Dockerfile, Dockerfile.hetzner, docker-compose.hetzner.yml, deploy.sh, push-node-env.sh, supabaseKeys.ts.

---

## 🟢 PHASE 0: VORPRÜFUNG (ERLEDIGET)

| ID | Status | Aufgabe | Prüfbefehl | Erwartung |
|----|--------|---------|------------|-----------|
| 0.1 | 🟢 | Preflight durchlaufen lassen | `bash scripts/hetzner/launch-preflight.sh --build --full` | Exit 0, nur erwartete Warnungen (DEPLOY_HOST leer, AI_MODE=off lokal, TURN_URLS veraltet, kein lokales Image) |
| 0.2 | 🟢 | Git-Status sauber | `git status --porcelain` | Keine uncommitted Changes außer erlaubten (launch-preflight.sh neu) |
| 0.3 | 🟢 | Main mit Remote identisch | `git rev-parse HEAD` vs `git ls-remote origin refs/heads/main` | Identisch |
| 0.4 | 🟢 | Tests grün | `npm run verify` | Exit 0, 3842+ Tests, 20/20 RT-Grenzen |
| 0.5 | 🟢 | Deploy-Variablen vollständig | `grep -E '^(DEPLOY_HOST|DEPLOY_SSH_KEY|HCLOUD_TOKEN|RUNPOD_API_KEY|RP_POD_IMAGE|RP_REGISTRY_AUTH_ID|AI_POD_TOKEN|CFS3_ACCESS_KEY|CFS3_SECRET_KEY|CFS3_BUCKET|CFS3_ENDPOINT|CFS3_BUCKET|CFS3_PUBLIC_URL|CFS3_SECRET_KEY|CFR2_ACCOUNT_ID|GHCR_USERNAME|GHCR_PASSWORD|SIGNALING_ALLOWED_ORIGINS|TURN_URLS|SB_URL|SB_SERVICE_ROLE)=' .env.deploy` | Alle gesetzt, keine Platzhalter |

---

## 🟢 PHASE 1: NAMING-KONSISTENZ (ERLEDIGET)

### 1.1 VITE-Build-Args: Beide Namenspaare durchreichen ✅
| Datei | Prüfen | Erwartung |
|-------|--------|-----------|
| `Dockerfile` | `ARG VITE_SB_URL=""`, `ARG VITE_SB_ANON_PUB=""`, `ARG VITE_SUPABASE_URL=""`, `ARG VITE_SUPABASE_ANON_PUB=""`, `ARG VITE_V2_AUDIO_MODE=""` | Alle 5 ARGs vorhanden |
| `Dockerfile.hetzner` | gleiche 5 ARGs | Alle 5 ARGs vorhanden |
| `docker-compose.hetzner.yml` | `VITE_SUPABASE_URL: ${VITE_SUPABASE_URL:-${VITE_SB_URL:-}}`, `VITE_SB_URL: ${VITE_SB_URL:-${VITE_SUPABASE_URL:-}}`, analog für ANON_PUB, `VITE_V2_AUDIO_MODE` | Beide Paare mit Fallback |
| `deploy.sh` | Schleife über `VITE_SUPABASE_URL:VITE_SB_URL` und `VITE_SUPABASE_ANON_PUB:VITE_SB_ANON_PUB` + `VITE_V2_AUDIO_MODE` | Beide Paare + V2_AUDIO_MODE |

**Test:** `.env` weglegen, `VITE_SB_URL=... VITE_SB_ANON_PUB=... VITE_V2_AUDIO_MODE=v2 npm run build` → `grep -r 'pwtwtqbcynsjtkxlkrwh.supabase.co' dist/assets/` findet URL in `index-*.js` und `audio-core-*.js`

**Wächter:** `tests/deployBuildArgs.test.ts` (6 Tests) muss grün sein.

### 1.2 Supabase Server-Key Prioritätsordnung ✅
**Datei:** `src/config/supabaseKeys.ts`

| Prüfpunkt | Erwartung |
|-----------|-----------|
| `SUPABASE_SERVICE_ROLE_KEY` in `SUPABASE_SERVER_KEY_ORDER` | Direkt hinter `SUPABASE_SERVICE_ROLE`, vor `SUPABASE_SERVICE_ROLE_JWT` |
| `supabaseUrl()` nutzt `.trim()` + explizite Prüfung, nicht `??` | Leerer String `SB_URL=` blockiert Fallback nicht |
| Kommentar im Code aktualisiert | `SB_SERVICE_ROLE → SB_SECRET → SB_PAT → SUPABASE_SERVICE_ROLE → SUPABASE_SERVICE_ROLE_KEY → SUPABASE_SERVICE_ROLE_JWT → …` |

**Tests:** `tests/supabaseKeys.test.ts` — 3 neue Cases:
- `findet den kanonischen SUPABASE_SERVICE_ROLE_KEY`
- `ein leerer SB_-Wert verdeckt den gültigen Legacy-Namen nicht`
- `supabaseUrl ignoriert ein leeres SB_URL und nimmt SUPABASE_URL`

### 1.3 push-node-env: Kandidatenlisten statt Einzel-Namen ✅
**Datei:** `scripts/hetzner/push-node-env.sh`

| Prüfpunkt | Erwartung |
|-----------|-----------|
| `KANDIDATEN` Array für jeden Zielnamen | `SB_URL` ← `VITE_SUPABASE_URL`/`SUPABASE_URL`/`VITE_SB_URL`, `SB_SERVICE_ROLE` ← `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_SERVICE_ROLE`/`SB_SECRET` |
| Schreibt **alle** Namen auf Knoten | `SB_*`, `SUPABASE_*`, `VITE_*` (via `ZWEITNAME`) |
| `STUDIO_ACCESS_TOKEN`, `SCRAPE_TOKEN` in `SCHLUESSEL` | Beide in Array, werden mitgeschleift |
| `STUDIO_ACCESS_TOKEN`, `SCRAPE_TOKEN` in Container-Output | `docker exec audiomonastry printenv STUDIO_ACCESS_TOKEN` zeigt Länge |
| Alias-Schleife schreibt **alle** Zweitnamen | `for zweit in ${ZWEITNAME[$k]:-}; do ZEILEN+=("${zweit}=${v}")` |

**Test:** `APP_IP=127.0.0.1 bash scripts/hetzner/push-node-env.sh` → Alle Einträge zeigen Länge > 0, Alias-Einträge vorhanden.

### 1.4 Knoten-Vorlage `.env.hetzner.example` prüfen ✅
| Variable | Muss gesetzt sein (nicht auskommentiert) |
|----------|------------------------------------------|
| `VITE_SB_URL` | ja |
| `VITE_SB_ANON_PUB` | ja |
| `VITE_SUPABASE_URL` | nein (Alias) |
| `VITE_SUPABASE_ANON_PUB` | nein (Alias) |
| `STUDIO_ACCESS_TOKEN` | **nein** — wird per `push-node-env.sh` gesetzt |
| `SCRAPE_TOKEN` | **nein** — wird per `push-node-env.sh` gesetzt |
| `AI_MODE` | **nicht** in Vorlage — Default ist `on-no-visuals` |

---

## 🟢 PHASE 2: INFRASTRUKTUR & STACK-INTEGRATION (ERLEDIGET)

### 2.1 Redis / Session-Restore / Locks ✅
| Prüfpunkt | Erwartung |
|-----------|-----------|
| `docker-compose.hetzner.yml` hat `redis` Service | Ja, `redis:7-alpine`, Healthcheck |
| `REDIS_URL=redis://redis:6379` in Compose | Ja, Default |
| `server/realtime.ts` nutzt `REDIS_URL` für Lock-Store | `createPluginLockStoreFromEnv()` liest `REDIS_URL` |
| Socket.IO Redis-Adapter aktiviert | `attachRedisSocketAdapter()` in `realtime.ts` |
| Lock-Store Memory-Fallback | Ohne `REDIS_URL` → Memory, Log "Memory-Store aktiv" |

**Test:** `docker compose -f docker-compose.hetzner.yml config --services` → `redis` enthalten.

### 2.2 Upload-Volume & Init ✅
| Prüfpunkt | Erwartung |
|-----------|-----------|
| `docker-compose.hetzner.yml` Volume `uploads_data` | Ja, `/app/data/uploads` |
| `uploads-init` Service im Profil `uploads-init` | Ja, `chown node:node /data` |
| `uploads-init` **nicht** im Default-Profil | Ja, `profiles: ["uploads-init"]` |
| `audiomonastry` depends_on `uploads-init` | `condition: service_completed_successfully` |
| Image hat `/app/data/uploads` als `node:node` | Dockerfile.hetzner `RUN mkdir -p /app/data/uploads && chown node:node /app/data/uploads` |

### 2.3 Caddy / TLS / DNS ✅
| Profil | Modus | DNS-Eintrag | Ports |
|--------|-------|-------------|-------|
| A (Minimal) | `origin` (Default, `ORIGIN_CERT`/`ORIGIN_KEY` gesetzt) | **Proxied** (orange Cloudflare) | 443 |
| B (Empfohlen) | `origin` + SFU+TURN | **Proxied** (orange) | 443 + UDP 40000-40099, 3478, 49152-49201 |
| C (ACME) | `DEPLOY_INSTALL_CADDYFILE=1` | **DNS only** (grau) | 80, 443 |

**Wichtig:** Modus und DNS **müssen** zusammenpassen. Der Preflight prüft das.

### 2.4 Firewall (Profil B) ✅
| Port | Protokoll | Dienst |
|------|-----------|--------|
| 40000-40099 | UDP | mediasoup RTP |
| 3478 | UDP/TCP | coturn TURN/STUN |
| 49152-49201 | UDP | coturn Relay-Ports |
| 22, 80, 443 | TCP | SSH, HTTP, HTTPS |

`provision.py --role sfu` öffnet diese Ports. `firewall-ensure.py` hat die Regeln.

---

## 🟢 PHASE 3: RUNPOD & PODS (ERLEDIGET — CODE/VERIFIKATION)

### 3.1 Pre-Checks (kostenlos) ✅
| Befehl | Erwartung |
|--------|-----------|
| `python3 scripts/runpod-pods.py plan` | Keine `PROBLEM:` Zeilen, VRAM ≤ 42 GB/Pod, Kosten ≤ Budget |
| `python3 scripts/runpod-pods.py weights` | Alle 20 Modelle in R2 (`weights/<model>/<rev>.tar` + `.sha256`) |
| `python3 scripts/runpod-pods.py status` | `0 Pods` (Kosten 0) |

### 3.2 Pod-Start Reihenfolge ✅ (Dokumentiert)
```bash
# 1. Nur brain (billigster Test)
python3 scripts/runpod-pods.py up --yes --only brain --wait 900
# → /health 200, ein /runsync warmup + echte Inferenz

# 2. Dann Rest
python3 scripts/runpod-pods.py up --yes --wait 900
```

### 3.3 Pod-Env Variablen prüfen ✅ (Konfiguration valide)
| Variable | Quelle | Muss im Pod sein |
|----------|--------|------------------|
| `AI_POD_TOKEN` | `.env.deploy` | ja (Middleware schützt alle Routen außer `/health`) |
| `AI_WEIGHTS_URLs` | `runpod-pods.py weight_entries()` | ja (Presigned URLs für alle Gewichte) |
| `RUNPOD_BRAIN_OPENAI_MODEL` etc. | `deploy/gpu/pod-fleet.json` | ja |
| `containerRegistryAuthId` | `RP_REGISTRY_AUTH_ID` | ja (GHCR private Image) |

### 3.4 Pod-Health prüfen ✅ (Dokumentiert: 8-15 Min Kaltstart)
- Pod zeigt `desiredStatus: RUNNING` → **nicht** gleich `/health` prüfen
- 2-3 Min warten, dann `/health` polen bis 200
- `/ready` für Models prüfen
- Kalte Pods brauchen 8-15 Min (25 GB Gewichte aus R2)

---

## 🔴 PHASE 4: DEPLOY-AUSFÜHRUNG (Die eigentliche Generalprobe)

### 4.1 Image bauen & pushen (einmalig)
```bash
bash scripts/hetzner/registry-push.sh
# Baut App-Image (1,51 GB) + master-player-Image
# Pusht nach ghcr.io/kainplanmusic/audiomonastry:<commit-hash>
```

### 4.2 Knoten provisionieren (ab hier läuft die Uhr!)
```bash
set -a; . ./.env.deploy; set +a
# Profil B (empfohlen): SFU + TURN auf DEMSELBEN Knoten
python3 scripts/hetzner/provision.py --type cx43 --location fsn1 --role sfu
# IP notieren → DEPLOY_HOST in .env.deploy eintragen
# A-Record der Domain auf IP setzen (PROXIED bei origin-TLS!)
```

### 4.3 App deployen
```bash
export DEPLOY_IMAGE_SOURCE=registry DEPLOY_SMOKE=1
bash deploy.sh
# → chmod 600 .env auf Knoten
# → Compose zieht Image, startet Stack
# → Health: /api/health → 200, richtiger Commit
# → Smoke: DEPLOY_SMOKE=1 ./deploy.sh prüft Studio, Store, Session, Medien
```

### 4.4 Knoten-.env mit echten Secrets versorgen
```bash
APP_IP=$DEPLOY_HOST bash scripts/hetzner/push-node-env.sh
# Überträgt: Supabase, R2, STUDIO_ACCESS_TOKEN, SCRAPE_TOKEN
# Schreibt ALLE Aliasnamen auf Knoten
ssh root@$DEPLOY_HOST 'cd /opt/audiomonastry && docker compose up -d --force-recreate audiomonastry'
```

### 4.5 SFU + TURN verdrahten (Profil B)
```bash
ssh root@$DEPLOY_HOST 'cd /opt/audiomonastry && bash scripts/hetzner/wire-rtc.sh sfu'
# Setzt ENABLE_SFU=1, SFU_ANNOUNCED_IP, TURN_URLS neu
ssh root@$DEPLOY_HOST 'cd /opt/audiomonastry && docker compose \
  -f docker-compose.hetzner.yml -f docker-compose.sfu.yml -f docker-compose.turn.yml \
  up -d caddy audiomonastry coturn'
```

### 4.5 RunPod Pods starten
```bash
python3 scripts/runpod-pods.py plan && python3 scripts/runpod-pods.py weights
python3 scripts/runpod-pods.py up --yes --only brain --wait 900   # erst EIN Pod
# /health 200 + /runsync warmup + echte Inferenz
python3 scripts/runpod-pods.py up --yes --wait 900
# RP_POD_ID_* in Knoten-.env übernehmen → docker compose up -d --force-recreate audiomonastry
```

---

## ✅ PHASE 5: ABSCHLUSS-ABNAHME (Die Liste, die "fertig" definiert)

| Check | Befehl | Erwartung |
|-------|--------|-----------|
| Health | `curl -fsS https://<domain>/api/health` | `status: ok`, commit=HEAD |
| Session | `curl -fsS https://<domain>/api/online` | `Session 1/4` |
| R2 | `curl -fsS https://<domain>/api/cloud/health` | `r2: ok` |
| Frontend | `curl -fsS -o /dev/null -w '%{http_code}\n' https://<domain>/` | 200 |
| Bank-Clip | `curl -fsS -o /dev/null -w '%{http_code}\n' https://<domain>/api/ai/vision/bank/m01a -H "x-studio-token: $STUDIO_ACCESS_TOKEN"` | 200 video/mp4 |
| Range | `curl -fsS -o /dev/null -w '%{http_code}\n' https://<domain>/api/ai/vision/bank/m01a -H "x-studio-token: $STUDIO_ACCESS_TOKEN" -H "Range: bytes=0-99"` | 206, `bytes 0-99/871661` |
| Startbild | `curl -fsS -o /dev/null -w '%{http_code}\n' https://<domain>/api/ai/vision/bank/m01a_start -H "x-studio-token: $STUDIO_ACCESS_TOKEN"` | 200 image/jpeg |
| Media Proxy | `curl -fsS -o /dev/null -w '%{http_code}\n' https://<domain>/api/media/r2/visuals/bank/m01a.mp4 -H "x-studio-token: $STUDIO_ACCESS_TOKEN" -H "Range: bytes=0-99"` | 206 |
| Library | `curl -fsS https://<domain>/api/library -H "x-studio-token: $STUDIO_ACCESS_TOKEN"` | 200, Samples + Tracks |
| Uploads | `curl -fsS https://<domain>/api/library/uploads -H "x-studio-token: $STUDIO_ACCESS_TOKEN"` | `status: ok`, `storage: {writable: true}` |
| Cloud Health | `curl -fsS https://<domain>/api/cloud/health` | `r2: ok` |
| Metrics | `curl -fsS https://<domain>/api/metrics -H "x-studio-token: $STUDIO_ACCESS_TOKEN"` | 200, Prometheus-Format gültig |

**Browser-Test (mit Studio-Cookie):**
- Mixer rendert, Session zeigt 1/4
- Visual-Show startet, liefert Frames (mind. 30 fps über 10s)
- Bibliothek listet 244 Tracks
- Upload landet in `uploads_data`, überlebt Neustart (`/api/library/uploads` → `status: ok`)

---

## 🔴 PHASE 6: BEENDEN (Kosten auf 0 €)

```bash
python3 scripts/runpod-pods.py down --yes      # Pods: 0 $/h
bash scripts/hetzner/delete-fleet.sh           # Knoten LÖSCHEN (stoppen reicht NICHT!)
python3 scripts/apptest-gate.py --group cost --run   # Beweis: 0 Server, 0 Floating IPs
```

Snapshots: nur letzter je Rolle behalten, alte löschen (0,0119 €/GB/Monat).

---

## 🔄 QUERVERWEIS-PRÜFLISTE (Für jeden Punkt einzeln!)

| Muster | Wo prüfen | Wenn gefunden → Aktion |
|--------|-----------|------------------------|
| `process.env.SUPABASE_*` im Server-Code | `grep -r "process.env.SUPABASE_" server/ src/` | In `supabaseKeys.ts` Prioritätsordnung prüfen, beide Namen in push-node-env.sh |
| `process.env.SB_*` im Server | `grep -r "process.env.SB_" server/ src/` | Alias in push-node-env.sh `KANDIDATEN` eintragen |
| `process.env.VITE_*` im Client | `grep -r "import.meta.env.VITE_" src/` | Beide Namen in Dockerfile/Compose/deploy.sh ARGs |
| `??` mit Env-Variablen | `grep -rn "\?\?" src/config/ server/` | Ersetzen durch `.trim()` + explizite Prüfung |
| `SB_URL=` in .env | `grep '^SB_URL=$' .env` | `supabaseUrl()` muss `.trim()` + Fallback prüfen |
| `SB_SERVICE_ROLE=` leer | `grep '^SB_SERVICE_ROLE=$' .env` | Prioritätsordnung muss `SUPABASE_SERVICE_ROLE_KEY` haben |
| `STUDIO_ACCESS_TOKEN` auskommentiert | `grep '^#STUDIO_ACCESS_TOKEN=' .env.hetzner.example` | push-node-env.sh muss es mitschleifen |
| `AI_MODE=off` in lokaler .env | `grep '^AI_MODE=off$' .env` | Preflight warnt, `DEPLOY_SYNC_ENV=1` verbieten |
| `TURN_URLS` IP prüfen | `grep 'TURN_URLS=' .env.deploy` | Preflight vergleicht mit `DEPLOY_HOST` |

---

## 💰 KOSTEN-ÜBERSICHT (Gemessen, nicht geschätzt)

| Posten | €/h | €/Monat | Hinweis |
|--------|-----|---------|---------|
| cx23 | 0,0105 | 6,53 | Minimal |
| **cx43 (empfohlen)** | **0,0305** | **19,03** | **Empfohlen für Profil B** |
| cx33 | 0,0162 | 10,10 | Alternative |
| Primary IPv4 | 0,00095 | 0,60 | 1x |
| Snapshot | — | 0,0119/GB | Nur letzte je Rolle |
| RunPod Pods | ~1,75 $/h | — | 5 Pods (A40/RTX) |

**Launch-Tag (4h, Profil B):** ~0,12 € + 7 $  
**Dauerbetrieb cx43 + IPv4:** ~19,63 €/Monat

**Kostenstopp:** `delete-fleet.sh` + `apptest-gate --group cost --run` → 0 €/h belegt.

---

## 📝 QUALITÄTS-CHECKLISTE VOR JEDEM COMMIT

- [ ] `npm run verify` → Exit 0
- [ ] `bash scripts/hetzner/launch-preflight.sh --build --full` → Exit 0
- [ ] Keine neuen `process.env.X` ohne Eintrag in `supabaseKeys.ts` / `push-node-env.sh`
- [ ] Keine neuen `import.meta.env.VITE_*` ohne ARGs in beiden Dockerfiles + Compose + deploy.sh
- [ ] Keine `??` mit Env-Variablen
- [ ] Tests für neue Env-Namen geschrieben (deployBuildArgs, supabaseKeys, push-node-env)
- [ ] Changelog-Eintrag in Commit-Message (welche Namensfalle gefixt)

---

## 🚀 STARTFREIGABE

**Alles oben 🟢 = Go.**

Nächster Befehl nach deiner Freigabe:
```bash
cd /mnt/wd-elements/Medien/Projekte/audioMONASTRY
bash scripts/hetzner/launch-preflight.sh --build --full
# → muss GRÜN sein (Exit 0)
# Dann: Generalprobe starten (Phase 4.2 ff.)
```

---

**Ende der Übergabe. Viel Erfolg! 🎯**

## BACKLOG – Betreiberentscheidung Runde 4 (2026-11-13)

- `R4-P2-UI-PROJECTION`: frühere Rack-Projektion **OFF / STBY / ON** nur als historische Alternative zurückgestellt. Aktive Variante **OFF / ON / AI** aus `cdb0644` bleibt ausdrücklich bestehen. Kein Revert und keine Umsetzung der alten Alternative freigegeben. Entscheidung/Beleg im bestehenden ROUND2_ORCHESTRATOR_REPORT und in EVIDENCE_REGISTRY.
