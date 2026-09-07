# TODO – audioMONASTRY

> Einzige offene Aufgabenliste des Repos.
> Stand: 2026-09-07 · priorisiert nach P0–P3 auf Basis deiner Antworten.
> Backup der entfernten Altdaten: `/tmp/audiomonastry-cleanup-2026-09-07/tracking-and-agent-backup.tgz`

---

## Entscheidungen (keine offenen Tasks)

- **Experimentelle Pfade** (V2-AudioGraph, WebGPU, Rust-Runtime, Rust-Mixer, WASM-DSP/HRTF, `localDemucs`) → bleiben als **Referenz/optional in `main`**; kein Produktiv-Zwang, kein Entfernen.
- **Rust/cpal-Runtime (`services/audio-runtime`)** → als **Referenz/Prototyp** behandeln, nicht produktiv in die Web-App integrieren.
- **Multi-Device-Clocking/Drift** → **zurückgestellt** (aktuell kein echtes Mehrgeräte-Setup geplant).
- **audioEngine-Split** → bleibt offen, wird **vorerst nicht umgesetzt** (P2).
- **Optionale Synthese-/DSP-Bausteine** → alle genannten sind relevant, als Backlog geführt.
- **HID-Output-/Feature-Report-Rückkanal** und **OS-Aggregation-Test** → relevant.
- **Betreiber-/Live-Umgebungen** → vorhanden/verfügbar: Hetzner-Flotte, Supabase-Live, iPhone/iOS, Android, Xonar U7/2.1, 4 User; Env/Tokens laut deiner Aussage vollständig hinterlegt.

---

## RunPod-Migration – aktueller Stand (2026-09-07)

- [x] Spezifikation: `docs/RUNPOD_AI_V1_SPEC.md` + `docs/RUNPOD_MODEL_HANDLERS.md`
- [x] RunPod Serverless Worker-Wrapper (`services/samplemonk-ai-runtime/runpod_worker.py`)
- [x] `RunPodProvider` (runsync) + `AiProviderId=runpod`
- [x] Deployment: `Dockerfile.runpod`, `scripts/runpod-deploy.py`, `.github/workflows/runpod-deploy.yml`
- [x] Handler-Code: Qwen3-14B, Qwen2-Audio, XTTS, ACE-Step, Demucs, PyAnnote, Essentia
- [x] Manifest auf H200 (141 GB VRAM) erweitert
- [x] GHCR-Image Build/Push erfolgreich
- [x] RunPod-Serverless-Template erstellt (ID: `9fious2yy9`)
- [ ] **RunPod-Endpoint anlegen** – blockiert: RunPod-Kontoguthaben < $0.01; nach Aufladung Workflow erneut ausführen
- [ ] BS-RoFormer-Handler auf GPU verifizieren/fixieren
- [ ] Replicate/HF-Code entfernen (erst nach RunPod-Cutover)
- [ ] HF-Endpoint/Repo/Space löschen (erst nach RunPod-Cutover)

---

## P0 – Betreiber-/Live-Gates (als Nächstes ausführen)

- [ ] **HF-Endpoint-Secret rotieren** – Token in HF-/Hetzner-Konsole ersetzen, `.env`/Docker-Secrets/CI-Secret aktualisieren, altes Token revoken.
- [ ] **Supabase-Live-Abgleich** – Migrationen (inkl. 002) anwenden/prüfen, RLS/Indizes bestätigen, Daten sichtbar.
- [ ] **Echter LLM-/MOA-Lauf je Plugin + Nightly-CI bestätigen** – 100 % Kern-Kommandos, Scores/Dauer/Fehler in Supabase; CI-Lauf auf GitHub grün.
- [ ] **AI-Docker-Build/GPU-Test lokal ausführen** – GPU-Container bauen und Inferenz/Health testen.
- [ ] **Gate-Verifikation** – keine Secrets im Repo/History, `npm audit` 0, ESLint ohne Errors, CI-Hardening (Actions-SHA) dauerhaft grün.

## P1 – Code-Qualität & verfügbare Live-Tests

- [ ] **Pre-existing WebGPU-/TS-Typfehler bereinigen** – `@webgpu/types` sauber auflösen oder als bekannte Runtime-only-Dateien dokumentieren/ausschließen.
- [ ] **Worklet-CPU-/Underrun-Budgets im UI ausbauen** – Underrun-/Dropout-Zähler, adaptive Puffer-/Energie-Optimierung (Audio-Context-Idle).
- [ ] **HID-Output-/Feature-Report-Rückkanal generisch implementieren** – WebHID-`sendReport`-Pfad ausbauen statt Best-Effort-No-op.
- [ ] **OPS-Load-Balancer LB11** – 2 App-Knoten, 4-User-E2E (State-Sync, Locking, Main-Stream), Failover-Test.
- [ ] **`docs/LIVE_CHECKLIST_2026-09-02.md` abarbeiten** – Flotte, Browser, Audio/DSP, 4-User, KI/Eval, Security.
- [ ] **H-1 Socket.io-Stresstest-Session-Pfad** – gültige Session-Tokens/Test-Fixture verwenden, Mehr-User-Pfad gegen Flotte testen.
- [ ] **4-User-Livelauf** – identischer State, Gäste hören Main, Cue separat, Rollenwechsel ohne Audio-Unterbrechung; Pump-/Zipper-Freiheit.
- [ ] **iPhone/iOS-Test** – Touch-Ziele ≥ 44 px, Safe-Areas, kein Hover-only, WebKit-Audio-Verhalten prüfen.
- [ ] **Android-Test** – Touch-Ziele, Safe-Areas, Audio-/Browser-Verhalten prüfen.
- [ ] **USB/Xonar U7 / 2.1** – automatische Geräteauswahl, 2.1-Layout sichtbar, Einstellungen nach Reload stabil.
- [ ] **2.1-Frequenzanalyse** – Sub < 80–120 Hz, L/R ohne Bass-Einbuße; Testtöne 40 Hz/1 kHz.
- [ ] **Latenz-/Jitter-Messungen** – lokal < 15 ms, Netz one-way < 50 ms, 120 BPM/10 min Jitter < 1 ms bzw. < 5 ms zwischen Browsern; 0 Xruns/Dropouts.
- [ ] **AI-E2E- und AI-Failure-Suite gegen echte Infrastruktur** – HF-Endpoint/GPU-Benchmarks (Cold/Warm/VRAM) und INT8-Kalibrierung je Modell.

## P2 – Mittelfristig / Backlog

- [ ] **audioEngine-Split Phase 2–4** – Worklets entkoppeln, Routing, Graph-Kompatibilität (`docs/audioEngine-split-plan.md`); bewusst später, nicht jetzt.
- [ ] **Automation-Backpressure prüfen** – Engine-seitiges Throttling/Coalescing für hohe Automation-/Pattern-Raten.
- [ ] **Optionale Synthese-/DSP-Bausteine** (alle gewünscht, Backlog)
  - E-Piano / Rhodes-artige Synthese
  - Phase-Distortion-Synthese
  - Spektrale Additiv-Steuerung
  - Zentrale Mod-Matrix
  - Reverb-High-Quality / Convolution
- [ ] **OS-Aggregation real testen** – PipeWire Combine-Sink / macOS Aggregate für Mehrgeräte-Audio.
- [ ] **`docs/LICENSE_EXTERNAL_RESOURCES.md`-Compliance** – kein fremdes Audiomaterial im Repo/Image/Snapshot, keine Presets mit fremden Samples, CC-BY-Attribution, neue Ressourcen zuerst eintragen.
- [ ] **`docs/PGVECTOR_LINT0014.md`-Compliance** – keine `CREATE EXTENSION vector` im `public`-Schema, keine unqualifizierten `public.vector`-Typen, kein angepasstes `search_path`, DB-Backup vorhanden.

## P3 – bewusst später / blockiert

- [ ] **MIDI-Hardware-Hörprobe** – TR-8S/Beatstep Pro (Clock-Lock, Notenzuordnung, SysEx); aktuell **keine Hardware vorhanden**.
- [ ] **Komponenten-Neubau Hardware-Look** – DJM-A9/XONE, MiniMoog/Prophet, TR-808, API/SSL … inkl. Screenshot-Baselines.
