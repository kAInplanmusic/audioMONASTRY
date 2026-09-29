# Audit-Fixpaket A — Bericht (2026-09-29)

Scope: CI-ESLint-Fix, Idempotenz/Fehlerbehandlung in `scripts/runpod-deploy.py`,
Workflow-Meldung/-Trigger in `.github/workflows/runpod-deploy.yml`, dieser Report.
Kein Push, kein Deploy, kein RunPod-LIVE-API-Zugriff, **keine inhaltlichen
Deploy-Default-Änderungen** (imageHq worker-comfyui bleibt separates Paket b).

## 1) ESLint-CI-Fix — Commit `9016a7c`

- `src/visuals/visualDirector.ts:77`: ungenutzter Parameter `opts` → `_opts`
  (entspricht `args-unused-pattern: ^_`).
- `tests/visualDirector.test.ts:56`: `let state` → `const state` (wird nie
  reassigned).
- Beweis:
  - `NODE_ENV=test npx vitest run tests/visualDirector.test.ts` → **9/9 passed** (Exit 0)
  - `npx eslint --max-warnings=0 src/visuals/visualDirector.ts tests/visualDirector.test.ts` → **Exit 0**

## 2) Deploy-Fixes — Commit `23df2e7`

### Template-Idempotenz (Live: „QueryError: Template name must be unique“, Rollen music + videoAbstract)

- Neu: Wenn die erste Lesung von `myself.podTemplates` **fehlgeschlagen** war und
  der Create dann auf den Unique-Fehler läuft, wird die Liste **erneut gelesen**;
  ein gefundenes Template wird **aktualisiert** (Update-Pfad) statt die Rolle zu
  überspringen. Genau der Live-Fehlerpfad aus run 36580686816.
- Grenze bewusst gezogen: War die erste Lesung ok (nur leer), gibt es **keinen**
  zweiten Call — sonst bekäme jeder Create einen Extra-API-Call. Der bestehende
  Repo-Test-Vertrag (`TemplateFallbackTest`) bleibt unverändert gültig.
- Listing-Fehler werden jetzt **sichtbar auf stderr gemeldet** statt still
  geschluckt (vorher: stiller `existing_template_id = ""` → der Lauf fiel erst
  beim Create auf die Nase, ohne Ursprungsmeldung).

### Registry-Auth (Live: „Registry-Auth konnte nicht angelegt werden: Failed to create registry auth“)

- `ensure_registry_auth`: **einmaliger Retry** nach fehlgeschlagenem Create; bei
  erneutem Fehlschlag klare Meldung mit möglichen Ursachen (Name belegt,
  Token/Permissions, API-Störung) und Abhilfe (`RUNPOD_REGISTRY_AUTH_ID=<id>` —
  wird dann ohne Anlegen direkt verwendet). Die Rolle läuft dann explizit
  gemeldet OHNE Registry-Auth weiter (privates Image nicht ziehbar).
- Verifiziert gegen `runpod==1.12.0` (CI-Version): das SDK bietet **keinen
  Lesezugriff** auf vorhandene Registry-Auths (nur create/update/delete), daher
  ist der Retry der mögliche Hebel — eine „bestehendes Credential suchen und
  verwenden“-Logik ist mit dem SDK nicht abbildbar.

### RP_API_KEY-Warnung („Repo-Secret RP_API_KEY fehlt oder ist leer“ trotz existierendem Secret)

- Workflow-Mapping **verifiziert**: Preflight (Z. 326) und Deploy-Step (Z. 338)
  lesen beide `secrets.RP_API_KEY` → Env `RP_API_KEY`. Das Mapping ist korrekt.
- Präzisierungen: Der Preflight nennt jetzt den **exakten gelesenen Namen**
  (`secrets.RP_API_KEY`, gemappt auf Env `RP_API_KEY` beider Steps) plus
  Abhilfe (Repo-Settings → Secrets and variables → Actions, exakter Name,
  z. B. Verwechslung mit `RUNPOD_API_KEY`). Die Python-Meldungen (`main`,
  REST-Pfad) nennen die Env-Reihenfolge `RP_AGENT_KEY > RP_API_KEY >
  RUNPOD_API_KEY` und das CI-Mapping.
- Erkenntnis: Da Mapping und Lesename korrekt sind, bleibt für die Live-Warnung
  nur ein **Kontext-Problem** (Step lief in einem anderen Kontext/Fork) oder ein
  inzwischen gelöschtes Secret — kein Mapping-Bug. Die präzisierte Meldung führt
  die Prüfung beim nächsten Auftreten.

### Trigger-Änderung (Betreiber-Freigabe, INFRA-AUDIT 2026-09-29)

- `push:`-Trigger (branches/paths) **entfernt**; der Workflow läuft nur noch per
  `workflow_dispatch` mit unveränderten Inputs. Kommentar im YAML. Kein
  automatischer Deploy mehr bei Push auf main.

## Verifikation (Commit 2)

- `python3 -m py_compile scripts/runpod-deploy.py` → OK
- YAML-Parse → OK; `on:` enthält **nur** `workflow_dispatch`
- `python3 tests/test_runpod_deploy_defaults.py` → **48/48 OK**
- **7/7 Offline-Smoke-Tests** der neuen Pfade (gemocktes `runpod`-SDK, kein
  Netz): Unique-Fehler bei fehlgeschlagener erster Lesung → Update; persistenter
  Listing-Fehler → sichtbare Warnung, kein zweiter Call; erste Lesung ok/leer →
  kein Extra-Call, Rolle wird sauber übersprungen; `RUNPOD_TEMPLATE_ID`-Override
  gewinnt; Registry-Retry erfolgreich / endgültig fehlgeschlagen mit Abhilfe-
  Meldung / explizite ID umgeht das Anlegen.
- Kein `bash`-Skript berührt → kein `bash -n` nötig.

## Offen / nicht Teil dieses Pakets

- **Paket b:** imageHq worker-comfyui-Update (Deploy-Defaults inhaltlich) — hier
  bewusst nicht angefasst.
- Live-Verifikation der neuen Pfade: RunPod-LIVE-API-Zugriffe sind verboten
  (APP-Ebene, keine Freigabe); der erste **manuelle** `workflow_dispatch`-Lauf
  ist der Live-Beweis.
- Wiederholt sich die „RP_API_KEY fehlt“-Warnung: Secret-Existenz in
  Repo-Settings prüfen (exakter Name `RP_API_KEY`); ist es vorhanden, den
  Kontext des fehlgeschlagenen Steps ansehen (Fork/anderes Repo).
- Registry-Auth-Retry ist einmalig; scheitert auch der zweite Versuch, ist
  `RUNPOD_REGISTRY_AUTH_ID` der Weg (Meldung im Log sagt es).
