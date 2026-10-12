# FINALEAUFGABEN

Erzeugt am: 2026-10-07 09:34

**Zusammenfassung**: 19 offene/partial Tickets; 97 dokumente enthalten ticketrelevante Informationen.


## Offene/teilweise Tickets (im SSOT)

### RT-AUDIT-P1-015: Runpod-Brain: Qwen 3.8 (int4) über vLLM mit Streaming, warm während aktiver Session; DAW-Executor-Modell vorbereiten

- **Status**: OPEN | **Priorität**: P1 | **Bereich**: AI

- **Akzeptanz**: TTFT warm < 300 ms, gemessen mit benchmark-brain, Streaming bis in die UI, Kein Kaltstart während aktiver Session (Log-Nachweis), Executor liefert nur schema-gültige Kommandos (Eval-Set 50 Prompts, 10...

- **Dateien**: services/audiomonastry-ai-runtime/model_manifest.json, services/audiomonastry-ai-runtime/Dockerfile.runpod, .github/workflows/runpod-deploy.yml, src/core/ai/LlmRouter.ts …

- **Hinweis**: 


### IDEA-2026-10-07-A-F1: Capture nachschaerfen: Sequencer-Ziel bestaetigen, drumsamplerMONK-Eingaben und exakten Transport-Start erfassen

- **Status**: OPEN | **Priorität**: P2 | **Bereich**: Feature

- **Akzeptanz**: Capture enthaelt drumsamplerMONK-Eingaben, Raster exakt am Worklet-Frame, Uebernommene Takte sichtbar in der Pattern-Ansicht...

- **Dateien**: src/components/am/CaptureControl.tsx, src/utils/audioEngine.ts, src/audio/worklets/v2SinkProcessor.ts, src/core/capture/quantizeCapture.ts

- **Hinweis**: 


### LIVE-P1-003: Live-/Hoerpruefungen (konsolidiert aus TESTRUN_2 + Live-Checkliste 2026-09-02)

- **Status**: PARTIAL | **Priorität**: P1 | **Bereich**: Mensch/Umgebung

- **Dateien**: docs/ENV_MATRIX.md, docs/LIVE_CHECKLIST_RESULTS_2026-09-18.md, docs/OPS_RUNBOOK.md, scripts/fleet-wake-measure.py …

- **Hinweis**: Beide Checklisten sind Live-/Hardware-Schritte ohne Automatisierung und wurden 2026-09-13 hierher konsolidiert (die Einzeldateien sind entfernt). Blockiert wie ENV-001/ENV-003: kein 4-Browser-/Hardware-Zugang in der Agent-Umgebung. || PARTIAL 2026-09-18 (ersetzt BLOCKED 'kein 4-Browser-/Hardware-Zug…


### VISUAL-P1-001: Live-Beweis Ghostuser 5/6 (Studio -> PA + Beamer) + MJPEG-Fallback

- **Status**: PARTIAL | **Priorität**: P1 | **Bereich**: VisualMONK

- **Dateien**: docs/OPS_RUNBOOK.md, docs/VISUALMONK_SPEC.md, scripts/master-out-audio-proof.mjs, scripts/mjpeg-live-proof.mjs …

- **Hinweis**: Der Betreiber macht den Live-Test, sobald die Flotte hochgefahren ist. Headless blockiert (Signaling auf :8080 gepinnt, stale Admin). || PARTIAL 2026-09-18. Der Repo-Anteil ist GEBAUT UND LIVE BEWIESEN - offen bleibt nur der Betreiber-Live-Beweis gegen die echte Flotte (Studio -> PA + Beamer, zwei G…


### INFRA-RUNPOD-012: Serverless-Flotte: negativer Kontostand blockiert JEDE Neu-Provisionierung - sah identisch aus wie ein unaufloesbares Template

- **Status**: PARTIAL | **Priorität**: None | **Bereich**: infra/runpod

- **Verbleibend**: ['RunPod-Konto aufladen (Betreiber-Entscheidung)', 'music: echter Job -> MP3 nach der Aufladung; videoAbstract/videoReal: Neu-Provisionierung belegen', 'Danach die 8/8 im Flottenverifikationsbericht wiederherstellen (oder die betroffenen Zeilen korrigieren)']

- **Akzeptanz**: Die Wache nennt den Kontostand VOR den Rollen und meldet ihn als Ursache, wenn Rollen ohne jeden Worker in der Queue stehen, Bei negativem Kontostand sendet die Wache keinen Heilungs-Schreibzugriff (e...

- **Dateien**: scripts/runpod-health-guard.py, tests/test_runpod_health_guard.py, docs/RUNPOD_COLDSTART.md, docs/FLEET_VERIFICATION_2026-09-20.md

- **Hinweis**: DONE-Anteil (Repo): Wache liest den Kontostand, meldet KONTO_NEGATIV/KONTO_UNBEKANNT, nennt ihn als Ursache neben FESTGEFAHREN und verweigert die Heilung bei negativem Konto (Exit 7, kein Schreibzugriff); Templates music (qsxc8encwr) und videoAbstract (7iihy61ouf) sind gelistet und gebunden, je mit …


### AI-P2-006: Drop-Generierung: serverseitiger Cache statt nur globalem Limiter

- **Status**: PARTIAL | **Priorität**: P2 | **Bereich**: AI/Server

- **Verbleibend**: (1) Grafana-Panel/Alert auf die neue Trefferquote (die Metrik liegt an, ein Panel fehlt), (2) TTL und Obergrenze nach echten Nutzungsdaten justieren (aktuell 10 min / 50 - bewusst konservativ gewaehlt), (3) optional: groessere Artefakte in R2 ablegen statt im Prozessspeicher.

- **Dateien**: server/dropCache.ts, server/routes/aiRoutes.ts, server/routes/opsRoutes.ts, server.ts …

- **Hinweis**: UMGESETZT 2026-09-21: server/dropCache.ts (rein, ohne Netz) haelt echte Modell-Ergebnisse kurz vor: Schluessel aus Prompt/BPM/Energie/Plugins/Stil/Dauer + keyVersion (Plugin-Reihenfolge und Zahlenformat normalisiert), TTL 10 min, Obergrenze 50 Eintraege mit Verdrängung des aeltesten, Zaehler (hits/m…


### INFRA-RUNPOD-013: RunPod: Kontostand positiv, 8/8 Templates aufloesbar, alle workersMin=0 - 'throttled' ist ein transienter Zustand

- **Status**: PARTIAL | **Priorität**: P1 | **Bereich**: Infra/Kosten

- **Verbleibend**: Offen und NICHT gemessen: die Job-Historie der Fehlschlaege (brain 38, video-real 5, video-abstract 4, music 2) - ohne Logs ist die Ursache unbekannt. Ausserdem: der Recycle-Ansatz 'workersMax=0, dann warten bis alle Worker weg sind' laeuft bei FlashBoot ins Leere (der Standby-Worker verschwindet nie, workersStandby=1) - die Wartebedingung muss kuenftig auf running/inProgress pruefen, nicht auf die Gesamtzahl.

- **Dateien**: scripts/runpod-health-guard.py

- **Hinweis**: GEMESSEN 2026-09-21: clientBalance 9,9123 USD; acht Endpoints, ALLE workersMin=0 -> kein Dauerlaeufer, keine berechnete Standby-GPU; alle acht Templates loesen auf (HTTP 200, u. a. music=qsxc8encwr und videoAbstract=7iihy61ouf - die frueheren 404-Faelle sind weg). Quota: Summe workersMax = 10 (ausge…


### INFRA-RUNPOD-018: Deploy-Workflow-Idempotenz: Template-Anlage unique-sicher (save_template aktualisiert statt dupliziert); Deploy-Run 36580686816 belegt lebendigen Pfad

- **Status**: PARTIAL | **Priorität**: P3 | **Bereich**: Infra/RunPod

- **Verbleibend**: Ergebnis von Run 36580686816 gegen die Flotte pruefen (Template-Zahl, Endpoint-Env) und hier nachtragen.

- **Dateien**: scripts/runpod-deploy.py, docs/audit-infra-runpod.md, docs/AUDIT-RESTTODOS.md

- **Hinweis**: NACHTRAG 2026-09-29 (Paket A, Commit 23df2e7): save_template unique-sicher implementiert (Update-Pfad bei 'name must be unique', Listing-Fehler sichtbar auf stderr, Registry-Auth-Retry); 7/7 Offline-Smoke-Tests. Offen bleibt: Live-Beweis per erstem manuellen workflow_dispatch.


### LIVE-P1-004: AI_MODE auf Hetzner-Knoten setzen (aiNegative-Suite erwartet AI_DISABLED)

- **Status**: OPEN | **Priorität**: P1 | **Bereich**: Infra

- **Akzeptanz**: AI_MODE=off in der Knoten-.env (app-1) gesetzt; aiNegative.spec.ts 7/7 gruen; kein RunPod-DNS-Traffic (tcpdump-Probe auf ai-1)....

- **Hinweis**: Beim Deep-Test gegen die frisch provisionierte Flotte (commit 7390f23) fielen 4 von 7 Tests in tests/e2e/aiNegative.spec.ts. Messung live: /api/ai/vision|generate-drop|compose antworten OHNE Token korrekt 401 (Studio-Gate fail-closed, kein Sicherheitsproblem); MIT Token liefern vision/generate-drop …


### LIVE-P1-005: live2browser: Peer-Verbindung scheitert (SFU/TURN-Kette nach Flottenstart)

- **Status**: OPEN | **Priorität**: P1 | **Bereich**: Infra

- **Akzeptanz**: Nach vollstaendiger RTC-Verdrahtung (coturn + wire-rtc.sh + DNS) live2browser.spec.ts gruen....

- **Hinweis**: tests/e2e/live2browser.spec.ts:109 schlaegt fehl: hasOpenPeer(pageB) wird nicht true innerhalb 25 s (Offer/Answer zwischen zwei echten Browsern). Die SFU/TURN-Kette war zum Testzeitpunkt noch nicht vollstaendig verdrahtet: coturn wurde erst NACH dem ersten Spec-Lauf auf sfu-1 gestartet, und sfu.anun…


### AI-RUNPOD-SING-002: bark-small: Gewichts-tar nach R2 spiegeln, sonst kann der music-Pod `sing` nicht laden

- **Status**: PARTIAL | **Priorität**: P2 | **Bereich**: Infra/RunPod

- **Verbleibend**: OFFEN: (a) Upload des fertig gebauten Archivs nach R2 (Chunked-Versuch laeuft; sonst frischer R2-S3-Zugang noetig), (b) music-Pod neu anlegen/starten, damit AI_WEIGHTS_URLS bark-small enthaelt, (c) Live-Beweis POST /api/voice/sing ohne VOICE_AI_RUNTIME_URL -> 200 mit WAV.

- **Akzeptanz**: weights/bark-small/1dbd7a128513b8ae4a4e2130fed57b7ac9da5bcd.tar und die .sha256-Datei liegen im R2-Bucket, Der music-Pod startet mit bark-small in AI_WEIGHTS_URLS und laedt es fehlerfrei, POST /api/vo...

- **Dateien**: scripts/weights-mirror.py, deploy/runpod/pod-fleet.json

- **Hinweis**: 


### PLUGIN-V2-D: 4-Server-Strategie deployen, testen, loggen, Snapshot

- **Status**: PARTIAL | **Priorität**: P0 | **Bereich**: Infra

- **Akzeptanz**: 4 Knoten provisioniert und erreichbar, Neueste Builds deployt (Client + Server + Runtime-Image), E2E gegen die echte Instanz gefahren, Logs gesammelt, Snapshot gemacht und Wiederaufsetzpunkt dokumenti...

- **Hinweis**: 2026-10-07 DURCHGEFUEHRT. Der Deploy war NICHT blockiert - ich hatte nach dem falschen Key-Namen gesucht: HCLOUD_TOKEN und RP_API_KEY stehen in der .env (nicht HETZNER_API_TOKEN/RP_AGENT_KEY). Die Flotte existierte bereits, lief aber mit einem Image vom 6.10. 14:50 - also VOR dem Pluginpool-Auftrag.…


### AI-INFRA-001: AI-Flotte: 5 RunPod-Pods, alles resident, max. 4 EUR/h, keine Visual-Generierung

- **Status**: PARTIAL | **Priorität**: P0 | **Bereich**: AI Infrastruktur

- **Akzeptanz**: scripts/runpod-pods.py up --yes --wait startet alle 5 Pods, jede Instanz meldet bereit, Ist-Kosten <= 4 EUR/h, AI_FLEET_MODE=pods: alle AI-Aufgaben laufen ueber die Pods, kein Serverless-Aufruf, Start...

- **Dateien**: deploy/runpod/pod-fleet.json, scripts/runpod-pods.py, scripts/weights-mirror.py, scripts/s3lite.py …

- **Hinweis**: STAND 2026-10-07 (umgesetzt, nicht live gelaufen): Entscheidung 8->5 Pods (brain+orchestrator, ears, voice, stems, music). Runtime-Pod-Modus (app.py Token + /runsync,/run,/status, pod_start.py Gewichte per Presigned-URL + SHA-256, Resident ohne Nachladen, AI_ROLE=a+b, AI_ROLE_MODELS), scripts/runpod…


### VISUAL-P0-010: Vis-Instanz: vollautomatische, selbstlernende Visuals aus eigenen Bildern/Videos (Browser-Ausgabe)

- **Status**: OPEN | **Priorität**: P0 | **Bereich**: Visuals

- **Akzeptanz**: Einstellung aktiviert die Vis-Instanz; Status laedt/bereit; URL erreichbar; zweites Geraet abgelehnt, Eigene Bilder/Videos hochladen, serverseitig transkodiert, getaggt und indexiert, Story-Engine sch...

- **Dateien**: docs/VISUALMAKER_PLAYER_SPEC.md, src/visuals/, src/core/visual/, src/components/visual/VisualMonkOverlay.tsx …

- **Hinweis**: Audit + Zielbild + Phasen V0-V7 in docs/VISUALMAKER_PLAYER_SPEC.md. Entschieden 2026-10-07: Quellen = eigener Bestand plus oeffentliche Quellen (fast alle, je Quelle schaltbar, Lizenz mitgespeichert), kein Rack-Streifen, Vis-Instanz = eigener GPU-Pod (NVENC), rendert mit Vorlauf gegen die Master-Clo…


### MEDIA-P1-001: Medien-Archiv: BRAIN-Platte (Bilder, Musik, Videos) in den Speicher laden

- **Status**: OPEN | **Priorität**: P1 | **Bereich**: Daten

- **Akzeptanz**: Lauf ohne --yes zeigt Mengen und Kosten, Lauf mit --yes laedt alles hoch, Doppelte nur einmal, Index media/index/*.jsonl vorhanden...

- **Dateien**: scripts/media-ingest.py, scripts/s3lite.py, docs/MEDIA_INGEST.md

- **Hinweis**: Werkzeug fertig: scripts/media-ingest.py (alle Ton- inkl. verlustfrei/HQ, Bild- inkl. RAW, Video-Formate, MIDI, LUTs; Dedupe per SHA-256, Multipart, fortsetzbar, Index-JSONL). Anleitung docs/MEDIA_INGEST.md. Betreiber startet es am Rechner mit der Platte. Budget: 2 TB kosten 13 EUR (B2) bis 28 EUR (…


### INFRA-HETZNER-022: Snapshot vor dem Loeschen der Hetzner-Flotte (unwiederbringlicher Datenverlust vermeiden)

- **Status**: OPEN | **Priorität**: P2 | **Bereich**: Infra/Hetzner

- **Verbleibend**: OFFEN: (a) Betreiber entscheidet, ob Snapshots bei jedem Abbau gemacht werden sollen (Default JA). (b) Dokumentation der Kosten: Snapshots kosten ~0,01 EUR/GB/Monat. (c) Optional: Altnamen-Lösung für die Medien-Rolle in der Flotte (falls media-1 fehlt, sollte das Skript trotzdem nicht abstuerzen, sondern melden).

- **Akzeptanz**: Der Loeschvorgang legt vor jedem Server ein Snapshot an (oder verwendet ein bestehendes) und loescht erst nach erfolgreichem Image-Aufbau., Bei fehlendem Token oder fehlendem Knoten bricht das Skript ...

- **Dateien**: scripts/hetzner/delete-fleet.sh, scripts/lib/fleetnodes.py, docs/SERVER_FLEET.md

- **Hinweis**: Die Flotte wird per delete-fleet.sh geloeschto. Ohne Snapshot ist der Datenverlust unwiederbringlich - der Server ist weg und ein Snapshot laesst sich danach NICHT mehr nachholen. Das Skript legt nun vor jedem Loeschen einen Snapshot jedes Knotens an (Beschreibung audiomonastry-snapshot-<rolle>-<dat…


### INFRA-HETZNER-022: Snapshot vor dem Loeschen der Hetzner-Flotte (unwiederbringlicher Datenverlust vermeiden)

- **Status**: OPEN | **Priorität**: P2 | **Bereich**: Infra/Hetzner

- **Verbleibend**: OFFEN: (a) Betreiber entscheidet, ob Snapshots bei jedem Abbau gemacht werden sollen (Default JA). (b) Dokumentation der Kosten: Snapshots kosten ~0,01 EUR/GB/Monat. (c) Optional: Altnamen-Lösung für die Medien-Rolle in der Flotte (falls media-1 fehlt, sollte das Skript trotzdem nicht abstuerzen, sondern melden).

- **Akzeptanz**: Der Loeschvorgang legt vor jedem Server ein Snapshot an (oder verwendet ein bestehendes) und loescht erst nach erfolgreichem Image-Aufbau., Bei fehlendem Token oder fehlendem Knoten bricht das Skript ...

- **Dateien**: scripts/hetzner/delete-fleet.sh, scripts/lib/fleetnodes.py, docs/SERVER_FLEET.md

- **Hinweis**: Die Flotte wird per delete-fleet.sh geloeschto. Ohne Snapshot ist der Datenverlust unwiederbringlich - der Server ist weg und ein Snapshot laesst sich danach NICHT mehr nachholen. Das Skript legt nun vor jedem Loeschen einen Snapshot jedes Knotens an (Beschreibung audiomonastry-snapshot-<rolle>-<dat…


### DA-2026-09-29-048: Sammel: Python-Runtime-Kanten (6 Findings)

- **Status**: OPEN | **Priorität**: P3 | **Bereich**: Deep-Audit

- **Verbleibend**: F77/F80 (ungueltige AI_DEVICE-Werte bzw. Geraete-Indizes werden still ignoriert -> Warnung + klarer Fehler), F76 (unsynchronisierter _device-Lesezugriff), F65 (id ohne Format-/Kollisionsgarantie), F05/F06 (Counter- vs. Gauge-Auslegung in Grafana).

- **Akzeptanz**: Alle 6 Punkte sind entweder behoben oder einzeln mit Grund verworfen (im Ticket dokumentiert)...

- **Dateien**: scripts/hetzner/grafana-dashboards/audiomonastry-overview.json, services/backend-core/ASSET_DB_SCHEMA.md, services/backend-core/python/device_utils.py

- **Hinweis**: Sammel-Eintrag, damit die Findings der Deep-Audit-Luecke NICHT still verschwinden. Enthaltene Findings (6): F05 (low/bug): Counter-Metriken werden als absolute 'total'-Stat angezeigt (Reset-Artefakte); F06 (low/bug): AI-Kosten werden inkonsistent als Gauge (last) und Counter (increase) interpretiert…


### DA-2026-09-29-049: Sammel: Architektur-Reste aus dem Deep-Audit (10 Findings)

- **Status**: OPEN | **Priorität**: P2 | **Bereich**: Deep-Audit

- **Verbleibend**: Enthaelt einen medium-Fund (F07, Kaputte LoRAs im selben Produktiv-Praefix) sowie F41 (unerreichbarer DESTRUCTIVE-Check), F69/F70/F75 (Skripte pruefen nur Syntax, fuehren aber keine Tests aus), F84 (dokumentierte Parallel-Implementierung von Session-/Lock-Logik), F12/F52/F58/F82. Bei F07, F11 und F18 war die Pruefung am 11.10. NICHT moeglich ('nicht pruefbar' im Rohreport) - vor dem Abarbeiten erneut messen.

- **Akzeptanz**: Alle 10 Punkte sind entweder behoben oder einzeln mit Grund verworfen (im Ticket dokumentiert)...

- **Dateien**: scripts/visual-vorrat/BERICHT.md, server/killSwitch.ts, services/audiomonastry-ai-runtime/mcp_runtime.py, services/audiomonastry-ai-runtime/workflows/contracts-20260916.json …

- **Hinweis**: Sammel-Eintrag, damit die Findings der Deep-Audit-Luecke NICHT still verschwinden. Enthaltene Findings (10): F07 (medium/architecture): Kaputte LoRAs liegen ungetrennt neben den brauchbaren im selben Produktiv-Präfix; F12 (low/architecture): Duplizierte Auswertung des Kill-Switch-Env; F41 (low/archi…


## Dokumente mit ticketbezogenen Inhalten

- **PRINCIPLES** (PRINCIPLES.md, 9528 Bytes): # PRINCIPLES.md — audioMONASTRY > **Status:** verbindlich ab 2026-09-23 · Owner: Betreiber (`kAInplanmusic`) > **Verhältnis zu `AGENTS.md`:** `AGENTS.md` regelt die *Technik* (Architektur,

- **PROD-P3-F8-check-2026-10-10** (PROD-P3-F8-check-2026-10-10.md, 1614 Bytes): # PROD-P3-F8 Check 2026-10-10 ## Gates - `npm run typecheck` → 0 Fehler (exit 0)

- **README** (services/audiomonastry-ai-runtime/workflows/README.md, 8455 Bytes): # ComfyUI-Workflows je Rolle `comfyui_adapter.py` laedt den Workflow einer Rolle in dieser Reihenfolge: 1. `workflow` direkt im Job-Args (Inline-Override, hoechste Prioritaet)

- **ABSCHLUSSBERICHT_2026-09-13** (docs/ABSCHLUSSBERICHT_2026-09-13.md, 11038 Bytes): # audioMONASTRY – Abschlussbericht (2026-09-13) > Erstellt nach Phase-10-Reihenfolge. Basis: Repository-Analyse (Phase 1), > Umsetzung P0-1/P0-2/P1-1/P1-2 + COLLAB-P1-004. Alle Gates grün

- **AI_ARCHITECTURE** (docs/AI_ARCHITECTURE.md, 7375 Bytes): # audioMONASTRY – AI-Architektur (Deep Audit, 2026-08-29) > **⚠️ ÜBERHOLT seit 2026-10-07 (RT-AUDIT-P1-014):** Produkt-AI läuft **nur lokal** (eigene GPU-Flotte/Runpod, Qwen quantisiert). > Cloud-Anbieter (Replicate, Hugging Face Inference, Cerebras, OpenRouter, Mistral, PublicAI, Gemini, OpenAI) sind aus dem Code entfernt.

- **AI_DEPLOYMENT_GUIDE** (docs/AI_DEPLOYMENT_GUIDE.md, 2687 Bytes): # audioMONASTRY – AI Deployment Guide > Verbindliche Zahlen: siehe docs/INFRA_KONSTITUTION.md. > Stand 2026-08-31 · Gilt für die AI-Infrastruktur (`src/core/ai/orchestrator/`,

- **AI_FLEET_6X48_PLAN** (docs/AI_FLEET_6X48_PLAN.md, 13693 Bytes): # AI-Flotte neu: 5 × 48 GB als Pods, alles resident, ohne Visual-Generierung (Stand 2026-10-07) Auftrag Betreiber: AI-Aufpreis max. 4 €/h, 48-GB-Instanzen (5–6 wären möglich), bei „AI an" liegen **alle** Modelle dauerhaft im VRAM (Laden beim App-Start,

- **AI_MODEL_SERVICE_MAP** (docs/AI_MODEL_SERVICE_MAP.md, 5439 Bytes): # AI Model → Service Mapping (Phase 2) > Verbindliche Zahlen: siehe docs/INFRA_KONSTITUTION.md. > Stand 2026-08-31 · Verkabelung aller AI-Modelle mit verantwortlichem

- **AI_PROMPTS** (docs/AI_PROMPTS.md, 6480 Bytes): # AI Prompt Engineering (Phase 2) > System-Prompts, Few-Shot-Templates und Kontextfenster-Strategien der > audioMONASTRY-KI.

- **AI_SECURITY_GUIDE** (docs/AI_SECURITY_GUIDE.md, 2282 Bytes): # audioMONASTRY – AI Security Guide > Verbindliche Zahlen: siehe docs/INFRA_KONSTITUTION.md. ## Grundsätze

- **ARCHITEKTUR_EVOLUTION** (docs/ARCHITEKTUR_EVOLUTION.md, 6016 Bytes): # ARCHITEKTUR-EVOLUTION – AudioMONASTRY > Verbindliche Zahlen: siehe docs/INFRA_KONSTITUTION.md. Stand: 2026-08-26 · Phase 1–5 Grundgerüst implementiert.

- **ARCH_P2_002_DEPENDENCY_GRAPH** (docs/ARCH_P2_002_DEPENDENCY_GRAPH.md, 16135 Bytes): # ARCH-P2-002 · Dependency-Graph der `server.ts`-Routen **Zweck.** Subitem 1 des Tickets verlangt den Dependency-Graph *vor* dem Verschieben („Dependency-Graph zuerst, dann Router/Services“). Dieses Dokument hält das Ergebnis

- **AUDIO-ENGINE-REFACTOR-UND-NUTZER-MIGRATION** (docs/AUDIO-ENGINE-REFACTOR-UND-NUTZER-MIGRATION.md, 13069 Bytes): # Audio-Engine-Refactor und Nutzer-Schema-Migration — Auftragsklärung und Messstand **Datum:** 2026-09-30 **Basis:** Branch `main`, HEAD `d76e64b`, Arbeitsbaum mit vorbestehenden Änderungen (u. a. `MASTERTODOENDE.json`)

- **AUDIT-FIXPAKET-A** (docs/AUDIT-FIXPAKET-A.md, 5154 Bytes): # Audit-Fixpaket A — Bericht (2026-09-29) Scope: CI-ESLint-Fix, Idempotenz/Fehlerbehandlung in `scripts/runpod-deploy.py`, Workflow-Meldung/-Trigger in `.github/workflows/runpod-deploy.yml`, dieser Report.

- **AUDIT-FIXPAKET-B** (docs/AUDIT-FIXPAKET-B.md, 5106 Bytes): # AUDIT-FIXPAKET-B — SSOT-Nachzug + Doku-Fixes **Stand:** 2026-09-29 · Repo-only (lokale Commits, nichts gepusht) · Basis: HEAD `9016a7c` ## 1. SSOT-Nachzug (`MASTERTODOENDE.json`)

- **AUDIT-FIXPAKET-C** (docs/AUDIT-FIXPAKET-C.md, 7797 Bytes): # AUDIT-FIXPAKET-C — Report **Stand:** 2026-09-29 · Bearbeiter: Sub-Agent Paket C · Repo-only, lokale Commits, **nicht gepusht** **Befundquelle:** `docs/AUDIT-RESTTODOS.md` (C1–C5) · Regeln beachtet: NTFS (`core.fileMode=false` unangetastet), Tests nur mit `NODE_ENV=test`, keine Pushes.

- **AUDIT-FIXPAKET-E** (docs/AUDIT-FIXPAKET-E.md, 32973 Bytes): # AUDIT-FIXPAKET E — Deep-Test T1: Triage der 55 Roten, Harness-Härtung, DNS-Vertrag **Stand:** 2026-09-29 · **Repo:** audioMONASTRY @ `05b2077` (Arbeitsstand; lokale Commits, **kein Push**) **Bezug:** `docs/DEEP-TEST-PLAN.md`, `scripts/hetzner/deep-test-run.sh`,

- **AUDIT-NACHTRAG-2026-10-01** (docs/AUDIT-NACHTRAG-2026-10-01.md, 7464 Bytes): # Nachträgliche Einordnung der SSOT ## Nachtrag zum Deep-Audit vom 29.09.2026 und zu den Testläufen **Datum:** 2026-10-01 · **Basis:** Commit `99797bb` · **SSOT:** `MASTERTODOENDE.json` (237 Items)

- **AUDIT-RESTTODOS** (docs/AUDIT-RESTTODOS.md, 8800 Bytes): # AUDIT-RESTTODOS (Paket C — startet nach Paket A/B, wegen Datei-Überlappung) Stand: 2026-09-29 · Quelle: Sub-Agent-Befunde (SSOT/Konsistenz-Track) + Deploy-Log-Analyse Regeln: Repo-only, lokale Commits, NICHTS pushen, NODE_ENV=test für Tests, NTFS (kein chmod).

- **AUDIT_REPORT_2026-09-23** (docs/AUDIT_REPORT_2026-09-23.md, 42769 Bytes): # AUDIT REPORT – audioMONASTRY (Projekt-Einlesen & Code-Audit) **Datum:** 2026-09-23 **Scope:** Gesamtprojekt `/home/patrick/AnunnakiTools Projekte/laufende Projekte/audioMONASTRY` (Stand `main` = `e71cb7d` == `origin/main`, Arbeitsbaum sauber)


---
*Automatisch generiert von Hermes*
