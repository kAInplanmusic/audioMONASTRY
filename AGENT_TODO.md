# AGENT_TODO – Background-Coder Pipeline (HF + Cerebras #7)

Aktualisiert: 2026-09-06T09:33:24.016Z


TASK-001
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **AUD-2609-2 · LOW · 12× unsafe-formatstring** – u. a. `src/utils/audioEngine.ts:449`, `services/taskWorker.ts:81`. Kategorie: Code-Qualität. Aufwand S.
IMPLEMENTATION_AGENT: #5
MODEL: zai-org/GLM-5.3-Flash
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-002
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **AUD-2609-4 · LOW · 76 ESLint-Warnungen** – 67× no-unused-vars, 6× hook-deps, 2× ban-ts-comment, 1× unused-expressions. Kategorie: Code-Qualität. Aufwand M.
IMPLEMENTATION_AGENT: #5
MODEL: zai-org/GLM-5.3-Flash
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-003
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **AUD-2609-6 · INFO · MCP-Credits wieder aufladen** – qwen-coder/Gegenprüfung via HF-Inference ist aktuell gesperrt (402). Betreiber-Schritt.
IMPLEMENTATION_AGENT: #5
MODEL: zai-org/GLM-5.3-Flash
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-004
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **WF-4 · NIEDRIG · UI-only-Plugins liefern leeres Array** – `mastering`/`stem`/`recording` sind in `pluginChannelMap` als `[]` markiert, obwohl sie Audio bearbeiten (Insert statt Quelle). Dokumentieren bzw. Insert-Mapping ergänzen.
IMPLEMENTATION_AGENT: #5
MODEL: zai-org/GLM-5.3-Flash
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-013
CLASS: MITTEL
DOMAIN: BACKEND
DESCRIPTION: **WF-2 · MITTEL · Musik-Load ohne Decode-Cache** – `loadTrackSample` erzeugt pro Ladung einen neuen `Tone.Player` (Decode-Spike beim Trackwechsel). Fix: OPFS-/Buffer-Cache analog `SfzSampleCache` für Musik-URLs.
IMPLEMENTATION_AGENT: #2
MODEL: moonshotai/Kimi-K2.7-Code
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-014
CLASS: MITTEL
DOMAIN: PERFORMANCE
DESCRIPTION: **WF-3 · MITTEL · Mastering-Insert liegt im Monitorweg** – `masterStreamTap` hängt post-Mastering: Monitor hört die Mastering-Latenz (Lookahead). Fix: separaten Pre-Mastering-Tap für Monitor, Post-Mastering nur für MAIN-Stream.
IMPLEMENTATION_AGENT: #3
MODEL: zai-org/GLM-5.3
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-025
CLASS: SCHWER
DOMAIN: SECURITY
DESCRIPTION: **AUD-2609-1 · MEDIUM · Workflow-Actions auf Commit-SHA pinnen** – 35× `actions/*@v4` (Supply-Chain). Kategorie: Security. Aufwand M.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: #6
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: FAILED
ERROR: Review: Der Diff/Änderungen-Teil der Aufgabe ist leer. Ohne konkrete Änderungen kann ich nicht beurteilen, ob die Workflow-Actions korrekt auf Commit-SHA gepinnt wurden oder ob die Implementierung den Security-Anforderungen entspricht. Bitte die tatsächlichen Änderungen bereitstellen.

TASK-026
CLASS: SCHWER
DOMAIN: SECURITY
DESCRIPTION: **AUD-2609-3 · LOW · 2× HTTP-Server ohne TLS-Bindung** – `services/midi-bridge/index.js:146`, `services/signaling/index.js:6` (intern, dokumentieren/binden). Kategorie: Security. Aufwand S.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: #6
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-027
CLASS: SCHWER
DOMAIN: SECURITY
DESCRIPTION: **AUD-2609-5 · LOW · csurf fehlt in signaling** – `services/signaling/index.js:5`. Kategorie: Security. Aufwand S.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: #6
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-028
CLASS: SCHWER
DOMAIN: AUDIO
DESCRIPTION: **WF-1 · HOCH · Kanal 5 ist Nadelöhr** – `sampler`, `mcp`, `sound`, `drop` teilen sich `channel5`. Bei paralleler Nutzung konkurrieren 4 Plugins um einen Kanalzug (Gain/EQ/Fader überschreiben sich). Fix: eigene Kanäle (z. B. drop→CH9, sound→CH10) oder Sub-Bus je Plugin.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

BLOCK-001
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **WF-5 · NIEDRIG · DB-RLS/Indizes** – `sample_embeddings` hat HNSW-Index + RLS; `ai_jobs`/`ai_sessions` ohne sichtbaren Index auf session_id (EXPLAIN in Live-DB prüfen).
IMPLEMENTATION_AGENT: #5
MODEL: zai-org/GLM-5.3-Flash
REVIEW_AGENT: -
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED
