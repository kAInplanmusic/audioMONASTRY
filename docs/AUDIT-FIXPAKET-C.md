# AUDIT-FIXPAKET-C — Report

**Stand:** 2026-09-29 · Bearbeiter: Sub-Agent Paket C · Repo-only, lokale Commits, **nicht gepusht**
**Befundquelle:** `docs/AUDIT-RESTTODOS.md` (C1–C5) · Regeln beachtet: NTFS (`core.fileMode=false` unangetastet), Tests nur mit `NODE_ENV=test`, keine Pushes.

## Commits

| # | SHA | Inhalt |
|---|-----|--------|
| c1 | `211a3d6` | NODE_ENV-Pinning: vitest.config.ts `test.env`, tests/setup.ts Fail-Fast, 14 Server-Import-Testfiles, `scripts.test` |
| c2 | `71388de` | comfyui_adapter.py imageHq → worker-comfyui-Vertrag (+ Historien-Kommentar), manifestRoles-VRAM-Gate, neuer Contract-Test |
| c3 | *(siehe `git log`)* | main.yml gelöscht, AUDIT-RESTTODOS-Status-Updates, dieser Report |

## Geänderte Dateien

**c1 (NODE_ENV, 17 Dateien):**
- `vitest.config.ts` — `test.env: { NODE_ENV: 'test' }` zentral (mit Begründungs-Kommentar)
- `tests/setup.ts` — Fail-Fast bei `NODE_ENV=production` im Setup (klare Diagnose statt ~90 Env-Fails)
- `package.json` — **nur** `"test": "NODE_ENV=test vitest run"` (devDeps-Ordnung nicht nötig)
- 14 Server-Import-Testfiles, je `process.env.NODE_ENV ??= 'test';` am Modulkopf **vor** dem dynamischen `import('../server')` (Reihenfolge je Datei skriptgeprüft): `agentRoutes`, `aiRateLimitRoutes`, `aiRoutes`, `aiSecurityPenTest`, `aiSecurity`, `alertsWebhookAuth`, `cloudR2Routes`, `masterRoutes`, `security`, `server`, `stemRoutes`, `telemetryXrun`, `uploadChunkRoutes`, `visualMjpegRoutes`
- **Nicht angefasst** (setzen selbst `NODE_ENV='production'` für ihre Szenarien): `cspPolicy`, `webrtcConfigF6`, `corsAllowedOrigins`, `securityProductionAuth`, `sessionResetProduction`

**c2 (C2+C4, 3 Dateien):**
- `services/audiomonastry-ai-runtime/comfyui_adapter.py` — `COMFY_ROLES.imageHq` → `{worker: "comfyui", protocol: "workflow", defaultModel: "flux1-dev"}`; Alt-Eintrag (`flux`/`prompt`/`flux1-dev-juiced`) als Kommentar **„Historisch bis 2026-09-27 (b90f7a8)“** oberhalb erhalten, nicht gelöscht; Modul-Docstring an den neuen Vertrag angepasst (Alt-Vertrag als historisch markiert)
- `tests/test_comfyui_adapter_imagehq.py` — **neu**, unittest (Konvention der Geschwister-Tests: Direktaufruf `python3 tests/…`, kein pytest nötig), 5 Fälle, offline
- `tests/manifestRoles.test.ts` — VRAM-Gate `Summe(estimatedVRAM der preloadModels) ≤ vramBudgetGb − vramSafetyMarginGb` je Rolle

**c3 (C5+Doku, 3 Dateien):**
- `.github/workflows/main.yml` — **gelöscht** (Sonar-Platzhalter `DEIN_PROJEKT_KEY`, workflow_dispatch-only, unbenutzbar)
- `docs/AUDIT-RESTTODOS.md` — Status-Updates je C1–C5 als Nachtrag-Blockquotes (Originaleinträge unangetastet)
- `docs/AUDIT-FIXPAKET-C.md` — dieser Report

## Beweise (alle real ausgeführt, 2026-09-29)

1. **Vorher-Nachher NODE_ENV** (Kernbefund C3):
   - Baseline `NODE_ENV=test`, 15 Files: **15 Files / 141 Tests grün** (vor jeder Änderung).
   - Gift-Env (ambient `NODE_ENV=production` dieses Hosts), `tests/aiRoutes.test.ts` ohne Pin: **18/18 FAILS** (`STUDIO_TOKEN_MISSING`, fail-closed) — Befund reproduziert.
   - Gleicher Lauf **nach** c1 bei identisch ambientem `production`: **18/18 grün** — `test.env` gewinnt gegen das Host-Env (vitest setzt selbst nur `NODE_ENV ??= 'test'` in `prepareVitest`; `config.env` wird an die Worker-Umgebungen verteilt, verifiziert in vitest 4.1.11-Dist).
2. **Finaler Suite-Lauf** (nach allen Änderungen, `NODE_ENV=test`): **15 Files / 142 Tests bestanden** (141 + 1 neues C4-Gate).
3. **Contract-Test C2:** `python3 tests/test_comfyui_adapter_imagehq.py` → **5/5 OK** (Rolle/Protokoll, Historien-Kommentar vorhanden + Alt-Worker aktiv nirgends mehr, klarer ValueError ohne deklarierten Workflow statt prompt-Body, `{workflow}`-Body ohne `prompt`-Feld, rohes base64 → `data:image/png;base64,…`).
4. **C4-Gate negativ verifiziert** (Manifest byte-exakt restauriert, sha256-gegengeprüft):
   - `whisper-large-v3` (Rolle `ears`, keine Ausnahme) est 5→200: Gate schlägt an (`ears: Summe 221 GB > Deckel 42 GB`).
   - videoAbstract-Ausnahmezeile temporär entfernt: Gate schlägt an (`videoAbstract: Summe 27 GB > Deckel 18 GB`).
   - Beide Dateien danach sha256-identisch zum Stand vor dem Versuch.
5. **Statisch:** `python3 -m py_compile` adapter + neuer Test → OK · `eslint --max-warnings=0` über **alle 17 geänderten TS-Files** → OK · `package.json` JSON-parse → OK · YAML-Parse **aller 9 verbleibenden Workflows** nach der main.yml-Löschung → alle OK.
6. **Nach jedem Commit:** `git status` geprüft — nur eigene Dateien im Commit (Fremdstände unberührt gelassen, s. u.).

## Neue Befunde (über RESTTODOS hinaus)

- **C4 betrifft zwei Rollen, nicht eine:** neben `videoReal` (wan22-t2v-a14b est 32 GB; Preload-Summe **41 GB** vs. Deckel 24−6=**18 GB**) verletzt auch **`videoAbstract`** das Gate (ltx-video-13b est 18 GB; Summe **27 GB** vs. **18 GB**). Beide als dokumentierte Ausnahme geführt (`VRAM-Nachmessung offen (APP-Touch)`), Verstöße bleiben als `console.warn` im Testlauf sichtbar; Manifestwerte bewusst **nicht** gefälscht.
- `vitest`-`test.env`-Semantik verifiziert: verteilt an Worker-Umgebungen, gewinnt gegen `process.env` — deshalb greift das zentrale Pinning auch für jsdom/React-Builds.

## skipped_due_to_parallel_worker

- **`scripts/runpod-deploy.py` + `tests/test_runpod_deploy_defaults.py` (C1):** Paket-A-Dateien — laut Auftrag und Skills an Paket A übergeben; in `AUDIT-RESTTODOS.md` unter C1 entsprechend vermerkt. Keine Sichtung/Änderung.
- Paket-A-/B-Dateien (`src/visuals/visualDirector.ts`, `tests/visualDirector.test.ts`, `.github/workflows/runpod-deploy.yml`, `docs/AUDIT-FIXPAKET-A.md`, `MASTERTODOENDE.json`, `docs/INFRA_KONSTITUTION.md`, `docs/runpod-8-instances-complete-plan.md`, `docs/AUDIT-FIXPAKET-B.md`): zu Task-Beginn und vor jedem Commit per `git status` kontrolliert — keine Berührung.

## Fremdstände im Working Tree (nicht meine, unangetastet gelassen)

- `M .agents/skills/deep-audit/SKILL.md`, `D .claude/skills/*` (7 Löschungen), `M tests/namingConventions.test.ts`, `?? docs/PROPOSAL_legacy-shim-removal.md`, `?? scripts/audit-ki-passes.py`
- **Hinweis zu package.json:** Bei Task-Beginn lag eine **uncommittete Fremdänderung** vor (Scripts `audit:ki`/`audit:ki:free` → `scripts/audit-ki-passes.py`). Um sauber nur `scripts.test` committen zu können, wurde sie vor c1 gesichert (`/tmp/pkg-foreign-auditki.patch`), `package.json` auf HEAD gesetzt und **nach c3 originalgetreu als uncommittete Arbeitsbereichsänderung wiederhergestellt** — kein Inhalt verloren, aber bewusst nicht in meine Commits gemischt.

## Offene Punkte

1. **C1** (Deploy-Defaults): an Paket A; Stand dort prüfen.
2. **C4-Nachmessung:** VRAM von wan22-t2v-a14b und ltx-video-13b am live-Worker messen (APP-Touch → nur mit Freigabe); danach Ausnahmen entweder auflösen (Budget/Pool anheben oder Preload korrigieren) oder bestätigen. Bis dahin Warnungen sichtbar.
3. **C5-Rest:** „ai.yml in ci.yml aufgehen lassen“ — bewusst offen gelassen (ai.yml aktiv, eigenständig; Verschmelzung ist Betreiber-Entscheid).
4. **imageHq-Workflow-Datei:** `workflows/imageHq.json` existiert nicht (Adapter nutzt inline `workflow` aus `runpodVision.ts` bzw. `COMFY_WORKFLOW_IMAGEHQ`); der Contract-Test skippt die Workflow-Datei-Prüfung, sobald sie existiert. Optional: Datei aus `image_flux1.json` ableiten.
5. **Probe-Skript** `scripts/runpod-comfyui-probe.py` nennt imageHq noch als PrunaAI/prompt in Header-Doku (`--role imageHq --prompt`) — Datei lag im Fremdlisten-Umfeld und war nicht Teil des Auftrags; bei nächster Gelegenheit an den Workflow-Vertrag anpassen.
6. Drei lokale Commits liegen auf `main` — **nicht pushen** (Remote wird parallel von anderen Rechnern bespielt; Push nur auf expliziten Auftrag).
