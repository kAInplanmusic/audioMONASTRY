# DEEP-TEST-PLAN · Hetzner-only E2E: Deploy auf neusten Stand + autonome Browser-Verifikation

**Stand:** 2026-09-29 · **Scope:** audioMONASTRY-App komplett, aber **ohne AI/RunPod** —
nur Hetzner-Knoten + App + Infra-Skripte. Kein MCP, keine Hermes-Plugins, keine externen
Dienste außer Hetzner-Cloud-API + DNS (Cloudflare), Linux-Bordmittel + Playwright lokal.

---

## 0. Vorbefund (Recon 2026-09-29, belegt)

- Hetzner-Live: **1 Server `pa-test-01`, status=off**, IP 78.47.65.129 — die audioMONASTRY-Flotte
  (app-1/sfu-1/ai-1/master-1/edge-1) existiert **nicht mehr** (Kostenstopp 2026-09-11, SSOT
  `fleetState2026_09_11`). Snapshots: 10 kanonische `audiomonastry-*` (2026-09-21/25) vorhanden.
- Playwright-Infra **existiert bereits**: `tests/e2e/` mit 19 Specs (smoke, audio-smoke, collab,
  live2browser, performance, visual, …) + helpers. Paket-JSON defekt/leer — zu reparieren (T1).
- Deploy-Werkzeuge vollständig: `bring-up-fleet.sh`, `fleet-deploy-live.sh`, `fleet-preflight.sh`,
  `smoke-test.sh`, `lifecycle.sh`, `push-node-env.sh`, cloud-init, Caddyfiles, Prometheus/Grafana.
- Test-Runner repariert (Paket C): `npm test` = `NODE_ENV=test vitest run` — 2228/2228 grün.

---

## 1. Was „neuester Stand" hier heißt (Deployment-Ziel)

1. **Code:** `main @ HEAD` (nach dem Audit-Push: flux1-dev-SSOT, NODE_ENV-Pinning,
   deploy-Idempotenz, Legacy-Bereinigung).
2. **App-Deploy ohne AI:** Die Flotte wird mit **allen 5 Hetzner-Rollen** hochgezogen, aber
   `ai-1` bekommt **keine RunPod-Credentials und keine AI-Env** — die App läuft mit
   `AI_MODE=off` (Killschalter existiert: `tests/killSwitch.test.ts`, aiGate). RunPod-Aufrufe
   sind dann strukturell ausgeschlossen (fail-closed), kein einziger GPU-Cent möglich.
3. **Konfig:** STUDIO_ACCESS_TOKEN gesetzt (fail-closed-Gate), HTTPS via Caddy, Media-Ports
   offen (check-media-ports.sh), Prometheus/Grafana mit.

## 2. Phasen

### T0 — Preflight (lokal, 10 min)
- `scripts/hetzner/fleet-preflight.sh` + `.env.deploy`-Vollständigkeitscheck
  (HCLOUD_TOKEN, CF-Tokens, STUDIO_ACCESS_TOKEN, DOMAIN).
- Kosten-Gate: Rechenbeispiel ausgeben (5 × Serverstundensatz + Volume), **Betreiber-OK
  einholen** (Konstitution: nur laufende Stunden zahlen; Ende des Tests = `lifecycle.sh stop`).
- Git-Stand einfrieren (`git rev-parse HEAD` → ins Test-Protokoll).

### T1 — Test-Infra reparieren (lokal, 30 min, ohne Kosten)
- `tests/e2e/package.json` neu aufsetzen (Playwright-Version lock auf root-lock),
  `playwright install chromium`, Config: `baseURL` + `x-studio-token`-Header aus Env.
- Trockenlauf der 19 Specs gegen eine **lokale** App-Instanz (`npm run dev` bzw. `start-prod.sh`
  lokal) — alle Specs, die RunPod/AI mocken oder brauchen, mit `@ai` taggen und in T4 überspringen.

### T2 — Flotte hochziehen (Hetzner, ~20 min, Kosten ab hier)
- `bash scripts/hetzner/bring-up-fleet.sh` (Snapshots 2026-09-25 vorhanden → schneller Start).
- `fleet-deploy-live.sh` (neuester Code auf die Knoten; ai-1 mit AI_MODE=off).
- `push-node-env.sh` (STUDIO_ACCESS_TOKEN & Co), `ensure-tls-terminator.sh`, `wire-scrape-token.sh`.
- Gates: `check-media-ports.sh`, `fleet-status.sh` (5 Knoten up), `rls-live-check.sh`,
  Smoke: `smoke-test.sh https://<domain>` (health, cloud/health).

### T3 — Infra-Tiefe (Hetzner, 20 min, automatisch)
- Prometheus-Targets alle grün, Grafana reachable, Alertmanager-Webhook trocken.
- Backup-Timer + Idle-Shutdown installiert (`install-backup-timer.sh`, `install-idle-shutdown.sh`)
  und systemd-Units `active` — **beide sind die Kosten-Bremse für vergessene Flotten**.
- Security-Check vom Client: 503-Expectations (Studio-Gate fail-closed von außen),
  TLS-Grade, offene Ports nur 80/443/UDP-Media.

### T4 — Autonome Browser-Tests (Playwright, 60–90 min, läuft ohne Aufsicht)
Reihenfolge nach Risiko, jede Stufe schreibt Bericht + Screenshots + Trace:
1. `smoke.spec.ts` + `startState.spec.ts` — App lädt, Studio-Auth, kein White-Screen.
2. `masterPlayerFixed.spec.ts` + `audioAction.spec.ts` + `audio-smoke.spec.ts` — Player,
   Aktionen, Audio-Pfade (ohne AI-Drop: Drop-Button → erwartete „AI aus"-Meldung = **korrektes
   Verhalten** bei AI_MODE=off, negativ-getestet!).
3. `collab.spec.ts` + `live2browser.spec.ts` + `monitorCue.spec.ts` — Multi-Client/WebSocket-
   Verhalten (2 Browser-Kontexte), SFU-RTP-Health via `sfu-rtp-run.mjs`.
4. `visual.spec.ts` — Visual-Pfad ohne AI (Canvas/shader lokal), MJPEG-Fallback.
5. `performance.spec.ts` + `stress.spec.ts` (reduziert) + `responsive.spec.ts` + `keyboard.spec.ts`
   + `a11y.spec.ts` + `pluginCloseSync.spec.ts` + `scratchpad.spec.ts` + `hardware.spec.ts`.
6. **Negativ-Suite (neu, schreibt der Runner):** /api/ai/* → 503/4xx ohne Token; mit Token →
   AI_DISABLED-Antwort (kein RunPod-DNS-Traffic, per tcpdump-Probe auf ai-1 belegbar),
   Health-Endpoints offen, Rate-Limiter greift.
Ergebnisprotokoll: JUnit-XML + HTML-Report + Traces in `test-results/e2e-hetzner/<ts>/`.

### T5 — Bericht + Abbau (10 min)
- Runner schreibt `docs/DEEPTEST-REPORT-<ts>.md` (Pass/Fail je Spec, Server-Metriken,
  Deploy-SHA, Kostenstunden).
- **Kosten-Stopp:** `lifecycle.sh stop` (Skalierung auf 0) — off-Server kosten ~nichts,
  Snapshots bleiben für den nächsten Lauf erhalten.
- SSOT-Eintrag: LIVE-P1-003/PROD-P3-F8-F9-F10-Beweise ergänzen (wenn grün).

## 3. Autonomie-Design (Selbststeuerung des Test-Runners)

- **Orchestrierung:** ein Skript `scripts/hetzner/deep-test-run.sh` (Phase T0→T5, stop-on-red
  mit Wahl „retry ×1"), jede Phase schreibt Statuszeilen in eine Progress-Datei (für Polling).
- **Kein LLM im Loop nötig** — deterministisch; nur bei Fehlern optional KI-Diagnose
  (llm7/DeepSeek-Flash, Budget $1) über die Log-Exzerpte.
- **Sicherheiten:** Hard-Timeout je Phase; Kosten-Zähler (Stunden × Satz) mit Abbruch-Grenze;
  `lifecycle.sh stop` läuft IMMER (auch bei Abort, via trap).
- **Wo der Agent (ich) dazwischentreten darf:** Log-Analyse bei roten Specs, Fix-Vorschläge,
  SSOT-Pflege — keine Server-Interaktion ohne protokollierte Befehle.

## 4. Offene Punkte / Entscheidungen Betreiber

1. **Kosten-Freigabe T2–T5** (5 Knoten ≈ 3–5 € für einen vollen Lauf, mit Idle-Shutdown
   darunter). LAUF NUR MIT OK.
2. **DNS/Domain:** Läuft der Test gegen die echte Domain (Cloudflare umhängen) oder gegen
   eine Test-Subdomain? (Empfehlung: Subdomain, CF-Token nötig.)
3. `pa-test-01` (off, 78.47.65.129): gehören die 3 `pa-test-01`-Snapshots zum publish-ready-Test?
   Dann bleiben sie unberührt.
4. SSOT INFRA-RUNPOD-014/015 (Deploy-Defaults auf worker-comfyui) sind **Hetzner-Test-unabhängig**
   — bleiben RunPod-seitig offen, bis der nächste manuelle Deploy/Verifikation läuft.

## 5. Definition of Done

- [ ] T0–T5 grün durchgelaufen, Report im Repo
- [ ] Alle nicht-`@ai`-Specs grün gegen die Hetzner-Instanz
- [ ] Negativ-Suite: AI strikt off belegt (kein RunPod-Traffic)
- [ ] Flotte gestoppt (Kosten 0), Snapshots intakt
- [ ] SSOT aktualisiert (LIVE/PROD-Beweise)
