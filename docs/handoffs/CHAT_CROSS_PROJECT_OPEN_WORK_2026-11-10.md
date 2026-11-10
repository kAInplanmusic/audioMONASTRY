# audioMONASTRY — Chat-übergreifende Übergabe und offene Implementierungsaufträge
Stand: 2026-11-10 · Quelle: Projektgespräche bis 2026-11-10 · Typ: Planung/Abgleich, **kein Implementierungsnachweis**.

## Zweck und Verifikation
Dieses Dokument konsolidiert Aufgaben und technische Entscheidungen, die in früheren ChatGPT-Gesprächen formuliert wurden, ohne nachweisbar als Code im Repository umgesetzt zu sein. Aussagen über abgeschlossene Tests, Änderungen oder Deployments sind **nicht** allein aufgrund einer Chat-Antwort als verifiziert anzusehen. Jede Aufgabe muss gegen den aktuellen Branch, tatsächliche Quelltexte, CI und Live-Audio verifiziert werden, bevor ihr Status auf DONE gesetzt wird. Kein automatisches Überschreiben bestehender SSOTs; bestehende Repo-Dokumente gelten bei Konflikten vorrangig bis zur begründeten Migration.

## Bereits im Remote vorhandene Dokumentation
Auf Branch `spatial` existiert `docs/architecture/spatialMONK_ARCHITEKTURPLAN_SSOT_2026-11-09.md` (Commit aus Projektgespräch: `33302043e47b`); außerdem sind dort weitere spatialMONK-SSOT-, TODO-, Transport- und Statusdokumente vorhanden. Diese Dateien hier **nicht duplizieren**. Die Existenz eines Dokuments beweist keine fertige Engine-Implementierung.
Am 2026-11-10 wurden RunPod/AI-Commits in GitHub gefunden, darunter `b263b129`, `5d854882`, `e8a6eec5` und `4c4f4906`. Neuere Remote-Arbeit hat Vorrang vor älteren Chat-Vorschlägen; ihre Laufzeitqualität ist noch gesondert zu prüfen.

## P0 — Audio-Engine, Spatial, Betrieb
### AM-CHAT-001 · spatialMONK realer Audiopfad
**Quelle:** spatialMONK-Architektur-Chat 2026-11-09; Plan vorhanden, Implementierung nicht daraus ableitbar.
- Mono-Panning entlang des tatsächlichen Worklet-Signalwegs korrigieren; verhindern, dass Mono-Objekte implizit zu falschen Stereokanälen werden.
- AudioWorklet-Modulregistrierung pro AudioContext cachen (nicht global über verschiedene Contexts).
- Versioniertes Spatial-Scene-Modell für Layout, Positionen, Parameter und Automation; Datenmigration testen.
- Separaten und deterministisch testbaren 2D-VBAP-Rechenkern und kontrollierten Renderer anschließen.
- Testen: Impuls pro Zielkanal, Objektbewegung ohne Klicks, Kanalrouting 12/16/18/24, Stereo-/Binaural-Downmix, Device-Wechsel, Context-Restart, Offline-Bounce.
**Gate:** echte PCM-/AudioWorklet-E2E-Prüfung mit gemessenen Ausgängen, nicht nur UI-Snapshot.

### AM-CHAT-002 · V2-Audio als einzige führende Wiedergabekette
**Quelle:** Gespräche 2026-09-09 und 2026-10-12.
- Bestehende V2StudioGraph/WorkletGraphRuntime/Monitor- und Output-Graphen vor Änderungen inventarisieren.
- Live AudioWorklet, sample-accurate Scheduler, Plugin-Laufzeit, PDC und Offline/Live-Parität prüfen.
- V1/Tone.js nur nach belegter DSP-/Routing-Parität und Regression-Gate entfernen; bestehende Grundarchitektur bewahren.
**Gate:** Realtime-Aufnahme/Wiedergabe, reproduzierbarer Bounce, Plugin-Bypass/Restart, deterministische PDC, Browser-E2E.

### AM-CHAT-003 · Keine Produktionsdaten gefährden
**Quelle:** DAW-Breaker-Testfreigabe 2026-10-29.
- Für 4 simultane User ausschließlich Staging/Test-Accounts, isolierte Daten und synthetische Medien verwenden.
- Kein destruktiver Test gegen Produktion. Prüfbereiche: AuthZ, Session-/Project-Isolation, Rollen, B2B-Locking, Rechtekonflikte, Prompt Injection, AI-Tool-Grenzen, Audio-QoS, Datenintegrität.
- Findings nach Sicherheitslücke, Datenintegrität, Audioqualität, UX, Skalierung und Designfehler trennen; Risiko nach Impact × Wahrscheinlichkeit × Reproduzierbarkeit.
**Gate:** reproduzierbare Befunde mit Revision, reproduzierenden Schritten und nachweisbarer Korrektur.

## P1 — Kollaboration, AI und Deployment
### AM-CHAT-004 · 4-User Collab und Zustandsgrenzen
**Quelle:** Architekturgespräch 2026-08-26.
- Geteilten Projektzustand von persönlichem Monitoring und flüchtigen Anwesenheitsdaten unterscheiden.
- Parameter-Leases/B2B-Locking, revisionsbasierte Konfliktlösung, reconnect, Session-Recovery, Clock-Sync und gleichzeitige Mutationen testen.
- Audio-Routing von gemeinsamen Kollaborations-Events separieren; LAN/Internet-Modi explizit behandeln.
**Gate:** 4 unabhängige Clients; widersprüchliche Automation, simultaneous transport, Join/Leave und Netzwerkausfall ohne korrupten Project State.

### AM-CHAT-005 · Zentrale aiMONK-Tool- und Provider-Grenzen
**Quelle:** Gespräche 2026-09-10 und 2026-10-12.
- AI-Aktionen ausschließlich über typisierte, validierte und berechtigte Tool-Contracts; Proposal/Confirm/Execute und Audit-Log differenzieren.
- `dropMONK`: Audioanalyse, Suche/Matching und Vorschläge dürfen nicht unbemerkt persistente Mutationen auslösen.
- Nutzerentscheidung 2026-09-10: RunPod als vollständig lokale AI-Inferenz; alte HF/Replicate/OpenAI/andere externen Pfade nicht blind als aktive Sollarchitektur übernehmen.
- Vor Provider-Entfernung aktuelle RunPod-Implementierung/Registry und Kosten- sowie VRAM-Limits mit jüngsten Commits abgleichen.
**Gate:** untrusted Audio/Prompts können keine nicht autorisierten DAW- oder Infrastrukturaktionen auslösen.

### AM-CHAT-006 · Deployment- und E2E-Befunde aus älterer Session
**Quelle:** Chat vom 2026-10-18; dort ausdrücklich nur vorgeschlagene Änderungen, nicht nachgeprüft.
- Prüfen, ob Playwright-Flakes in `tests/e2e/**` weiterhin bestehen.
- Prüfen: Deployment-Argument-Parsing; Caddy-Abhängigkeit; defektes `STUDIO_ACCESS_TOKEN`; RunPod-Feld `containerRegistryAuthId`.
- Vorhandenes Master-TODO auf Tickets und aktuelle Statuswerte prüfen, statt fremde/alte Ticket-IDs unbesehen einzutragen.
**Gate:** reproduzierbarer Vorher/Nachher-Test; keine ungeprüften Erfolgsmeldungen.

## P2 — Erweiterungen
### AM-CHAT-007 · Portables Projekt, Headless-Render und DSP
**Quelle:** Architektur-Roadmap 2026-10-12.
- Portable Content-Addressed-Assets und kanonischen Project-State entwerfen/validieren.
- Headless Offline-Render, Plugin-Graph-Validierung, WASM-DSP-Evaluation und Audiometriken als separate, isoliert testbare Schritte priorisieren.
- Keine Architektur-Neufassung ohne zwingenden, gemessenen Grund.

## Nicht als vorhandene Repo-Dateien behaupten
- Audio-MCP-Tarball aus älterem Chat wurde als Download erwähnt; weder sein Inhalt noch ein Git-Commit wurden in dieser Sitzung verifiziert. Nicht aus der Chat-Zusammenfassung als ausführbaren Code rekonstruieren.
- Externe Bild-ZIP (156 Bilder) und Video-Jobs wurden in einem Chat erwähnt; weder Dateien noch Lizenz-, Größen-, Speicher- und Kostenstatus sind hier repo-verifiziert. Nicht ungeprüft in Git committen.
- Alte vorgeschlagene `MASTER_TODO.md`, `AUDIT_REPORT.md` und `V1_REMOVAL_REPORT.md` sind Aufgaben, kein Nachweis für existierende Artefakte.

## Empfohlene Umsetzung
1. Für jedes Ticket Quellpfade und aktuelle CI/Worklet-Tests erfassen.
2. Nur bestätigte offene Befunde in kleine PRs übernehmen; keine ungeprüften Umschreibungen.
3. Bei jeder Codeänderung Tests und hörbaren/messbaren Audio-Nachweis mitliefern.
4. Erst nach Review und CI in `main` mergen; Produktivsystem nicht destruktiv testen.
