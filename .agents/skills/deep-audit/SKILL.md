---
name: deep-audit
description: Führt das Deep-Audit-300-System für audioMONASTRY aus (deterministische Gates + DeepSeek/HF-KI-Review-Pässe), interpretiert AUDIT_DEEP.md und trägt neue Befunde in MASTER_TODO.md ein. Use when the user asks for a deep audit, code review, validation, security scan, 300% check, or audit report of this repository.
---

# Deep Audit 300 – Skill

Dieser Skill startet und interpretiert das eingebaute Tiefen-Audit-System des Repos. Er ergänzt den `audioaudit`-Skill für Audio-/Audio-Engine-spezifische Prüfungen.

## Wann verwenden

- Nutzer bittet um „Deep Audit", „300% prüfen", „Code-Review", „Validierung", „Security-Scan" oder „Audit-Report".
- Es sollen mehrere unabhängige Verfahren (Linter, SAST, Dependencies, Architektur-Gates, KI-Review) auf das Repo oder einen Diff angewendet werden.
- Befunde sollen nach `MASTER_TODO.md` übernommen und in `AUDIT_DEEP.md` dokumentiert werden.

## Ablauf

1. **Modus wählen**
   - Full-Audit: `npm run audit:deep`
   - Nur geänderte Dateien: `npm run audit:deep:diff`
   - Nur deterministisch/offline: `npm run audit:deep:static`
   - Kleiner Smoke-Lauf: `npm run audit:deep:smoke`
   - Direkte Steuerung: `npx tsx scripts/deep-audit/run.ts --help`

2. **Vor dem Start prüfen**
   - Repo-Root ist `audioMONASTRY` (Skripte sind dort definiert).
   - Bei KI-Pässen müssen Keys erreichbar sein (`DEEPSEEK_API_KEY`/`API_KEY`, `HF_API_KEY`/`HF_TOKEN`); `.env` wird automatisch geladen.
   - Wenn keine Keys gewünscht sind, `--offline` oder `npm run audit:deep:static` verwenden.

3. **Ergebnisse lesen**
   - Hauptreport: `AUDIT_DEEP.md`
   - Rohdaten: `test-results/deep-audit/findings.json` und `test-results/deep-audit/report.md`
   - Exit-Code: `0` = Gate bestanden, `1` = Gate nicht bestanden (`--fail-on high|critical|none` steuerbar).

4. **Befunde verarbeiten**
   - Findings nur in `MASTER_TODO.md` eintragen, wenn der Nutzer das möchte oder `--update-todo` aktiv ist.
   - Keine Codeänderungen allein aus einem Audit-Finding vornehmen; erst mit dem Nutzer priorisieren.
   - Bei Audio-/Worklet-/DSP-Findings den `audioaudit`-Skill hinzuziehen.
   - Beweise immer gegen Datei/Zeile prüfen; KI-Findings niemals ungeprüft als Fakt behandeln.

5. **Kontextregeln**
   - `AGENTS.md` enthält verbindliche Architekturregeln (B2B-Locking, Low-Latency, Plugin-Grenzen).
   - `AUDIT.md`, `MASTER_TODO.md` und `docs/*AUDIT*` sind bestehende Audit-Quellen; neue Befunde ergänzen, nicht widersprechen.
   - Keine Secrets in Reports oder Nachrichten schreiben.
