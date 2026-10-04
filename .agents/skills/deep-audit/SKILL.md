---
name: deep-audit
description: Führt das Deep-Audit-300-System für audioMONASTRY aus (deterministische Gates + DeepSeek/HF-KI-Review-Pässe), interpretiert den Audit-Report und trägt neue Befunde in TODO.md ein. Use when the user asks for a deep audit, code review, validation, security scan, 300% check, or audit report of this repository.
---

# Deep Audit 300 – Skill

Dieser Skill startet und interpretiert das eingebaute Tiefen-Audit-System des Repos. Er ergänzt den `audioaudit`-Skill für Audio-/Audio-Engine-spezifische Prüfungen.

## Wann verwenden

- Nutzer bittet um „Deep Audit", „300% prüfen", „Code-Review", „Validierung", „Security-Scan" oder „Audit-Report".
- Es sollen mehrere unabhängige Verfahren (Linter, SAST, Dependencies, Architektur-Gates, KI-Review) auf das Repo oder einen Diff angewendet werden.
- Offene Befunde sollen nach `TODO.md` übernommen werden.

## KI-Review-Pässe mit Anbieter-Rotation und Budget (erweitert 2026-09-29)

Beim Full-Audit laufen zusätzlich fokussierte KI-Pässe über verschiedene Anbieter —
**Budget-Gate zuerst** (Gesamtdeckel für einen Audit-Lauf, default 6 USD, via `AUDIT_BUDGET_USD`):

1. **Guthaben prüfen, bevor ein bezahlter Pass startet** (DeepSeek: `GET https://api.deepseek.com/user/balance`, Bearer `DEEPSEEK_API_KEY`). Verbrauch = Balance-Delta, nach **jedem** Pass loggen (z. B. `logs/audit-budget-<datum>.md`: Pass, Anbieter, prompt/completion-Tokens aus `response.usage`, Kosten-Schätzung, Restbudget). Deckel erreicht → keine bezahlten Pässe mehr, Rest mit `:free`-Modellen.
2. **Anbieter-Rotation (verschiedene Blickwinkel):**
   - **DeepSeek** (direct, Modelle `deepseek-flash`, Fallback `deepseek-chat`): Root-Cause-/Auth-Review (server.ts-Gate, aiRoutes-Validierung, runpodProvider-Fehlerpfade). Bezahlter Pass, klein halten.
   - **Nous** (nur Modelle mit Suffix `:free` — z. B. `meituan/longcat-2.0:free`, `stepfun/step-3.7-flash:free`, Liste via `GET /v1/models` filtern): Architektur-/Konsistenz-Review, Adversarial-Pass gegen die Befunde der anderen Pässe. **Kostenlos.**
   - **GLM/CometAPI**: nur nutzen, wenn die Sitzung ohnehin dort läuft; keine Extra-Pässe auf Kosten eines dritten Anbieters.
3. **Prompt-Hygiene:** nur relevante Ausschnitte (Datei:Zeile-Bereiche, < ~15k Tokens Payload), `max_tokens` 600–1000, `temperature` 0.2. KI-Antworten sind **Hypothesen** — jeder Befund gegen Datei:Zeile beweisen, bevor er in TODO.md landet.
4. **Deterministische Zusatz-Layer (billig, lokal):** `npm run lint` (Voll-Lauf), `npm run security` (audit + Interface-Boundaries), `node scripts/assert-no-skipped-tests.mjs` (skip-Schmuggel), `python3 -m compileall services scripts` (Syntax), optional `scripts/dead-code-sweep.sh`.

## Hinweise

- **Bekannte Lücke:** der `audioaudit`-Skill wird unten referenziert, existiert aber (Stand 2026-09-29) nicht unter `.agents/skills/` — Audio-/DSP-Findings entsprechend ohne ihn behandeln oder den Skill nachziehen.
- `TODO.md` war zuletzt leer/nicht vorhanden — Befunde ggf. direkt in `MASTERTODOENDE.json` als Eintrag vorschlagen (nur mit Nutzer-Freigabe).

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
   - Hauptreport: `test-results/deep-audit/audit-report.md`
   - Rohdaten: `test-results/deep-audit/findings.json` und `test-results/deep-audit/report.md`
   - **KI-Pässe (Rotation + Budget):** `python3 scripts/audit-ki-passes.py --pass rootcause|adversarial|archdrift|all --budget 6` — Reporte unter `test-results/deep-audit/ki-passes/`, Budget-Log `logs/audit-budget-<datum>.md`. Eingebaute Learnings: DeepSeek-Reasoning braucht max_tokens ≥ 8000 (leerer Content → Auto-Retry), blocked-Key-Erkennung (Nous 401 → Anbieter skip), Free-Fallback-Kette nous → llm7 → FreeLLMAPI-Router. `--dry-run` und `--list` vorhanden; npm: `npm run audit:ki`.
   - Exit-Code: `0` = Gate bestanden, `1` = Gate nicht bestanden (`--fail-on high|critical|none` steuerbar).

4. **Befunde verarbeiten**
   - Findings nur in `TODO.md` eintragen, wenn der Nutzer das möchte oder `--update-todo` aktiv ist.
   - Keine Codeänderungen allein aus einem Audit-Finding vornehmen; erst mit dem Nutzer priorisieren.
   - Bei Audio-/Worklet-/DSP-Findings den `audioaudit`-Skill hinzuziehen.
   - Beweise immer gegen Datei/Zeile prüfen; KI-Findings niemals ungeprüft als Fakt behandeln.

5. **Kontextregeln**
   - `AGENTS.md` enthält verbindliche Architekturregeln (B2B-Locking, Low-Latency, Plugin-Grenzen).
   - `TODO.md` ist die einzige offene Aufgabenliste; neue Befunde dort als offene Punkte ergänzen, nicht widersprechen.
   - Keine Secrets in Reports oder Nachrichten schreiben.
