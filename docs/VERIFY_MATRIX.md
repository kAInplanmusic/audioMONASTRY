# Gate-Matrix: welches Gate läuft wo

**Stand:** HEAD `9a9d6d37`, 2026-11-06 · Ticket **AUDIT P2-006**
**Quellen (maßgeblich, nicht diese Datei):** `package.json` → `scripts`, `.github/workflows/ci.yml`,
`build.yml`, `nightly.yml`, `audioflow.yml`, `sonarcloud.yml`, `ai.yml`, `deep-audit.yml`, `live-stress.yml`.
Bei Abweichung gilt immer der Workflow/das Skript; dann diese Datei nachziehen (siehe „Pflege“).

**Warum diese Datei existiert:** `npm run verify` hat 10 Gates, `ci.yml` fährt davon nur eine
Teilmenge, das Nightly fährt die volle Kette – und ein `|| true` beim Bundle-Budget hat einen
Fehlschlag unsichtbar gemacht. Ohne eine Übersicht ist nicht erkennbar, welches Gate wo greift
und welches nirgends.

## Legende

| Zeichen | Bedeutung |
|---|---|
| ✅ | läuft im vollen Umfang |
| ⚠️ | läuft, aber eingeschränkt (Teilmenge/anderer Schalter) – Einschränkung steht in der Zeile |
| – | läuft dort nicht |
| *skip* | Gate existiert dort, kann sich aber ohne Voraussetzung selbst überspringen (Exit 0) |

## A. Die 10 Gates der `npm run verify`-Kette

`verify` = `typecheck → lint → test → test:python → security → audio:gate → audit:rt:gate →
test:rls → check:deadfiles → audit:deep:static → verify:summary` (verkettet mit `&&`, Abbruch beim
ersten Fehler).

| # | Gate | Befehl | verify | `ci.yml` (PR + push main) | `nightly.yml` (04:00 UTC) | weitere Workflows | SKIPPED-Bedingung (Wann grün ohne Messung?) | Benötigte Secrets/Zugangsdaten |
|---|---|---|---|---|---|---|---|---|
| 1 | Typecheck | `npm run typecheck` (`tsc --noEmit`) | ✅ | ✅ | ✅ (via verify) | `audioflow.yml` ✅, `ai.yml` ✅ (`npx tsc --noEmit`) | keine – bricht bei Typfehlern ab | – |
| 2 | Lint | `npm run lint` (`eslint . --max-warnings=0`) | ✅ | ✅ | ✅ (via verify) | `build.yml` ✅ (Schritt heißt „TypeScript-Check“, ruft aber `npm run lint`), `audioflow.yml` ✅ | keine – 0 Warnings sind Pflicht | – |
| 3 | Unit-/Integrationstests | `npm run test` (`NODE_ENV=test vitest run`) | ✅ | ⚠️ `npm run test:ci` (strenger: JSON-Report + `assert-no-skipped-tests.mjs`) | ⚠️ nur `test` via verify – **ohne** Skip-Assert | `sonarcloud.yml` (`test:coverage`), `ai.yml` (nur `aiOrchestrator.test.ts`) | `test`: keine (Vitest kann intern skippen, wird hier nicht geprüft); `test:ci`: bricht bei `skip`/`todo` ab | – |
| 4 | Python-Tests | `npm run test:python` (10 Skripte) | ✅ | ⚠️ **andere, kleinere Menge**: 10 Einzeldateien (u. a. `plugin_interface_test`, `test_runpod_comfyui_probe`, `test_moa_orchestrator`); gemeinsame Schnittmenge mit `test:python` ist nur `test_runpod_deploy_defaults.py` | ✅ (via verify, `test:python`) | – | bricht bei fehlendem `python3`/`numpy` ab (Exit ≠ 0), kein Skip | – (CI installiert `numpy`) |
| 5 | Security | `npm run security` (`npm-audit.mjs` + `validate-interface-boundaries.mjs`) | ✅ | ✅ | ✅ (via verify) | `ai.yml` ⚠️ (nur Boundary-Scan + `npm audit --omit=dev`) | keine – kann der Registry-Audit nicht laufen, **exit 3** („Gate darf nicht grün sein“) | Netz zu registry.npmjs.org (kein Secret) |
| 6 | Audio-Gate (LUFS/True-Peak) | `npm run audio:gate` (`scripts/audio-gate.sh`) | ✅ | ✅ (installiert ffmpeg vorher) | ⚠️ **kein ffmpeg-Install im Job** – fehlt ffmpeg im Runner-Image, bricht das Skript mit exit 1 ab (kein Skip) | `sonarcloud.yml` ✅ (installiert ffmpeg) | keine – fehlendes ffmpeg oder fehlende WAVs = Fehler | – |
| 7 | Echtzeit-Audit | `npm run audit:rt:gate` (`rt-bench.ts --gate`) | ✅ | ✅ | ✅ (via verify) | – | keine | – |
| 8 | RLS-Live-Abgleich | `npm run test:rls` (`verify-rls-live.ts --gate`) | *skip* | – | *skip* (via verify; im Runner gibt es keine `.env`) | – | **`SB_URL` + `SB_SERVICE_ROLE` fehlen → „UEBERSPRUNGEN“, Exit 0** | `SB_URL`, `SB_SERVICE_ROLE` (Service-Role-Key, nur serverseitig/CI-Secret) |
| 9 | Dead Files/Dependencies | `npm run check:deadfiles` (`knip --include files,dependencies`) | ✅ | – | ✅ (via verify) | – | keine | – |
| 10 | Deep-Audit (statisch) | `npm run audit:deep:static` (`run.ts --mode full --offline`) | ⚠️ statisch: **KI-Stages (deepseek-flash/hf-qwen/deepseek-pro) laufen nicht** (`skippedStage('offline-Modus')`) | – | ⚠️ wie verify | `deep-audit.yml` (manuell, `--fail-on high`) ⚠️ ebenfalls `--offline` | KI-Stages immer (by design, `--offline`); statische Befunde laufen | – (KI-Stages bräuchten Provider-Keys, laufen hier nie) |

## B. Gates außerhalb der verify-Kette

| Gate | Befehl | wo es läuft | SKIPPED-Bedingung | Secrets |
|---|---|---|---|---|
| Bundle-Budget (Startlast) | `npm run check:bundle` bzw. `node scripts/check-bundle-size.mjs` | `build.yml` (PR + push main) ✅, `nightly.yml` ✅ (**seit P2-006 ohne `|| true`**) | keine – Budgetüberschreitung ist rot | – |
| React.memo-Audit | `npm run check:memo` | `build.yml` ✅ | keine | – |
| Memory-Pressure-Gate (< 512 MB Heap-Delta) | `npm run check:memory` | nur `nightly.yml` ✅ | keine | – |
| Stresstest (Playwright, FPS/Heap) | `npm run test:stress` | `nightly.yml` Job `stress-longtest` ✅, `live-stress.yml` (manuell) ✅ | keine; FPS-Gate läuft jetzt **während** der Last (P2-005) | – |
| Übrige E2E-Specs (`smoke`, `audio-smoke`, `aiNegative`, `responsive`, `a11y`, `collab`, `performance`) | `npm run test:e2e*` | **nirgends automatisch** (nur lokal / manuell); `audioflow.yml` fährt einen eigenen Inline-Browser-Smoke statt der Suite | – | `STUDIO_ACCESS_TOKEN` (lokal aus `.env`) |
| Bundle/`dist`-Build | `npm run build` | `ci.yml` ✅, `nightly.yml` ✅, `build.yml` ✅, `audioflow.yml` ✅ | keine | – |
| Secret-Scan | `gitleaks-action` | `build.yml` ✅ (`fetch-depth: 0`) | keine | `GITHUB_TOKEN` (vorhanden) |
| Compose-Validierung (Deploy-Manifeste) | `docker compose config` je Datei/Overlay | `build.yml` ✅ | keine | – |
| Google-/Firebase-Importverbot | `grep` über `src`, `server.ts` | `build.yml` ✅ | keine | – |
| KI-Eval je Plugin | `npm run eval:ai` | nur `nightly.yml` | **ohne erreichbares Modell: „UNCHECKED“, Exit 0**; mit `AI_EVAL_REQUIRE_MODEL=1` wird daraus ein Fehler | Provider-Keys der Flotte (falls vorhanden) |
| Prompt-Iteration | `npm run iterate:prompts` | nur `nightly.yml` | Konvergenz-Gate; ohne Modell kein echter Lauf | dito |
| Coverage/Sonar | `npm run test:coverage` | `sonarcloud.yml` ✅ | keine | `SONAR_TOKEN` (Repo-Secret) |
| NIRGENDS verdrahtet (tote Skripte) | `test:python:pods`, `test:python:master`, `perf:worklet`, `check:dupes`, `mcp:smoke`, `proof:turn`, `proof:ice-recovery`, `proof:mjpeg`, `proof:webgpu`, `proof:ffmpeg-whitelist` | – | – | teils Live-Zugänge |

## C. Die Abschlusszeile der verify-Kette

`npm run verify` endet mit **`npm run verify:summary`**. Die Zeile nennt jedes Gate, das
zwar angestoßen, aber nicht wirklich gemessen wurde – heute konkret:

```
GATE-ABDECKUNG (verify): 1 Gate(s) uebersprungen
  - test:rls - RLS-Live-Abgleich gegen die echte DB: SB_URL/SB_SERVICE_ROLE nicht gesetzt, das Skript meldet UEBERSPRUNGEN
  Hinweis: audit:deep:static laeuft ohne KI-Stages (--offline). Gates ausserhalb der verify-Kette: docs/VERIFY_MATRIX.md
```

Grenzen dieser Zeile, damit sie nicht für mehr gehalten wird, als sie ist:

* Sie läuft **nur bei grünem Lauf** (`&&`-Kette). Bricht ein Gate vorher ab, ist der Abbruch die
  Meldung – dann gibt es keine Zusammenfassung.
* Sie prüft die Skip-Bedingungen der Gates, die sich selbst überspringen können (heute nur
  `test:rls`). Gates, die bei fehlender Voraussetzung **abbrechen** (`audio:gate` ohne ffmpeg,
  `security` ohne Registry), brauchen keine Zeile: sie werden rot.

## D. Bekannte Lücken (Befund, nicht behoben)

1. **`test:rls` ist überall übersprungen.** In `verify` und im Nightly fehlen `SB_URL`/`SB_SERVICE_ROLE`,
   in `ci.yml` läuft das Gate gar nicht. Der einzige Live-RLS-Messpunkt ist damit ein manueller
   Aufruf (`npm run verify:rls-live` mit gesetzten Werten).
2. **Nightly fährt `test`, nicht `test:ci`.** Der Skip-Assert (`assert-no-skipped-tests.mjs`) läuft
   nur in `ci.yml`; im Nightly können Tests still übersprungen werden.
3. **Nightly installiert kein ffmpeg**, `ci.yml` und `sonarcloud.yml` schon. Solange das
   Runner-Image ffmpeg mitbringt, ist das folgenlos; sonst bricht `audio:gate` im Nightly ab.
4. **Die Python-Mengen von `verify` und `ci.yml` sind nicht deckungsgleich** (Schnittmenge: eine
   Datei). Beide sind grün, ohne dass eine der beiden Mengen die andere enthält.
5. **`check:deadfiles` und `audit:deep:static` laufen nur im Nightly** – ein PR kann sie brechen,
   ohne dass `ci.yml` rot wird.
6. **Die E2E-Suite läuft in keinem Workflow vollständig** (nur `stress.spec.ts` im Nightly,
   on-demand `live-stress.yml`).

## Pflege

Neues Gate? Dann in derselben Änderung: (1) `package.json`-Skript anlegen, (2) in `verify`
aufnehmen (oder hier begründen, warum nicht), (3) Zeile in Tabelle A/B, (4) kann es sich selbst
überspringen, zusätzlich in `verify:summary` aufnehmen.
