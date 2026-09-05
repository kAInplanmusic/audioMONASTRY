# AUDIT REPORT – OpenGrep + reviewdog Tiefen-Audit

Datum: 2026-09-05
Scope: `/home/patrick/audioMONASTRY` (git-tracked Dateien)
Modus: D – Audio-Engine-Code-Audit (SAST + Linter, offline)
Tools: OpenGrep v1.29.0 · reviewdog v0.21.0 (ESLint 10.9.1, tsc 5.8.3) · npm audit

## Zusammenfassung

- Status: **FAIL** (1 kritischer Security-Befund: hartcodiertes Secret im Repo)
- OpenGrep: **545 Regeln auf 744 Dateien → 59 Findings** (4 ERROR, 41 WARNING, 14 INFO)
- reviewdog/ESLint: **72 Probleme** (1 Error, 71 Warnings)
- reviewdog/tsc: **0 Fehler** (TypeScript sauber)
- npm audit: **0 Vulnerabilities** (675 Dependencies geprüft)

> Hinweis: OpenGrep hat 9 Dateien nur partiell geparst (Bash-Snippets in Workflows, 1 JSON, server.ts Syntax-Meldung) und 57 Dateien > 1 MB übersprungen. Die Zahlen sind daher eine Untergrenze.

## Befunde

### Kritisch

| ID | Severity | Ort | Befund | Empfehlung |
|---|---|---|---|---|
| OG-1 | KRITISCH | `services/turn/turnserver.conf:7` | Hartcodiertes TURN-Auth-Secret (`static-auth-secret=…`, Wert redigiert) ist eingecheckt und damit in der Git-History | Secret sofort rotieren; aus Datei + History entfernen (BFG/git-filter-repo); per Umgebungsvariable/Secret injizieren |

### Hoch

| ID | Severity | Ort | Befund | Empfehlung |
|---|---|---|---|---|
| OG-2 | HOCH | `.github/workflows/live-stress.yml:29,32` | Shell-Injection: `${{ inputs.base_url }}` direkt in `run:` interpoliert | Input via `env:` an den Step übergeben und im Skript referenzieren |
| OG-3 | HOCH | `.github/workflows/live-stress.yml:46` | Script-Injection: `github`-Context-Daten direkt im `actions/github-script`-`script:` interpoliert | Daten als Environment-Variablen übergeben, nicht inline interpolieren |

### Mittel

| ID | Severity | Ort | Befund | Empfehlung |
|---|---|---|---|---|
| OG-4 | MITTEL | 8 Workflow-Dateien (35 Stellen) | Actions nur mit mutablem Tag gepinnt (`actions/checkout@v4` etc.) – Supply-Chain-Risiko | Auf vollständige Commit-SHA pinnen |
| OG-5 | MITTEL | `scripts/hetzner/dns_setup.py:43`, `scripts/hetzner/provision.py:48` | Dynamische URL-Konstruktion für urllib-Requests | URL-Schema-/Host-Allowlist + Validierung |
| OG-6 | MITTEL | `services/midi-bridge/index.js:146`, `services/signaling/index.js:6` | HTTP-Server statt HTTPS | TLS terminieren bzw. nur intern binden |
| OG-7 | MITTEL | `scripts/background-coder/hfRouter.mjs:51` | `insecure-object-assign` (ungeprüftes Zusammenführen von Nutzereingaben) | Spread/explizite Feldprüfung, keine blinde Merge |
| OG-8 | MITTEL | `scripts/deep-audit/pattern.ts:12` | Non-literal Regex (ReDoS-/Injection-Risiko) | Regex-Quelle validieren/escapen |
| RE-1 | MITTEL | `scripts/background-coder/orchestrator.mjs:52` | ESLint-Fehler: `DOMAIN_AGENT_OVERRIDE` zugewiesen, nie genutzt | Variable entfernen oder verwenden |

### Niedrig

| ID | Severity | Ort | Befund | Empfehlung |
|---|---|---|---|---|
| OG-9 | NIEDRIG | 13 Stellen (u. a. `src/utils/audioEngine.ts:449`, `src/context/AudioContext.tsx:80,85`, `src/utils/errorTracker.ts:45`, `services/midi-bridge/index.js:35`, `services/taskWorker.ts:81`) | Unsichere Format-Strings (variabler Format-String an `console.*`/printf-artige APIs) | Literale Format-Strings verwenden |
| OG-10 | NIEDRIG | `services/signaling/index.js:5` | Express ohne `csurf`-Middleware (CSRF-Schutz) | CSRF-Middleware ergänzen oder Endpunkte als reine APIs absichern |
| RE-2 | NIEDRIG | 62 Stellen, diverse Dateien | `no-unused-vars`: ungenutzte Variablen/Importe | Aufräumen oder ESLint-Regel pro Verzeichnis schärfen |
| RE-3 | NIEDRIG | 6 Stellen (React-Hooks) | `react-hooks/exhaustive-deps`: fehlende/unnötige Dependencies | Dependencies korrigieren |
| RE-4 | NIEDRIG | `src/utils/audioEngine.ts:2025,2027` | `@ts-ignore` statt `@ts-expect-error` | Auf `@ts-expect-error` umstellen |
| RE-5 | NIEDRIG | 1 Stelle | `no-unused-expressions` | Ausdruck in Anweisung auflösen |

## Priorisierte Maßnahmen

1. **Sofort (P0):** OG-1 – TURN-Secret rotieren und aus Repo/History entfernen. Es ist über die Git-History bereits geleakt; alle Stellen, die dieses Secret nutzen, müssen auf das neue Secret umgestellt werden.
2. **Kurzfristig (P1):** OG-2 + OG-3 – Injection in `live-stress.yml` fixen (env-Übergabe statt Interpolation).
3. **Kurzfristig (P1):** RE-1 – ESLint-Fehler in `orchestrator.mjs` beheben, damit Lint wieder grün werden kann.
4. **Mittelfristig (P2):** OG-4 Action-Pinning, OG-5/OG-6/OG-7/OG-8 Härtung, OG-9 Format-Strings.
5. **Aufräumen (P3):** RE-2 bis RE-5 – ESLint-Warnungen reduzieren (62 ungenutzte Variablen).

## Verknüpfte Prüfpunkte

- [ ] Gate S-Security: keine Secrets im Repo (nach OG-1-Fix verifizieren)
- [ ] Gate Q-Qualität: `npm run lint` (tsc) bleibt grün, ESLint ohne Errors
- [ ] Gate CI-Hardening: Workflow-Actions auf SHA gepinnt (OG-4)
- [ ] Gate D-Dependencies: `npm audit` weiterhin 0 Vulnerabilities

## Anhang: Scan-Statistiken

| Tool | Regeln | Dateien | Findings |
|---|---|---|---|
| OpenGrep (`auto` + `p/security-audit` + `p/secrets`) | 545 | 744 | 59 (4 E / 41 W / 14 I) |
| ESLint via reviewdog | – | – | 72 (1 E / 71 W) |
| tsc via reviewdog | – | – | 0 |
| npm audit | – | 675 Deps | 0 |

OpenGrep-Regelverteilung (Top): 35× `github-actions-mutable-action-tag`, 13× `unsafe-formatstring`, 2× `run-shell-injection`, 2× `dynamic-urllib-use-detected`, 2× `using-http-server`, 1× `github-script-injection`, 1× `insecure-object-assign`, 1× `detect-non-literal-regexp`, 1× `express-check-csurf-middleware-usage`, 1× `detected-generic-secret`.
