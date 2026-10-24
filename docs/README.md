# Doku-Index und Provenienz

> Stand 2026-10-18. Diese Seite beantwortet zwei Fragen, die der
> Bereinigungs-Commit `6dc1c35e` offen gelassen hat (Ticket
> DOC-2026-10-13-001): **welche Dokumente gelten** und **woher stammen die
> wiederhergestellten**.

## 1. Verbindliche Einstiegspunkte

Diese Dateien treffen die Aussagen, an denen sich Code und Betrieb messen
lassen. Sie sind bei Widerspruch zuerst zu lesen - und bei Aenderung zuerst
nachzuziehen.

| Datei | Was sie verbindlich sagt |
| --- | --- |
| `AGENTS.md` | Architektur- und Arbeitsregeln (Rollen, Pfade, Testpflichten) |
| `MASTERTODOENDE.json` | Einzige Liste offener Arbeit (Status, Belege, offene Reste) |
| `docs/INFRA_KONSTITUTION.md` | Grenzen fuer Flotte und Kosten (Zahlen, die anderswo zitiert werden) |
| `docs/SERVER_FLEET.md` | Rollen und Servertypen der Flotte - die eine Tabelle, inkl. `FLEET_TYPE_<ROLLE>` |
| `docs/AI_ARCHITECTURE.md` | MoA-Zustaendigkeiten (Planung/ausfuehrung) und ihre eine Kante |
| `docs/UI_SPEC.md` | UI-Modi und Bedienregeln der Oberflaeche |
| `docs/HETZNER_DEPLOY.md` | Deploy-Wege, Migrationsliste alt -> neu |
| `docs/OPS_RUNBOOK.md` | Betrieb: Start/Stop, Live-Beweise, Pruefschritte vor E2E-Laeufen |
| `services/backend-core/SESSION_DB_SCHEMA.md` | Wer Session-, Plugin- und Lock-Zustand fuehrt (der Server) |

## 2. Zurueckgeholt aus `6dc1c35e^` (Stand vor der Bereinigung)

`6dc1c35e` hat 103 Dateien geloescht, darunter Dokumente, die Code, Tests und
Tickets nennen. 53 davon sind zurueckgeholt (50 Dokumente + die drei Dateien in
`services/backend-core/`). **Ihr Inhalt ist der Stand VOR der Bereinigung** -
wer sie fortschreibt, prueft zuerst den heutigen Code; wer sie zitiert, nennt
das Datum.

Zurueckgeholt:

`docs/AI_ARCHITECTURE.md`, `docs/AI_COST_GUIDE.md`, `docs/AI_DEPLOYMENT_GUIDE.md`,
`docs/AI_FLEET_6X48_PLAN.md`, `docs/AI_OPERATIONS.md`, `docs/AI_PROMPTS.md`,
`docs/AI_SECURITY_GUIDE.md`, `docs/ARCH_P2_002_DEPENDENCY_GRAPH.md`,
`docs/AUDIT-FIXPAKET-D.md`, `docs/AUDIT-FIXPAKET-E.md`,
`docs/AUDIT_REPORT_2026-09-23.md`, `docs/DEEP-TEST-PLAN.md`,
`docs/DEPLOY_SNAPSHOT_2026-10-07.md`, `docs/DSP_OPTIONAL_BLOCKS_2026.md`,
`docs/DSP_PARITY_TOLERANCES.md`, `docs/ENV_MATRIX.md`,
`docs/FIXPLAN_2026-09-20_externer_apptest.md`, `docs/HARDWARE_TEST_MATRIX_2026.md`,
`docs/HETZNER_DEPLOY.md`, `docs/INFRA_KONSTITUTION.md`,
`docs/LICENSE_EXTERNAL_RESOURCES.md`, `docs/MEDIA_INGEST.md`,
`docs/ONNX_MODELS.md`, `docs/OPS_RUNBOOK.md`, `docs/ORIGIN_TLS_DNS_RUNBOOK.md`,
`docs/PERFORMANCE_BUDGETS_2026.md`, `docs/PLUGIN_PROMPT_MATRIX.md`,
`docs/PROPOSAL_legacy-shim-removal.md`, `docs/QUALITY_TOOLING_2026.md`,
`docs/RECHT_ENTWURF_DATENSCHUTZ_IMPRESSUM.md`, `docs/RUNPOD_AI_V1_SPEC.md`,
`docs/RUNPOD_COLDSTART.md`, `docs/RUNPOD_PODS_RUNBOOK.md`,
`docs/SECURITY_COOKIES.md`, `docs/SEC_BLOCK2_ATTACKS.md`,
`docs/SEC_CF_TOKEN_ROTATION.md`, `docs/SERVER_FLEET.md`, `docs/UI_SPEC.md`,
`docs/VISUALMAKER_PLAYER_SPEC.md`, `docs/VISUALMONK_SPEC.md`,
`docs/VISUALVORLAGEN.md`, `docs/VISUAL_LORA_STACK.md`,
`docs/VISUAL_LORA_TRAINING.md`, `docs/audit-infra-ARCHITEKTUR.md`,
`docs/audit-infra-hetzner.md`, `docs/audit-infra-runpod.md`,
`docs/audit/AUDIT_2026-10-07_AI_LOKAL.md`,
`docs/audit/AUDIT_2026-10-07_ECHTZEIT.md`, `docs/design/V2_UI_VERKABELUNG.md`,
`docs/runpod-8-instances-complete-plan.md`,
`services/backend-core/ASSET_DB_SCHEMA.md`,
`services/backend-core/SESSION_DB_SCHEMA.md`,
`services/backend-core/SIGNALING_PROTOCOL.md`

Zwei davon sind NICHT der alte Stand, sondern neu geschrieben, weil der alte
Stand eine zweite, parallele Session-/Lock-Implementierung dokumentierte
(Deep-Audit F84): `services/backend-core/SESSION_DB_SCHEMA.md` und
`services/backend-core/ASSET_DB_SCHEMA.md`.

`docs/DEPLOY_SNAPSHOT_2026-10-07.md` steht seit dem 2026-10-19 NICHT mehr im
Baum: sein Inhalt ist in `docs/HETZNER_DEPLOY.md` §0 (Deploy-SSOT) aufgegangen.
Die Nennung oben bleibt als Provenienz, die Datei selbst ist bewusst entfernt.

### Durchsicht der toten Pfadnennungen (2026-10-24)

`scripts/doc-path-audit.py` prueft alle Backtick-Pfade der 50 zurueckgeholten
Dokumente gegen `git ls-files` + Dateisystem (Verzeichnisse und Basisnamen
zaehlen als vorhanden). Ergebnis: 12 Dokumente nennen zusammen 43 Pfade, die es
heute nicht gibt. Entscheidung je Datei:

| Dokument | Entscheidung |
| --- | --- |
| `docs/AI_ARCHITECTURE.md` | bewusst: Text sagt „Entfernt (Legacy, 2026-09-20)" |
| `docs/HETZNER_DEPLOY.md` | bewusst: datierte Nachtraege („bis 2026-10-19", „ist geloescht") |
| `docs/INFRA_KONSTITUTION.md` | bewusst: die Tabelle listet den FALSCHEN Stand anderer Doku |
| `services/backend-core/SESSION_DB_SCHEMA.md` | bewusst: „existieren nicht mehr" im selben Absatz |
| `docs/AI_SECURITY_GUIDE.md` | korrigiert: Verweis auf geloeschtes Fehlerregister ersetzt |
| `docs/AUDIT_REPORT_2026-09-23.md` | historisch: datierter Audit-Bericht |
| `docs/FIXPLAN_2026-09-20_externer_apptest.md` | historisch: datierter Plan |
| `docs/PROPOSAL_legacy-shim-removal.md` | historisch: Vorschlag |
| `docs/QUALITY_TOOLING_2026.md` | historisch: Stand 2026 |
| `docs/audit-infra-ARCHITEKTUR.md` | historisch: Audit-Notiz |
| `docs/audit/AUDIT_2026-10-07_ECHTZEIT.md` | historisch: datierter Audit |
| `docs/VISUAL_LORA_STACK.md` | kein Repo-Pfad: `src/extra_model_paths.yaml` liegt im ComfyUI-Worker-Image |

Damit ist jede Stelle entweder bewusst historisch oder korrigiert; ein
Wiederholungslauf des Skripts ist der Nachweis.

## 3. Bewusst geloescht geblieben

Die uebrigen 50 Dateien aus `6dc1c35e` bleiben weg. Grund (geprueft am
2026-10-18): **kein Code, kein Skript und kein Test nennt sie noch.** Sie
werden nur noch von (a) historischen Belegkapiteln genannt, die selbst als
Momentaufnahme datiert sind, und (b) von `MASTERTODOENDE.json` in den
`files`/`source`/`reports`-Feldern alter Tickets. Beides ist Vergangenheit -
und Vergangenheit wird nicht umgeschrieben (Audit-Regel). Eine Ausnahme ist
`docs/en/INFERENCE.md`: das ist die API-Doku des UPSTREAM-Repos
`github.com/ace-step/ACE-Step-1.5`, nicht unser Baum.

## 4. Wie das Waechter-getestet wird

- `tests/docReferences.test.ts`: jeder `docs/*.md`-Pfad in getracktem Code
  (plus `README.md`/`AGENTS.md`) muss existieren. Ausnahmen brauchen eine
  Begruendung in der Liste. Damit kann ein Bereinigungs-Commit wie `6dc1c35e`
  nicht mehr still Doku loeschen, auf die Code zeigt.
- `tests/moaBoundary.test.ts`, `tests/namingConventions.test.ts`,
  `tests/aiLegacyEndpointExample.test.ts` und `tests/test_hetzner_scripts.py`
  lesen Dokumente inhaltlich; sie sind die zweite Haelfte des Waechters.
