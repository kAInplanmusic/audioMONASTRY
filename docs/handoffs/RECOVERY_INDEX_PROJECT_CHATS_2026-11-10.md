# Recovery-Index: historische audioMONASTRY-Projektchats
**Erstellt:** 2026-11-10
**Ziel:** vorhandenen, in GitHub persistierten Quellcode aus abgebrochenen Chats lokalisieren und vor versehentlichem Verlust schützen. Diese Datei ist selbst committed; sie ersetzt keinen Quellcode und bescheinigt keinen erfolgreichen Build.

## Verifizierter GitHub-Zustand (2026-11-10)
Vergleichsbasis: `main` zum Prüfzeitpunkt. `ahead`-Zahlen über Branches sind **nicht additiv**.

| Herkunft | Ref / Branch | Gegen main | Bewertung |
| --- | --- | --- | --- |
| spatialMONK V2 | `spatial` | 61 ahead / 26 behind | Code + Tests + Architektur vorhanden, divergiert |
| Virtueller binauraler 4-User-Monitor | `feat/spatial-virtual-binaural-sony-xm4` | 203 ahead / 26 behind; PR #23 offen | Code vorhanden, Draft; **nicht** merge-freigegeben |
| RunPod 8-GPU-Inferenz | `codex/runpod-eight-inference-20261110` | 13 ahead / 5 behind | Code vorhanden, divergiert, runtime-verifizieren |
| RunPod-Musik-Rebalance | `feat/runpod-8xa40-music-rebalance-20261109` | 0 ahead / 8 behind | bereits in main enthalten |
| Historische Chat-Handoff-Notizen | `docs/chat-handoff-20261110` | separat committed | Chat-Backlog, kein Runtime-Code |

### Echte Code-Artefakte, die **bereits** in Git liegen
**Spatial** (Quelle: API-Vergleich zu `spatial`): `src/core/spatial/v2/{model,motion,vbap2d,objectRenderer,routingPlan,outputAdapter,physicalRouting}.ts`, `src/components/spatial/{SpatialClubSetup,SpatialXYRoomController}.tsx`, `src/audio/spatial/node.ts`, `src/audio/spatialBus.ts`, `tests/spatialMonoRegression.test.ts`, `tests/spatialBusLifecycle.test.ts`, mehrere weitere Tests und `docs/architecture/spatialMONK_ARCHITEKTURPLAN_SSOT_2026-11-09.md`.
**Binaural-Monitor** (Quelle: API-Vergleich zu Feature-Branch): `src/audio/spatial/{localBinauralMonitor,localHeadphoneDevice,localV2SpatialMonitorController,connectLocalV2SpatialPcm}.ts`, `src/audio/monitorRoutingFacade.ts`, Anpassungen `src/App.tsx`, Workflows `spatial-monk*.yml`, Test-/Übergabedokumente.
**RunPod** (Quelle: API-Vergleich zu Codex-Branch): `services/audiomonastry-ai-runtime/handlers_{acestep_turbo,brain,ears_cpu,executor,moss_music,studio,yue2}.py`, `handlers.py`, `handlers_stems.py`, `registry.py`, `model_manifest.json`, `deploy/runpod/pod-fleet.json`, `scripts/runpod-pods.py`.

### Bereits gemergte DAW-Breaker-Chat-Arbeit
- [PR #19](https://github.com/kAInplanmusic/audioMONASTRY/pull/19): Session-/Socket-Mitgliedschaft und Rechte — **merged**; Merge `35dc25e6a11e2d03f7f9adee1bddfc1c7157f7b3`.
- [PR #20](https://github.com/kAInplanmusic/audioMONASTRY/pull/20): SFU-Auth, Datensignalisierung und VP8 — **merged**; Merge `de81fcf86c6675ecfd2a429c452d9d7105445ad6`.
- [PR #21](https://github.com/kAInplanmusic/audioMONASTRY/pull/21): CI/Python/Sonar/Abbruch-Race — **merged**; Merge `ccad93692a45e53802e162358af86633ee90bcf0`.
- [PR #22](https://github.com/kAInplanmusic/audioMONASTRY/pull/22): DAW-Breaker Gesamtaudit und integrierte Fixes — **merged**; Merge `11dd13263eacdbe2c650fd9705280609a259dff2`.
- [PR #23](https://github.com/kAInplanmusic/audioMONASTRY/pull/23): spatialMONK Binaural-Monitor — **open draft / not merged**, 109 geänderte Dateien. Laut PR bleiben Typecheck, Lint, Vitest, E2E, Gain-/Routingprüfung, 4-User- und Hörtest als Freigabegates.

### Historische Referenzen aus vorherigen Chats
- `origin/v2-complete` / `86ca6014d99f700026dc66f07a7465558208652d` aus 2026-09-09: frühere V2-Engine-Arbeit; **nicht** in dieser Sitzung auf aktuelle Remote-Erreichbarkeit geprüft.
- `3844499d` aus älterer E2E-/Deployment-Diskussion: **nicht** auf Existenz und Branch-Zugehörigkeit geprüft.
- `audioMONASTRY-audio-mcp.tar.gz` aus 2026-09-24: im alten Chat als Sandbox-Artefakt genannt; Byte-Inhalt hier nicht verfügbar. Kein Commit ohne echte Quelldaten.
- Mehrere alte Architektur-, KI- und E2E-Chats enthielten Vorschläge statt nachweisbarer Codeänderungen; siehe `CHAT_CROSS_PROJECT_OPEN_WORK_2026-11-10.md`.

## Integrationsschutz / zwingende Reihenfolge
1. Jede Code-Linie ist über ihren bestehenden Git-Branch bereits persistent; niemals allein wegen einer Chat-Zusammenfassung synthetischen Ersatzcode als Original ausgeben.
2. `feat/spatial-virtual-binaural-sony-xm4` ist räumlich und sachlich auf Spatial-Monitoring beschränkt: **keine** RunPod-/Deploy-/Docker-/Server-/fremde-Plugin-Änderungen in diesen Branch einschleusen.
3. Divergierte Branches nicht blind oder mit `--force` nach `main` pushen; Rebase/Merge nur mit Konfliktanalyse, CI und Audio-QA.
4. Für RunPod gilt die zuletzt geforderte lokal gehostete AI-Inferenz mit Budget-/VRAM-Grenzen; erst Ist-Code prüfen.
5. 4-User-/Auth-Sicherheit nur mit Staging und synthetischen Daten testen, niemals destruktiv auf Produktionsdaten.
6. Fehlende Artefakte dürfen als `NOT_RECOVERED` dokumentiert werden, aber nicht als `DONE`.

## Noch nicht zurückgewonnen
- Uncommittete lokale Worktrees auf fremden PCs und in abgeschlossenen Chat-Sandboxes: weder über GitHub API noch aus Gesprächszusammenfassungen auslesbar.
- Original-Dateien aus alten Sandbox-Downloads ohne weiterhin vorhandene Dateibytes.
- Ein Teil der abgebrochenen Chat-Sitzungen kann nicht vollständig aus ihrer Zusammenfassung rekonstruiert werden.
- Laufzeit-/CI-/Hörtests für die getrennten Branches sind **nicht** durch diesen Dokumentations-Commit nachgewiesen.

## Nächste maschinenprüfbare Schritte
- Branch-zu-Branch-Diffs und Testpakete prüfen; erst danach einzelne, isolierte Integrations-PRs erstellen.
- Offenen Draft #23 unverändert lassen, bis die dort dokumentierten Audio-/Vier-User-Gates bestanden sind.
- Historische `v2-complete`-Commits auf Existenz prüfen und bei tatsächlichen Lücken separat cherry-picken.
- `main`-Regressionsprüfung nach jedem gezielten Merge ausführen.
