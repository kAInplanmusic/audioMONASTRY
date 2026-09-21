# audioMONASTRY OPS-Runbook (PREP-8)

> Verbindliche Zahlen: siehe docs/INFRA_KONSTITUTION.md.

Betreiber-/Security-Aufgaben, die nur mit externen Zugängen (Cloud-Konsole,
HF, GitHub) gehen. Kein Code nötig – aber jeder Punkt ist ein Security/Compliance-Gate.

## 1. HF-Endpoint-Secret rotieren (halbjährlich oder bei Verdacht)
1. HuggingFace-Konto → *Settings → Access Tokens*.
2. Neues Token erzeugen (`read` für Inference-Endpoints genügt; für Deployment `write`).
3. In `~/.env` (bzw. Remote-`.env` im Flotten-Root) `HF_TOKEN=…` ersetzen.
4. `npm run verify` + Smoke: `npx tsx scripts/replicate-smoke.ts` (nur Replicate),
   AI-Fallback-Test: `node scripts/verify-ai.ts` (falls vorhanden) bzw. einen
   echten LLM-Aufruf via DeepSeek/HF-Router starten.
5. Altes Token sofort widerrufen.
6. Secret nie in Git/Logs – `git log -S` gegen den alten Wert prüfen.

## 2. Logging & Telemetrie
- Abgelehnte Socket-Handshakes loggt `services/signaling` seit 2026-09-06 mit
  IP-Hash (`ip#<hash>`) + ISO-Zeit – keine Klartext-PII.
- Ziel: abgelehnte Handshakes zusätzlich als Metrik an `/api/telemetry`
  (offen, PREP-8-Teilaufgabe für Flotten-Betrieb).

## 3. Flotten-Lebenszyklus
| Aktion | Befehl |
|---|---|
| Start (Git-Pull + Flotte + Deploy + Smoke) | `npm run fleet:start` |
| Stop (Snapshot-Backup + Server löschen, 0 €) | `npm run fleet:stop:yes` |
| Status | `bash scripts/hetzner/fleet-status.sh` |

Snapshots: `scripts/hetzner/lifecycle.sh stop` erzeugt `<name>-auto-<ts>`.
Wiederherstellung: `npm run fleet:start` provisioniert aus dem aktuellen Repo;
aus Snapshots booten erfordert `provision-fleet.sh` mit `IMAGE=<snapshot>`.

## 4. Supabase
- Migrationen live: `npm run supabase:apply`
- RLS: anon = lesen, service_role = schreiben (Migration 006).
- Keys: `SUPABASE_PAT` für Management-API, nie in den Client bauen.

## 5. Rotations-Checkliste (Sicherheit)
- [ ] HF_TOKEN rotiert
- [ ] `npm audit` 0 Vulnerabilities
- [ ] `git log --all -S` zeigt keine Secrets
- [ ] Workflow-Actions auf Commit-SHAs (AUD-2609-1)
- [ ] Nightly-CI-Lauf auf GitHub bestätigt

## 6. Rotations-Drill (2026-09-14, lokal ausgeführt)

Ablauf (gegen `node dist/server.cjs`, `NODE_ENV=production`, Port 3907):

```
Phase A: STUDIO_ACCESS_TOKEN=old-token-A
  curl -H "x-studio-token: old-token-A" /api/online  -> 200
  curl -H "x-studio-token: new-token-B" /api/online  -> 401
Phase B: Neustart mit STUDIO_ACCESS_TOKEN=new-token-B
  curl -H "x-studio-token: old-token-A" /api/online  -> 401
  curl -H "x-studio-token: new-token-B" /api/online  -> 200
```

Erkenntnis aus dem Drill: Nach dem Kill muss der Port tatsächlich frei sein
(`ss -ltnp | grep <port>`), sonst startet die neue Instanz mit `EADDRINUSE`
und die alte Instanz beantwortet weiter — das fällt bei `curl` nicht sofort
auf, weil die Antworten identisch aussehen. Deshalb im Deploy-Skript nach
`kill` immer erst `ss`/Health prüfen, bevor `up -d` läuft.

## 7. Backup & Restore (Off-Site, PROD-P0-002 — 2026-09-14 real durchgespielt)

**Ziel:** `BACKUP_S3_*`/`HOS_S3_*` (Hetzner Object Storage, Bucket
`audiomonastry-backups` in `nbg1`). Lokal bleibt der tar.gz mit Rotation.

```
# taeglich (Cron): lokales Backup + Off-Site-Kopie + Verifikation per HeadObject
BACKUP_DIR=/var/backups/audiomonastry bash scripts/backup.sh --offsite

# Kontrolle
node scripts/r2-backup.mjs buckets          # Bucket sichtbar?
node scripts/r2-backup.mjs list             # vorhandene Backups (Groesse/Datum)

# Restore
node scripts/r2-backup.mjs restore backups/audiomonastry_<stamp>.tar.gz /tmp/restore.tar.gz
sha256sum <lokal> /tmp/restore.tar.gz        # muss identisch sein
tar -xzf /tmp/restore.tar.gz -C /var/www/audiomonastry
```

**Scope:** `dist` + `public` OHNE `dist/data`, `dist/music`, `public/data`,
`public/music` → ~47 MB statt 5 GB (dist enthaelt beim Build Kopien der Medien).
Die 3 GB Orchestral-Samples sind Inhalt, kein Zustand; fuer eine Vollsicherung
`--full` verwenden. `public/uploads` (Nutzersamples) ist immer enthalten.

**Drill 2026-09-14 (echt):** Backup 48 253 484 Bytes → Upload nach
`nbg1.your-objectstorage.com/audiomonastry-backups` (etag verifiziert) →
Restore → **SHA-256 identisch** (`7889efda…39ddd`) → 311 Dateien entpackt →
`dist/server.cjs` byte-identisch und `node --check` OK.

**RPO/RTO:** taeglicher Lauf ⇒ RPO 24 h (mit `--offsite` auch off-site);
RTO ~2 min (entpacken) bzw. ~10 min inkl. `npm ci` + `npm run build`.

**Flotten-Verdrahtung (INFRA-HETZNER-008):** In der Flotte läuft der Lauf nicht
per Cron auf dem Laptop, sondern als systemd-Timer auf **app-1** – dort liegt der
Zustand (`dist`/`public` + Knoten-`.env` mit den Off-Site-Keys):

```bash
# Installation (macht bring-up-fleet.sh Schritt 6 automatisch auf app-1)
ssh root@<app-1-ip> 'bash /opt/audiomonastry/scripts/hetzner/install-backup-timer.sh'

# Kontrolle
ssh root@<app-1-ip> 'systemctl list-timers audiomonastry-backup.timer'
ssh root@<app-1-ip> 'tail -n 20 /var/log/audiomonastry-backup.log'
ssh root@<app-1-ip> 'systemctl start audiomonastry-backup.service'   # Sofort-Lauf
```

Timer: 15 min nach jedem Boot (die Flotte wird je Session neu erzeugt – ein
Kalenderzeitpunkt greift bei kurzen Sessions nie) und danach alle 24 h.
`Off-Site ist best effort, aber nie ein stiller No-Op`: fehlen Zugangsdaten
(`BACKUP_S3_*`/`HOS_S3_*`/`CFS3_*`/`CFR2_*`) oder `@aws-sdk/client-s3` im
Knoten-Repo, meldet der Lauf das laut ins Log und sichert lokal weiter;
`REQUIRE_OFFSITE=1` macht Off-Site zur Pflicht (Timer-Lauf endet dann mit
Exit 3 = `failed`). Der Stop-Pfad (Portal **und** CLI) zieht zusätzlich vor dem
Löschen je Knoten einen Server-Snapshot (Retention: letzte 2 je Rolle) – ein
Stop ist damit nicht mehr unwiederbringlich.

**Nicht im Backup (bewusst):** `.env`/Secrets (getrennt verwahren), Supabase-DB
(eigene Backups), statische Medienbibliothek (siehe Scope).

## 8. Deploy + Rollback (PROD-P0-003 — 2026-09-17 real auf einer Hetzner-Instanz durchgespielt)

**Ziel:** Nachweis, dass `deploy.sh` gegen eine echte Instanz faehrt, der
Health-Check greift und ein BEWUSSTER Rollback die Vorversion zurueckbringt.
Der Punkt stand bis 2026-09-17 als BLOCKED im SSOT ("Hetzner-Token ungueltig") -
das war ueberholt: das Token ist gueltig (API-Antwort HTTP 200).

**Instanz:** `audiomonastry-drill` (cx23, 167.235.20.245, nbg1, Ubuntu 24.04,
Docker 29.1.3 + Compose 2.40.3, Firewall `audiomonastry-drill` oeffnet 22/80/443).
Ohne `DEPLOY_DOMAIN` bleibt `DOMAIN` leer, Compose setzt dann `:80`
(reiner HTTP-Test ohne ACME) - genau dafuer ist der Default da.

```bash
# Deploy (lokal bauen, Images per ssh uebertragen, remote starten)
DEPLOY_HOST=167.235.20.245 DEPLOY_SSH_KEY=$HOME/.ssh/id_ed25519 \
DEPLOY_MODE=docker DEPLOY_SYNC_ENV=1 DEPLOY_SMOKE=1 ./deploy.sh

# Rollout mit neuem Versionsstempel (ohne package.json anzufassen)
DEPLOY_HOST=167.235.20.245 DEPLOY_SSH_KEY=$HOME/.ssh/id_ed25519 \
DEPLOY_MODE=docker DEPLOY_SYNC_ENV=0 DEPLOY_SMOKE=1 \
DEPLOY_VERSION=1.210.002-drill ./deploy.sh

# Rollback (Befehl, den deploy.sh selbst ausgibt: das Skript taggt vor jedem
# Deploy das LAUFENDE Image als audiomonastry:hetzner-rollback)
ssh root@167.235.20.245 'docker tag audiomonastry:hetzner-rollback audiomonastry:hetzner \
  && cd /opt/audiomonastry \
  && docker compose -f docker-compose.hetzner.yml up -d --no-build --force-recreate audiomonastry'
```

**Nachweis (2026-09-17, gemessen):**

| Schritt | Ergebnis |
|---|---|
| Deploy v1 | `EXIT=0`, `docker compose ps`: `audiomonastry` + `audiomonastry-master` **healthy**, `audiomonastry-caddy` up |
| Health von aussen | `curl http://167.235.20.245/api/health` → `{"status":"ok","version":"1.210.001"}` |
| Smoke mit Studio-Token | `/api/health` 200, `/api/cloud/health` 200 (`supabase: ok (service_role)`), `/api/master/health` 200 (`master-player 2.0.0`) |
| Deploy v2 (`DEPLOY_VERSION=1.210.002-drill`) | `EXIT=0`, Health → `{"status":"ok","version":"1.210.002-drill"}` |
| Rollback (Befehl oben) | Container recreated + gestartet, Health → `{"status":"ok","version":"1.210.001"}`, App **healthy**, Image-SHA `sha256:41106b55e92f…` = exakt der v1-Build |
| Cost-Stop | Instanz nach dem Drill geloescht |

**Warum die Version im Health-Endpunkt steht:** Ohne sie ist ein Rollback von
aussen nicht unterscheidbar ("`{"status":"ok"}` bleibt `{"status":"ok"}`").
`deploy.sh` uebergibt die Version aus `package.json` als Build-Arg
(`DEPLOY_VERSION` ueberschreibt sie), das Dockerfile setzt
`AUDIOMONASTRY_VERSION`, `/api/health` nennt sie als `version` (`dev` ohne
Stempel). Das Argument steht im Dockerfile bewusst NACH den teuren Layern
(`COPY --chown` von dist/services/node_modules): stand es davor, baute ein
reiner Versionswechsel den kompletten Runtime-Stage neu.

**Operative Messwerte aus dem Drill (wichtig fuer die Planung):**

- Lokaler Image-Build: ~5 min warm (Builder-Stage gecacht), ~30 min kalt. Der
  fruehere `RUN chown -R node:node /app` brauchte allein >20 min (overlayfs
  kopierte jede der ~50k Dateien aus 305 MB node_modules); jetzt
  `COPY --chown=node:node` in einem Durchlauf.
- `docker save | ssh docker load` uebertraegt beide Images UNKOMPRIMIERT
  (~2,65 GB: app 1,43 GB + master-player 1,22 GB) und brauchte ~17 min je
  Deploy. Fuer haeufige Deploys ist eine Registry (GHCR) statt Image-Transfer
  der richtige Weg; `DEPLOY_REMOTE_BUILD=1` baut auf dem Ziel, spart den
  Transfer, braucht dort aber npm/mediasoup-Build.
- Deploy-Skript waehrend eines laufenden Deploys NICHT editieren: bash liest
  Skripte stueckweise - eine Aenderung mitten im Lauf brach den Drill mit
  `uild: Befehl nicht gefunden` ab (Lehre aus diesem Lauf).

## 9. Observability: Stack, SLOs, Alarmzustellung (PROD-P1-004 — 2026-09-18 lokal durchgespielt)

**Ziel:** Ein Dashboard zeigt Requests/Latenz/Fehler/Xruns und AI-Kosten; ein
kuenstlich erzeugter Fehler loest sichtbar einen Alarm aus.

**Zwei echte Defekte, die die Inbetriebnahme verhindert haetten** (beide live
gemessen und behoben):

1. `docker-compose.monitoring.yml` uebergab Prometheus `--config.expand-env`.
   Das Flag gibt es nicht → `unknown long flag` → Prometheus startete nie
   (Restart-Schleife). Zusaetzlich expandiert Prometheus Umgebungsvariablen in
   der Konfiguration grundsaetzlich nicht, `credentials: '${SCRAPE_TOKEN}'` waere
   also selbst mit funktionierendem Start das Literal geblieben (Scrape → 401).
   Fix: gueltige Flags und ein Entrypoint, der `__SCRAPE_TOKEN__` beim Start
   ersetzt (das Token steht damit nie im Image, die Datei bleibt secret-frei).
2. Die Alarmzustellung starb an der eigenen Auth: Alertmanager kann kein
   Studio-Cookie halten, `POST /api/alerts/webhook` antwortete
   `401 STUDIO_TOKEN_REQUIRED` – Alarme erreichten Discord/Slack/Telegram NIE.
   Fix: dediziertes `ALERT_WEBHOOK_TOKEN` (nur diese eine Route, Konstantzeit-
   Vergleich, ohne gesetztes Token weiter fail-closed). Zusaetzlich: ein
   App-Down-Alarm kann nicht ueber die App zugestellt werden (der Empfaenger ist
   genau das, was ausgefallen ist) → Route fuer `severity="critical"` direkt auf
   einen `CRITICAL_WEBHOOK`; ohne gesetztes CRITICAL_WEBHOOK bleibt der Fallback
   die App-Route (Verhalten wie vorher).
3. Zweiter Stolperstein: ein gefalteter YAML-Block mit tiefer eingerueckten
   Folgezeilen behaelt den Zeilenumbruch – der `sed`-Aufruf wurde dadurch in drei
   Shell-Befehle zerlegt (`-e: not found`, `...yml: Permission denied`).
   Entrypoint deshalb EINZEILIG halten.

**Lokaler Nachweis (die App lief auf dem Host, :8080):**

```bash
# 1) App mit Scrape-Token, Alert-Token und Webhook-Ziel
PORT=8080 STUDIO_ACCESS_TOKEN=... SCRAPE_TOKEN=... ALERT_WEBHOOK_TOKEN=... \
  DISCORD_WEBHOOK=http://127.0.0.1:9099/alerts npx tsx server.ts

# 2) Empfaenger (Messinstrument; im Betrieb nicht noetig)
node scripts/hetzner/alert-webhook-receiver.mjs --port 9099 --out /tmp/alerts.jsonl

# 3) Stack (das Overlay loest `audiomonastry` auf den Host auf und oeffnet die APIs)
SCRAPE_TOKEN=... ALERT_WEBHOOK_TOKEN=... CRITICAL_WEBHOOK=http://host.docker.internal:9099/alerts \
  docker compose -f docker-compose.monitoring.yml -f docker-compose.monitoring.proof.yml \
  up -d prometheus alertmanager grafana
```

**Ergebnis (gemessen):**

| Nachweis | Ergebnis |
|---|---|
| Scrape | `up{job="audiomonastry"}=1`, Target `healthy`; Serien `audiomonastry_http_requests_total`, `..._duration_seconds_bucket/_sum/_count` (neu), `..._ai_cost_usd`, `..._telemetry_xruns_total` |
| Regeln | 12 Regeln geladen, `health=ok`: 6 Einzelalarme + 3 SLO-Recordings + 3 SLO-/Xrun-Alarme (neu) |
| Dashboard | Grafana 11.2: Dashboard `audiomonastry-overview` provisioniert, **22 Panels** inkl. `SLO Verfuegbarkeit (24h)`, `SLO Verfuegbarkeit (1h)`, `Latenz p95 (30m)`, `AI-Kosten (USD, kumuliert)`, `AI-Kosten pro Stunde`, `Client-Xruns pro Sekunde (nach Quelle)`, `Xruns gesamt (10m-Zunahme)`, `SLO-Burn: Fehlerquote`; Panel-Ausdruecke liefern Daten |
| Alarm 1 (Fehlerrate) | 40×401 gegen 40×200 → Regel `AudiomonastryHighErrorRate` **firing** → zugestellt: `[FIRING] Hohe HTTP-Fehlerrate (audiomonastry:8080)` |
| Alarm 2 (neues SLO) | dieselbe Störung → `AudiomonastrySloAvailabilityBreach` **firing** → zugestellt: `[FIRING] Verfuegbarkeits-SLO verletzt (1 h < 99,5 %)` |
| Alarm 3 (App-Down, DIREKT) | App gestoppt → `up=0` → `AudiomonastryAppDown` **firing** → direkt zugestellt (Alertmanager-Payload, App war tot) |
| Xruns (neu) | 30 Telemetrie-Events `type=xrun` via `POST /api/telemetry` → `AudiomonastryClientXruns` **pending** → `firing` nach `for: 5m` |

**SLO-Definitionen (Recording-Rules in `prometheus-alerts.yml`):**

- `audiomonastry:slo_availability:ratio_24h` – Anteil erfolgreicher HTTP-Antworten,
  Ziel **99,5 % / 24 h**; Alarm `AudiomonastrySloAvailabilityBreach` ab 1-h-Verletzung.
- `audiomonastry:slo_latency_p95_seconds:30m` – p95 aus dem neuen Histogramm
  `audiomonastry_http_request_duration_seconds_bucket`, Ziel **< 250 ms**; Alarm
  `AudiomonastrySloLatencyBreach`. Vorher gab es nur einen Mittelwert-Gauge – der
  verdeckt genau den langen Schwanz, den ein Latenz-SLO messen soll.

**Noch offen (bewusst):** `fleetMaxEurPerHour`-Alarm feuert auf die kumulierte
Kostenserie (`increase(...[1h]) > 10`) – er ist konfiguriert, aber nicht
kuenstlich ausgeloest (Kosten lassen sich nicht serioes simulieren, ohne echte
Provider-Calls zu bezahlen). Node-/cadvisor-Alarme brauchen die beiden
Host-Exporter, die im lokalen Nachweis nicht gestartet wurden.

## 10. Upload-Resume/Chunking (FEAT-P3-003 — 2026-09-18 live durchgespielt)

**Ziel:** Uploads laufen in Chunks und setzen nach einem Abbruch an der
Abbruchstelle fort, statt von vorn zu beginnen.

**Routen** (alle unter der Studio-Auth; `/api/upload/sample` bleibt unveraendert
der Ein-Request-Weg):

```
POST /api/upload/chunk/init        {filename,size,chunkSize,contentType,fields,fingerprint}
PUT  /api/upload/chunk/:id/:index  (roher Chunk-Body)
GET  /api/upload/chunk/:id         -> receivedChunks/missingChunks/nextIndex
POST /api/upload/chunk/:id/complete
```

**Drei Eigenschaften, die den Unterschied machen:**

1. *Positioniertes Schreiben + Schreibstand in den Metadaten.* Ein Chunk wird an
   seinen Offset geschrieben (idempotent, auch out-of-order). Der Schreibstand
   liegt in `<id>.json` - bewusst NICHT aus der Dateigroesse abgeleitet: die
   Datei waechst spaerlich, und eine erste Fassung, die sie vorab auf Zielgroesse
   stutzte, zaehlte deshalb alle Chunks als vorhanden (der Test hat es
   aufgedeckt).
2. *Sitzung auf Platte.* Damit ueberlebt die Wiederaufnahme auch einen
   Serverneustart/Deploy - haelt man es nur im Speicher, ist nach jedem Deploy
   alles weg. `sweep()` verwirft nie fortgesetzte Uploads nach 24 h
   (`DEFAULT_UPLOAD_TTL_MS`), sonst waechst die Platte zu.
3. *Eigener Limiter.* Die Kostenbremse fuer `/api/upload` steht bei 10
   Requests/Minute; ein Chunk-Upload ist zwangslaeufig eine Serie und lief live
   nach 20 Chunks in 429. Chunks laufen deshalb unter
   `UPLOAD_CHUNK_RATE_LIMIT_MAX` (Default 240/min), der Scan-/Ablage-Schritt
   weiterhin unter der Kostenbremse.

**Live-Nachweis (5 292 078 Bytes WAV, 21 Chunks à 256 kB):**

| Schritt | Ergebnis |
|---|---|
| init | `resumed:false`, 21 fehlende Chunks |
| Chunk 0 + 2 senden, dann **Serverprozess beendet** | `receivedChunks:[0,2]`, `nextIndex:1` |
| init nach dem Neustart (gleicher Fingerabdruck) | `resumed:true`, **gleiche uploadId**, `receivedChunks:[0,2]`, `nextIndex:1` |
| nur die fehlenden Chunks (1, 3–20) | `complete:true`, `receivedBytes: 5292078` |
| sha256 der zusammengesetzten Datei vs. Original | `337dafc0…67ae` = **byte-identisch** |
| complete | lief durch die GEMEINSAME Pipeline (Scan/R2/Supabase); R2 scheitert am bekannten Legacy-Token-Signaturfehler, `chunked.sha256` belegt die Zusammensetzung |

**Tests:** `tests/chunkedUpload.test.ts` (12: Chunk-Arithmetik, halb
geschriebener Chunk zaehlt nicht, Idempotenz, Resume nach "Neustart", TTL,
Metadaten-Robustheit), `tests/uploadChunkRoutes.test.ts` (6: Abnahme ueber die
echten Routen inkl. byte-identischer Assemblierung, unvollstaendig -> 409,
gemischte Validierung mit dem Multipart-Weg, Limiter-Trennung),
`tests/chunkedUploadClient.test.ts` (7: nur fehlende Chunks senden, 429-Backoff,
4xx ohne Retry, Abbruchsignal).

## 11. aiMONK-Agent-Lauf (AI-P1-006 — planen → ausführen → prüfen)

**Routen** (unter der Studio-Auth; Start/Fortsetzen sind teuer, Statusabfragen nicht):

```
POST /api/ai/agent/runs              {task, maxCorrections?, allowWrite?, context?}  -> 202 {run}
GET  /api/ai/agent/runs              -> letzte 20 Läufe (Status, Schritte, Kosten)
GET  /api/ai/agent/runs/:runId       -> Zustand eines Laufs
POST /api/ai/agent/runs/:runId/cancel
POST /api/ai/agent/runs/:runId/resume
```

Der Loop selbst ist `MoaAgent.run()` (planen → WRITE-Gate → ausführen → prüfen →
korrigieren, seit AI-P1-003 P5 im Einsatz). Darum herum liegt
`ResumableAgentRunner`:

- **Lauf auf Platte** (`AI_AGENT_RUN_DIR`, Default `<tmp>/audiomonastry-agent-runs`):
  jeder Schritt wird weggeschrieben. Damit überlebt ein Abbruch einen
  Neustart/Deploy — im Speicher wäre „Wiederaufnahme" nur solange wahr, wie der
  Prozess lebt.
- **Abbruch** ist kooperativ: die Marke wird vor jedem Schritt geprüft, es läuft
  kein halber Schritt weiter. `cancel` wartet den Stopp ab und liefert den
  **wirklich** abgebrochenen Zustand (sonst sähe der Aufrufer noch „running").
- **Wiederaufnahme** benutzt den **Originalplan** und führt nur die offenen
  Schritte aus — kein zweiter Vollauf, keine doppelten Planungskosten. Wurde der
  Lauf während der Planung abgebrochen (noch kein Plan), plant er neu: es ist ja
  nichts ausgeführt worden.
- **Kosten**: `cost.totalUsd` mit `planningUsd`/`correctionsUsd` und `estimated:true`.
  Planung/Korrektur sind LLM-Aufrufe, die Ausführung sind lokale Kommandos und
  kostet nichts. Die Schätzung rechnet über die Zeichenzahl (`AI_AGENT_COST_PER_1K_USD`);
  der Router liefert keinen Preis. **Kein hartes Budget-Limit pro Lauf** — die
  Grenze zieht die Kostenbremse (`AI_RATE.expensiveMax`) und der Alarm
  `AudiomonastryAiCostBudget` (siehe §9).
- **Schreibzugriffe sind opt-in**: ohne `allowWrite:true` lehnt das WRITE-Gate
  jeden Schreib-Schritt ab (fail-safe, unbekannte Kommandos gelten als WRITE).
  Die UI startet ohne Freigabe, also nur lesende Schritte.

**Zwei live gefundene Betriebsfehler (2026-09-18, beide behoben):**

1. *Statusabfrage lag hinter der Kostenbremse.* Die Agent-Routen liegen unter
   `/api/ai` (10 Requests/Minute). Die UI fragt einen laufenden Lauf aber
   regelmäßig ab — nach wenigen Polls kam `429`. Statusabfragen sind jetzt von
   der Kostenbremse ausgenommen und haben ein eigenes Budget
   (`AI_AGENT_RATE_LIMIT_MAX`, Default 240/min); das **Starten/Fortsetzen**
   bleibt unter der Kostenbremse.
2. *Stiller Leer-Erfolg.* Antwortete das Modell nur mit Denktext statt JSON,
   war der Plan leer — der Lauf meldete trotzdem `succeeded: true` bei null
   Schritten. Jetzt gilt ein leerer Plan als Fehlschlag, löst die
   Korrekturrunde aus („antworte NUR mit dem JSON-Array"), und ein Lauf ohne
   ausgeführten Schritt ist nie erfolgreich.

**Weiteres live gefundenes Problem (offen, separat erfasst):** der LLM-Weg ist
zurzeit nicht benutzbar: der lokale Brain-Provider (Worker) lehnt das Payload ab
(`Job input must contain one of: openai_input (+openai_route), route (+body), or
prompt/messages.`), und der externe Provider (`AI_ALLOW_EXTERNAL_LLM=true`,
DeepSeek) antwortet nicht (Zeitlimit greift). Deshalb zeigt der Agent-Lauf live
`failed` mit `Zeitlimit überschritten` bzw. den Worker-Fehler — **die Mechanik ist
davon unabhängig** und durch die Tests abgedeckt. Neu: `AI_AGENT_PLAN_TIMEOUT_MS`
(Default 45 s) verhindert, dass ein hängender Aufruf den Lauf endlos „running"
stehen lässt.

**UI:** `src/components/AgentRunPanel.tsx`, eingebunden in `MoaAssistant` (jedes
Plugin-Terminal mit MOA-Zeile): Auftrag starten, Status/Phase, Schritte mit
Haken/Fehler, Kostensumme sowie **Abbrechen**/**Fortsetzen**. Der Panel lädt beim
Öffnen den letzten Lauf (der Lauf liegt serverseitig).

### 11b. LLM-Weg: drei Defekte und die Kaltstart-Falle (AI-P1-008, 2026-09-18)

Der Agent-Lauf plant über den lokalen Brain. Drei Defekte in
`src/core/ai/LlmRouter.ts` hatten den ganzen LLM-Weg lahmgelegt — jeder einzelne
hätte gereicht, und alle drei waren unsichtbar (die Aufrufer fielen still auf
lokale Ersatzpfade zurück, z. B. der Drop-Generator):

1. **Asymmetrischer Env-Zugriff (Hauptursache).** `available` prüfte
   `RP_BRAIN_OPENAI_URL` **und** `RUNPOD_BRAIN_OPENAI_URL`; `modelFor()` und
   `complete()` lasen nur `RUNPOD_…`. In `.env` steht nur die `RP_`-Form → der
   Provider galt als verfügbar, der Aufruf ging aber in den **nativen
   Worker-Pfad** (`task:'llm'` mit `{prompt,maxTokens,…}`), und worker-vllm
   lehnt das ab:
   `Job input must contain one of: openai_input (+openai_route), route (+body), or prompt/messages.`
   → **Fix:** eine Stelle `openAiUrl()`, von `available`/`modelFor`/`complete`
   gemeinsam benutzt.
2. **Falscher Modellname.** Der vLLM-Endpoint adressiert sein Modell über den
   HuggingFace-Namen. Der Router schickte `qwen3-14b`, der Endpoint bietet
   `Qwen/Qwen3-14B-AWQ` (`GET <url>/models`; Worker-Log:
   ``The model `qwen3-14b` does not exist.`` NotFoundError 404).
   → **Fix:** eigener Default `OPENAI_COMPAT_BRAIN_MODEL_DEFAULT='Qwen/Qwen3-14B-AWQ'`
   plus `RUNPOD_BRAIN_OPENAI_MODEL`/`RP_BRAIN_OPENAI_MODEL`; der interne Kurzname
   gilt nur noch für den nativen Worker-Weg.
3. **Unbrauchbare Fehlermeldung.** `extractText` warf nur `HTTP 500` und verwarf
   den Fehlerkörper; `JSON.stringify(new Error(...))` liefert `{}` — der Grund des
   Endpoints war nicht ermittelbar. → **Fix:** Fehlerkörper (300 Zeichen) in die
   Meldung, Fehlerabbildung berücksichtigt `.message`, und bei Modell-Ablehnung
   nennt die Meldung Modell, Stellschraube und Modell-Listen-URL.

**Nebenbei geklärt (kein Defekt, sondern Aufbau):** Die Plugin-Kommandos
(`transport`, `mixer`, …) werden **client-seitig** registriert
(`src/main.tsx` → `src/core/voice/pluginCommandRegistry.ts`). Ein serverseitiger
Agent-Lauf plant und prüft daher, kann Plugin-Kommandos aber nicht ausführen und
meldet ehrlich `Kein Plugin-Kommando`. Server-ausführbar sind die Werkzeuge der
MCP-Runtime (`session.getState`, `runtime.status`, `sample.search`, `fleet.status`).

**Kaltstart (Betreiber):** Der Brain-Endpoint läuft mit `workersMin=0` und
`idleTimeout=15 s`. Nach Idle kostet der erste Aufruf **~2–3 min** (vLLM-Init
133 s + CUDA-Graphs ~50 s, im Worker-Log gemessen). `AI_AGENT_PLAN_TIMEOUT_MS`
muss dazu passen (z. B. 240000), sonst endet der Lauf korrekt, aber ohne Ergebnis:
`Zeitlimit ueberschritten`. Messung mit korrektem Modellnamen gegen den warmen
Endpoint: **HTTP 200 in ~1 s**.

## 12. Cloud-Speicher R2: Signaturfehler diagnostizieren und Credentials setzen (F2 — 2026-09-20)

**Befund (externer App-Test 2026-09-20):** `/api/cloud/health` meldete
`r2: error: The request signature we calculated does not match the signature you
provided`; `/api/session/autosave` scheiterte (20× im Log); `POST /api/upload/sample`
endete in HTTP 500 exakt mit diesem Fehler.

**Zwei Ursachen (beide im Code adressiert, der Wert bleibt Betreiber-Sache):**

1. **Zwei Schreibweisen für dasselbe Paar, ohne Abgleich.** Der Server kannte nur
   `CFS3_ACCESS_KEY`/`CFS3_SECRET_KEY` (bzw. `CFR2_*` als Legacy-Fallback). Auf
   app-1 lagen die Werte unter `CFS3_ACCESS_KEY_ID`/`CFS3_SECRET_ACCESS_KEY` –
   diese Namen wurden **still ignoriert**, der Aufruf fiel auf das (falsche)
   `CFR2_*`-Paar aus der Rollen-`.env` zurück. Jetzt lesen Server und
   Portal-Worker dieselbe Alias-Liste; der Portal-Worker schreibt EINE Herkunft
   unter den kanonischen Namen **plus** Legacy-Spiegel mit identischem Wert
   (`services/portal-worker/src/index.js` → `r2EnvLines`), und der Server nennt
   die benutzte Quelle in der Health-Antwort.
2. **Der Fehler war nur im Log sichtbar.** R2 wird jetzt mit einem **echten
   Probeobjekt** geprüft (PUT + DELETE unter `probes/r2-health-<stamp>.json`, mit
   Timeout), der Zustand steht als `cloud.r2` in `/api/metrics`, und der Autosave
   wiederholt begrenzt mit Backoff und meldet `degraded` + `reason` statt still
   zu scheitern.

### Betreiber-Schritte

```bash
# 1. R2-API-Token im Cloudflare-Konto prüfen/neu erzeugen
#    (R2 → Manage R2 API Tokens → Object Read & Write für den Bucket)
#    und im Portal-Secret setzen (canonical ODER legacy, beides wird gelesen):
#      CFS3_ACCESS_KEY / CFS3_SECRET_KEY / CFS3_BUCKET / CFR2_ACCOUNT_ID
#    ACHTUNG: liegen beide Familien mit VERSCHIEDENEN Werten vor, ist genau das
#    die Ursache – der Server meldet die Abweichung laut (siehe unten).

# 2. Diagnose IM Repo (kein Portal, kein Container nötig). Exit 0 = beschreibbar.
npm run r2:check
#   bzw. direkt:
npx tsx scripts/cloud/r2-health-check.ts
npx tsx scripts/cloud/r2-health-check.ts --json        # maschinenlesbar
npx tsx scripts/cloud/r2-health-check.ts --timeout=8000

# 3. Rollen-`.env` neu erzeugen (Portal-Wake) oder die Werte auf dem Knoten setzen
#    /opt/audiomonastry/.env – EIN Paar pro Variable, keine Mischung beider Familien.

# 4. Auf dem laufenden Knoten nachmessen (force = TTL-Cache aus, echte Probe):
curl -s -H "x-studio-token: $STUDIO_ACCESS_TOKEN" "https://<domain>/api/cloud/health?probe=1"
curl -s -H "x-studio-token: $STUDIO_ACCESS_TOKEN" "https://<domain>/api/metrics" | grep -o '"cloud":{.*}' 
```

**Erwartete Ausgabe des Diagnose-Skripts** (real gemessen 2026-09-20 gegen einen
lokalen Stub, damit keine echten Credentials in die Ausgabe gerieten):

```
# Fall A – gültige Probe:
audioMONASTRY R2-Healthcheck (FIX F2)
  Quelle:        CFS3_ACCESS_KEY + CFS3_SECRET_KEY + CFS3_ENDPOINT + CFS3_BUCKET
  Bucket:        audiomonastrysamples
  Endpoint:      127.0.0.1:4599
  Probe:         ok (PUT+DELETE, 70 ms)
  Probeobjekt:   probes/r2-health-mua4f00f-est35kng.json (nach dem Test gelöscht)
  Ergebnis:      ok – R2 ist beschreibbar.
EXIT=0

# Fall B – Signaturfehler + widersprüchliche Quelle:
  Quelle:        CFS3_ACCESS_KEY + CFS3_SECRET_KEY + CFS3_ENDPOINT + CFS3_BUCKET
  Probe:         FEHLER [signature-mismatch] (PUT+DELETE, 64 ms)
  Meldung:       The request signature we calculated does not match the signature you provided.
  Unbenutzt:     CFR2_ACCESS_KEY_ID (anderer Wert als die benutzte Quelle)
  ABWEICHUNG:    Mehrere R2-Quellen widersprechen sich – accessKeyId: benutzt CFS3_ACCESS_KEY
                 [CFS3_ACCESS_KEY(len=32, fp=3ba3f5f4) vs CFR2_ACCESS_KEY_ID(len=32, fp=cd93782b)].
  Betreiber:     Access Key und Secret passen nicht zum Bucket/Endpoint. R2-API-Token-Paar im
                 Portal-Secret UND in der Knoten-`.env` auf dasselbe Paar setzen.
EXIT=1

# Fall C – keine Credentials (--json): problem "not-configured",
#          state unconfigured in /api/cloud/health, kein Schreibversuch.
EXIT=1
```

**Erwartete Felder nach der Korrektur:**

| Ort | Erwartet |
|---|---|
| `GET /api/cloud/health?probe=1` | `r2.state: "ok"`, `r2.status: "ok"`, `r2.probe.method: "PUT+DELETE"`, `r2.credentials.deviationCount: 0` |
| `GET /api/metrics` (JSON) | `cloud.r2.state`/`cloud.r2.problem`/`cloud.writes.autosave`, `audiomonastry_cloud_r2_ok 1` im Prometheus-Zweig |
| `POST /api/session/autosave` | 200 `{ok:true}`; bei Fehlschlag `degraded:true`, `reason` (z. B. `signature-mismatch`), `attempts` – und **eine** Log-Zeile je Fehlerklasse |
| Log auf app-1 | keine wiederholte `SignatureDoesNotMatch`-Flut (Wiederholungen werden gezählt, nicht geloggt) |

**Ohne R2-Credentials** bleibt der Zustand ausdrücklich `unconfigured`
(`status: "not-configured"`) – **nicht** `ok`. Die App arbeitet lokal weiter
(OPFS/Presets); der Ladebildschirm zeigt den Grund im Text.

### Was nur der Betreiber live belegen kann

Die Signaturprüfung selbst kann offline nicht nachgestellt werden (der Stub
antwortet mit derselben XML wie R2, prüft aber nicht kryptografisch). Der
Live-Nachweis der F2-Verifikation ist deshalb: `npm run r2:check` → `EXIT=0`
auf app-1, `/api/cloud/health?probe=1` → `r2: ok`, Autosave 200 und ein
3-s-WAV-Upload mit Objekt-Key in `audiomonastrysamples`.

## TURN-Relay und ICE-Wiederherstellung beweisen (COLLAB-P0-003)

Der TURN-Pfad war lange „verdrahtet, aber nicht nachgewiesen" (in der
Entwicklungs-/CI-Umgebung gab es keinen TURN-Server). Er ist lokal mit einem echten
coturn **messbar** — genau das schließt die Lücke:

```bash
# 1) coturn starten (Beweis-Konfiguration, Loopback-Peers erlaubt)
docker run -d --name am-coturn --network host \
  -v "$PWD/services/turn/turnserver.local-proof.conf:/etc/coturn/turnserver.conf:ro" \
  coturn/coturn:latest -c /etc/coturn/turnserver.conf

# 2) App mit denselben Werten starten (Secret identisch zur coturn-Konfiguration)
PORT=8080 STUDIO_ACCESS_TOKEN=... \
TURN_URLS=turn:127.0.0.1:3478 TURN_STATIC_AUTH_SECRET=turnproofsecret123 \
npx tsx server.ts

# 3) Relay-Beweis: relay-only-Verbindung + Gegenprobe mit manipuliertem Credential
APP_URL=http://127.0.0.1:8080 STUDIO_TOKEN=... npm run proof:turn

# 4) Ausfall-Beweis: coturn WAEHREND der Verbindung stoppen, ICE-Restart, Erholung
APP_URL=http://127.0.0.1:8080 STUDIO_TOKEN=... npm run proof:ice-recovery
```

Was die beiden Läufe messen (Stand 2026-09-18, gemessen):

| Prüfung | Ergebnis |
|---|---|
| `/api/webrtc-config` liefert kurzlebige TURN-Credentials | 200, `username=<expiry>:…`, Credential gesetzt |
| Relay-only-Verbindung über coturn | **verbunden**, ausgewählter Kandidatenpfad `relay`/`relay` (udp) |
| Gegenprobe mit manipuliertem Credential | **keine** Relay-Kandidaten → Verbindung scheitert (Rechteprüfung wirkt) |
| Echter ICE-Ausfall (coturn gestoppt) | nach ~10 s `disconnected`, nach ~20 s `failed` |
| Zustandsmaschine (`src/core/transport/connectionRecovery.ts`) | `restart-ice` (first-failure) → `reconnect` (attempt-2) |
| Erholung nach Rückkehr des Relays | verbunden nach ~2,2 s (2 ICE-Restarts, selbsttätig) |

**Befund aus mehreren Läufen (ehrlich, weil gemessen):** Die Erholung gelingt, wenn
der Relay innerhalb des Versuchsfensters zurückkommt — in zwei von drei Läufen
verbunden nach 18,4 s bzw. 22,2 s. In einem Lauf blieb der Relay länger weg und die
Zustandsmaschine lief in `gave-up (max-attempts)` (Standard: 3 Versuche, Decke 15 s;
mit der Mess-Policy 8/12 Versuche wurden 8 Versuche verbraucht, Abstände ~15 s aus
der ICE-Ausfallerkennung). Danach versucht sie **nichts** mehr — das ist so gewollt
(nicht endlos gegen einen toten Relay hämmern), hat aber eine Folge für den Betrieb:

* **Nur ein Relay + Ausfall länger als ~1 min ⇒ Client neu laden.** Für Produktion
  deshalb entweder **zwei TURN-Knoten** in `TURN_URLS` (Client probiert beide) oder
  ein höheres Versuchsbudget; im Runbook-Abschnitt „Ausfall" steht der Reload als
  Eskalation.

Der Beweis misst bewusst **auch diesen Fall** — eine Zustandsmaschine, die nur im
Glücksfall erholt, wäre als Nachweis wertlos.

**Wichtig:** `services/turn/turnserver.local-proof.conf` erlaubt Loopback-Peers —
die Produktionsvorlage (`services/turn/turnserver.conf`) verbietet sie bewusst
(Relay-Sonde in interne Netze). Der Beweis misst daher **das Credential-Verfahren
und die Wiederherstellung**, nicht die Peer-Härtung der Produktionskonfiguration.

### F6 (2026-09-20): coturn läuft als Service — was offline belegt ist

Seit F6 ist der Relay **kein Handbetrieb** mehr, sondern ein Compose-Service auf
dem SFU-Knoten (`docker-compose.turn.yml`) mit Provisioning über
`scripts/hetzner/wire-rtc.sh` (Verdrahtung) bzw. `services/turn/deploy-turn.sh`
(apt-/Systemd-Variante auf einem eigenen Knoten). Die Strecke
`/api/webrtc-config` → kurzlebige Credentials → coturn wurde lokal gemessen:

```bash
# coturn als Service starten (Konfiguration erzeugt wire-rtc.sh aus der Vorlage)
docker run -d --name am-coturn --network host \
  -v "$PWD/services/turn/turnserver.local-proof.conf:/etc/coturn/turnserver.conf:ro" \
  coturn/coturn:4.18.0 -c /etc/coturn/turnserver.conf

# Credentials aus UNSEREM Servercode holen (derselbe Pfad wie /api/webrtc-config)
npm run dev   # bzw. PORT=8080 TURN_URLS=turn:127.0.0.1:3478 TURN_STATIC_AUTH_SECRET=turnproofsecret123 npx tsx server.ts
curl -s localhost:8080/api/webrtc-config -H "x-studio-token: <token>"
```

| Prüfung (2026-09-20, gemessen) | Ergebnis |
|---|---|
| Production-Konfiguration in `coturn/coturn:4.18.0` als Service | läuft, `Relay address to use`, `Default realm`, `Relay ports initialization done` |
| Listener + Healthcheck | `udp`/`tcp` auf 3478 offen, `turnutils_stunclient 127.0.0.1` → exit 0 |
| Allokation mit den Credentials aus `buildWebRtcConfigResponse` | **12/12 Nachrichten über den Relay**, exit 0 |
| Falsches Credential | `ERROR Cannot complete Allocation` (exit 255) |
| Abgelaufener Zeitstempel | `ERROR Cannot complete Allocation` (exit 255) |

Bekannte Kanten (live gefunden, im Overlay dokumentiert): `cap_drop: [ALL]` lässt
coturn **nicht** starten (`/usr/bin/turnserver: Operation not permitted`), und
`--log-file=stdout` auf der Kommandozeile verliert gegen `log-file=` aus der
Konfigurationsdatei — beides steht als Kommentar dort, wo es auffällt.

**Offen (nicht offline belegbar):** zwei echte Browser außerhalb des LANs
(Relay-Pfad inkl. Zertifikatskette für `https://sfu.<domain>`).

## MJPEG-Fallback für den Beamer beweisen (VISUAL-P1-001)

Der Visual-Stream läuft normal über WebRTC/SFU (Ghostuser 6, `/visual-out`). Für
den Beamer gibt es zusätzlich den Fallback ohne SFU: ein `<img>` auf einen echten
MJPEG-Strom. Beweis (startet den Server selbst; der Port muss frei sein):

```bash
npm run proof:mjpeg            # rot -> grün -> blau am "Beamer", inkl. Zuschauer-Zählung
PROOF_PORT=8098 npm run proof:mjpeg
```

| Prüfung | Ergebnis (gemessen 2026-09-18) |
|---|---|
| `POST /api/visual/frame` mit echtem JPEG (ffmpeg) | 200 `{ok:true, bytes:584}` |
| Beamer-`<img>` auf `/api/visual/mjpeg?token=…` | Bild dekodiert, Status meldet `viewers:1` |
| Wechselt das Bild? (Screenshot-Pixel je Frame) | rot `254,0,0` → grün `0,129,2` → blau `1,0,254` |
| Grenzen (Größe/Frequenz/Typ) | `413`/`202 too-fast`/`415` mit Grund, kein stiller Erfolg |
| Ohne Zuschauer | Studio enkodiert **nichts** (`viewers:0`) |

**Betriebshinweise:** Der Token geht bei `<img>` als `?token=` in die URL — das ist
eine bewusste, auf genau diese Route begrenzte Ausnahme (ein `<img>` kann keine
Header setzen); der Vergleich läuft weiter über `safeTokenEqual`. Bei mehreren
App-Knoten liefert der Knoten, der die Frames bekommt: die Beamer-URL muss auf
denselben Knoten zeigen wie die Studio-Session (der Frame-Hub ist pro Prozess).
Ein Stream, der nach 15 s endet und dann stehen bleibt, war der erste-Frame-Timeout
— er wird jetzt mit dem ersten Frame beendet (im Browser-Beweis aufgefallen).

**Was noch offen bleibt (Betreiber, nicht Repo):** der Live-Beweis Ghostuser 5/6
gegen die echte Flotte (Studio → PA + Beamer) mit zwei Geräten und frischer
Session; siehe `VISUAL-P1-001` im Mastertodo.

## Sprach-Kette: Text-Normalisierung vor der Synthese (VOICE-P1-001)

Alle Sprachwege (Flotten-Runtime mit Qwen3-TTS, HF-Fallback, lokales RVC/VITS-CLI,
Web-Speech im Browser) bekommen denselben, vorbereiteten Text. Die Normalisierung
liegt in `src/core/audio/speechNormalization.ts` und läuft in beiden Servern:

| Route | Weg | Normalisierung |
|---|---|---|
| `POST /api/voice/tts` | Flotte (`VOICE_AI_RUNTIME_URL` → `/infer`, Qwen3-TTS) bzw. HF | ja — `text` im `/infer`-Auftrag ist normalisiert |
| `POST /api/voice/sing` | Flotte | ja |
| `POST /api/generate-voice` | lokales CLI bzw. Web-Speech | ja — Antwort enthält zusätzlich `speechText` |

Beispiele (gemessen über `tests/voiceNormalizationRoutes.test.ts`, das einen
`/infer`-Stub mitschreiben lässt):

| Eingabe | was gesprochen wird |
|---|---|
| `17.09.2026` | siebzehnte September zweitausendsechsundzwanzig |
| `14:30` | vierzehn Uhr dreißig |
| `19,99 €` | neunzehn Komma neun neun Euro |
| `12 %` | zwölf Prozent |
| `3,5 kg` / `44,1 kHz` / `120 km/h` | drei Komma fünf Kilogramm / … Kilohertz / … Kilometer pro Stunde |
| `z.B.` / `max.` / `Nr. 7` | zum Beispiel / maximal / Nummer sieben |
| `MP3`, `AI` | M P drei, A I |
| **unverändert:** `Port 8080`, `Version 1.210.001`, `@#1` | technische Angaben werden NICHT als Zahlwort vorgelesen |

Betrieb: der gesprochene Text steht bei `/api/voice/tts` im Antwort-Header
`X-Voice-Speech-Text` (URI-kodiert, gekürzt) — damit ist ohne Zusatzwerkzeug
nachvollziehbar, was das Modell zu lesen bekam. Die Runtime selbst bringt den
Qwen3-TTS-Handler mit (`services/audiomonastry-ai-runtime/handlers.py`,
inkl. Sprach-Aliassen); sie braucht das Paket `qwen-tts` im Image — das ist der
Punkt „nächster Image-Build“ aus `VOICE-P1-001`.

## Vor jedem E2E-Lauf: Ports prüfen (Fund 2026-09-18)

Vite nutzt einen **festen HMR-Port** (`24678`). Läuft noch ein Dev-Server aus einem
früheren Lauf (z. B. aus einem abgebrochenen Beweis-Skript), bindet Playwrights
`webServer` ihn nicht, der HMR-WebSocket scheitert — und die Smoke-Tests fallen mit
`"WebSocket closed without opened"` um, obwohl kein Codefehler vorliegt.

```bash
ss -ltnp | grep -E ':24678|:8080'   # muss leer sein
pkill -f "[t]sx server.ts"          # Klammer-Trick: killt nicht die eigene Shell
```

Die Beweis-Skripte (`proof:turn`, `proof:ice-recovery`, `proof:mjpeg`) starten ihre
Server `detached` und beenden die **Prozessgruppe**; `proof:mjpeg` bricht zusätzlich
ab, wenn sein Port belegt ist — damit wird kein fremder/alter Server gemessen.

## WebGPU-Pfad prüfen und beweisen (VISUAL-P1-009)

Der dritte Renderpfad (WebGPU/WGSL) ist gebaut und live bewiesen. Zwei Fallen sind
dabei aufgefallen und stehen hier fest, damit sie nicht wiederkehren:

1. **`about:blank` ist kein sicherer Kontext.** Dort fehlen `navigator.gpu` *und*
   `audioWorklet` — eine API-Sonde auf `about:blank` meldet „WebGPU nicht
   vorhanden", obwohl es vorhanden ist. Deshalb: immer auf einem lokalen Origin
   (`http://127.0.0.1:PORT`) messen.
2. **Headless braucht die Entwicklungs-Flags.** Ohne Flags liefert
   `requestAdapter()` keinen Adapter (SwiftShader nicht freigeschaltet):
   `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan
   --use-vulkan=swiftshader --disable-vulkan-surface`. Auf echter GPU-Hardware
   ist das nicht nötig.

```bash
npm run probe:apis     # Verfügbarkeit in 4 Startkonfigurationen + Chromium-Version
npm run proof:webgpu   # echter Frame + GPU-Rücklesung: zeichnet der Pfad wirkt?
```

Gemessen (2026-09-18, Chromium 151.0.7922.34): mit den Flags `adapter-vorhanden`,
der Pfad zeichnet ~55 000 nicht-schwarze Pixel je Frame (mittlere Helligkeit ~134),
drei Presets ergeben unterschiedliche Bilder, eine Show-Szene wird als
`sceneIgnored` gemeldet.

## Live-Beweise gegen die Flotte (2026-09-18, gemessen)

### Ablauf, der funktioniert

1. **Wecken** (Portal): `POST /api/login` (ADMIN_USER/ADMIN_PASSWORD aus `.env.deploy`)
   → Cookie `portal=…` **und** `studio=…`; dann `POST /api/wake`.
   Messskript: `python3 scripts/fleet-wake-measure.py`, Verdrahtung: `python3 scripts/fleet-wire.py`.
2. **Auf den Knoten bringen**: `bash scripts/hetzner/fleet-deploy-live.sh <app-ip> 8080`
   (rsync des Repo-Stands ohne Knoten-`.env`, Image per `docker save | gzip | ssh docker load`,
   plus Test-Overlay, das den App-Port **nur an Loopback** veröffentlicht).
3. **Tunnel**: `ssh -N -L 8080:127.0.0.1:8080 root@<app-ip>` (Hintergrundprozess).
4. **Messen** (siehe unten) — **Achtung**: gegen `http://localhost:8080` fahren, nicht
   gegen `127.0.0.1`.

### Falle 0 (die teuerste): die Ziel-Instanz verifizieren

Ein **lokaler** Produktions-Build (`node dist/server.cjs`) antwortet auf `/api/health`
genauso wie der Knoten — nur mit `"version":"dev"`. Läuft lokal noch ein Server auf
8080, scheitert der SSH-Tunnel still (`Address already in use`) und die E2E-Suite
misst die falsche Maschine: ein "Live-Beweis" gegen den lokalen Build ist keiner.
Vor jedem Live-Lauf:

```bash
ss -ltnp | grep ':8080'                 # muss den ssh-Tunnel zeigen, nicht node/tsx
curl -s http://localhost:8080/api/health # MUSS die Knoten-Version melden (z. B. 1.210.001)
```

### Vier Fallen, die je einen halben Tag kosten können

| Falle | Wirkung | Regel |
|---|---|---|
| `http://127.0.0.1:8080` als Browser-URL | `src/config/runtime.ts` behandelt `127.0.0.1` wie einen Entwicklungsrechner und setzt die Signalisierungs-URL auf den **absoluten** Dev-Default `http://localhost:8080` → anderer Origin → das Studio-Cookie wird nicht mitgesendet → `Signaling connection failed: unauthorized`, der Session-Zähler bleibt bei `1/4` | Immer **`http://localhost:8080`** verwenden |
| `/api/session/reset` gegen eine Produktions-Instanz | HTTP 404 (dev-only) | Der E2E-Helfer toleriert 404 bei gesetztem `E2E_BASE_URL`; für einen frischen Serverzustand den **Container neu starten** |
| Kein Reset-Hook + 7 Tests hintereinander | nach 4 belegten Plätzen öffnet der nächste Browser kein Studio mehr (`SESSION VOLL`) | Live-Beweise **pro Test** mit frischem Container fahren |
| `POST /api/visual/frame` mit `image/png` | HTTP 415 `unsupported-type` | Der Route-Vertrag erlaubt `image/jpeg`, `image/webp`, `application/octet-stream` |

### Wake→ready: Ziel < 90 s wird NICHT erreicht — vier Ursachen (gemessen)

| # | Befund | Beleg |
|---|---|---|
| 1 | **Snapshots werden nie benutzt** → jeder Wake ist ein Kaltstart (cloud-init + Docker-Build) | `POST /api/wake` → `fallbackRoles: ["app","sfu","ai","master","edge"]`, `usedSnapshots: {}`, obwohl 5 Rollen-Snapshots `available` sind. Ursache: `snapshotRoleOf()` las nur `labels.role`; die Portal-Snapshots haben **leere Labels** und nur eine Beschreibung (`samplemonk-snapshot-app-2026-09-18[-live]`). **Behoben** in `services/portal-worker/src/index.js` + Test |
| 2 | **Wake verdrahtet die Domain nicht** | `/api/status` bleibt dauerhaft `starting-app` mit `healthError: HTTP 522`; `origin.anunnakitools.de` zeigt nicht auf die neue app-IP. `wire-fleet` hilft nur, wenn der Worker-Token DNS darf (siehe 3) |
| 3 | **Cloudflare-Token im Worker ist tot** — seit 2026-09-18 **sichtbar**: `startFleet` gibt `wiring` zurueck (`dns.ok=false` + Meldung), der Ladebildschirm warnt. Vorher verschluckte ein `console.warn` den Fehlschlag, der Betreiber sah nur `starting-app`/522 | `POST /api/wire-fleet` → `{"dns":{"ok":false,"message":"Cloudflare-Zone nicht gefunden"}}` (der Worker bekommt bei `/zones` eine leere Antwort). Der neu bereitgestellte Token darf Workers/KV/Zonen **lesen**, aber **kein DNS** (`/zones/<id>/dns_records` → *Authentication error*) |
| 4 | **Idle-Shutdown schläft den Knoten vor der Erreichbarkeit** | app-1 war nach ~35 min `off` (Timer „idle=30 min"), obwohl die Domain nie erreichbar wurde. Für Beweissessions: `systemctl stop audiomonastry-idle-shutdown.timer` |

Zusätzlich nützlich: die Floating-IP (`samplemonk-floating`, 46.225.253.71) war **nicht
angehängt** — `POST /api/wake` tut das nicht.

### Zwei Live-Runden: 5/7 → 7/7 (Ursache der zwei Ausfaelle)

Die erste Runde ergab 5/7. Die beiden Ausfaelle prueften ueber den Debug-Hook
`window.__webRTCManager` — der wird **absichtlich nur im Dev-Build** gesetzt
(`if (import.meta.env?.DEV)` in `src/utils/WebRTCManager.ts`). Isolation: derselbe
Code als lokaler **Produktions-Build** (`NODE_ENV=production node dist/server.cjs`,
Port 8080) zeigte exakt dieselben 2 Ausfaelle. Danach wurden die Tests auf
produktionssichtbares Verhalten umgestellt (Resync per Reconnect,
Main-Out-Vorbedingung per Spiegelung + Audit): **Dev 7/7 · Prod-Build 7/7 ·
live 7/7**. Wer kuenftig gegen eine echte Instanz testet, findet die Falle im
Runbook: Debug-Hooks sind dev-only.

### Wake nach dem Worker-Deploy (2026-09-18, dritte Messung)

Mit dem ausgerollten Worker (snapshotRoleOf-Fix + sichtbare Verdrahtung):

```
POST /api/wake -> HTTP 200 nach 2,4 s
  usedSnapshots: [app, sfu, ai, master, edge]   # ALLE Rollen aus Snapshots
  fallbackRoles: []                             # kein cloud-init, kein Build
  wiring: { appFirewall:{ok:true},
            dns:{ok:false, message:"Cloudflare-Zone nicht gefunden"},
            ports:{ok:true} }
```

Der Knoten war nach ~45 s gesund; `state` bleibt `starting-app` mit HTTP 522, weil
`ready` den Health-Check UEBER DIE DOMAIN verlangt und dem Token das DNS-Recht fehlt.
Der Unterschied zu vorher: der Grund steht jetzt in der Antwort und im Ladebildschirm.

### Snapshot-Wake: ~60 s statt ~5 min (gemessen in der zweiten Runde)

Der zweite Wake benutzte Snapshots (`usedSnapshots: {app: …}`) und die App war nach
**~60 s** erreichbar; der erste Wake (ohne Snapshots) brauchte ~5 min Kaltstart.
Grund: die Snapshots vom 2026-09-11 tragen **keine Labels** (deshalb der
Repo-Fix an `snapshotRoleOf`), die aus `/api/refresh-snapshots` tragen welche. Der
Snapshot enthaelt den deployten Stand (Container + Overlay) — ein Restore bringt
also Code **und** Geschwindigkeit.

### Was live bewiesen wurde (2026-09-18)

- **4-User-Session gegen den echten Knoten**: **7 von 7** `collab.spec.ts`-Tests grün
  über den Tunnel (`E2E_BASE_URL=http://localhost:8080`, 1,3 min) — nachdem die zwei
  Tests, die einen dev-only Debug-Hook benutzten, auf produktionssichtbares
  Verhalten umgestellt wurden (Details oben).
- **Live-Latenz der echten Instanz**: 782 HTTP-Requests, Mittel 7,6 ms, p95 ≤ 25 ms
  (`scripts/prom-p95.py` liest die Histogramm-Exposition).
- **Beide Ghostuser live** (gleicher Lauf): `/visual-out` (Beamer) und `/master-out`
  (PA) verbinden sich, der Zähler eines normalen Users bleibt **`SESSION 1/4`** —
  keiner der beiden verbraucht einen der 4 Plätze. Die PA-Seite hat bewusst kein
  Bild; ihr Beleg ist der Server-Audit-Eintrag `JOIN_MASTER_OUT`.
- **Bildweg live inklusive Inhalt**: ein Abonnent am Knoten empfängt echten
  Multipart-Strom (`--audiomonastryframe`, `image/jpeg`); der Beweis schneidet das
  JPEG per `Content-Length` heraus und **dekodiert** es: 320×180, Mittelpixel
  `r=218 g=30 b=30` — genau das eingespeiste Rot. `POST /api/visual/frame` liefert
  200 (584 Bytes je JPEG; PNG wird korrekt mit 415 abgelehnt).
- **Nebenbei live bestätigt**: `[fleet] Knoten verdrahtet: masterPlayer → 142.132.231.146:8000`
  über die **Alt-Namen** der Fleet-Map (`samplemonk-*`) — der Kompatibilitätspfad aus
  NOMEN-P1-001 arbeitet in Produktion; und `[mos] 16 Hörerwertungen aus der Persistenz
  geladen` (AI-P1-007).

### PA-Audioweg: was er voraussetzt (gemessen 2026-09-18)

Der Master-Stream zum `/master-out`-Zuhörer entsteht **nur**, wenn der DJ
Main-Out-Halter ist:

```
src/App.tsx:  if (webRTCManager.isMainOutOwner) startHostMain()
              -> audioEngine.createMasterStreamDestination()
              -> webRTCManager.startMainStream(dest.stream)
```

Die Rolle vergibt der Server (mixerMONK-Lock). Ohne Halter bleibt der PA stumm —
auch wenn er korrekt angedockt ist (`JOIN_MASTER_OUT` im Audit).

Der Fortschritt ist seit 2026-09-18 **produktionssichtbar** am Marker
`document.body.dataset.mainStream`:

| Marker | Bedeutung |
|---|---|
| `no-owner` | DJ ist nicht Main-Out-Halter (Rack-Menü `mixerMONK Menü` → PRO) |
| `owner-no-dest` | Halter, aber die Engine liefert keinen Stream — der V2-Sink ist nicht verbunden, weil **nichts spielt** (`MasterStreamTap.create()` → `null`, bewusst kein No-Op-Fallback) |
| `on` | Stream läuft zu den Zuschauern |

**Warum im Headless-Aufbau zusätzlich die KANÄLE gesperrt bleiben** (nachgelesen
2026-09-19): „Send to Track" verlangt `audioEngine.canLoadTrack(t)` →
`mainHolderActive`, und das ist in `src/App.tsx` dreifach verknüpft:
`moduleStates['mixer'] === 'PRO'` **und** `pluginLocks['mixer'].active` **und**
`pluginLocks['mixer'].lockedBy === webRTCManager.userId`. Ein Menü-Klick im
Einzel-Browser lässt das Rack auf `AUTO_AI` — PRO+Server-Lock kommen dort nicht
zustande, also bleiben alle Kanäle „nur DJ / Freigabe". Außerdem: Preset-Samples
haben in dieser Umgebung **keine Audio-URL** (Menüpunkt korrekt gesperrt mit „kein
Audio-URL"); ein **eigener Upload** bekommt eine Blob-URL und ist sendbar.

Für eine Messung muss also erst der Halter gesetzt **und** eine Quelle
tatsächlich abgespielt werden; dann misst
`node scripts/master-out-audio-proof.mjs` den RMS am Zuschauer
(AnalyserNode). Ein vorheriger Klick auf das Kopf-Icon `mixerMONK` schließt das
Rack — das Menü liegt direkt im Rack.

### Aufräumen (Kosten)

`POST /api/stop` **löscht** alle Server und Floating-IPs (danach 0 €/Monat für Compute;
die Snapshots bleiben). Vorher: `POST /api/refresh-snapshots`, damit der nächste Wake
den aktuellen Stand enthält — das ist erst nach dem `snapshotRoleOf`-Fix auch schnell.

## Session-Reset im Testlauf und das Idle-Shutdown-Signal lesen (F8/F9 — 2026-09-20)

Beide Punkte kommen aus `docs/FIXPLAN_2026-09-20_externer_apptest.md`, F8 und F9.
Kurzform der Befunde: Der Reset-Hook war ohne expliziten Schalter aktiv und belegte
seine Wirkung nicht; `/api/online` meldete nach abgebrochenen Verbindungen 3 Clients
bei 1 echten. Das Idle-Signal des Timers hingegen war **strukturell immer 0**
(`curl http://127.0.0.1/api/online` → Caddy-308 bzw. 401 ohne Token; beides endete in
der 0 des `awk`-END-Blocks, Exit-Code 0 — der Fehlschlag war unsichtbar).

### 1. Session-Reset (nur Testlauf)

Zwei Schlösser, beide nötig: `NODE_ENV != production` **und** `AUDIOMONASTRY_TEST_RESET=1`.
In Produktion antwortet der Pfad wie ein nicht existierender (404), auch mit Schalter
und gültigem Token. Zusätzlich ist ein konfiguriertes Studio-Token Pflicht (401).

```bash
# App fuer den Testlauf (Startzustand isolierbar):
AUDIOMONASTRY_TEST_RESET=1 STUDIO_ACCESS_TOKEN=<token> npm run dev

# Zustand lesen (gleiche Schranke wie der Reset):
curl -s -H "x-studio-token: <token>" http://localhost:8080/api/session/state
#   → {"sessionInstanceId":"session-…","revision":0,"modules":{},"locks":[],…}

# Zuruecksetzen und die Wirkung belegen (Zahlen werden aus dem NEUEN Zustand gelesen):
curl -s -X POST -H "x-studio-token: <token>" http://localhost:8080/api/session/reset
#   → {"status":"reset","sessionInstanceId":"session-…","previous":{"revision":7,"moduleStates":2,"locks":1},
#      "revision":0,"moduleStates":0,"locks":0}
```

Lesart: `sessionInstanceId` **muss** sich nach dem Reset ändern (eine „Revision 0" allein
kann auch ein frisch gestarteter Prozess sein); `previous` belegt den Zustand davor.
Der E2E-Helfer (`tests/e2e/helpers/studioAuth.ts`) ruft denselben Pfad und verträgt 404
gegen `E2E_BASE_URL` (Produktion) weiterhin — dort bleibt der frische Zustand beim
**Container-Neustart** der Weg der Wahl.

### 2. Idle-Shutdown-Signal

Der systemd-Timer (`audiomonastry-idle-shutdown.timer`, Installation über
`scripts/hetzner/install-idle-shutdown.sh`) fragt **die App**:

```bash
# Menschenlesbar (JSON):
curl -s -H "x-scrape-token: <token>" "http://127.0.0.1:8080/api/idle-signal"
# Maschinenlesbar (genau die Log-Zeile; Header x-idle-verdict / x-idle-shutdown):
curl -s -H "x-scrape-token: <token>" "http://127.0.0.1:8080/api/idle-signal?format=text"
```

Der Timer liefert dabei nur seine **Host-Fakten** mit (`openSockets`, `sshSessions`,
`load1`, `busyContainers`, `thresholdSec` aus `IDLE_MINUTES`); die App kennt, was der Host
nicht wissen kann: aktive Socket-Verbindungen und den letzten **erfolgreichen** App-Request
(`/api/health`, `/api/metrics`, `/api/online`, `/api/audit` und der Idle-Abruf selbst zählen
NICHT — sonst hielte sich die Instanz über Scrapes selbst wach). Regeln:
`server/idleSignal.ts`; Tests: `tests/idleSignal.test.ts`.

Logzeile im Betrieb (`/var/log/audiomonastry-idle-shutdown.log`):

```
[idle-check] 2026-09-20T17:59:00.900Z ONLINE=0 OPEN_SOCKETS=0 SSH=0 LOAD1=0 BUSY_CONTAINERS=0
  LAST_ACTIVITY=2026-09-20T17:58:23.179Z ACTIVITY_AGE=38s IDLE_FOR=4s THRESHOLD=3s
  VERDICT=idle SHUTDOWN=yes REASON="idle seit 4s >= Schwelle 3s"
```

| Feld | Bedeutung |
|---|---|
| `ONLINE` | aktive Socket-Clients (Registry-Wahrheit, F8) |
| `OPEN_SOCKETS` / `SSH` / `LOAD1` / `BUSY_CONTAINERS` | Host-Fakten, die der Timer meldet |
| `LAST_ACTIVITY` / `ACTIVITY_AGE` | letzter erfolgreicher App-Request und sein Alter |
| `IDLE_FOR` / `THRESHOLD` | bisherige Idle-Dauer und die Schwelle |
| `VERDICT` | `active` (Nutzung messbar), `idle` (keine Nutzung), `unknown` (Signal nicht lesbar) |
| `SHUTDOWN` | `yes` nur bei `idle` UND erreichter Schwelle |

**`VERDICT=unknown` ist fail-safe: es wird NICHT heruntergefahren.** Die Zeile nennt
dann `SIGNAL=unavailable HTTP=<code>`; `308` heißt „`IDLE_CHECK_URL` zeigt auf Caddy
statt auf die App (Port 8080)", `401` heißt „Token fehlt". Der Timer läuft als
Maschinen-Client ohne Cookie; sein Token liegt in
`/etc/audiomonastry/idle-check.env` (Modus 0600, wird vom Installer angelegt und
übernimmt einen vorhandenen `SCRAPE_TOKEN`/`STUDIO_ACCESS_TOKEN` aus der App-`.env`).
Ohne Token läuft der Check fail-safe — es wird nichts heruntergefahren.

```bash
# Trockenlauf (schreibt nur ins Log, kein Shutdown). IDLE_MINUTES darf fuer
# Probelaeufe ein Bruchteil sein (0.05 = 3 s Schwelle):
IDLE_MINUTES=0.05 bash /usr/local/bin/audiomonastry-idle-check.sh --dry-run
# Host-Fakten allein (Diagnose, kein Signal, keine Entscheidung):
bash /usr/local/bin/audiomonastry-idle-check.sh --print-facts
# Unit-Inhalt offline pruefen (kein Installieren, kein root):
bash scripts/hetzner/install-idle-shutdown.sh --print-units
```

Reproduktion des alten Befunds (lokal, beide Pfade ergeben 0 bei Exit-Code 0):

```bash
curl -fsS http://127.0.0.1/api/online | awk -F'"online":' '{n=$2+0} END{print n+0}'   # 308 → 0
curl -fsS http://127.0.0.1:8080/api/online | awk -F'"online":' '{n=$2+0} END{print n+0}' # 401 → 0
```

Zum Mitlesen der Socket-Seite: `/api/online` liefert jetzt zusätzlich `ghosts`,
`idleSockets` und `unattachedSockets` aus dem letzten Socket-Sweep — nicht-null-Werte
zeigen Reste abgebrochener Verbindungen, die der Sweep im nächsten Intervall entfernt.

## Cloudflare-Token vor dem DNS-Fix messen (F1 — 2026-09-20)

Der externe App-Test fand **fünf** Cloudflare-Fundstellen in zwei Dateien
(`CLOUDFLARE_API_TOKEN`, `CF_API_KEY`, `CF_ACCOUNT_TOKEN` in `.env.deploy` und
`.env.portal`). Bevor jemand einen Token „hinterlegt“ und dann auf einen
Portal-Neustart wartet, sagt dieses Skript lesend, welcher überhaupt lebt:

```bash
python3 scripts/hetzner/cf-token-diagnose.py            # Zone anunnakitools.de
```

Es ruft ausschließlich `GET /user/tokens/verify` und `GET /zones?name=…` auf,
schreibt nichts und gibt **nie Token-Werte** aus — nur `success`, den ersten
Fehlercode (z. B. `1000 Invalid API Token`) und die Zahl der sichtbaren Zonen.
Ein Wert, der wie ein globaler API-Key aussieht (37 Hex-Zeichen), wird als
solcher gekennzeichnet: für ihn ist `tokens/verify` die falsche Prüfung (er
braucht `X-Auth-Email` + `X-Auth-Key`, und `CF_EMAIL` fehlt in den Dateien).

Ergebnis am 2026-09-20: **alle fünf** antworten `1000 Invalid API Token`,
Zonenzugriff 0 → `Zone:DNS:Edit` fehlt komplett. Das ist der Blocker für F1 und
für das Portal-gesteuerte Flotten-Wake.

## Flotten-Versorgung: Firewall, Images, Knoten-Stand (2026-09-20)

Drei Werkzeuge, die beim Versorgen der Flotte helfen (alle lesend bzw.
idempotent, keines provisioniert Server):

```bash
python3 scripts/hetzner/firewall-inventory.py          # Ist-Stand aller Firewalls + erwartete SFU-Ports
python3 scripts/hetzner/firewall-ensure-turn.py        # Trockenlauf: fehlende TURN-Regeln der Rolle sfu
python3 scripts/hetzner/firewall-ensure-turn.py --apply # schreiben (set_rules, idempotent)
bash scripts/hetzner/fleet-status.sh                   # Knoten, Container, Compose-Projekt, Health
```

`firewall-ensure-turn.py` ergänzt **nur** die vier Regeln 3478 udp/tcp und
49152-49201 udp/tcp — dieselben Zahlen wie `portal-worker/firewallRules()` und
`scripts/hetzner/provision.py`. Ohne sie kann kein Browser einen TURN-Relay
aufbauen (am 2026-09-20 fehlten sie live, obwohl der Code sie erwartet).

Rollen-Versorgung (neuer Repo-Stand + aktuelles Image, ohne die Knoten-`.env`
anzufassen):

```bash
rsync -az -e "ssh -o BatchMode=yes" --exclude node_modules --exclude dist --exclude .git \
  --exclude .env --exclude '.env.*' --exclude .worktrees --exclude public/data/orchestral \
  ./ root@<ip>:/opt/audiomonastry/
docker save audiomonastry:hetzner | gzip -1 | ssh root@<ip> 'gunzip | docker load'
ssh root@<ip> 'cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=audiomonastry \
  docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml -f docker-compose.turn.yml \
  up -d --no-build --remove-orphans caddy audiomonastry coturn'
```

`install-ai1.sh` (ai-1) ist idempotent und zieht `qwen2.5:7b` + Stem-AI
systemd-Unit; der Health-Check am Ende schlägt fehl, wenn der Dienst nicht
startet — dann `journalctl -u stem-ai` prüfen (Importpfad-Falle siehe
`services/stem-ai/main.py`).

## Medieninhalte auf einen Knoten bringen (produktionsreif, ohne Image-Ballast)

Die schweren Inhalte liegen bewusst NICHT im Image (`.dockerignore`): sonst wächst
jeder Build um ~3,7 GB. Stattdessen liegen sie auf dem Knoten und werden read-only
in die Auslieferpfade gemountet (`docker-compose.media.yml`):

| Inhalt | Größe | Auslieferpfad im Container | Lizenz |
| --- | --- | --- | --- |
| `public/data/orchestral` (VSCO 2 CE) | ~3,0 GB | `/app/dist/data/orchestral` | CC0 – darf ausgeliefert werden |
| `public/models/htdemucs.onnx` | ~291 MB | `/app/dist/models` | ONNX-Export (HF `smank/htdemucs-onnx`) |
| `public/music` (Demo-Tracks) | ~382 MB | `/app/dist/music` | **keine dokumentierte Freigabe** – nur mit `--with-music` |

```bash
# Inhalte nachladen (einmalig, lokal)
npm run download:orchestral            # CC0-Library, ~3 GB
bash scripts/download-models.sh        # htdemucs.onnx, ~291 MB

# Auf den Knoten bringen + App mit Medien-Overlay neu starten
bash scripts/hetzner/deliver-media.sh <knoten-ip>
bash scripts/hetzner/deliver-media.sh <knoten-ip> --print-config   # Trockenlauf
bash scripts/hetzner/deliver-media.sh <knoten-ip> --with-music     # nur mit Freigabe

# Kontrolle im Container
ssh root@<knoten-ip> 'docker exec audiomonastry ls /app/dist/data/orchestral | head -3;
                      docker exec audiomonastry ls -lh /app/dist/models | head -3'
```

Fehlen die Quellen lokal, endet das Skript mit Exit 2 und nennt die Nachlade-
Befehle — ein leeres Inhaltsverzeichnis im Container sähe sonst wie ein kaputtes
Feature aus. `docs/LICENSE_EXTERNAL_RESOURCES.md` ist die Quelle für die
Lizenzlage; VSCO 2 CE ist dort die einzige freigegebene Library.

## Legacy-Namen aufraeumen (Firewalls, Altpfad) - 2026-09-20

Nach dem Namespace-Fix liegen Altlasten herum, die einen Fehlgriff beguenstigen:

```bash
# Ungenutzte Legacy-Firewalls (Praefix aus fleet-names.sh) auflisten/loeschen
python3 scripts/hetzner/cleanup-legacy-firewalls.py            # Trockenlauf
python3 scripts/hetzner/cleanup-legacy-firewalls.py --apply    # loeschen
```

Geloescht wird **nur**, wenn `applied_to` leer ist (sonst "UEBERSPRUNGEN" + Grund).
Am 2026-09-20 waren das sechs Stueck (`samplemonk-test/-app/-sfu/-ai/-master/-edge`)
mit teils anderen Regeln als die aktiven `audiomonastry-*`-Firewalls - die alte
`samplemonk-sfu` hatte z. B. keine TURN-Ports.

Dazu die Knoten-Hygiene: `docker image prune -f` + `docker builder prune -f`
(ungetaggte Images und Build-Cache; **getaggte** Images bleiben, darunter das
Rollback-Image `audiomonastry:hetzner-rollback`, und Volumes werden nie
angefasst - die kopierten Alt-Volumes sind der Rueckweg der Migration). Auf ai-1
wurde der veraltete Altpfad `/opt/samplemonk` (6,0 GB, Kopie vom 18.09.) entfernt;
die Dienste `ollama` und `stem-ai` laufen unveraendert aus
`/opt/audiomonastry` + `/root/.ollama`.

## App-Metriken direkt scrapen (SCRAPE_TOKEN + Monitoring-Pfad) - 2026-09-20

Befund beim Produktionsreife-Lauf: der Prometheus-Job `audiomonastry` war
`health=down` mit **HTTP 521** — er fragte `https://anunnakitools.de/api/metrics`
ab, und diese Kette hängt an Cloudflare/DNS (F1). Die App lief, das Monitoring war
trotzdem blind; zusätzlich wird `/api/metrics` ohne `SCRAPE_TOKEN` mit 401
abgewiesen (fail-closed).

Jetzt läuft der Scrape **direkt** gegen den Container:

```bash
# 1. Token setzen (identisch auf beiden Seiten; Wert wird nie ausgegeben)
ssh root@142.132.229.71 'cd /opt/audiomonastry && bash scripts/hetzner/wire-scrape-token.sh app'
ssh root@142.132.229.71 "grep '^SCRAPE_TOKEN=' /opt/audiomonastry/.env" \
  | ssh root@167.233.192.196 'cd /opt/audiomonastry && bash scripts/hetzner/wire-scrape-token.sh edge'
# Trockenlauf beider Rollen: ... wire-scrape-token.sh <app|edge> --print-config

# 2. Firewall: 8080 NUR fuer den Monitoring-Knoten
python3 scripts/hetzner/firewall-ensure-app-metrics.py           # Trockenlauf
python3 scripts/hetzner/firewall-ensure-app-metrics.py --apply

# 3. Kontrolle (alle vier Jobs muessen up sein)
docker exec audiomonastry-prometheus sh -c 'wget -qO- "http://127.0.0.1:9090/api/v1/targets?state=active"'
```

`docker-compose.hetzner.yml` veröffentlicht dafür `8080:8080` am App-Container; die
Begrenzung auf den Monitoring-Knoten liegt in der Hetzner-Firewall
(`audiomonastry-app`, Regel `8080/tcp` von `167.233.192.196/32`), der Endpunkt
bleibt durch `SCRAPE_TOKEN` geschützt. Ergebnis am 2026-09-20: `audiomonastry`,
`node`, `cadvisor` und `prometheus` alle `health=up`.

## Cloudflare-DNS der Flotte verdrahten (F1) — 2026-09-21

Der oeffentliche Zugang haengt an zwei A-Records, die **DNS-only** (proxied=false)
direkt auf die Knoten zeigen. Vertrag und Werkzeug:

```bash
# 1. Token ablegen (alle lokalen Fundstellen; Wert wird nie ausgegeben)
printf '%s\n' "$CF_TOKEN" | python3 scripts/hetzner/cf-token-set.py --value-stdin          # Trockenlauf
printf '%s\n' "$CF_TOKEN" | python3 scripts/hetzner/cf-token-set.py --value-stdin --apply   # schreiben

# 2. Records setzen/reparieren (drift-fest, idempotent)
python3 scripts/hetzner/cf-dns-ensure.py            # Trockenlauf: was waere zu tun?
python3 scripts/hetzner/cf-dns-ensure.py --apply    # origin -> app-1, sfu -> sfu-1, beide A/DNS-only

# 3. Lesende Kontrolle (beide Records)
bash scripts/hetzner/fleet-preflight.sh dns

# 4. Live-Beweis
curl -s -o /dev/null -w '%{http_code}\n' https://anunnakitools.de/api/health        # erwartet 200
curl -s -o /dev/null -w '%{http_code}\n' https://sfu.anunnakitools.de/api/health    # erwartet 200
```

Live am 2026-09-21 gefunden und behoben: `origin.anunnakitools.de` stand auf einem
alten Hetzner-Server (`46.225.253.71`) **mit Cloudflare-Proxy** — der Worker holt den
Origin ueber genau diesen Namen, also lief die Domain dauerhaft in HTTP 521/522; der
SFU-Record fehlte ganz.

### SFU-HTTPS auf sfu-1 (F6)

`sfu.anunnakitools.de` braucht ein **oeffentlich vertrauenswuerdiges** Zertifikat, weil
der Browser direkt (DNS-only) dorthin verbindet:

```bash
# auf sfu-1: Site-Adresse setzen (Caddy holt Let's Encrypt per HTTP-01, Port 80 offen)
SFU_PUBLIC_URL=https://sfu.anunnakitools.de bash scripts/hetzner/wire-rtc.sh sfu
COMPOSE_PROJECT_NAME=audiomonastry docker compose -f docker-compose.hetzner.yml \
  -f docker-compose.sfu.yml -f docker-compose.turn.yml up -d --no-build --force-recreate caddy

# auf app-1: Client-Pfad auf wss umstellen (Secret per Pipe, kein Rotieren)
ssh root@<sfu-1> "grep '^TURN_STATIC_AUTH_SECRET=' /opt/audiomonastry/.env | cut -d= -f2-" \
  | ssh root@<app-1> 'cd /opt/audiomonastry && SFU_PUBLIC_IP=<sfu-ip> \
      SFU_PUBLIC_URL=https://sfu.anunnakitools.de bash scripts/hetzner/wire-rtc.sh app --secret-stdin'
ssh root@<app-1> 'cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=audiomonastry docker compose \
  -f docker-compose.hetzner.yml -f docker-compose.media.yml up -d --no-build --force-recreate audiomonastry'
```

Ein **Cloudflare-Origin-Zertifikat waere hier falsch**: es gilt nur fuer Cloudflares
Edge, ein Browser lehnt es ab. Ein Origin-Zertifikat gehoert auf den App-Knoten
(Worker-Pfad, `Caddyfile.origin`), Let's Encrypt auf den SFU-Knoten (Client-Pfad).

TURN-Beweis (echt, mit den von der App geminteten Credentials):

```bash
# Credentials minten (Token aus der Knoten-.env) und als 600er Datei nach sfu-1
ssh root@<app-1> 'bash -s' < /tmp/mint-turn-creds.sh > /tmp/.turn-creds      # "username credential"
scp /tmp/.turn-creds root@<sfu-1>:/root/.turn-creds
ssh root@<sfu-1> 'bash -s' < /tmp/turn-proof-sfu.sh     # turnutils_uclient im coturn-Container
```

Erwartet: Allokation mit den App-Credentials gelingt, falsches Credential endet mit
`Cannot complete Allocation` (exit 255). Beides am 2026-09-21 gemessen.

