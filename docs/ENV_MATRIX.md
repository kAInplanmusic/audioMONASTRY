# audioMONASTRY – ENV-Konfigurationsmatrix (SSOT)

> Stand: 2026-09-13 · Erzeugt aus Code- und Template-Analyse (Phase 1/7).
> Regel: **Alias-Namen werden nur mit Warnung gelesen, nie still umbenannt.**
> Kanonisches Schema (Commit 359ce7e): `RP_*` (RunPod), `SB_*` (Supabase),
> `CFR2_*` (Cloudflare R2 nativ), `CFS3_*` (Cloudflare R2 S3-kompatibel).

## 1. Laufzeit-Kern (server.ts + src)

| Erwarteter ENV-Name | Tatsächlich verwendet | Quelle | Pflicht | Default | Validierung | Komponenten | Secret |
|---|---|---|---|---|---|---|---|
| `PORT` | `PORT` | Prozess | nein | `8080` | Nummer | server.ts, alle Services | nein |
| `NODE_ENV` | `NODE_ENV` | Prozess | nein | – | – | server.ts (Production-Warnungen) | nein |
| `STUDIO_ACCESS_TOKEN` | `STUDIO_ACCESS_TOKEN` | .env | **ja (prod)** | – | 32+ Zeichen empfohlen | server.ts (fail-closed Auth) | **ja** |
| `MAIN_OUT_USER_ID` | `MAIN_OUT_USER_ID` | .env | nein | erster Admin | non-empty String | server.ts P0-1 (MixerMONK-Pin) | nein |
| `SESSION_HOST_USER` | `SESSION_HOST_USER` | .env | empfohlen | erster Join | non-empty String | server.ts `roleForSessionUser` | nein |
| `SESSION_ROLE` | `SESSION_ROLE` | .env | nein | `guest` | admin/producer/engineer/guest | server.ts `roleForSessionUser` | nein |
| `REDIS_URL` | `REDIS_URL` | .env | nein | – | URL | server.ts (Socket-Adapter + Session-Persistenz) | **ja** |
| `SIGNALING_ALLOWED_ORIGINS` | `SIGNALING_ALLOWED_ORIGINS` | .env | nein | alle | CSV-URLs | server.ts (Origin-Check) | nein |
| `SIGNALING_IDLE_TIMEOUT_MS` | `SIGNALING_IDLE_TIMEOUT_MS` | .env | nein | 300000 | Nummer | server.ts | nein |
| `SIGNALING_SOCKET_SWEEP_MS` | `SIGNALING_SOCKET_SWEEP_MS` | .env | nein | 30000 | Nummer (min. 1000) | server/realtime.ts + server/socketLiveness.ts (F8: Sweep toter/idle Sockets) | nein |
| `AUDIOMONASTRY_TEST_RESET` | `AUDIOMONASTRY_TEST_RESET` | .env (nur Dev/Test) | nein | – | `1` = an; nur wirksam mit `NODE_ENV != production` | server.ts + server/routes/sessionRoutes.ts (F8: `/api/session/reset`, `/api/session/state`) | nein |
| `IDLE_SHUTDOWN_MINUTES` | `IDLE_SHUTDOWN_MINUTES` | .env | nein | `30` | Nummer (Bruchteile nur für Trockenläufe) | server/idleSignal.ts + server/routes/opsRoutes.ts (F9: Fallback-Schwelle, wenn der Timer kein `thresholdSec` schickt) | nein |
| `SIGNALING_MAX_CLIENTS` | `SIGNALING_MAX_CLIENTS` | .env | nein | – | Nummer | server.ts | nein |
| `UPLOAD_MAX_MB` | `UPLOAD_MAX_MB` | .env | nein | 100 | Nummer | server.ts `/api/upload` | nein |
| `STEM_MAX_UPLOAD_MB` | `STEM_MAX_UPLOAD_MB` | .env | nein | 100 | Nummer | server.ts `/api/separate-stems` | nein |
| `STEM_MAX_JOBS` | `STEM_MAX_JOBS` | .env | nein | 2 | Nummer | server.ts (Backpressure) | nein |
| `STEM_JOB_TIMEOUT_MS` | `STEM_JOB_TIMEOUT_MS` | .env | nein | 300000 | Nummer | server.ts | nein |
| `TURN_STATIC_AUTH_SECRET` | `TURN_STATIC_AUTH_SECRET` | .env | nein | – | non-empty | server/webrtcConfig.ts | **ja** |
| `TURN_URLS` | `TURN_URLS` | .env | nein | – | URL | server/webrtcConfig.ts | nein |
| `VISION_ARTIFACT_DIR` | `VISION_ARTIFACT_DIR` | .env | nein | system temp | Pfad | server/visionArtifacts.ts | nein |
| `VITE_ENABLE_LOCAL_EMBEDDINGS` | `VITE_ENABLE_LOCAL_EMBEDDINGS` | Vite | nein | – | boolean | src/lib/cloudConfig.ts | nein |
| `SCRAPE_TOKEN` | `SCRAPE_TOKEN` | .env | nein | – | 16+ Zeichen empfohlen | server.ts (Lese-Metriken: `/api/metrics`, `/api/online`, `/api/idle-signal`), Prometheus, Hetzner-Idle-Timer | **ja** |
| `UPLOAD_CHUNK_DIR` | `UPLOAD_CHUNK_DIR` | .env | nein | `<tmp>/audiomonastry-uploads` | Pfad | server/chunkedUpload.ts (Teil-Uploads) | nein |
| `UPLOAD_CHUNK_RATE_LIMIT_MAX` | dito | .env | nein | `240` | Nummer/min | server.ts (eigener Limiter fuer Chunk-Uploads) | nein |
| `ALERT_WEBHOOK_TOKEN` | `ALERT_WEBHOOK_TOKEN` | .env | nein | – | **16+ Zeichen erzwungen** (`length >= 16`, sonst inaktiv) | server.ts (Maschinen-Endpunkt `/api/alerts/webhook`) | **ja** |
| `CRITICAL_WEBHOOK` | `CRITICAL_WEBHOOK` | .env/Compose | nein | App-Route | URL | docker-compose.monitoring.yml (Alertmanager-Direktroute fuer `severity="critical"`) | **ja** |
| `DISCORD_WEBHOOK` / `SLACK_WEBHOOK` | dito | .env | nein | – | URL | server.ts `/api/alerts/webhook` (Weiterleitung) | **ja** |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | dito | .env | nein | – | Token/ID | server.ts `/api/alerts/webhook` | **ja** |

## 1b. Idle-Auto-Shutdown-Timer (PROD-P3-F9 / F9)

Der Timer läuft auf dem Knoten und **entscheidet nichts selbst**: er holt
`GET /api/idle-signal` auf dem App-Port ab und schreibt die Antwort samt
HTTP-Status ins Log. Die Regeln stehen rein und getestet in
`server/idleSignal.ts` (idle nur, wenn keine Socket-Clients, keine offenen
Sockets/SSH/Load/Container-Jobs und kein erfolgreicher App-Request innerhalb der
Schwelle; Shutdown nur bei `idle` UND erreichter Schwelle). Ohne lesbares Signal
ist der Lauf fail-safe.

| Name | Ort | Default | Bedeutung | Secret |
|---|---|---|---|---|
| `IDLE_SHUTDOWN_MINUTES` | Knoten-`.env` (App) | `30` | Fallback-Schwelle der App, wenn der Timer kein `thresholdSec` schickt | nein |
| `SCRAPE_TOKEN` | Knoten-`.env` + `/etc/audiomonastry/idle-check.env` | – | Maschinen-Token des Timers (`x-scrape-token`; Fallback `STUDIO_ACCESS_TOKEN`) | **ja** |
| `IDLE_MINUTES` | Installer/Unit-Environment | `30` | Schwelle des Timers in Minuten → `thresholdSec` | nein |
| `CHECK_INTERVAL` | Installer | `5` | Prüfintervall des Timers in Minuten (`OnUnitActiveSec`) | nein |
| `IDLE_CHECK_URL` | `/etc/audiomonastry/idle-check.env` | `http://127.0.0.1:8080/api/idle-signal` | Ziel des Checks; Port 80 ist Caddy (308!) | nein |
| `IDLE_CHECK_ENV_FILE` | Prozess/Unit | `/etc/audiomonastry/idle-check.env` | Ort der Zugangsdatei (Modus 0600) | nein |
| `LOG` | Installer/Unit-Environment | `/var/log/audiomonastry-idle-shutdown.log` | Logdatei des Checks | nein |
| `IDLE_ALLOW_TOKEN_LESS` | Installer | `0` | `1` = Timer auch ohne Token installieren (blind, fährt nie herunter) | nein |
| `IDLE_BIN_DIR`, `IDLE_UNIT_DIR` | Installer (nur Tests) | `/usr/local/bin`, `/etc/systemd/system` | Zielverzeichnisse der Kopien — damit Tests ohne root/systemd laufen | nein |

`IDLE_SHUTDOWN_MINUTES` und `SCRAPE_TOKEN` stehen seit 2026-09-21 auch in
`.env.hetzner.example` (sie waren nur hier dokumentiert — genau das war die offene
SSOT-Lücke zu PROD-P3-F9). Reihenfolge beim Token: der Timer bevorzugt die Datei
`idle-check.env`; legt der Installer sie an, übernimmt er einen vorhandenen
`SCRAPE_TOKEN`/`STUDIO_ACCESS_TOKEN` aus der App-`.env` und gibt den Wert nie aus.
Ohne Token bricht der Installer mit Exit 2 und Klartext ab, **bevor** er Units
aktiviert (ein Timer ohne Token kann strukturell nie auslösen = dieselbe
Fehlerklasse wie der F9-Befund).

## 2. Supabase (kanonisch `SB_*`)

| Erwartet | Verwendet | Alias (Warnung) | Pflicht | Komponenten | Secret |
|---|---|---|---|---|---|
| `SB_URL` | `SB_URL` | `SUPABASE_URL` | nein (offline-fähig) | src/config/supabaseKeys.ts, server.ts | nein |
| `SB_SERVICE_ROLE` | `SB_SERVICE_ROLE` | `SUPABASE_SERVICE_ROLE` | nein | server.ts (Server-Schreibzugriff) | **ja** |
| `SB_ANON_PUB` | `SB_ANON_PUB` | `SUPABASE_ANON_PUB` | nein | src/lib/supabaseClient.ts | nein (publishable) |
| `SB_PUBLISHABLE` | `SB_PUBLISHABLE` | – | nein | src/lib/supabaseClient.ts | nein (publishable) |
| `SB_SECRET` | `SB_SECRET` | `SUPABASE_SECRET` | nein | server.ts | **ja** |
| `SB_PAT` | `SB_PAT` | `SUPABASE_PAT` | nein | scripts (Migrationen) | **ja** |
| `VITE_SB_URL` / `VITE_SUPABASE_URL` | beide akzeptiert | – | nein | Browser-Bundle | nein |
| `VITE_SB_ANON_PUB` / `VITE_SUPABASE_ANON_PUB` | beide akzeptiert | – | nein | Browser-Bundle | nein (publishable) |

## 3. Cloudflare R2 (kanonisch `CFR2_*`/`CFS3_*`)

| Erwartet | Verwendet | Alias (Warnung) | Komponenten | Secret |
|---|---|---|---|---|
| `CFR2_ACCOUNT_ID` | `CFR2_ACCOUNT_ID` | `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCOUNT_ID` | server/cloud.ts, src/lib/cloudConfig.ts | nein |
| `CFR2_ACCESS_KEY_ID` | `CFR2_ACCESS_KEY_ID` | `CLOUDFLARE_ACCESS_KEY_ID` | R2-Schreibpfad | **ja** |
| `CFR2_SECRET_ACCESS_KEY` | `CFR2_SECRET_ACCESS_KEY` | `CLOUDFLARE_SECRET_ACCESS_KEY` | R2-Schreibpfad | **ja** |
| `CFR2_BUCKET` | `CFR2_BUCKET` | – | server/cloud.ts | nein |
| `CFR2_PUBLIC_URL` | `CFR2_PUBLIC_URL` | – | Public-Read-URLs | nein |
| `CFS3_ACCESS_KEY` | `CFS3_ACCESS_KEY` | `CFS3_ACCESS_KEY_ID` | S3-kompatibler Pfad | **ja** |
| `CFS3_SECRET_KEY` | `CFS3_SECRET_KEY` | `CFS3_SECRET_ACCESS_KEY` | S3-kompatibler Pfad | **ja** |
| `CFS3_ENDPOINT` | `CFS3_ENDPOINT` | – | S3-kompatibler Pfad | nein |
| `CFS3_BUCKET` | `CFS3_BUCKET` | – | S3-kompatibler Pfad | nein |
| `CFS3_PUBLIC_URL` | `CFS3_PUBLIC_URL` | `CFR2_PUBLIC_URL` | Public-Read-URLs | nein |
| `CFS3_PUBLIC_KEY` | `CFS3_PUBLIC_KEY` | – | S3-kompatibler Pfad | nein |

**FIX F2 (2026-09-20) – eine Herkunft, Abweichungen laut:** `server/r2Config.ts`
ist die EINZIGE Auflösung für beide Rollen-Quellen (Knoten-`.env` und Rollen-`.env`
des Portal-Workers). Gelesen werden die oben genannten Aliasse; auf app-1 lagen die
Werte unter `CFS3_ACCESS_KEY_ID`/`CFS3_SECRET_ACCESS_KEY`, die der Server vorher
**still ignorierte** (Folge: `SignatureDoesNotMatch`). Liefern zwei gesetzte
Variablen unterschiedliche Werte für dasselbe Feld, ist das eine gemeldete
Abweichung (`/api/cloud/health` → `r2.credentials.deviation`, Warnung im Log,
`docs/OPS_RUNBOOK.md` Abschnitt 12) – kein stilles Priorisieren. Werte erscheinen
dabei nie im Klartext, nur als Fingerabdruck. Der Portal-Worker schreibt die
kanonischen `CFS3_*`-Namen plus Legacy-Spiegel (`CFR2_*`) mit identischem Wert
(`services/portal-worker/src/index.js` → `r2EnvLines`, geprüft in
`tests/portalWorkerR2EnvParity.test.ts`).

## 4. RunPod-GPU-Flotte (kanonisch `RP_*`)

| Erwartet | Verwendet | Alias (Warnung) | Komponenten | Secret |
|---|---|---|---|---|
| `RP_API_KEY` | `RP_API_KEY` | `RUNPOD_API_KEY` | runpodProvider.ts, fleetWake.ts | **ja** |
| `RP_AGENT_KEY` | `RP_AGENT_KEY` | – | runpodProvider.ts (Vorrang) | **ja** |
| `RP_ENDPOINT_ID_BRAIN/EARS/VOICE/MUSIC/IMAGE/VIDEO_REAL/VIDEO_ABSTRACT/ORCHESTRATOR` | `RP_ENDPOINT_ID_*` | `RUNPOD_ENDPOINT_ID_*` | endpointRegistry.ts (8-Instanzen-Flotte) | nein |
| `RP_ENDPOINT_ID` | `RP_ENDPOINT_ID` | `RUNPOD_ENDPOINT_ID` | endpointRegistry.ts (Legacy-Fallback, gilt für ALLE 8 Rollen) | nein |
| `RP_BRAIN_OPENAI_URL` | `RP_BRAIN_OPENAI_URL` | – | LlmRouter (vLLM-Override) | nein |
| `RUNPOD_BRAIN_OPENAI_URL` | `RUNPOD_BRAIN_OPENAI_URL` | – | LlmRouter (Server-Pfad liest genau diesen Namen) | nein |
| `RUNPOD_API_BASE` | `RUNPOD_API_BASE` | – | runpodProvider.ts (Tests) | nein |
| `RP_S3_ACCESS_KEY` / `RP_S3_SECRET_KEY` | `RP_S3_*` | – | RunPod-Payload-Transfer | **ja** |

## 4b. Brain-OpenAI-Pfad (vLLM)

Live gemessen 2026-09-16 gegen den Brain-Endpoint (`Qwen/Qwen3-14B-AWQ`):

```
POST https://api.runpod.ai/v2/<brain-endpoint-id>/openai/v1/chat/completions
Authorization: Bearer <RP_AGENT_KEY|RP_API_KEY|RUNPOD_API_KEY>
{ "model": "Qwen/Qwen3-14B-AWQ", "messages": [...], "max_tokens": 32,
  "chat_template_kwargs": { "enable_thinking": false } }
```

* Ohne `enable_thinking: false` verbraucht der Qwen3-`<think>`-Block das
  Token-Budget komplett (gemessen: 16/16 Tokens, `finish_reason=length`, keine
  nutzbare Antwort). Mit der Payload des App-Pfads: `Paris`,
  `finish_reason=stop`, 2 Tokens. Die Abschaltung ist tragend, nicht kosmetisch -
  `LlmRouter` schickt sie deshalb standardmaessig mit.
* Kaltstart im Messlauf: 4m48s bzw. 2m35s (Worker-Skalierung von 0).
* Der Brain braucht **kein** `HF_TOKEN`; `Qwen/Qwen3-14B-AWQ` ist auf Hugging
  Face nicht gated (live ohne Token verifiziert).

## 5. AI-Orchestrator / LLM

| Erwartet | Verwendet | Default | Komponenten | Secret |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | – | src/core/ai/clientLlm.ts, LlmRouter | **ja** |
| `OLLAMA_URL` | `OLLAMA_URL` | http://127.0.0.1:11434 | LlmRouter (lokaler Fallback) | nein |
| `OLLAMA_MODEL` | `OLLAMA_MODEL` | qwen2.5:7b | LlmRouter | nein |
| `AI_JOB_TIMEOUT_MS` | `AI_JOB_TIMEOUT_MS` | 120000 | aiOrchestrator.ts | nein |
| `AI_SESSION_IDLE_TIMEOUT` | `AI_SESSION_IDLE_TIMEOUT` | – | SessionManager (Scale-to-Zero) | nein |
| `AI_LOG_LEVEL` | `AI_LOG_LEVEL` | INFO | aiLogger.ts | nein |
| `AI_COST_*` | `AI_COST_*_USD_PER_HOUR` u. a. | rollenabhängig | costTracker.ts | nein |
| `AI_CB_FAILURE_THRESHOLD` / `AI_CB_RESET_MS` | `AI_CB_*` | 5 / 30000 | circuitBreaker.ts | nein |
| `AI_MAX_VRAM` | `AI_MAX_VRAM` | 80 | modelManager.ts | nein |

## 6. Python-AI-Runtime (services/audiomonastry-ai-runtime)

| Name | Pflicht | Default | Secret |
|---|---|---|---|
| `AI_ROLE` | nein (Legacy-All) | – | nein |
| `AI_DEVICE` / `AI_RUNTIME_DEVICE` | nein | simulated | nein |
| `AI_MODEL_MANIFEST` | nein | model_manifest.json | nein |
| `HF_TOKEN` | nein | – | **ja** |
| `HF_HOME` | nein | /data/hf-cache | nein |
| `AI_MCP_PERMISSION` | nein | READ | nein |
| `AI_MCP_API_TOKEN` | nein | – | **ja** |
| `AI_UPLOAD_ROOT` / `AI_MAX_UPLOAD_MB` | nein | temp / 50 | nein |
| `AI_SEPARATION_TIMEOUT_SEC` | nein | 900 | nein |
| `AI_TASK_TIME_LIMIT_SEC` / `AI_TASK_SOFT_TIME_LIMIT_SEC` | nein | – | nein |
| `AI_RESULT_EXPIRES_SEC` | nein | – | nein |

## 7. Migrationsstrategie für Alias-Namen

1. Alias bleibt lesbar, wird aber beim Lesen mit `console.warn`/`aiLogger.warn` protokolliert.
2. `.env.TEMPLATE`/`.env.example`/`.env.hetzner.example` dokumentieren nur kanonische Namen.
3. Umstellung je Betreiber: alten Namen durch kanonischen ersetzen, App neu starten,
   Warnung verschwindet. Kein Code entfernt Alias-Namen unangekündigt.

## 8. Bekannte Altlasten (nicht still umbenannt)

**Stand 2026-09-17 (SEC-P1-002, gemessen statt vermutet):** Die lokale `.env`
wurde von den ungenutzten Cloudflare-/Comet-Tokens befreit. Entfernt:
`CFR2_API_KEY`, `CF_ACCESS_TOKEN`, `CF_API_TOKEN`, `CFR2_API_TOKEN`,
`COMET_API_KEY` (Backup der Datei: `.env.bak-<ts>-sec-p1-002`). `CF_API_KEY` und
`CF_ACCOUNT_TOKEN` waren bereits vorher aus der `.env` verschwunden.

Referenzprüfung (kein Code liest diese Namen - geprüft in `src/`, `server/`,
`services/`, `scripts/`, `.github/`, `docker-compose*`, `Dockerfile*`,
`Caddyfile`): einzig `CFR2_API_TOKEN` hatte einen Konsumenten,
`scripts/wake-on-login/deploy.sh` (Fallback `CF_TOKEN`) - dieser Token war bei
der Messung bereits **tot** (HTTP 401), das Skript war also schon vorher nicht
lauffähig und braucht für einen Wake-on-Login-Deploy einen frischen Token per
`CF_TOKEN`.

Gültigkeitsmessung 2026-09-17 gegen `GET https://api.cloudflare.com/client/v4/user/tokens/verify`:

| Token | Ergebnis | Konsequenz |
|---|---|---|
| `CF_API_TOKEN` | HTTP 200, `status: active` → **gültig** | **Korrektur 2026-09-23:** Hier stand „aus der `.env` entfernt" — das war FALSCH. Der Wert lag weiter in `.env` und in zwei `.env.bak-*`-Dateien (`SEC-P1-005`). Am 2026-09-23 nachgemessen und **tatsächlich entfernt**: 0 Dateien mit Wert, 0 Commits in der gesamten Historie. Offen bleibt der **Widerruf im Cloudflare-Dashboard** — lokales Löschen macht einen Token nicht ungültig (siehe `docs/SEC_CF_TOKEN_ROTATION.md`). |
| `CFR2_API_TOKEN` | HTTP 401 (Code 1000) → tot | entfernt |
| `CF_ACCESS_TOKEN` | HTTP 401 (Code 1000) → tot | entfernt |
| `CFR2_API_KEY`, `COMET_API_KEY` | nicht prüfbar / kein Repo-Konsument | entfernt (`COMET_API_KEY` gehört zur externen Deep-Code-Integration, nicht zum Repo) |

Weiter ungenutzt in der `.env`, aber **bewusst nicht angefasst** (kein
Repo-Konsument auffindbar, externe Werkzeuge des Betreibers sind nicht
ausschließbar - Betreiberentscheidung, siehe SEC-P1-002): `CFS3_PUBLIC_KEY`
(öffentlicher Schlüssel, kein Secret), `DNS_HC_TOKEN`, `GHCR_REPO`,
`GHCR_TOKEN` (`GHCR_USERNAME`/`GHCR_PASSWORD` werden von Deploy-Skripten
gelesen), `RP_S3_ACCESS_KEY`, `RP_S3_SECRET_KEY`, `SB_PROJECT_ID`,
`SB_REST_ENDPOINT`, `SQ_PERSONAL_TOKEN`. Diese gehören in einen eigenen
Aufräum-/Rotationslauf oder in die Löschung beim Anbieter; das bloße Entfernen
aus der `.env` widerruft sie nicht.

## 8b. Alarmzustellung (PROD-P1-004, 2026-09-18 gemessen)

Ohne `ALERT_WEBHOOK_TOKEN` antwortet `POST /api/alerts/webhook` mit
`401 STUDIO_TOKEN_REQUIRED` – genau das passierte live: der Alertmanager konnte
kein Studio-Cookie halten, jede Zustellung scheiterte. Reihenfolge deshalb:
Token setzen → Alertmanager rendert ihn beim Start in den
`http_config.authorization`-Header (Platzhalter `__ALERT_WEBHOOK_TOKEN__`) →
erst danach Alarme erwarten. `CRITICAL_WEBHOOK` ist der zweite, unabhaengige Weg
fuer Alarme, die die App selbst betreffen (App-Down) – ohne ihn zeigt
`http_config` weiter auf die App-Route.

## 3b. Hetzner Object Storage als Backup-Ziel (PROD-P0-002, 2026-09-14)

Kanonisch: `HOS_S3_*` (Hetzner Object Storage, S3-kompatibel). Der Uploader
`scripts/r2-backup.mjs` liest in dieser Reihenfolge: `BACKUP_S3_*` → `HOS_S3_*`
→ `CFS3_*`/`CFR2_*`. Damit ist das Backup-Ziel unabhaengig vom R2-Sample-Upload.

| Erwarteter ENV-Name | Verwendet von | Pflicht | Beispiel | Secret |
|---|---|---|---|---|
| `HOS_S3_ACCESS_KEY` | scripts/r2-backup.mjs, scripts/backup.sh --offsite | fuer Off-Site | 20 Zeichen (Hetzner-Format) | **ja** |
| `HOS_S3_SECRET_KEY` | dito | fuer Off-Site | 40 Zeichen (Hetzner-Format) | **ja** |
| `HOS_S3_ENDPOINT` | dito | fuer Off-Site | `https://nbg1.your-objectstorage.com` | nein |
| `HOS_S3_BUCKET` | dito | fuer Off-Site | `audiomonastry-backups` | nein |
| `HOS_S3_REGION` | dito (optional) | nein | `nbg1`/`fsn1`/`hel1` – wird sonst aus dem Endpoint abgeleitet | nein |

Wichtig: Hetzner Object Storage verlangt **`region` = Location** (nbg1/fsn1/hel1),
Cloudflare R2 dagegen `auto`. Der Uploader leitet das automatisch ab.
R2-Keys sind hex 32/64 Zeichen, Hetzner-Keys 20/40 Zeichen – daran sind sie zu
unterscheiden (server/cloud.ts validiert R2 streng auf hex32/hex64).

## Cloudflare-API-Token (2026-09-18, gemessen)

Der Betreiber hat einen Cloudflare-API-Token bereitgestellt. Er liegt **nur** in der
gitignorierten `.env` (`CF_API_TOKEN`, `CF_ACCOUNT_ID`) — **kein Repo-Konsument**
(siehe SEC-P1-002 oben), sondern ein Betreiber-Werkzeug.

Gemessener Umfang (Probes gegen `api.cloudflare.com/client/v4`):

| Endpunkt | Ergebnis |
|---|---|
| `/accounts/<id>/tokens/verify` | 200, `status: active` |
| `/accounts/<id>/workers/scripts` | 200 — Worker können gelesen/ausgerollt werden |
| `/accounts/<id>/storage/kv/namespaces` | 200 (KV, im Account aktuell leer) |
| `/zones?name=anunnakitools.de` | 200 (Zone lesbar) |
| `/zones/<id>/dns_records` | **Authentication error** — **kein DNS-Zugriff** |

Konsequenz (live gemessen, siehe `docs/OPS_RUNBOOK.md`): der Token reicht für Worker-Deploy
und KV, aber **nicht**, um `origin.anunnakitools.de` auf die neue app-1-IP zu setzen — genau
das braucht der Wake (`POST /api/wire-fleet` → `dns.ok: false`). Für einen vollständigen
Wake-Pfad braucht es zusätzlich die Berechtigung `Zone → DNS → Edit` (oder einen eigenen
`origin`-A-Record, der die Floating-IP nutzt).

**Sicherheitshinweis:** Der Token wurde im Klartext übergeben. Er gehört nach getaner Arbeit
im Cloudflare-Dashboard rotiert; ein Commit enthält ihn nicht (`.env` ist gitignoriert).
