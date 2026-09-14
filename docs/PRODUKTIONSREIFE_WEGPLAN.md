# Produktionsreife-Wegplan audioMONASTRY

**Datum:** 2026-09-14 · **Basis-Commit:** a937edc (`main`, gepusht)
**Auftrag:** tiefe Analyse des Ist-Stands + Wegplan bis zur Produktionsreife; Instanzen
dürfen hochgefahren und bespielt werden, **Kostendeckel 1,50 € für RunPod + Hetzner**;
Soundkarte muss auf dem **Onboard-Chip ohne Grafikkarte** funktionieren.
**Verbraucht bisher: 0,00 €** (keine Cloud-Zugangsdaten vorhanden, s. §6) — alle
Nachweise kommen von der Zielmaschine selbst (Hostname `audioMONASTRY`).

Werkzeuge/Skills in diesem Lauf: `audioaudit` (Modus A: Audioqualität, Modus D:
Engine-Code-Audit), `runpod` (Provisioning-/Kostenrahmen), `ffmpeg`/`aplay`/`amixer`,
`docker compose config`, `curl`, Playwright-Gates.

---

## 1. Was in diesem Lauf real gemessen wurde

| # | Prüfung | Kommando (Auszug) | Ergebnis |
|---|---|---|---|
| 1 | **Onboard-Soundkarte ohne GPU** | `aplay -D plughw:0,0 probe_1k.wav` + `cat /proc/asound/card0/pcm0p/sub0/status` | **PASS** — Karte 0 `HDA Intel PCH` / `ALC269VB Analog`, 48 000 Hz stereo, PCM `RUNNING` → `DRAINING` → `closed`, `aplay exit=0` |
| 2 | Grafikkarte vorhanden? | `nvidia-smi -L` | `command not found` → **keine GPU**, Test lief trotzdem |
| 3 | Mixer nicht gemutet | `amixer sget Master` | `Front Left/Right: Playback … [on]` (95 %, für den Test auf 50 % und zurück) |
| 4 | Server headless startbar | `PORT=3901 node dist/server.cjs` | **PASS** — `audioMONASTRY running on http://0.0.0.0:3901`, ohne GPU/Audio-Device-Abhängigkeit |
| 5 | Fail-closed-Posture | 18 Routen ohne Token | nur `/api/health` = 200; **alles andere 401** (by design, `server.ts:340-350`) |
| 6 | Routen liefern echte Daten | mit `x-studio-token` | `/api/metrics` JSON · `/api/online` `{"online":0}` · `/api/webrtc-config` ICE+**TURN** · `/api/stem/status` · `/api/audit` `{"entries":[],"total":0}` |
| 7 | Eingabevalidierung | POST `{}` | `/api/voice/tts` → 400 `text fehlt` · `/api/upload/sample` → 415 `Erwartet multipart/form-data` |
| 8 | Deploy-Manifeste | `docker compose -f … config --quiet` | `docker-compose.hetzner.yml`/`.monitoring.yml`/`.ai.yml` **valide**; `docker-compose.sfu.yml` **invalide** (s. §3) |
| 9 | Test-Basis | `npx vitest run` | **1.445/1.445** grün (210 Dateien), `npm run verify` exit 0 |

**Konsequenz aus 1–3:** Die geforderte Konstellation „Onboard-Soundchip, keine
Grafikkarte" ist auf dieser Maschine **bewiesen**. Der Audio-Pfad des Servers
(FFmpeg-Nummern, Stem-/Master-Rendering, RTP/SFU) ist geräteunabhängig; die
Soundkarte ist nur für die **Wiedergabe** relevant (Browser des Operators oder ein
lokaler RTP-Empfänger).

---

## 2. Reifegrad je Bereich

| Bereich | Ampel | Beleg / Lücke |
|---|---|---|
| Deploy-Skript + Rollback | 🟡 | `deploy.sh` taggt Rollback-Image, wartet auf `/api/health`, kein **Rollback-Drill** |
| TLS/Proxy | 🟡 | `Caddyfile` mit Reverse-Proxy, Cache- und CORS-Headern; Domain/TLS real nicht geprüft |
| Monitoring | 🔴 | Prometheus/Alertmanager/node-exporter/cadvisor vorhanden — **Metriken sind 401**, Scrape-Pfad ohne Token |
| Backup/Recovery | 🔴 | `scripts/backup.sh` sichert nur `dist` + `public/uploads` **lokal** als tar.gz; kein Off-Site, kein DB-Dump, kein Restore-Test |
| Security | 🟢/🟡 | fail-closed ✓, Security-Header ✓, `npm audit` 0, semgrep 0, Boundary-Scan ✓; Pen-Test/Rotation nicht belegt |
| Audio-Engine (Code) | 🟢 | `npm run verify` exit 0, 1.445 Tests; Worklet-Messlücken offen (PERF-P3-002) |
| Audio-Hardware | 🟡 | Onboard-Chip 48 kHz bewiesen; 44,1/96 kHz, Buffer-Größen, Xruns, USB-Interface offen |
| Audio-Qualität | 🔴 | **keine** Golden-WAVs und **keine** LUFS/True-Peak-Gates im CI |
| Daten/Persistenz | 🟡 | Session-Snapshots + Autosave ✓ (PERSIST-P1-002 DONE) |
| AI-Flotte | 🟡 | Endpoints/Budget-Regeln im SSOT, `/api/stem/status` live; Restpakete offen (AI-P1-003) |
| CI/CD | 🟢/🟡 | 10 Workflows, build+verify, runpod-deploy, live-stress (on-demand); Deploy auf Hetzner nicht automatisiert |

---

## 3. Befunde mit Beweis

### P0 — Blocker für echten Produktionsbetrieb

**P0-1 · Monitoring kann die Metriken nicht abholen.**
`/api/metrics` und `/api/online` antworten ohne `x-studio-token` mit **401**
(gemessen, §1/5). Prometheus braucht einen erreichbaren Scrape-Endpunkt. Ohne
Freigabe gibt es keine Latenz-/Fehler-/Xrun-Sicht im Betrieb — und genau die
braucht das 4-User-Latenzversprechen.
*Fix:* eigener, token-geschützter Scrape-Pfad (Bearer/mTLS) **oder** Bind auf
localhost/Internes Netz + dokumentierte Ausnahme in `server.ts:340-420`; dann
`curl`-Nachweis + Alertregel-Test.

**P0-2 · Backup ist nicht katastrophenfest.**
`scripts/backup.sh` legt `audiomonastry_<stamp>.tar.gz` mit Rotation im **lokalen**
Verzeichnis ab. Kein Off-Site-Ziel, kein Supabase-/DB-Dump, kein Restore-Nachweis.
Ein Plattenverlust oder eine kaputte Migration ist damit ein Totalverlust.
*Fix:* Off-Site-Ziel (S3/R2), DB-Dump (Supabase `pg_dump`/API), **Restore-Drill**
auf einer Wegwerf-Instanz, RPO/RTO im Runbook.

**P0-3 · Deploy/Rollback auf einer echten Instanz ist nie gelaufen.**
`deploy.sh` ist vorhanden (Rollback-Tag, Health-Wait), aber es gibt keinen
Nachweis: kein Deploy-Log, kein Rollback-Test. Zusätzlich fehlen der
Agent-Umgebung die Zugangsdaten (§6).
*Fix:* ein Deploy + ein bewusster Rollback auf einer kleinen Hetzner-Instanz,
Ergebnis im Runbook; Kosten s. §6.

**P0-4 · `docker-compose.sfu.yml` ist allein nicht deploybar.**
`docker compose -f docker-compose.sfu.yml config` bricht ab:
`service "sample-monk" has neither an image nor a build context specified` und
`SFU_ANNOUNCED_IP is not set`. Es ist ein Overlay — das steht nirgends.
*Fix:* Overlay in Datei-Kommentar/`HETZNER_DEPLOY.md` dokumentieren, in CI mit
`docker compose config -f docker-compose.yml -f docker-compose.sfu.yml` validieren.

### P1 — Produktreife

**P1-1 · `/api/separate-stems` liefert bei leerem Upload simulierte Stems.**
Gemessen: `POST /api/separate-stems` mit `{}` streamt `progress 20…100`. Ursache:
der Fallback-Stub (`server/routes/stemRoutes.ts`, Kommentar „Fallback: simulierte
4-Stem-Aufteilung (Stub) mit Fortschritt“) greift, wenn keine Datei ankommt; der
`files.length === 0`-Guard steht nur im nicht-streamenden Zweig.
*Risiko:* Ein Client hält ein Stub-Ergebnis für echte Trennung.
*Fix:* leerer Upload → 400; Stub nur bei `STEM_AI_PROVIDER=fallback` und dann
`simulated: true` in jeder Antwort.

**P1-2 · Keine Audio-Qualitäts-Gates.**
Kein WAV-Fixture im Repo (`assets/` enthält nur `.aistudio`), kein
`ebur128`/LUFS/True-Peak-Lauf in CI, obwohl Zielwerte dokumentiert sind.
*Fix:* Golden-WAVs (`scripts/generate-golden-wav.ts` erzeugt sie), Gate auf
LUFS/True-Peak/Clipping (audioaudit Modus A) mit Toleranzfenster, in `npm run verify`.

**P1-3 · Soundkarten-Matrix ist zu dünn.**
Bewiesen ist 48 kHz stereo über `plughw:0,0`. Nicht geprüft: 44,1/96/192 kHz,
Buffer-Größen (64/128/256/512), Xrun-Zähler unter Last, Onboard vs. USB-Interface,
RTP/SFU-Wiedergabe auf derselben Maschine.
*Fix:* Matrix in §5 abarbeiten, Xrun-/Latenz-Telemetrie (`metrics.telemetryXruns`)
gegen die SLOs stellen.

**P1-4 · 4-User-Live-E2E und WebRTC/TURN-Härtung fehlen** (SSOT: COLLAB-P0-002
PARTIAL, COLLAB-P0-003 BLOCKED) — inklusive Live-Stress gegen die echte Instanz
(`.github/workflows/live-stress.yml` ist on-demand vorhanden).

**P1-5 · Worklet-Messlücken** (SSOT: PERF-P3-002 BLOCKED): `renderCapacity` und
Max-Blockzeit sind nicht messbar → Latenzversprechen (< 10 ms) ist nicht belegt.

### P2 — Härtung/Betrieb

- **P2-1** Observability-Dashboards + SLOs + Log-Rotation prüfen (json-file-Limits
  sind in den Compose-Dateien gesetzt ✓), Fehler-Tracking/Alert-Zustellung testen.
- **P2-2** AI-Kosten-Guard scharf stellen (`budget.fleetMaxEurPerHour`=10,
  `fleetEndpointsMax`=5 existieren als Regel; Alarm bei Überschreitung fehlt).
- **P2-3** Security: Rotation von `STUDIO_ACCESS_TOKEN`/`ADMIN_TOKEN`/TURN-Secrets
  nach Runbook (Kap. 1/5 vorhanden) einmal real durchspielen, CORS-Allowlist
  gegen die Produktionsdomain prüfen.
- **P2-4** CI: Compose-Validierung + `check:dupes`-Budget als Gate, Deploy-Workflow
  für Hetzner (heute nur `runpod-deploy.yml`).

---

## 4. Wegplan in Phasen

### Phase 0 — Zugang & Sicherheitsnetz (½ Tag, 0 €)
1. Zugangsdaten bereitstellen: `RUNPOD_API_KEY`, Hetzner-Token/SSH-Ziel, Off-Site-Ziel (R2/S3).
2. `bash scripts/backup.sh` **einmal** mit Off-Site-Ziel + Restore in ein temporäres
   Verzeichnis; Ergebnis dokumentieren.
3. **Akzeptanz:** Restore liefert lauffähige `dist` + `public/uploads`; Runbook-Kapitel
   „Restore" existiert.

### Phase 1 — Transparenz (1 Tag, ~0,10 €)
4. Metrik-Scrape freigeben (P0-1) und `curl -s <metrics-url> | head` als Nachweis.
5. Prometheus + Alertmanager starten (`docker compose -f docker-compose.monitoring.yml up -d`),
   eine Testregel (z. B. `up == 0`) bis zur Zustellung durchspielen.
6. **Akzeptanz:** Dashboard zeigt `samplemonk_*`-Metriken; ein künstlich erzeugter
   Fehler löst sichtbar einen Alarm aus.

### Phase 2 — Echter Deploy + Rollback (1 Tag, ~0,20 €)
7. Kleine Instanz (Hetzner CX22, s. §6) provisionieren, `deploy.sh` gegen sie fahren.
8. Bewusst ein kaputtes Image deployen → Rollback-Tag zurückrollen, `/api/health`
   beobachten.
9. Live-Stress einmal on-demand gegen die Instanz (`.github/workflows/live-stress.yml`).
10. **Akzeptanz:** Deploy-Log + Rollback-Log + Health-Nachweis im Runbook; Instanz
    danach gelöscht (Kostenstopp).

### Phase 3 — Audio-Beweise (1 Tag, 0 € lokal)
11. P1-1 fixen (Stub gaten/labeln, leerer Upload → 400) + Test.
12. Golden-WAVs + LUFS/True-Peak-Gate (P1-2) in `npm run verify` aufnehmen.
13. Soundkarten-Matrix §5 abarbeiten, Ergebnisse in `HARDWARE_TEST_MATRIX_2026.md`.
14. **Akzeptanz:** Gate schlägt bei absichtlich übersteuertem WAV fehl; Matrix
    vollständig mit Messwerten gefüllt.

### Phase 4 — Collaboration & Latenz (2–3 Tage, 0 € lokal)
15. 4-User-Live-E2E gegen die echte Instanz (COLLAB-P0-002) + SFU/TURN-Härtung
    (COLLAB-P0-003).
16. Worklet-Messlücken schließen, Latenz- und Xrun-SLO aus der Telemetrie ableiten
    (PERF-P3-002, LIVE-P1-003).
17. **Akzeptanz:** Latenz-/Xrun-Zahlen über 30 min unter 4 Nutzern im Report.

### Phase 5 — Reste/Vision (nach Bedarf, GPU nur mit separatem Budget)
18. VISUAL-P1-001 (Ghostuser-Beweis), VISUAL-P1-009 (WebGPU), VISUAL-P1-007
    (Stil-LoRA auf RunPod — **sprengt 1,50 €**, eigener Auftrag), AI-P1-003.

---

## 5. Soundkarten-/Headless-Testmatrix (Onboard-Chip, keine GPU)

| Fall | Kommando | Erwartung |
|---|---|---|
| Chip vorhanden | `aplay -l` | Karte 0 `HDA Intel PCH`, `ALC269VB Analog` ✓ **erledigt** |
| Mixer offen | `amixer sget Master` | `[on]`, Pegel > 0 ✓ **erledigt** |
| Wiedergabe 48 kHz | `aplay -D plughw:0,0 tone.wav` | `exit=0`, PCM `RUNNING` ✓ **erledigt** |
| 44,1 kHz | `aplay -D plughw:0,0 tone_44k1.wav` | `exit=0` (Resampling durch `plughw`) |
| 96 kHz | `aplay -D plughw:0,0 tone_96k.wav` | `exit=0` oder dokumentierter Fehler |
| Buffer-Größen | `aplay -D plughw:0,0 --buffer-time=… --period-time=…` | keine Xruns bis Zielwert |
| Xruns unter Last | `cat /proc/asound/card0/pcm0p/sub0/xrun_debug` (bzw. `--xrun`) | Zähler bleibt 0 |
| Aufnahme | `arecord -D plughw:0,0 -f cd -d 3 mic.wav` | Datei entsteht (Onboard-Mic je Modell) |
| RTP/SFU → Chip | SFU-Testlauf + `ffplay`/`aplay` auf dem empfangenen Stream | hörbar, PCM `RUNNING` |
| Headless ohne X | Server + `curl /api/health` | läuft ohne Display ✓ **erledigt** |

**Wichtige Cloud-Realität (Kosten sparen):** RunPod- und Hetzner-VMs haben
**keine Soundkarte** (`/dev/snd` fehlt). Ein „Soundchip-Test in der Cloud" ist
deshalb nicht möglich; dort lässt sich nur der *serverbseitige* Audio-Pfad
(Rendering, Stem-/Master-Dienste, RTP-Versand) prüfen, die Wiedergabe auf dem Chip
nur auf Hardware wie dieser Maschine oder über einen PulseAudio-Null-Sink zur
Verifikation der API-Aufrufe (`pactl load-module module-null-sink`).

---

## 6. Kostenplan (Deckel 1,50 €)

| Posten | Größe | Preis | Dauer | Kosten |
|---|---|---|---|---|
| Hetzner CX22 (2 vCPU/4 GB) Deploy+Rollback | ~0,0045 €/h | 2 Tage | ca. 0,22 € |
| Hetzner CX22 Storage/Backup-Volumen | minimal | pauschal | 2 Tage | ca. 0,05 € |
| RunPod CPU-Pod (2 vCPU) Serverless-Image-Smoke | ca. 0,10 €/h | 30 min | ca. 0,05 € |
| RunPod GPU (nur falls Stil-LoRA) | ≥ 0,30 €/h | — | **nicht im Deckel** | eigener Auftrag |
| **Summe Phase 0–4** | | | | **≈ 0,30 €** |

**Blocker heute:** `runpodctl user` → `{"error":"api key not found"}`; kein
`HCLOUD_TOKEN`/`HETZNER_*` in der Umgebung; RunPod-MCP ist verbunden, aber ohne
belastbaren Guthaben-/Key-Nachweis starte ich keine kostenpflichtige Instanz.
Deshalb: **0,00 € ausgegeben**, Restdecke bleibt für Phase 2/6 übrig. Sobald die
Zugangsdaten da sind, ist die Reihenfolge in §4 einzuhalten und jede Instanz
**sofort nach dem Nachweis zu löschen** (`runpodctl pod delete` / `hcloud server delete`).

---

## 7. Definition of Done „Produktionsreif"

- [ ] Deploy **und** Rollback auf einer echten Instanz nachgewiesen (Log im Runbook)
- [ ] `/api/health` + Metrik-Scrape von außen erreichbar, Alarm zugestellt
- [ ] Backup off-site + Restore-Drill dokumentiert (RPO/RTO benannt)
- [ ] `npm run verify` grün **inkl.** Audio-Gate (LUFS/True-Peak) und Compose-Validierung
- [ ] Soundkarten-Matrix §5 vollständig mit Messwerten
- [ ] 4-User-Live-E2E + Latenz-/Xrun-Report (30 min) ohne SLO-Verletzung
- [ ] Secrets-Rotation einmal real durchgespielt, CORS/Allowlist gegen Produktionsdomain geprüft
- [ ] Kein Route-Handler liefert im Fehlerfall ein Stub-Ergebnis ohne Kennzeichnung

---

## 8. Verweise

`docs/OPS_RUNBOOK.md` · `docs/HETZNER_DEPLOY.md` · `docs/HARDWARE_TEST_MATRIX_2026.md` ·
`docs/ENV_MATRIX.md` · `docs/AI_COST_GUIDE.md` · `docs/AI_OPERATIONS.md` ·
`Caddyfile` · `deploy.sh` · `scripts/backup.sh` · `docker-compose*.yml` ·
`.github/workflows/live-stress.yml` · `MASTERTODOENDE.json` (Aufgaben: PROD-P0-001…P1-0x)
