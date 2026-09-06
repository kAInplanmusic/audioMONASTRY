# AGENT_TODO – Background-Coder Pipeline (HF + Cerebras #7)

Aktualisiert: 2026-09-06T08:36:01.041Z


TASK-025
CLASS: SCHWER
DOMAIN: BACKEND
DESCRIPTION: **BUG-6926-1 · HOCH · Doppelte Icon-Leiste konsolidieren** – Kürzel-Leiste (Plugin-Toolbar) ist bereits entfernt; verbleibend: `CTRL` (controllerMONK) fehlte im Header → wurde ergänzt (10 Spalten). Zu verifizieren: keine Dubletten mehr, einheitlicher Aktiv-Zustand, Header enthält alle 19 MONKs.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-026
CLASS: SCHWER
DOMAIN: BACKEND
DESCRIPTION: **BUG-6926-2 · HOCH · SFU-Verdrahtung + Settings-Anbindungen fertigstellen** – `SettingsDialog`: SFU (Mediasoup) voll verdrahten (Session-/Plugin-State-Sync über SFU-DataChannel, nicht nur Media-Pfad), Verbindungsstatus anzeigen (verbunden/nicht verfügbar), MIDI-Status korrekt spiegeln (midi-bridge-Sidecar für iOS/Safari), Cross-Origin-Isolation-Header (COOP/COEP) in server.ts setzen, AI-Shutdown-Button nur aktiv wenn HF-Endpoint konfiguriert.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED
