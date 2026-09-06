# AGENT_TODO – Background-Coder Pipeline (HF + Cerebras #7)

Aktualisiert: 2026-09-06T10:02:59.282Z


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
ERROR: Review: Der Diff/Änderungen-Teil der Aufgabe ist leer. Es wurden keine tatsächlichen Code-Änderungen bereitgestellt, die ich reviewen könnte. Ohne sichtbare Änderungen kann ich nicht beurteilen, ob die Workflow-Actions korrekt auf Commit-SHA gepinnt wurden oder ob die 35 `actions/*@v4`-Referenzen wie geford

TASK-026
CLASS: SCHWER
DOMAIN: AUDIO
DESCRIPTION: **WF-1 · HOCH · Kanal 5 ist Nadelöhr (Cerebras vorbereiten)** – `sampler`, `mcp`, `sound`, `drop` teilen sich `channel5`. Bei paralleler Nutzung konkurrieren 4 Plugins um einen Kanalzug (Gain/EQ/Fader überschreiben sich). Fix: eigene Kanäle (z. B. drop→CH9, sound→CH10) oder Sub-Bus je Plugin.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-027
CLASS: SCHWER
DOMAIN: BACKEND
DESCRIPTION: **WF-2 · HOCH · Musik-Load ohne Decode-Cache (Cerebras vorbereiten)** – `loadTrackSample` erzeugt pro Ladung einen neuen `Tone.Player` (Decode-Spike beim Trackwechsel). Fix: OPFS-/Buffer-Cache analog `SfzSampleCache` für Musik-URLs.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-028
CLASS: SCHWER
DOMAIN: PERFORMANCE
DESCRIPTION: **WF-3 · HOCH · Mastering-Insert liegt im Monitorweg (Cerebras vorbereiten)** – `masterStreamTap` hängt post-Mastering: Monitor hört die Mastering-Latenz (Lookahead). Fix: separaten Pre-Mastering-Tap für Monitor, Post-Mastering nur für MAIN-Stream.
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
