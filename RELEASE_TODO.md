# audioMONASTRY · Release-TODO für Agenten

**Einstiegspunkt im Repo-Stamm · Stand 21. November 2026 · Plan-Branch `docs/release-todo-2026-11-21`**

**Erster Auftrag: AM-01 und AM-02 am aktualisierten Stand prüfen.** AM-03 und AM-32 gleichzeitig vorbereiten. Jedes Ticket hat genau eine verantwortliche Bearbeitung. Übernimm ein Ticket anhand seiner AM-ID und hinterlasse für die nächste Bearbeitung einen revisionsgebundenen Status. Führe unabhängige Tests auch dann aus, wenn ein vorheriger Check rot ist. Die Pflichtprüfung bleibt dabei rot.

## 0. Referenz und Startbedingungen

- [ ] `AGENTS.md` in der tatsächlichen Arbeitsrevision vollständig lesen. Aktive Betreiberentscheidungen und spätere Korrekturen vor älteren historischen Abschnitten anwenden. Die freigegebene Architektur, Modulzahl, Rollen und Live-Semantik gelten für alle Tickets.
- [ ] Remote-Referenzen und Arbeitskopie prüfen. Bestehende lokale Änderungen und Worktrees erhalten. Planung auf diesem Branch pflegen. Implementierungen in eigenen Ticket-Branches vom aktuellen freigegebenen Integrationsstand bearbeiten. Gehören zwei Änderungen in dieselbe Datei, zuerst den zuständigen Ticket-Branch beenden oder mit seiner Bearbeitung abstimmen.
- [ ] Für jeden Auftrag aktuelle main-SHA, Ticket-Branch, reproduziertes Ausgangsergebnis, Abhängigkeiten und erlaubten Testumfang festhalten. Bestehende PRs, Branches, Issues und Evidence-IDs vor der Änderung abgleichen. Einen belegten Fix im Ticket referenzieren und gezielt regressionsprüfen.
- [ ] Snapshot am 21.11.2026: main `c7b69990670f3276616030b885f05e3c691532d8`. `fix/spatial-postmerge-regression-20261121` bei `9576a50e4bae8a3f288f67a32e3648bbba0b8093` lag zwei Commits voraus. Vergleich meldete Änderungen an `SpatialRack.tsx` und `spatial-complete-diagnostics.yml`. AM-01 vergleicht diese Diffs mit den fünf Fehlern in `V2OutputGraph.ts`. AM-02 prüft die Warnungen separat. AM-03 prüft die Diagnose-Resultate pro Step. `continue-on-error` macht einen Diagnoselauf als Gesamtstatus ungeeignet für die Pflichtabnahme.
- [ ] Bestehende Nightly-Issues #44 (Typecheck) und #42/#43 (Lint) zuerst nachlesen und ihre aktuellen Zustände erfassen. AM-IDs sind Backlog-Referenzen. Für Zuordnungen GitHub-Issue, PR und Commit ausdrücklich benennen. Für vorhandene Tickets die bestehenden Repo-Labels verwenden, Status erst nach Abnahme aktualisieren.
- [ ] Arbeitsstart ist lokal bzw. mit vorhandener CI. Live-Tests, Staging-Mutationen, Provider-Allokationen und Veröffentlichung sind Ausführungsschritte mit eigenem Betriebsumfang. Vor Ausführung die bestehende Betreiberfreigabe für Umgebung, Budget und Ziel prüfen. Dokumentation und CPU-/Offline-Checks können während eines Live-Blockers weiterlaufen. Änderungen mit möglichen Provider-Workflows gemäß ihren tatsächlichen Triggern vor einem Push prüfen.

### Ticketstatus und Reihenfolge

`OFFEN → IN ARBEIT → ZUR ABNAHME → ABGENOMMEN`. Bei fehlender Voraussetzung `BLOCKIERT` mit genauem Grund und nächstem zulässigen Schritt. Bei einer Scope-Entscheidung `VERSCHOBEN` nur mit dokumentierter Entscheidung und geprüftem Effekt auf die veröffentlichte Oberfläche. Rot, Skip, fehlender Check oder ein veralteter Nachweis ergeben keinen Abschluss. Ein gelöster Blocker bringt das Ticket zurück in die Bearbeitung. Ein Fix nach der Abnahme öffnet betroffene Nachweise zur erneuten Prüfung.

1. Alle Abhängigkeiten aus dem Ticket und der folgenden Tabelle erfüllen. Teilaufgaben für Analyse und lokale Fixtures dürfen früher beginnen. Freigaben und Schließen erst nach Erfüllung der Abhängigkeiten.
2. Erst das Ausgangsergebnis am normalen Einstieg reproduzieren oder einen vorhandenen, revisionsgleichen Beleg verifizieren. Dann die kleinste fachlich vollständige Änderung und ggf. gezielte Regression. Danach denselben Einstieg erneut ausführen.
3. Ein Review fordert passende Testartefakte und den Impact auf Audio, Rollen, Persistenz und Betrieb gemäß Ticket. Bei Abnahme die Ticketzeile und die Modulmatrix mit Beleg verknüpfen. Bestehende rote Tests separat mit ursprünglichem Lauf erfassen. Jeder rote Pflichtcheck bleibt Freigabeblocker.
4. Wer ein Ticket übernimmt, nennt nach Abschluss oder Blockade automatisch den ersten ausführbaren Folgeschritt aus der Tabelle und hält alle offenen Abhängigkeiten fest.

### Lokale Baseline und CI-Nachweise

In einer sauberen Arbeitskopie vom festgehaltenen Commit ausführen. Versionen mit der CI vergleichen, insbesondere Node 22. Voraussetzungen wie FFmpeg, Python und NumPy aus den aktuellen Workflows übernehmen.

```bash
git fetch origin --prune
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
node --version
npm --version
npm ci

# Jeden Baseline-Check einzeln ausführen und Exit-Code festhalten.
npm run typecheck
npm run lint
npm run test:ci
npm run build

# Für die vollständige Prüfkette einschließlich Verify-Summary.
npm run verify
```

Gezielte Prüfungen über vorhandene Tests und die im Ticket genannten Einstiegspunkte ausführen. Erst vorhandene Fixture und Helper wählen. Dateinamen und Optionen aus der Zielrevision übernehmen. `npm run verify` bricht beim ersten Fehler ab. Für unabhängige Diagnose die betroffenen Einzelchecks separat ausführen. RLS-Skip im lokalen Verify, KI-Skip im statischen Audit und Unit-Tests ohne funktionalen Browser-/Gerätebeleg separat ausweisen. Verwende bei Audio/Web die bestehende Playwright-Konfiguration und die projektspezifischen Audio-Tests. Ein bestandener Screenshot ersetzt keinen Sample-Nachweis.

### Nachweisschema pro Ticket

Einen Eintrag im bestehenden Nachweispfad verwenden oder im Ticket-/PR-Text folgende Felder füllen. Diagnose- und Rohdaten in vorhandenen CI-/Testartefakten verlinken. Manifest- und Ressourcen-IDs sind zulässig, geheime Werte gehören in die vorgesehene Secret-Verwaltung.

```yaml
ticket: AM-XX
status: ZUR ABNAHME
review_revision: <vollständige SHA>
base_revision: <vollständige SHA>
target: local | CI | staging | production
toolchain: <Node, Browser, FFmpeg, Plattform soweit relevant>
inputs: <Fixture, Seed, Accounts/Rollen ohne Credentials, Geräte, Manifest>
expected: <konkreter Sollwert oder benannte Projektgrenze>
observed: <Istwert und Einheit oder klarer Pass/Fail-Befund>
checks:
  - command_or_workflow: <Befehl oder Workflow und Job>
    result: PASS | FAIL | SKIP | BLOCKED
    exit_code: <falls zutreffend>
    artifact: <permanenter Link oder Evidence-ID>
remaining_blocker: <Ticket, fehlender Zugriff oder fehlender Beleg>
review: <Reviewer und Zeitpunkt oder offen>
```

### Arbeitsfolge mit Übergabepunkten

| Eintritt | Ausführen | Übergabe |
|---|---|---|
| Sofort | AM-01, AM-02, AM-03, AM-12, AM-24, AM-25, AM-32 | Fix- und Entwurfsstände, Repo-/Staging-Basis, explizite Scope-Entscheidung |
| AM-01 grün | AM-05/06/08/13/19, AM-20 zunächst lesende/CPU-Pfade | Typkorrekte Audio- und Session-Verträge, reproduzierbare Fixtures |
| AM-05/06 bzw. AM-13 und jeweilige Ticketvoraussetzungen erfüllt | AM-07/09/10/11/14–18/20/21/22 | Audio-, Zustands- und Bedienungsbelege sowie vollständige CPU-Ersatz-Flotte |
| AM-01–03 abgeschlossen | AM-04, anschließend AM-26/27 nach deren Voraussetzungen | Vollständige Prüfkette, aktuelle Staging-/Image-/Inference-Belege |
| Entsprechende Staging-Voraussetzungen erfüllt | AM-23, AM-28 für angebotene Geräteformate, AM-29, AM-30 | Geräte-, Vier-Nutzer-, Restore- und Cleanup-Belege |
| Alle Pflichtnachweise für den freigegebenen Umfang vorhanden | AM-31, danach AM-33 mit Release-Freigabe | Signierte bzw. nachvollziehbare Go/No-Go-Entscheidung, Tag, Rollback-Referenz, Produktions-Smoke |

AM-14 verwendet den beschlossenen Betriebsmodus. AM-32 bleibt offen, bis dieser und die angebotenen Spatial-/Club-Formate feststehen. AM-05, AM-06 und AM-08 dürfen den Stereo-Kern unabhängig davon bearbeiten.

### Ausführungsvorgaben nach Fachbereich

#### AM-01–04 · Build und Gate-Vertrauen

- **AM-01**. Zuerst Typecheck auf neuer Basis. Jeden TS-Fehler einem Aufrufvertrag zuordnen. Rebuild bei gültig → ungültig → gültig fokussiert prüfen. Messpunkte sind bisherige Layout-ID, aktive Node-Topologie und Rückkehr zu gültigem Output. Output-Lifecycle und PCM-Referenz liegen in AM-05/06.
- **AM-02**. Unabhängigen Voll-Lint durchführen. Pro betroffener Datei Regel und Ursache identifizieren. Erst Code mit passender Semantik korrigieren, dann Regression am betroffenen Einstieg. Vorherige Warnings und finalen Null-Warnungs-Lauf belegen. Keine generelle Deaktivierung von Regeln.
- **AM-03**. Je gelöschtem Workflow eine Zeile mit ursprünglichem Zweck, aktuellem Job, Trigger, Testmaterial, Skip-Bedingung und Pflichtstatus erfassen. Prüfen, ob die beiden Routing-Pfade jeweils einen Spatial-Job triggern. CPU-Smoke an echten Browser-Output hängen. Staging-only-Prüfungen offen lassen, bis der vorgesehene Job läuft.
- **AM-04**. Auf einem gemeinsamen Kandidaten alle Pflichtjobs und Produktionsbuild prüfen. Pro Step den tatsächlichen Ausgang erfassen. Nightly-Hauptjob, unabhängiger Langzeitjob, Bundle/Heap, KI-Eval und Prompt-Iteration einzeln dokumentieren. Named skips mit zugehörigem Staging-Nachweis schließen.

#### AM-05–11 · Testsignale und DSP

- **AM-05/06**. Referenzsession mit Monoquelle, zwei eindeutig unterscheidbaren Stereoquellen, einer selektierten Spatial-Quelle, einem unselektierten Kanal und FX-Return anlegen. Erst Spatial aus, danach bei identischem Projekt an. Je Senke Kanalanzahl, Impulsindex, RMS/Peak, Stille, Duplikate und Klicks erfassen. Für Rebuilds Listener-, Worklet-, Node- und Tap-Bestand vor/nach der Schleife prüfen. Bei fehlgeschlagenem Gerätewechsel Sollroute und Fallback erneut messen.
- **AM-07**. Jede Kombination aus freigegebenem Layout, Rate und Zielgerät in der Matrix ausweisen. SceneV2 laden, Position speichern, reloaden und dasselbe PCM-Mapping erneut messen. Post-Map-Meter bei einem einzelnen bespielten Kanal mit den PCM-Werten vergleichen. Virtuelle Verteilung und Audiointerface-Kanäle einzeln belegen.
- **AM-08**. Vor dem Patch Default-Initialisierung, Ladepfad und Version älterer Presets prüfen. Fälle in der Reihenfolge frische Session, Legacy linear, vorhandenes dB-Preset, Save/Reload messen. Das Testsignal muss die Limitierung tatsächlich auslösen. Soll ist ein Ceiling von −1 dB für den Default und der jeweilige gültige Presetwert für gespeicherte Werte.
- **AM-09/10**. Dieselben Samples für Backend-Main, Monitor, Record und Bounce verwenden. Testfälle mit Bypass, zwei Quellen mit verschiedener Latenz, geändertem DSP-Delay und Fehlerpfad durchlaufen. Versatz in Samples und ms bei dokumentierter Rate messen. Grenzwerte aus den Audits des Zielcommits übernehmen. Bei langem Bounce Peak-RAM und bei Realtime Rate/Blockgröße/Xrun-Zähler angeben.
- **AM-11**. Unter gleicher Eingangsrate und Last vergleichen. CPU, Allokationen, p95 Blockdauer, Aussetzer und Signalparität erfassen, sofern für den Hotspot messbar. Eine Codeänderung braucht einen reproduzierbaren Befund sowie einen Vergleich unter derselben Last.

#### AM-12–19 · Session- und Bedienungsverträge

- **AM-12**. Auditprotokoll für Rotation/Widerruf, Secret-Scan und Branch-Regeln anhand bestehender administrativer Nachweise abgleichen. Lesenden Prüfzugang und erfolgreiche Storage-Funktion dokumentieren. Neue Credential-Werte weder ausgeben noch als Nachweis speichern.
- **AM-13/14**. Rollenmatrix mit Mixer-Halter, weiterem Plugin-Halter und zwei getrennten Teilnehmern abarbeiten. Je Standardaktion erlaubtes Ergebnis, verweigerte Aktion und daraus folgenden Server-/UI-Zustand mit bestehenden Vertragsprüfungen vergleichen. Nach Handover, Leave, Reconnect und Restore Settings-Version, Holder und Output-Inhaber vergleichen. Rollenspezifische Snapshots nach Datenschema prüfen. Single-Coordinator durch konfigurierte Topologie belegen. Bei Multi-Knoten Teilnehmer auf zwei Knoten verteilen und Zustands-/Kapazitätsprüfungen aus dem bestehenden Testvertrag belegen.
- **AM-15/16/17**. Je UI-Kontrolle Auslöser, Store-/Event-Schritt, Reaktion beim zweiten Teilnehmer und hörbares Ergebnis bei Audioregelung nachvollziehen. Für den Drop-Papierkorb Löschung, Reload und doppelte Zustellung mit demselben Preset erfassen. Für Library-Suche und Sessionzustand eindeutige Testobjekte verwenden. Status und bedienbare Aktionen für Main-Out in der UI unterscheidbar halten.
- **AM-18/19**. Event-Matrix mit Event, Sender, Vertrag, Empfänger, erwartetem UI-Zustand, genau einer Zustellung bei einer Aktion und Fehlerfeedback führen. Bei dynamischen Registrierungen den echten Aufrufpfad belegen. Scratchpad bei Tastatur und Touch am normalen Einstieg prüfen. Tote Datei erst nach Abgleich bestehender dynamischer oder Build-Verbraucher entfernen.

#### AM-20–24 · KI und Modulabnahme

- **AM-20/21**. Je UI-Auftrag Tool-ID, Schema, Rollenanforderung, Dispatch-Ziel, Sync-/Async-Ergebnis, Fehler, Abbruch und Folgeaktion erfassen. Eingabepunkt für aiMONK ist der explizit abgesendete Text. Autorisierung und Delegation mit existierenden serverseitigen Vertragsprüfungen belegen. Visuals mit vorhandenem Medium bis zum ausgewählten Output verfolgen. CPU-Test für Preisfehler muss zeigen, dass keine Allokation ausgelöst wird.
- **AM-22**. Erst den CPU-Lauf aus PR #39 reproduzieren. Dann fehlende Warmup-/Retry-/Timeout-/Async-/Auth-Fälle und Phasen C–E in der Reihenfolge des Testauftrags durchführen. Erwartete Fehler und erfolgreiche Dispatches mit Aufgabe, Rolle und Session-ID ausweisen. Jeder erwartete Auftrag hat genau ein Endergebnis. Fehlleitung oder doppelte Wirkung sind rot.
- **AM-23**. Feste Referenzaudiodateien und Prompt-Eingaben für TTS/Song/Sound/Stem verwenden. Für Stem sechs Ausgaben mit Label, Rolle, Format, Dauer, Kanal/Routing und Fallback-Marker inventarisieren. Hörprobe und Ablage in der Library mit dem tatsächlichen Modell erfassen. Qualitätsunterschiede dokumentieren und am vereinbarten Umfang bewerten.
- **AM-24**. Auditindex mit je zwei Auditpfaden pro Modul, stabiler Finding-Referenz, AM-ID und Beleg führen. Historische Findings zuerst auf tatsächlichen Pfad der aktuellen Revision abbilden. Modul erst nach Ausführung der jeweiligen Checklisten-Zeile abhaken.

#### AM-25–33 · Live-Betrieb und Freigabe

- **AM-25/26**. Vorherinventar zeitlich erfassen. Staging mit getrenntem Projekt, Teilnehmern, Storage und Secrets prüfen. FFmpeg-/TURN-/SFU-/Client-Versionen und für die RLS-Abnahme das richtige Staging-Projekt als ID festhalten. Fehlender Zugang wird als Blocker geführt.
- **AM-27**. Erst Manifest und aktuelles Attestat der sieben Digests, Quellfingerprints und 22 Identitäten belegen. Vor Live-Start vollständige, aktuelle Kostendaten derselben Session und die geltenden Freigaben prüfen. Danach pro Rolle Pull, Kaltstart, Readiness, Inferenz und Peak-VRAM erfassen. Reihenfolge und zulässige Schritte aus Fleet-Runbook übernehmen. Den bestehenden Collector mit realen, korrekt zugeordneten Kostendaten verwenden. Fehlende oder fremde Kostendaten lösen entsprechend `AGENTS.md` einen Stopp aus. Für WAN-Abnahme die aktiven Stopps aus `AGENTS.md`/Runbook anwenden. Bei diesem Planstand sind das mehr als 20 % RTP-Concealment je Empfänger/Peer über das rollende 30-Sekunden-Fenster und mehr als 5 Sekunden Output-Unterbrechung beim Ownerwechsel. Beide Metriken am vorgegebenen Messpunkt erfassen. Die Concealment-Quote beschreibt Empfangsdaten. Die DSP-Glitchrate bleibt ohne Blockzähler unbekannt.
- **AM-28**. Für jede angebotene physische Route Interface, Betriebssystem, Gerät, Layout, Rate und nachgewiesene Kanäle erfassen. Einen Einzelimpuls pro zugeordnetem Ziel ausgeben, Metersicht und physische Route vergleichen und Monitor/Cue bei Umschaltungen prüfen. Aussagen zur physischen Latenz aus einer physischen Messung ableiten.
- **AM-29**. Zu Beginn Testressourcen eindeutig in der Session erfassen. Drei Lifecycle-Verläufe belegen. Normaler Idle-Pfad mit 30 Minuten, Snapshot und Rückleseprüfung vor Cleanup. Aktivität während Karenz mit zurückgesetztem oder abgebrochenem Idle-Pfad. Fehlgeschlagener Snapshot mit erhaltenem Testknoten. Watchdog-Neustart und Restore im jeweils passenden Verlauf prüfen. Löschung nur für zugeordnete und dafür freigegebene Testressourcen. Am Ende Inventardifferenz und verbleibende Kosten erfassen.
- **AM-30**. Vier getrennte Browserkontexte mit unabhängigen Accounts im WAN verbinden. Zeitachse für Join, Import, Pattern, Drop, TTS/Stem, Holderwechsel, Widerruf, Reconnect und Wiedergabe führen. Audio-, RTP- und Laufzeitbelege unter derselben Testsession koppeln. Für den 30-Minuten-Beleg nur einen vollständig durchgelaufenen Versuch mit aktiver Wiedergabe verwenden.
- **AM-31**. Prüft alle angebotenen Formate/Funktionen gegen die Checkliste. CI-, Staging-, Ersatz-Flotten- und Runtime-Beleg müssen auf die freigegebene Revision bzw. ihre attestierten Images zeigen. Unbekannte Pflichtwerte, rote Checks, fehlender Rollback oder ungeklärter Scope führen zu No-Go.
- **AM-32**. Für jede offene Entscheidung eine Zeile mit freigegebenem Umfang, Testfolge, betroffener UI/Konfiguration und Beleg der Betreiberentscheidung führen. Offene Hardware-Optionen verhindern die Freigabe genau des betroffenen Umfangs.
- **AM-33**. Vor Ausrollen Kandidaten-SHA, Zielumgebung, Digests, Freigabe und Recovery-Punkt vergleichen. Nach Ausrollen laufende Version aus der Zielumgebung verifizieren und den Produktions-Smoke dokumentieren. Bei fehlgeschlagenem Pflicht-Smoke das geübte Rollback-Verfahren anwenden und Zustand nach Wiederherstellung erneut prüfen.

---

## Ticketkatalog

**Planungsstand 21. November 2026 · Ausgangsrevision `c7b69990670f3276616030b885f05e3c691532d8`**

Grundlage ist der Endspurt-Bericht vom 21. November. Die IDs unten sind Arbeitsreferenzen für die Entwicklung. Bestehende GitHub-Issues #42–#44 werden weitergeführt. Sieben geprüfte Nebenbranches lagen vollständig in main, daher ergibt sich aus ihnen kein Merge-Auftrag. PR #24 liefert historische Hinweise. Die 103 als DONE markierten Einträge aus `MASTERTODOENDE.json` bleiben Historie. Die aktuelle Arbeit ergibt sich aus dem beobachteten Defekt oder dem noch fehlenden Abnahmebeleg.

**P0** blockiert die Freigabe für den jeweils angegebenen Umfang. **P1** gehört zur Release-Abnahme, sofern die Funktion in der veröffentlichten Oberfläche oder Konfiguration angeboten wird. Ein P1-Finding, das Datenverlust, falsche Berechtigungen oder einen defekten Kernpfad belegt, wird zum P0-Fix. **Entscheidung** bedeutet, dass der Umfang dokumentiert werden muss. **Abnahme** bedeutet, dass zuerst auf der Release-Revision geprüft und bei einer Abweichung gezielt nachgebessert wird.

Bei jedem Abnahmeticket den Commit und den Befund oder Lauf verlinken. Bei Hardware, Staging und GPU zusätzlich Umgebung, Zeitpunkt und relevante Konfiguration oder Image-Digests festhalten. Ein nachfolgender Fix entwertet die betroffenen Nachweise und löst deren Wiederholung aus. Beim umfassenden Go/No-Go müssen CI, Ersatz-Flotte und Staging derselben Release-Revision zugeordnet sein.

## Reihenfolge bis zur Freigabe

| Phase | Starten | Abschluss |
|---|---|---|
| CI und Umfang | AM-01, AM-03, AM-12, AM-24, AM-25 und AM-32. AM-02 separat bearbeiten. | AM-04 bestätigt eine vollständig ausführbare Prüfkette. AM-32 hält fest, was veröffentlicht wird. |
| Kernfunktionen | Nach AM-01 die Audioarbeiten AM-05–11 sowie UI- und KI-Arbeiten AM-15–22 aufnehmen. AM-13/14 parallel bearbeiten. | Audio, Datenintegrität, Bedienung und CPU-Ersatz-Flotte liefern belastbare Nachweise. |
| Staging | AM-26/27 nach den jeweiligen Freigabevorstufen, anschließend AM-29 und AM-30. AM-28 nur für bestätigte Spatial-Formate abnehmen. | Vier-Nutzer-Betrieb, echte Audio-/GPU-Wirkung, Restore und Cleanup sind belegt. |
| Release | AM-31 schließt das Nachweispaket. AM-33 führt die Freigabe und Veröffentlichung durch. | Release-Tag, Smoke nach Veröffentlichung und eindeutiger Rollback-Punkt. |

Der kritische Audio-Pfad führt über AM-01 → AM-05 → AM-08/09 → AM-30 → AM-31 → AM-33. Parallel dazu muss die Betriebsstrecke über AM-22 → AM-27 → AM-29 abgeschlossen werden. Hardware-Spatial und Multi-Knoten-Betrieb haben je einen eigenen Freigabenachweis.

## 1. Build und Prüfkette

### AM-01 · Spatial-Typecheck reparieren — P0 · Fix · GitHub #44

- [ ] `V2OutputGraph.setLayout()` an `SpatialRoutingRequestV2`, die zweistellige Partitionprüfung und die vorhandenen Zuständigkeiten für Graph, Gain-Werte und Taps anschließen. `NonDestructiveSpatialTapRegistry` mit dem zuständigen `BaseAudioContext` erzeugen.
- [ ] Layout erst mit gültigem Plan übernehmen. Stereo, 2.1 und ungültigen Layoutwechsel fokussiert prüfen.
- **Abnahme** — Node 22, Typecheck und fokussierte Output-/Spatial-Suiten grün. #44 mit Lauf verknüpfen und in AM-04 gemeinsam mit dem Nightly prüfen.

### AM-02 · Lint auf null Warnungen bringen — P0 · Fix · GitHub #42 und #43

- [ ] 40 gemeldete Warnungen in 7 Produkt- und 8 Testdateien am Ausgangsstand prüfen. Regelverstöße beheben und betroffene Pfade gezielt testen.
- **Abnahme** — `npm run lint` unter Projekt-Node mit null Warnungen. #42 und #43 mit gemeinsamem Lauf belegen.

### AM-03 · Release-Abdeckung nach Workflow-Cleanup vervollständigen — P0 · Fix

- [ ] Die elf in `9a1a881a` entfernten Workflows mit `docs/VERIFY_MATRIX.md` abgleichen. Browser-Audiofluss, Module und Labels mit laufendem Smoke abdecken. Spatial-Trigger für `V2OutputGraph.ts`, `pluginContract.ts` und relevante Routingänderungen prüfen.
- [ ] Memo-, Secret-, Compose-, Bundle-, Heap- und Spatial-Checks einem tatsächlich laufenden Gate oder Freigabeschritt zuordnen. Staging-RLS und KI-Eval mit erreichbarer Runtime als Nachweise aufnehmen. Alte Fleet-Workflows auf ihren aktuellen Testvertrag abbilden.
- **Abnahme** — Ein Prüfpfad pro relevanter Kontrolle mit Trigger, Testmaterial und Laufbeleg. Reale Staging-Prüfungen laufen über AM-26/27.

### AM-04 · Vollständigen Verify- und Nightly-Lauf nachweisen — P0 · Abnahme · nach AM-01–03

- [ ] Typecheck, Lint, Tests, Build und `npm run verify` auf identischer SHA ausführen. Nightly-Hauptjob einschließlich Memory-Pressure, Bundle-Budget, KI-Eval und Prompt-Iteration prüfen. Langzeit-Stressjob mit erfassen.
- **Abnahme** — Vollständiger grüner Lauf mit ausgewiesenem Prüfmaterial. Staging-gebundene Nachweise separat in der Gate-Matrix referenzieren.

## 2. Signalweg, DSP und Echtzeit

### AM-05 · Stereo-Main und getrennte Audiosenken mit PCM beweisen — P0 · Fix und Abnahme · nach AM-01

- [ ] Stereo-Main, persönliches Monitor/Cue, dediziertes Spatial-Main, Stream und Record mit Impulsen und Testton einzeln messen. Ausgabegerätewechsel und Auswahl der Senke in derselben Referenzsession prüfen.
- [ ] Selektierte Dry-Quellen genau einmal am räumlichen Ausgang, FX-Returns und unselektierte Spuren als Bed nachweisen. Mono hörbar prüfen. Stereo-Main und Export mit Spatial aus/an vergleichen.
- **Abnahme** — PCM-Artefakte je Senke belegen korrekte Kanalzuordnung und erwarteten Pegel. Umschalten läuft ohne Doppelroute, Stille oder Klicks. SP-P0-01/02/06 referenziert.

### AM-06 · Spatial-Bus und Worklet-Lifecycle stabilisieren — P0 · Abnahme · nach AM-01

- [ ] Worklet je AudioContext, Retry, Source-Rewire, Layoutwechsel, Gerätefehler, Reconnect und Dry/Wet-Fallback prüfen. Automatische lokale Binaural-Aktivierung aus PR #23 als Regression mitführen.
- **Abnahme** — 100 Rebuilds mit belegtem Cleanup. Fehlerfall und Reconnect führen zurück zu einer funktionierenden Route. SP-P0-03/04/05 referenziert.

### AM-07 · SceneV2, Kanal-Mapping und Spatial-Meter prüfen — P1 · Abnahme · nach AM-05/06 und AM-32

- [ ] Alte Szenen und Presets migrieren. VBAP-Energie, isolierte PCM-Kanäle, Hardwareerkennung, Crossover/Subs, PDC und Post-Map-Meter messen. Mono, Stereo, 2.1, 44,1/48/96 kHz, Positionen sowie selektierte und unselektierte Quellen abdecken.
- [ ] Für freigegebene Club-Layouts Visualizer, Meter und ausgewählte Ausgabeschnittstellen bis zum entsprechenden Gerät prüfen. Virtuelle Kanalzahl und reale Device-Channels einzeln erfassen.
- **Abnahme** — Deterministische Referenzartefakte für SP-P1-01–08. Gerätefreigabe folgt über AM-28.

### AM-08 · Limiter-Ceiling und Preset-Migration korrigieren — P0 · bestätigter Fix · nach AM-01

- [ ] Initialisierung in `DspRack.tsx` auf den Reglervertrag von −1 dB bringen. Historischen linearen Wert 0,98 und gespeicherte Alt-Presets anhand ihres Versions-/Einheitenvertrags migrieren. Bestehende dB-Werte erhalten.
- **Abnahme** — Neuer Default, Legacy-Preset und gespeicherter dB-Wert ergeben jeweils den erwarteten gemessenen Ceiling am aktiven Signalweg.

### AM-09 · Headroom, PDC und Mastering durchgängig messen — P0 · Abnahme · nach AM-05 und AM-08

- [ ] Backend-Main, Monitor, Record und Bounce mit Impuls, Transiente, Sinus und Mix vergleichen. Zeitversatz pro Quelle, True-Peak, Lookahead, EQ-/DSP-Wirkung, Bypass und Dynamik bei veränderter DSP-Latenz erfassen.
- [ ] Hartes PCM-Clamping und Sample-Lücken getrennt messen. Headroom vor dem Master, LUFS/True-Peak, Ausrichtung am Summenpunkt und Abweichung zwischen Live und Bounce gegen die vorhandenen Grenzwerte prüfen.
- **Abnahme** — Signalwegbezogene Messwerte für Clipping, Dropouts, Xruns und PDC. Abweichende Parameterquellen und relevante Überschreitungen behoben.

### AM-10 · Echtzeit- und Bounce-Randfälle absichern — P0 · Abnahme · nach AM-05

- [ ] DB-011/017/018 mit Adapterfehler, Puffer-/Quantum-Last und langem Bounce prüfen. Bypass, begrenzte Arbeit pro Audio-Quantum und Peak-RAM messen.
- **Abnahme** — Bypass bleibt hörbar und stabil. Projektgrenzen für Echtzeit und Speicher werden unter dokumentierter Last eingehalten.

### AM-11 · Hotspots im Backend nach Messung bearbeiten — P1 · Abnahme mit bedingten Fixes · nach AM-05

- [ ] FFmpeg je 100-ms-Block und Main-Takt, blockweise Autorisierung, Publisher-Kopien, Mixer-Puffer und Sortierung, Resampler-Allokationen und JSON-Signaturen profilieren. Nur betroffene Pfade mit reproduzierbarer Überschreitung oder hörbarem Fehler ändern.
- **Abnahme** — Profil, Entscheidung je Kandidat und Vorher/Nachher-Beleg für jede Änderung. Laufende Widerrufe bleiben wirksam.

## 3. Session, Rollen und geteilte Daten

### AM-12 · Zugangsdaten und Branch-Schutz belegen — P0 · Abnahme

- [ ] Widerruf beziehungsweise Rotation betroffener Alt-Zugangsdaten mit den vorgesehenen Verfahren nachweisen. Aktive Abhängigkeiten des Storage-Pfads und Secret-Scan prüfen. Freigaberegeln für den Release-Branch bestätigen.
- **Abnahme** — Datierter Nachweis für DB-001/002 und funktionaler Storage-Check. Belege enthalten keine Secret-Werte.

### AM-13 · Identität, Schreibrechte und Lifecycle auf Session-Ebene prüfen — P0 · Abnahme · nach AM-01

- [ ] Auth-Pfade einschließlich zulässiger Legacy-Grenzen erfassen. Vier getrennte Identitäten auf erlaubte Schreibvorgänge, Lock-/Holder-Wechsel, Listener-Schutz, Leave, Rejoin, Ablauf, Widerruf und Weitergabe laufender Settings prüfen.
- [ ] Serverseitige KI-Grants, Account-Limits, Metadaten-Allowlist und minimale Output-Snapshots für `/master-out` und `/visual-out` prüfen. Einen gültigen Inhaber je Main-Ausgang nachweisen.
- **Abnahme** — Rollenmatrix mit freigegebenen und abgelehnten Vertragsfällen sowie Wiederherstellung nach Reconnect. DB-003/004/006/007/008/010/012/014/015/016 abgedeckt.

### AM-14 · Zustandsautorität und Kapazitätsgrenzen absichern — P0 · Entscheidung und Abnahme · nach AM-13 und AM-32

- [ ] Für Multi-Knoten verbindliche Revisionen, atomare Schreibautorität und globale Join-/Output-Kapazität sicherstellen. Zwei-Knoten-, Konkurrenz- und Restore-Tests durchführen.
- [ ] Bei Single-Coordinator-Freigabe die Betriebsgrenze in Konfiguration und Runbook durchsetzen und vier gleichzeitige Nutzer mit Locking und Restore auf dieser Topologie prüfen.
- **Abnahme** — DB-009/013/019 mit der freigegebenen Topologie belegt. Konkurrierende Updates, Kapazitätsgrenzen und Wiederanlauf führen zu konsistentem Zustand.

## 4. Bedienung und Plugin-Integration

### AM-15 · mixerMONK-Regler mit hörbarer Wirkung verdrahten — P1 · Fix und Abnahme · nach AM-05/13

- [ ] Filter und Sends, Filter-/FX-/Build-Makros, FX LOCK, Deck-Pads und Main-Out prüfen. Main-Out als eindeutigen Status oder als funktionierende Aktion ausführen. Für Deck-Regler Verbraucher belegen oder den Regler entfernen.
- [ ] MIDI-Learn und Mapping mit einem Controller bis zur Engine ausführen. Zustand bei Holder-/View-Wechsel prüfen.
- **Abnahme** — Jeder sichtbare Regler zeigt seinen Zustand und bewirkt die erwartete Graph-/Meter-Änderung. Geteilte Aktionen berücksichtigen den aktuellen Holder.

### AM-16 · dropMONK-Presets und Session-Pattern reparieren — P1 · Fix · nach AM-13

- [ ] Papierkorb mit Preset-Store verbinden. Schreibpfade prüfen und doppelte Writes beseitigen. Kanalvalidierung, Pattern, Loop, Quantisierung und Fehlerfälle einschließlich Holder-Wechsel und Reload abdecken.
- **Abnahme** — Einmaliges Löschen mit dauerhaftem Ergebnis. Pattern-Wiederherstellung und samplegenaue Quantisierung über Sessionwechsel anhand einer Referenzsession belegt.

### AM-17 · biblioMONK-Ladevorgang und Zustand prüfen — P1 · Abnahme · nach AM-13

- [ ] Cloud-/Store-Vertrag, Suche, Laden über den Event-Pfad und begrenzten Analyse-Cache prüfen. Festlegen, welche Ordner-, Such- und Seitenzustände lokal oder geteilt sind.
- **Abnahme** — Zwei Teilnehmer sehen die jeweils vereinbarte Ansicht. Die gewählte Datei landet beim richtigen Verbraucher. Reload und Holder-Wechsel erhalten den vorgesehenen Zustand.

### AM-18 · ControlBus und Socket-Rückmeldungen vervollständigen — P1 · Fix und Abnahme · nach AM-13

- [ ] Für `sound-generate`, `library-load`, `drop-auto`, `stem-status`, `song-result`, `ai-plan`, `midi-learn`, `midi-mapping` und `plugin-route` Sender, Empfänger, Zustandsänderung und UI-Wirkung abgleichen.
- [ ] `rbac-denied`, `session-join-denied`, `store-rejected`, `main-out-update-rejected`, `monitor-signal-denied` und `session-reset` mit Rückmeldung oder Resync prüfen. Audit-Treffer gegen dynamische Registrierungen und externe Verbraucher abgleichen.
- **Abnahme** — Jede aktive Aktion erreicht ihren vorgesehenen Empfänger. Ablehnungen und Reset führen zu verständlicher Rückmeldung und konsistentem Zustand.

### AM-19 · Scratchpad und Release-relevante Loader bereinigen — P1 · Fix und Abnahme · nach AM-01

- [ ] Scratchpad-Clipboard mit Touch und Tastatur nutzbar machen. Live-Proof-Imports und `check:library-links` ohne lokale `.env` prüfen. Knip-Treffer einschließlich Visual-Szene, I420 und indirekter Loader einzeln verifizieren.
- **Abnahme** — Clipboard auf Touch und Tastatur nutzbar. Prüfpfade laufen in dokumentierter Umgebung. Jede Entfernung eines Kandidaten ist durch den Verbraucherabgleich gedeckt.

## 5. KI, Visual und Flottenbetrieb

### AM-20 · KI-Tool-Registry und Runtime-Verträge angleichen — P0 · Fix und Abnahme · nach AM-01, für schreibende Tools nach AM-13

- [ ] `mcpRuntime`, Endpoint-Registry, Handler und UI-Tools abgleichen. `nlu`, `multimodal`, `image.embed`, `warmup`, TTS und Spezialzuordnungen wie ACE-Step bis zum Dispatch nachvollziehen. Alte Image-/Video-Generationseinträge gegen den veröffentlichten Funktionsumfang bereinigen.
- **Abnahme** — Jede aktive UI-/KI-Aufgabe erreicht ihren vorgesehenen Handler. Sync-/Async-Ergebnis und definierte Fehler sind geprüft. TTS gehört zum Umfang. STT und Mikrofon-Sprachinput sind auf später verschoben. Der Umfang betrifft Spracheingaben und sagt nichts über gewöhnliche Audioaufnahme aus.

### AM-21 · Wake, Autostop, Preise und Visual-Ausgabe verdrahten — P0 · Fix und Abnahme · nach AM-13/20

- [ ] Serverberechtigung und UI-Rückmeldung für Start, Wiederanlauf und Autostop prüfen. Fehlende Rollenpreise zeigen Rolle und Konfigurationsfehler. Preload-Liste mit Manifest synchronisieren.
- [ ] Vorhandene Medien über `/visual/*` bis zum ausgewählten Visual-Output rendern. Ausgabevertrag mit AM-13 abstimmen.
- **Abnahme** — Fehlender Preis verhindert Provisionierung. Status und Render-Wirkung sind an App und ausgewähltem Output belegt.

### AM-22 · Ersatz-Flotte vollständig auf Release-Revision abnehmen — P0 · Abnahme · nach AM-18/20/21

- [ ] 24 Modellaufträge und B1–B3 aus PR #39 wiederholen. B4–B7 für Warmup, Retry, Timeout, Async-Jobs und Auth ergänzen. Phasen C/D/E und Schnittstellen I1–I11 gegen den Testauftrag abgleichen.
- **Abnahme** — Routing, Fehler, Abbruch, autorisierte Nebenwirkung und vollständiger HTTP-Pfad erhalten reproduzierbare CPU-Belege.

### AM-23 · Aktive Modellqualität und Plugin-Ergebnis abnehmen — P1 · Abnahme · nach AM-22/27

- [ ] Song-, Sound-, Voice- und Stem-Ergebnisse bis zu Mixer bzw. Library prüfen. TTS-Abbruch, Fallback-Hinweis, große Uploads, Timeouts und Modellfehler erfassen.
- [ ] Sechs Stems am aktiven Produktionsmodell mit Referenzmaterial bewerten. Ausgaben, Kanalzuordnung und DSP-Fallback nachvollziehbar kennzeichnen. Historische 5-Stem-Doku zuordnen. Modellverdachtsfälle aus Audits nur auflösen, wenn sie das aktive Manifest betreffen.
- **Abnahme** — Vergleichsmaterial, Rolle/Modell, Revision, erwartete Ausgabe und Fallback-Wirkung sind dokumentiert.

## 6. Auditverwaltung und Staging

### AM-24 · Mixer-Idea-Destroyer nachliefern und Findings indexieren — P1 · Dokumentation

- [ ] Fehlenden mixerMONK-Idea-Destroyer auffinden und zuordnen oder frisch erstellen. Pro kanonischem Modul Standard-Audit und Idea-Destroyer erfassen, insgesamt 32 Berichte.
- [ ] Maschinenlesbaren Index mit Original-ID oder Pfad, Plugin, betroffenem Signalweg, Status, geprüfter Revision, Ticket und Beleg erstellen. Dubletten zusammenführen, Alt-Nachweise referenzieren und belegte Fixes mit Regression oder Pass-Commit abschließen. `MASTERTODOENDE.json`, `EVIDENCE_REGISTRY.json` und Phasenberichte verlinken.
- **Abnahme** — 16 von 16 Modulen mit beiden Auditarten indexiert. Jedes relevante Finding hat ein Ticket, einen belastbaren Abschluss oder einen dokumentierten Produktentscheid.

### AM-25 · Staging- und Providerstand erfassen — P0 · Inventar

- [ ] Hetzner, Vast, DNS, TURN/SFU, R2 und Supabase lesend inventarisieren. Aktive Revisionen, Image-Digests, Health, Kostenbasis und vorhandene Testressourcen datieren. Historische Messung vom 18.11. als Referenz mit vier bereiten Rollen und anschließendem Cleanup übernehmen.
- **Abnahme** — Eindeutige Basis für Staging und spätere Gegenprüfung des Ressourcen-Cleanups.

### AM-26 · Supabase/R2 und SFU auf Staging abnehmen — P0 · Abnahme · nach AM-03/12/13/25

- [ ] Reale RLS-Rollen und erlaubte Datenzugriffe prüfen. SFU-Ticket-Laufzeit, Datenrelay, VP8, Browser-Audio/Video/RTP, TURN und Reconnect auf der Staging-Topologie verifizieren.
- **Abnahme** — DB-005/020/021 und RLS mit Laufbeleg. Authentifizierte Geräte- und Browser-Sessions erreichen die erwarteten Audio-, Video- und Datenpfade.

### AM-27 · Acht Vast-Rollen mit echter Inferenz belegen — P0 · Abnahme · nach AM-04/22/25

- [ ] Vertrag mit 8 Rollen, 7 Images und 22 aktiven Modellidentitäten gegen Manifest, Digests, Fingerprints, R2-Hash-/Revisionsintegrität und abhängige Dateien prüfen. TLS, Readiness, Inferenz, Peak-VRAM und Kaltstart/Pull messen. Brain, Voice und Studio nach den Build-Fixes erneut prüfen. Music-Pull und Zweit-Host mit Zeit- und Kostengrenzen erfassen. Gepinnte Modellgewichte als Bezugsquelle dokumentieren.
- [ ] Erreichbare Runtime für KI-Eval registrieren. Vor Provisionierung aktuell gültige Grenzen und Berechtigungen abgleichen. Ausgangswerte aus dem Repo sind 8 €/h für den Fleet-Preflight und 50 € je Live-Testsession.
- **Abnahme** — Alle freizugebenden Rollen liefern echte Inferenz mit zugeordnetem Image, Kosten- und Qualitätsbeleg. Offene Infrastrukturreste sind im Inventar eindeutig zuordenbar.

### AM-28 · Physische Spatial-/Club-Ausgabe freigeben — P0 für angebotene Hardware-Formate · nach AM-07/26/32

- [ ] Gewählte Formate und Schnittstellen mit realer Hardware messen. Kanäle, Sub/Crossover, Cue/Monitor, Pegel, physische Latenz und Klickfreiheit bei Layout-/Gerätewechsel prüfen. Vier-Nutzer-WAN-Verhalten mit AM-30 verknüpfen.
- **Abnahme** — Freigabeliste mit zuverlässig gemessenen Kanalzahlen je Gerät, Layout und Schnittstelle. Für Spatial-Optionen im Release-Scope liegt ein Audio- und Gerätebeleg vor.

### AM-29 · Golden Master, Runtime-Restore und 30-Minuten-Cleanup durchspielen — P0 · Abnahme · nach AM-14/25/26/27

- [ ] Unveränderliche Softwareversion samt Manifest und Images hinterlegen. Session-/Studio-Daten aus Supabase, R2 und Runtime-Checkpoint separat wiederherstellen. Watchdog auf App/Edge samt Neustart prüfen.
- [ ] Start → Nutzung → 30 Minuten ohne berechtigte Aktivität oder laufenden Auftrag → Snapshot → Status `available` und Rücklesbarkeit → zugeordnete Testinstanzen löschen → Restore ausführen. Neuen Login oder Job während der Karenz und einen fehlschlagenden Snapshot testen.
- **Abnahme** — Neuer Login oder laufender Auftrag stoppt den Idle-Cleanup. Snapshot-Fehler erhält den betroffenen Knoten. Wiederanlauf stellt die geprüften Nutzerdaten und Funktionen her. Abschließendes Inventar belegt Cleanup sowie verbleibende Speicher-/Snapshot-Kosten.

### AM-30 · Vier unabhängige Nutzer im WAN auf derselben Revision abnehmen — P0 · Abnahme · nach AM-04/05/06/09/10/13/14/15/16/18/23/26, für angebotene Spatial-Hardware zusätzlich AM-28

- [ ] Testprojekt und getrennte Accounts verwenden. Import → Hit/Pattern → Drop → TTS/Stem → Library/Mixer → Main, persönliche Monitore und Visual-/Record-Ausgabe gemeinsam durchspielen. Lock- und Holder-Handover, Widerruf und Reconnect beobachten.
- [ ] Den lokalen R8-Smoke als Regression behalten und um einen 30-Minuten-WAN-Lauf mit beobachtbarem Audio ergänzen. Stereo, Transienten, Pegel, Klickfreiheit und hörbaren Handover auf realer Wiedergabe bewerten.
- **Abnahme** — Vier parallele Nutzer mit konsistenten Rollen, hörbarem Output und wiederhergestelltem Zustand. Netzstatistik, Audio-Xruns und physische Latenz sind separat gemessen.

## 7. Umfang, Plugin-Freigabe und Veröffentlichung

### AM-31 · Release-Kandidat auf Vollständigkeit prüfen — P0 · Freigabe · nach AM-04/07/11/17/19/24/29/30 und AM-28 für angebotene Hardware

- [ ] Alle 16 Plugin-Zeilen unten mit Revision und Prüfbeleg abschließen. Bedingte Tickets gegen die bestätigte Freigabeliste prüfen. Offene P0 und P1 im veröffentlichten Umfang schließen oder den betroffenen optionalen Umfang vor Veröffentlichung ausdrücklich aus der Freigabe nehmen.
- [ ] SHA und Image-Digests für CI, Ersatz-Flotte und Staging korrelieren. Betriebsgrenzen, Restore, Last und Kostenbelege verlinken. Daten-/Versionskompatibilität und geübten Rollback verifizieren.
- **Abnahme** — Ein datiertes Go/No-Go mit belegter Entscheidung je Audioformat, Betriebsmodus und angebotener Funktion. Ein fehlschlagendes Pflicht-Gate stoppt die Veröffentlichung.

### AM-32 · Release-Umfang und Betriebsmodus festlegen — P0 · Entscheidung · parallel zum CI-Start

- [x] Spatial-Produktentscheidung vom 21.11.2026: Stereo-first als Kernfreigabe und Club-v4 als aktive Club-Spezifikation. Rechteckiger Raum auf Ohrhöhe mit unabhängiger Breite X und Tiefe Y in Metern. Genau 12, 16, 24 oder 32 Satelliten; bis zu zwei getrennte Subs. Geometrie und Zahl auswählbarer Satelliten gelten für neue Club-Setups.
- [ ] AM-07: Für bestehende Quadrat-/18er-Presets einen expliziten Legacy-Pfad testen. Alte Projekte mit ihren ursprünglichen Daten öffnen und ohne Auswahländerung erhalten. Wenn ein Nutzer ein altes Setup als neues Club-v4-Setup speichert, müssen neue Kanalzahl und Mapping sichtbar bestätigt werden.
- [ ] AM-28: Freigegebene Visualizer-/PipeWire-/USB-/LAN-Funktionen und Hardwareformate nach PCM- und Gerätetest benennen. Für 32 Satelliten plus zwei unabhängige Subs 34 getrennte Ausgangskanäle belegen.
- [ ] Single-Coordinator oder Multi-Knoten für den ersten Release auswählen. Mixer-Undo, Linking und Multiroom entscheiden. TTS, sechs Stems und die aktiven Modelle im KI-Umfang benennen. Kandidaten aus PR #33 nur nach eigener Freigabe zu Integrität, Lizenz/Zugriff, GPU-Lauf, Qualität und Kosten aufnehmen.
- **Abnahme** — Schriftliche Liste der angebotenen Formate, Geräte, Features und Topologie. AM-07/14/28 können daraus ihre genaue Testmatrix ableiten.

### AM-33 · Freigegebenen Stand veröffentlichen und verifizieren — P0 · Ausführung nach Go aus AM-31

- [ ] Release-Tag und Versionshinweise mit freigegebenen Funktionen und Betriebsgrenzen erstellen. Geprüfte Images/Digests ausrollen und den Wiederherstellungspunkt festhalten.
- [ ] Nach Veröffentlichung Login, Laden eines Projekts, Stereo-Main, Kollaboration, KI-Start und Status der veröffentlichten Ausgabepfade per Smoke bestätigen. Auffälligkeiten anhand des vorbereiteten Rollback-Verfahrens behandeln.
- **Abnahme** — Erreichbare veröffentlichte Revision, bestätigter Produktions-Smoke sowie verlinkter Tag und Rollback-Beleg.

## Abnahme-Checkliste der 16 Plugins

| Erledigt | Modul | Nachweis auf Release-Revision | Tickets |
|---|---|---|---|
| ☐ | mixerMONK | Audit vollständig. Filter/Sends/Makros/FX LOCK, Deck-Regler, Holder/View, Gain-Staging und versionierter Zustand. | AM-09/13/15/24 |
| ☐ | dropMONK | Preset löschen, Pattern restaurieren, Kanalgrenzen, samplegenaue Quantisierung, Übergang, Fehler und PDC. | AM-09/16 |
| ☐ | songMONK | Erzeugtes Audio im richtigen Kanal, Ergebnis-Event, Lock, Abbruch, Timeout und Library-Metadaten. | AM-13/18/22/23 |
| ☐ | effectMONK | Send/Return und hörbarer Dry/Wet-Bypass, Peak-/Feedback-Schutz plus Meter. | AM-05/09/10 |
| ☐ | syntisamplerMONK | Container-/Kindvertrag, Stimmen beim Tabwechsel, Kanal 4, Zustand und Bundle-/Latenzverhalten. | AM-04/09/10/13 |
| ☐ | drumsamplerMONK | Eine Clock, Swing/Flam, Sample-/Kit-Import, PDC, Pattern und Stimmen-/Pegelgrenzen. | AM-09/10/30 |
| ☐ | instruMONK | Kanal 5, MIDI bis zur Stimme, Lock, Inputwerte und Gerätewechsel. | AM-05/09/13/15 |
| ☐ | biblioMONK | Cloud/Store, Such-/Ladepfad, begrenzter Cache und Sessionzustand. | AM-17/18/26 |
| ☐ | voiceMONK | Kanal 6, Stimmenwahl, TTS, Abbruch, Fallback und Library-Metadaten. | AM-20/22/23 |
| ☐ | soundMONK | Kanal 7, Erzeugungsbefehl, Sample/Pattern-Policy, Timeout, Fehler und Speichergrenzen. | AM-10/18/23 |
| ☐ | stemMONK | Sechs Stems am aktiven Modell, DSP-Fallback, Routing, Timeout und große Uploads. | AM-18/23/27 |
| ☐ | spatialMONK | Mono, SceneV2, Taps, PCM-Layout und nachgewiesene Hardwarekanäle im Stereo-first-Vertrag. | AM-01/05/06/07/28 |
| ☐ | eqMONK | Master-EQ, Band-ID/Q, Live/Bounce, Snapshot und Migration. | AM-09/29 |
| ☐ | dspMONK | Limiter-Einheit, dynamische Latenz, optionaler DSP, Oversampling, Bypass und Bounce. | AM-08/09/10 |
| ☐ | masterMONK | Lookahead, True-Peak, PDC auf Backend-Main, Monitor und Bounce. | AM-09 |
| ☐ | recordMONK | Hörbare Aufnahme und Bounce, MIME/Endung, Speicherung und Cleanup gemäß Export-Vertrag. | AM-05/09/10/29/30 |

## Nach dem ersten Release

SOFA/HRTF-Individualisierung, DBAP/HOA, Kalibrierungswizard, ADM-Export, KI-Trajektorien, portable Assets und Headless-/WASM-Ausbau gehören in die jeweiligen Erweiterungsbacklogs. Frontier-Modelle ohne positiven Freigabeentscheid folgen mit eigenen Benchmarks. Historische RunPod- und dedizierte A100-Endpoint-Aufträge liefern gegebenenfalls weiterhin relevante Testfälle für Vast.

## Quellen

- [GitHub-Ausgangsrevision](https://github.com/kAInplanmusic/audioMONASTRY/tree/c7b69990670f3276616030b885f05e3c691532d8) · [GitHub-Issues](https://github.com/kAInplanmusic/audioMONASTRY/issues)
- [Prüfmatrix](https://github.com/kAInplanmusic/audioMONASTRY/blob/c7b69990/docs/VERIFY_MATRIX.md) · [Verdrahtungsbefunde](https://github.com/kAInplanmusic/audioMONASTRY/blob/c7b69990/VerkabelungsToDo.md) · [DAW-Breaker](https://github.com/kAInplanmusic/audioMONASTRY/blob/c7b69990/docs/DAW_BREAKER_GESAMTBERICHT_2026-10-29.md)
- [Spatial-SSOT](https://github.com/kAInplanmusic/audioMONASTRY/blob/c7b69990/docs/architecture/spatialMONK_ARCHITEKTURPLAN_SSOT_2026-11-09.md) · [Club-Backlog V4](https://github.com/kAInplanmusic/audioMONASTRY/blob/c7b69990/docs/architecture/spatialMONK_MASTER_TODO_V4.md)
- [Fleet-Gates](https://github.com/kAInplanmusic/audioMONASTRY/blob/c7b69990/docs/FLEET_INTERFACES_AND_GATES.md) · [Runbook](https://github.com/kAInplanmusic/audioMONASTRY/blob/c7b69990/docs/FLEET_RUNBOOK.md) · [Ersatz-Flotte PR #39](https://github.com/kAInplanmusic/audioMONASTRY/pull/39) · [R8-Bericht](https://github.com/kAInplanmusic/audioMONASTRY/blob/c7b69990/r8-report.md)
