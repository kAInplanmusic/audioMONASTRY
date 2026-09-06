# MASTER_TODO – audioMONASTRY

> Deep Audit 2026-09-05 · autonome Ausführung (Phase 0–7) · Cerebras/Backgroundcoder/deepcode-Methodik

---

## Audit-Zusammenfassung

| Kennzahl | Wert |
|---|---|
| Datum | 2026-09-05 |
| Scope | Gesamtes Repo (git-tracked): 21 Plugins, 12 Services, 7 DB-Migrationen, 40+ Skripte, CI/Workflows, Infra (Hetzner/Cloudflare/Supabase) |
| Phase 0 Flotte | 5/5 Server running, `https://anunnakitools.de/api/health` → HTTP 200 |
| Statische Analyse | OpenGrep 545 Regeln / 744 Dateien → **53 Findings (0 ERROR)**, ESLint → 76 Warnungen (0 Errors), tsc → 0 Fehler, npm audit → 0 Vulnerabilities |
| Live-Tests | Replicate Demucs-Job **real gelaufen (OK)**, Supabase-Migrationen 002–005 + `match_samples` **OK**, Hetzner-Stresstest HTTP-Pfad **OK**, Socket.io-Session-Test **unvollständig** (unauthorized, siehe H-1) |
| Findings | CRITICAL: 0 · HIGH: 2 · MEDIUM: 7 · LOW: 6 |
| Gegenprüfung | Cerebras (Backgroundcoder #7) für SCHWER-Analysen; übrige Befunde statisch/durch Live-Test verifiziert |

---

## Bereits im Audit behoben (Phase 6)

- **TURN-Secret-Leak (CRITICAL):** hartcodiertes Secret entfernt, per `TURN_STATIC_AUTH_SECRET`/Env injiziert, Git-History via `git-filter-repo` gesäubert (alle 4 Branches), coturn auf sfu-1 deployt (`lt-cred-mech` + statischer User), `VITE_TURN_*` in `.env.deploy`.
- **Shell-Injection in `live-stress.yml` (HIGH):** `${{ inputs.base_url }}` läuft jetzt ausschließlich über `env:`.
- **Script-Injection in `live-stress.yml` (HIGH):** `github-script` bekommt `STRESS_BASE_URL` als Env.
- **dynamic-urllib (MEDIUM):** `scripts/hetzner/dns_setup.py` + `provision.py` mit `_safe_url()`-Allowlist.
- **insecure-object-assign (MEDIUM):** `hfRouter.mjs` Budget-Merge mit Schema-Validierung.
- **non-literal-regexp (MEDIUM):** `scripts/deep-audit/pattern.ts` mit statischer `VALID_GLOB_RE`.
- **ESLint-Error `DOMAIN_AGENT_OVERRIDE` (LOW):** entfernt.
- **MixerMONK-UI:** nach `uimixerMONK.PNG` + `uimixercontroller1/2.jpg` neu gebaut (CDJ/DJS/LIB-Controller, 6-Kanal-Konsole, größere Schrift, Breitbild, dynamische Breite).
- **App-UX:** doppelte Toolbar entfernt, masterplayerMONK sticky + PLAY/STOP, Header öffnet Module (Touch), Auflösungsanzeige, Logo auf `logofullsize.png`.

---

## Offene TODOs

### [HIGH]

#### H-1 Socket.io-Stresstest kann Session-Pfad nicht prüfen (unauthorized)
- **Kategorie:** Testing / Infra-Deployment
- **Betroffene Dateien/Module:** `scripts/hetzner/stress-test.mjs`, `services/signaling/index.js`, `server.ts`
- **Beschreibung:** Live-Lasttest gegen `anunnakitools.de` lief im HTTP-Pfad durch; der Socket.io-Session-Test bekam für alle Clients `connect_error: unauthorized` → „zu wenige Verbindungen (0 < 5)“. Gefunden per echtem Live-Test (Phase 4). Die Ablehnung ist sicherheitstechnisch korrekt (Auth greift), aber der Test kann den Mehr-User-Pfad damit nicht validieren.
- **Auswirkung:** Session-/Multi-User-Verhalten unter Last bleibt ungetestet; Regressionen im Kollaborationspfad fallen erst im Betrieb auf.
- **Empfohlener Fix:** Test-Fixture mit gültigen Session-Tokens (Dev-Credential aus `.env`/Test-User) ausstatten oder separaten „unauthorized expected“-Assert einbauen; anschließend Session-Test erneut gegen Flotte fahren.
- **Aufwand:** M
- **Status:** Offen
- **Gegenprüfung:** Nur von einer Instanz geprüft (Live-Test)

#### H-2 Workflow-Actions nur mit mutablem Tag gepinnt (Supply-Chain)
- **Kategorie:** Security
- **Betroffene Dateien/Module:** 8 Workflows (`build.yml`, `deep-audit.yml`, `nightly.yml`, `live-stress.yml`, `hf-endpoint.yml`, `ai.yml`, `main.yml`, `sonarcloud.yml`)
- **Beschreibung:** OpenGrep meldet 35 Stellen mit `actions/*@v4`-Pinning (mutable Tags). Statischer Fund (Phase 2).
- **Auswirkung:** Kompromittierte Action-Release-Tags könnten Code/Secrets im CI-Runner ausführen.
- **Empfohlener Fix:** Alle Actions auf vollständige Commit-SHA pinnen (Renovate/Dependabot für Updates konfigurieren).
- **Aufwand:** M
- **Status:** Offen
- **Gegenprüfung:** Bestätigt (OpenGrep + manuelle Sichtung)

### [MEDIUM]

#### M-1 Interne Services ohne HTTPS-Bindung (midi-bridge, signaling)
- **Kategorie:** Security / Infra-Deployment
- **Betroffene Dateien/Module:** `services/midi-bridge/index.js:146`, `services/signaling/index.js:6`
- **Beschreibung:** Beide Services starten `http.createServer` (Klartext). Statischer Fund. Sofern sie nur intern/über Caddy-TLS erreichbar sind, akzeptabel.
- **Auswirkung:** Bei direkter Exposition sind MIDI-/Signaling-Verkehr und ggf. Credentials abhörbar.
- **Empfohlener Fix:** Bindung an `127.0.0.1` (oder internes Netz) erzwingen, TLS-Terminierung dokumentieren.
- **Aufwand:** S
- **Status:** Offen
- **Gegenprüfung:** Bestätigt (OpenGrep + manuelle Sichtung)

#### M-2 aiMONK-Kommando „fade-in in MAIN“ nicht als atomarer Befehl vorhanden
- **Kategorie:** AI-Integration
- **Betroffene Dateien/Module:** `src/core/voice/pluginCommandRegistry.ts`, `src/core/ai/orchestrator/aiOrchestrator.ts`
- **Beschreibung:** `setBpm` und Kanal-Load/Trigger sind im Command-Registry vorhanden, ein zeitgesteuerter **Fade-in auf MAIN** („Lied von Len Faki auf Kanal 1, BPM 100, langsam in MAIN faden“) existiert nicht als einzelner Befehl. Gefunden per Trace-Simulation des Nutzerkommandos (Phase 4).
- **Auswirkung:** Natürlichsprachliche Mix-Anweisungen mit Fades laufen ins Leere oder werden nur teilweise ausgeführt.
- **Empfohlener Fix:** `fadeChannelToMain(channel, ms)`-Kommando (Ramp via `setChannelGain`) in Registry + Orchestrator-Mapping ergänzen; Test in `tests/` ergänzen.
- **Aufwand:** M
- **Status:** Offen
- **Gegenprüfung:** Nur von einer Instanz geprüft (Trace-Simulation)

#### M-3 dropMONK-Auto-Drop („passendes Lied aus biblioMONK, Drop erstellen, automatisch ausführen“) nicht end-to-end verdrahtet
- **Kategorie:** AI-Integration / UX-Flow
- **Betroffene Dateien/Module:** `src/components/drop/DropGeneratorPanel.tsx`, `src/components/drop/DJTransitionPanel.tsx`, `src/core/voice/pluginCommandRegistry.ts` (dropMONK-Sektion), `src/data/musicLibrary.ts`
- **Beschreibung:** dropMONK hat Generator-/Preset-/Transition-Komponenten, aber die Kette „aktuellen Kanal analysieren → passenden Track aus biblioMONK wählen → Drop generieren → automatisch triggern“ ist nicht als ein Aufruf verdrahtet. Trace-Simulation (Phase 4).
- **Auswirkung:** Der beschriebene Assistenten-Flow funktioniert nicht auf Zuruf.
- **Empfohlener Fix:** Orchestrator-Kommando `autoDrop(channel)` implementieren (BPM/Key-Match gegen `SORTED_MUSIC_LIBRARY`, Drop-Preset laden, Trigger zur nächsten Phrase); Test ergänzen.
- **Aufwand:** L
- **Status:** Offen
- **Gegenprüfung:** Nur von einer Instanz geprüft (Trace-Simulation)

#### M-4 Socket.io-Auth abgelehnte Stress-Clients ohne Log-Korrelation
- **Kategorie:** Infra-Deployment
- **Betroffene Dateien/Module:** `services/signaling/index.js`, `server.ts`
- **Beschreibung:** Live-Test zeigte 39× `connect_error: unauthorized`. Serverseitige Logs/Telemetrie zu abgelehnten Handshakes sind nicht systematisch (Rate/Quelle/IP). Live-Fund (Phase 4).
- **Auswirkung:** Missbrauch/Fehlkonfiguration ist schwer nachvollziehbar.
- **Empfohlener Fix:** Strukturiertes Logging für abgelehnte Handshakes (Session-Room, IP-gehasht) + Metrik in `/api/telemetry`.
- **Aufwand:** S
- **Status:** Offen
- **Gegenprüfung:** Nur von einer Instanz geprüft (Live-Test)

#### M-5 ESLint-Warnungen (76) nicht aufgeräumt
- **Kategorie:** Code-Qualität
- **Betroffene Dateien/Module:** 67× `no-unused-vars` (u. a. `src/core/adapters.ts`, `src/App.tsx`, `src/core/instrument/catalog.ts`, `src/utils/audioEngine.ts`), 6× `react-hooks/exhaustive-deps`, 2× `ban-ts-comment`, 1× `no-unused-expressions`
- **Beschreibung:** ESLint meldet 76 Warnungen, 0 Fehler. Statischer Fund (Phase 2).
- **Auswirkung:** Toter Code, potenziell stale Closures in Hooks, sinkende Wartbarkeit.
- **Empfohlener Fix:** Ungenutzte Symbole entfernen oder Regel schärfen; Hook-Dependencies korrigieren; `@ts-ignore` → `@ts-expect-error`.
- **Aufwand:** M
- **Status:** Offen
- **Gegenprüfung:** Bestätigt (ESLint-Lauf)

### [LOW]

#### L-1 Unsichere Format-Strings (12×)
- **Kategorie:** Code-Qualität
- **Betroffene Dateien/Module:** u. a. `src/utils/audioEngine.ts:449`, `src/context/AudioContext.tsx:80,85`, `services/taskWorker.ts:81`, `services/midi-bridge/index.js:35`
- **Beschreibung:** `console.*`/printf-artige Aufrufe mit variablem Format-String. OpenGrep INFO.
- **Empfohlener Fix:** Literale Format-Strings verwenden.
- **Aufwand:** S · **Status:** Offen · **Gegenprüfung:** Bestätigt (OpenGrep)

#### L-2 csurf/CSRF-Schutz in signaling fehlt
- **Kategorie:** Security
- **Betroffene Dateien/Module:** `services/signaling/index.js:5`
- **Beschreibung:** Express ohne CSRF-Middleware (OpenGrep).
- **Empfohlener Fix:** CSRF-Middleware oder reine API-Absicherung (kein Cookie-Auth) dokumentieren/ergänzen.
- **Aufwand:** S · **Status:** Offen · **Gegenprüfung:** Bestätigt (OpenGrep)

#### L-3 CI-Gate für Replicate/Eval fehlt
- **Kategorie:** Testing
- **Betroffene Dateien/Module:** `scripts/replicate-smoke.ts`, `scripts/eval-ai.ts`, `.github/workflows/`
- **Beschreibung:** Replicate-Smoke lief manuell OK (echter Demucs-Job); es existiert kein regelmäßiger CI-Smoke/Gate.
- **Empfohlener Fix:** Wöchentlichen `replicate-smoke` + `eval:ai` als Nightly-Job einplanen.
- **Aufwand:** S · **Status:** Offen · **Gegenprüfung:** Nur von einer Instanz geprüft

#### L-4 HF-Fallback-Pfad nicht aktiv durchgespielt
- **Kategorie:** AI-Integration
- **Betroffene Dateien/Module:** `scripts/background-coder/hfRouter.mjs`
- **Beschreibung:** HF wurde laut Vorgabe nicht aktiv aufgerufen; Fallback-Logik (Budget-/Quota-/Fehlerpfad) nur statisch geprüft.
- **Empfohlener Fix:** Gezielter Fallback-Test (HF-Simulation offline) als Unit-Test ergänzen.
- **Aufwand:** S · **Status:** Offen · **Gegenprüfung:** Nur von einer Instanz geprüft

#### L-5 Vite-Bundle-Chunks > 500 kB
- **Kategorie:** Performance
- **Betroffene Dateien/Module:** `vite.config.*`, Lazy-Loading in `src/plugins/registry.ts`
- **Beschreibung:** `vite build` meldet große Chunks (Build-Log).
- **Empfohlener Fix:** `manualChunks` / stärkeres Code-Splitting der schweren Audio-Module.
- **Aufwand:** M · **Status:** Offen · **Gegenprüfung:** Bestätigt (Build-Log)

#### L-6 AudioHealth `STATE: CLOSED` im Ruhezustand ohne sichtbaren Resume-Hinweis
- **Kategorie:** UX/Flow
- **Betroffene Dateien/Module:** `src/App.tsx` (masterplayerMONK), `src/utils/audioEngine.ts` (`resumeFromIdle`)
- **Beschreibung:** Im Browser-Test zeigte perfMONK `STATE: CLOSED`/0 Hz, bis Play gedrückt wird; für Nutzer nicht erklärt.
- **Empfohlener Fix:** Hinweis-Badge „▶ PLAY drücken, um Audio zu starten“ im masterplayer.
- **Aufwand:** S · **Status:** Offen · **Gegenprüfung:** Nur von einer Instanz geprüft (Browser-Test)

---

## Bestehende offene Punkte (Live-/Betreiber-/Hardware-Prüfungen)

> Aus früheren Audits übernommen (nicht automatisiert lösbar – vor Ort / Konsole erforderlich).

### Nur Code/Tests (automatisiert umsetzbar)
- Worklet-CPU-Budgets im PerformanceMonitor · kontinuierliches Profiling · adaptive Puffergrößen bei Xruns · Energie-Optimierung (Audio-Context Idle)
- Granular-Engine, SFZ-Parsing, 6-Op-FM, Wavetable, Tonewheel, E-Piano, Drum-Synthese, Orchester-Library, Phase-Distortion, EXS24/SF2/WAV-Import-Konzept, Reverb-Verbesserung, spektrale Additiv-Steuerung, Mod-Matrix-Konzept

### Live-/Hardware-/Browser-Prüfpunkte (vor Ort)
- Main-RMS < -60 dBFS (60 s Dauerlauf) · iPhone/iOS-Test · USB-Gerät automatisch wählen · 2.1-Layout sichtbar · Scratchpad Reload/DnD/Clipboard · Latenz < 15 ms lokal / < 50 ms Netz · 4-User-Livelauf (Cue/Main, Rollenwechsel) · Drop-Hörprobe am laufenden Mix · 2 App-Knoten hinter LB11 + Failover
- MIDI-Out/Clock mit echter Hardware (TR-8S/Beatstep Pro) · Beatstep-Pro-MIDI-Profil + Pads-Synth-UI · Audio-Layouts 12.x/18.x/24.x (braucht Hardware)

### Betreiber-Schritte (externe Konsole/Cloud)
- Migration 002+ in Live-Supabase anwenden + RLS-Abgleich · HF-Endpoint-Secret rotieren · Nightly-CI-Lauf auf GitHub bestätigen · echter DeepSeek/MOA-LLM-Lauf je Plugin + Scores in Supabase · AI-GPU-Benchmarks + AI-Docker-Build/GPU-Test · Flotten-Wake < 90 s erneut messen · LB11 erst bei Skalierung

### Experimentelles in `main` (optional, laut VISIONS-Regel)
- WebGPU-Kernel (`src/core/gpu/`), Rust-Runtime (`services/audio-runtime`), Rust-Mixer (`services/mixer`), V2-AudioGraph, WASM-DSP/HRTF-Kernel, `localDemucs` → Benchmarks/Entscheid offen, Details in `VISIONS_TODO.md` (Branch `visions`)

---

## Historie

> Ältere Abschnitte (AUDIT.md 2026-09-03, AUDIT_DEEP.md 2026-09-04, Softwareaudit/OpenGrep+reviewdog 2026-09-05, Cerebras-Tiefenaufträge, Delegationsaufträge) wurden konsolidiert: alle dortigen Punkte sind **erledigt** und wurden am 2026-09-05 entfernt (Details in `TASKDONE.md` bzw. Git-History). Dieses Dokument enthält nur noch offene Punkte aus dem Deep Audit 2026-09-05 sowie weiterhin gültige Live-/Betreiber-Prüfpunkte.

---

## 🧠 Cerebras-Aufträge 2026-09-06 (User-Bugs 6926)

> Quelle: Screenshots `public/BUGS/Bug6926doppelteicons.png` + `Bug6926einstellungen.png`. Routing: HOCH → SCHWER → #7 (Cerebras).

- [x] **BUG-6926-1 · HOCH · Doppelte Icon-Leiste konsolidieren** – Kürzel-Leiste (Plugin-Toolbar) ist bereits entfernt; verbleibend: `CTRL` (controllerMONK) fehlte im Header → wurde ergänzt (10 Spalten). Zu verifizieren: keine Dubletten mehr, einheitlicher Aktiv-Zustand, Header enthält alle 19 MONKs.
- [x] **BUG-6926-2 · HOCH · SFU-Verdrahtung + Settings-Anbindungen fertigstellen** – `SettingsDialog`: SFU (Mediasoup) voll verdrahten (Session-/Plugin-State-Sync über SFU-DataChannel, nicht nur Media-Pfad), Verbindungsstatus anzeigen (verbunden/nicht verfügbar), MIDI-Status korrekt spiegeln (midi-bridge-Sidecar für iOS/Safari), Cross-Origin-Isolation-Header (COOP/COEP) in server.ts setzen, AI-Shutdown-Button nur aktiv wenn HF-Endpoint konfiguriert.
