# AGENT_TODO – Background-Coder Pipeline (HF + Cerebras #7)

Aktualisiert: 2026-09-05T23:02:43.464Z


TASK-013
CLASS: MITTEL
DOMAIN: UI
DESCRIPTION: **NET-1 · MITTEL · Senden-an-User/MONK/DJ-Anfrage** – Klick-/Touch-Logik: Plugin/State an bestimmten User senden, an MONK übergeben, DJ-Anfrage stellen (WebRTC-DataChannel) + UI-Elemente.
IMPLEMENTATION_AGENT: #4
MODEL: Qwen/Qwen3-Coder-Next
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-025
CLASS: SCHWER
DOMAIN: AUDIO
DESCRIPTION: **MIDI-1 · HOCH · midiMONK-Geräte/Routing** – Web-MIDI-Geräteliste (angeschlossene MIDI-Keyboards/Controller), Routing-Konfiguration, Ziel-MONK-Auswahl (welches MONK bekommt Noten/CC); MIDI-Keyboard-Klasse (GM/CC/Notes) an AudioEngine verdrahten.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-026
CLASS: SCHWER
DOMAIN: BACKEND
DESCRIPTION: **MIDI-2 · HOCH · Digitakt-2-Integration** – Elektron Digitakt 2: Specs/Config/Template in midiMONK vorbereiten (CC/NRPN-Map, Transport-Sync, Pattern-Feed), Geräteprofil speicherbar.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-027
CLASS: SCHWER
DOMAIN: BACKEND
DESCRIPTION: **AI-1 · HOCH · aiMONK-/dropMONK-Automation verifizieren + nachbessern** – Kommandos „Lied von Len Faki auf Kanal 1, BPM 100, langsam in MAIN faden“ und „auto-Drop für laufendes Lied auf Kanal 1: passendes Lied aus biblioMONK suchen, Drop erstellen, automatisch ausführen“ end-to-end prüfen; fehlende Schritte (Kanal-Load, BPM-Set, Fade, Drop-Trigger) implementieren + Tests.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

BLOCK-001
CLASS: SCHWER
DOMAIN: SECURITY
DESCRIPTION: **OG-2 · HOCH · Shell-Injection in GitHub-Actions-Run-Steps** – `.github/workflows/live-stress.yml:29,32`: `${{ inputs.base_url }}` nicht direkt in `run:` interpolieren, sondern via `env:` übergeben.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: #6
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED

BLOCK-002
CLASS: SCHWER
DOMAIN: SECURITY
DESCRIPTION: **OG-3 · HOCH · Script-Injection in actions/github-script** – `.github/workflows/live-stress.yml:46`: `github`-Context-Daten nicht direkt im `script:` interpolieren.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: #6
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED

BLOCK-003
CLASS: MITTEL
DOMAIN: DATABASE
DESCRIPTION: **OG-5 · MITTEL · 2x dynamic-urllib** – `scripts/hetzner/dns_setup.py:43`, `scripts/hetzner/provision.py:48`: URL-Schema-/Host-Allowlist + Validierung.
IMPLEMENTATION_AGENT: #2
MODEL: moonshotai/Kimi-K2.7-Code
REVIEW_AGENT: -
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED
