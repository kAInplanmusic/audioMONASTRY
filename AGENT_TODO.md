# AGENT_TODO – Background-Coder Pipeline (HF + Cerebras #7)

Aktualisiert: 2026-09-05T21:29:38.408Z


TASK-001
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **OG-9 · NIEDRIG · 13x unsafe-formatstring** – u. a. `src/utils/audioEngine.ts:449`, `src/context/AudioContext.tsx:80,85`, `src/utils/errorTracker.ts:45`: literale Format-Strings verwenden.
IMPLEMENTATION_AGENT: #5
MODEL: zai-org/GLM-5.3-Flash
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-002
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **OG-10 · NIEDRIG · csurf-Middleware fehlt** – `services/signaling/index.js:5`: CSRF-Schutz ergänzen bzw. reine API-Absicherung.
IMPLEMENTATION_AGENT: #5
MODEL: zai-org/GLM-5.3-Flash
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-003
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **RE-2 · NIEDRIG · 71 ESLint-Warnungen** – 62 no-unused-vars, 6 react-hooks/exhaustive-deps, 2 ban-ts-comment (`src/utils/audioEngine.ts:2025,2027`), 1 no-unused-expressions → aufräumen oder Regeln schärfen.
IMPLEMENTATION_AGENT: #5
MODEL: zai-org/GLM-5.3-Flash
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-013
CLASS: MITTEL
DOMAIN: UX
DESCRIPTION: **OG-4 · MITTEL · 35x mutable Action-Tags** – 8 Workflow-Dateien: `actions/*@v4` etc. auf vollständige Commit-SHA pinnen (Supply-Chain-Hardening).
IMPLEMENTATION_AGENT: #4
MODEL: Qwen/Qwen3-Coder-Next
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-014
CLASS: MITTEL
DOMAIN: AUDIO
DESCRIPTION: **OG-6 · MITTEL · 2x HTTP statt HTTPS** – `services/midi-bridge/index.js:146`, `services/signaling/index.js:6`.
IMPLEMENTATION_AGENT: #2
MODEL: moonshotai/Kimi-K2.7-Code
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-015
CLASS: MITTEL
DOMAIN: BACKEND
DESCRIPTION: **OG-7 · MITTEL · insecure-object-assign** – `scripts/background-coder/hfRouter.mjs:51`: kein blindes Merge von Nutzereingaben.
IMPLEMENTATION_AGENT: #2
MODEL: moonshotai/Kimi-K2.7-Code
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-016
CLASS: MITTEL
DOMAIN: BACKEND
DESCRIPTION: **OG-8 · MITTEL · non-literal-regexp** – `scripts/deep-audit/pattern.ts:12`: Regex-Quelle validieren/escapen.
IMPLEMENTATION_AGENT: #2
MODEL: moonshotai/Kimi-K2.7-Code
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-017
CLASS: MITTEL
DOMAIN: BACKEND
DESCRIPTION: **RE-1 · MITTEL · ESLint-Fehler** – `scripts/background-coder/orchestrator.mjs:52`: `DOMAIN_AGENT_OVERRIDE` ungenutzt (no-unused-vars Error) → entfernen/verwenden.
IMPLEMENTATION_AGENT: #2
MODEL: moonshotai/Kimi-K2.7-Code
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-025
CLASS: SCHWER
DOMAIN: SECURITY
DESCRIPTION: **OG-1 · KRITISCH · Hartcodiertes TURN-Static-Secret** – `services/turn/turnserver.conf:7`: Secret sofort rotieren, aus Datei + Git-History entfernen (git-filter-repo), per Env/Secret injizieren. Wert ist im Report redigiert.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: #6
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
