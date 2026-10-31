# Code-Audit: schlanker, robuster und echtzeitfähig

**Stand:** 31.10.2026 · **Untersuchte Basis:** `e0397818575f850e904134626b4c9af691089ff6` (`wip/audio-audit-snapshot`).
**Ziel:** belegte Rückstände, Duplikate und Verbesserungsmöglichkeiten priorisieren, ohne funktionierende Schnittstellen oder Live-Audio versehentlich zu entfernen. Dieser Bericht ist keine Freigabe für Merge oder Produktion. Er beschreibt Empfehlungen; Produktionscode wurde für diesen Bericht nicht verändert.

## Vorgehen und Einordnung

- Drei unabhängige, lokale Untersuchungen für Frontend/Plugins, Audio/Worklets sowie Backend/Skripte; zentrale Befunde zusätzlich am Quelltext und anhand von Aufrufern geprüft. Die Prüfung war risikoorientiert, **keine lückenlose manuelle Untersuchung jeder Datei**.
- `jscpd --reporters json --min-tokens 100 src server services scripts` erfasste 891 Quellen und meldete 27 Klonpaare sowie 530 duplizierte Zeilen. Der Bericht enthält auch Lockfiles und Markdown: Die Zahlen sind Scanner-Metriken, nicht 530 sicher entfernbare Codezeilen. Keine Reduktion oder Beschleunigung ist daraus abzuleiten.
- `knip --include files,dependencies --no-config-hints` und ein zweiter Lauf mit `--production` scheiterten unter Node 22.23.4 mit `RangeError: Array buffer allocation failed` im `oxc-parser`. **Kein verwertbares Ergebnis**, also keine Aussage, dass alle toten Dateien gefunden oder ausgeschlossen wurden. Die Ursache des Speicherfehlers wurde nicht abschließend untersucht.
- Konkrete Empfehlungen unterscheiden zwischen **nachgewiesenen lokalen Rückständen**, **aktiver Duplikation** und **nur zu prüfenden Kandidaten**. Exporte, dynamische Worklets, Docker-Einstiege, optionale Backends und historische Skripte nicht allein aufgrund statischer Suchergebnisse löschen.
- P1 = zuerst Korrektheit bzw. Sicherheits- und Ressourcenfolgen absichern; P2 = danach gezielte Wartbarkeit/Echtzeitverbesserung; P3 = kleiner, risikoarmer Aufräumschritt. Prioritäten sind Einschätzungen, keine gemessenen Performancegewinne.

## P1 – Korrektheit vor Aufräumen

### 1. HRTF-WASM: gemeinsamer Zustand vermischt mehrere Quellen

**Beleg:** `src/audio/worklets/spatialProcessor.ts:411–443` verarbeitet aktive Quellen nacheinander mit demselben `hrtf_process`; `src/audio/wasm/hrtf_conv/src/lib.rs:27–44,177–190` verwendet einen globalen Konvolverzustand inklusive Overlap und Cursor. Im High/WASM-Pfad werden Quellen damit nicht unabhängig gefaltet.

**Eigener lokaler Nachweis unter Node 22:** Ein Impuls im letzten Sample der ersten Quelle und eine zusätzlich verarbeitete stille zweite Quelle ergaben im selben Block links am ersten Sample `0.17677669`; mit nur der ersten Quelle `0`. Der Vergleich verwendet das vorhandene `public/hrtf/hrtf_conv.wasm` und den echten `SpatialProcessor` in einem Node-Harness, nicht Browser-/Hardware-Audio.

**Verbesserung:** Konvolverhistorie und Cursor pro Quelle isolieren; Kernel/FFT-Pläne können nur dann geteilt werden, wenn ihr unveränderlicher Charakter nachgewiesen ist. Speicher- und Initialisierungskosten außerhalb des Render-Callbacks planen. Vor der Optimierung der WASM-Views in Befund 7 beheben.

**Akzeptanztests:** Mehrere Quellen mit Impulsen an Blockgrenzen, stille und entfernte Quellen, individuelles Reset/IR-Wechsel, wechselndes Routing, Vergleich zu voneinander unabhängigen Referenzkonvolvern; anschließend Deadline-, Speicher- und Browser-/Gerätemessung. `tests/wasmHrtf.test.ts` deckt den einfachen Integrationspfad ab, nicht diese Mehrquellen-Isolation.

### 2. SFZ: stumme, ausklingende Loop-Stimme bleibt aktiv

**Beleg:** `src/core/instrument/sfzVoiceBankCore.ts:109–150` reduziert die Release-Hüllkurve auf null, setzt dabei aber `active` nicht auf false. `loop_continuous` erreicht das natürliche Sample-Ende nicht; `src/audio/worklets/v2SinkProcessor.ts:543–549` verarbeitet aktive Banken weiter. Die Bridge ist vorhanden (`src/audio/sfzBridge.ts:62–69`); die gegenwärtige Nutzung über die UI wurde nicht abschließend nachgewiesen.

**Eigener Nachweis unter Node 22:** nach Note-off und 12.800 gerenderten Frames war `hasActiveVoices()` noch `true`, obwohl der nächste Block Peak `0` hatte. Kein CPU-Gewinn wurde gemessen.

**Verbesserung:** Stimmen nach dem abgeschlossenen Release deaktivieren und vorhandene Slots wiederverwenden. Nicht vorzeitig abschneiden oder fremde Stimmen beenden.

**Akzeptanztests:** Loop/One-shot, Release-Länge und Klickfreiheit, überlappende Noten, selektives Note-off, Retrigger, Voice-Stealing und Slot-Wiederverwendung. `tests/sfzVoice.test.ts:61–75` prüft bislang das Abklingen, nicht die Freigabe.

### 3. Diagnose-Pod: redundante Payload-Zuweisungen und uneinheitliche Log-Erwartung

**Beleg:** `scripts/runpod-ears-debug.py:85–150` weist `dockerEntrypoint` und Ports mehrfach zu und erzeugt mehrere Presigned-URLs wiederholt. Der eingebettete Diagnosecode benutzt `UPLOAD_URL2`; die Warteschleife `:159–165` erwartet dagegen drei Logs. Das ist ein dokumentierter manueller Diagnosepfad, kein pauschal toter Code. `target.presign` ist ein Funktionsaufruf, nicht automatisch eine nebenwirkungsfreie Zuweisung.

**Verbesserung:** Diagnoseziel festlegen, Payload nur einmal konstruieren und erwartete Uploads an den tatsächlich ausgeführten Ablauf anpassen. Pod-Bereinigung auch bei Fehlern ausdrücklich absichern; der aktuelle DELETE-Aufruf steht nach Polling und Downloads (`:159–177`), nicht in einem `finally`.

**Akzeptanztests:** Mock von RunPod/S3/Uhr; Zahl und Zweck der Presigns, Payload, fehlende Logs, Zeitbudget und DELETE bei Polling-/Downloadfehlern prüfen. Keine Live-Pods für den Regressionstest starten.

## P2 – weniger Duplikation und gezielte Audio-Hotpaths

### 4. Zwei aktive Plugin-Adapter skalieren identisch

**Beleg:** `src/plugins/adapters/DrumSamplerPluginAdapter.ts:28–40` und `SyntiSamplerPluginAdapter.ts:29–41` multiplizieren jeden Kanal in-place mit identisch begrenztem Gain × Velocity. Beide sind in `src/plugins/adapters/index.ts:51–52` registriert; Parameter-Side-Effects und Commands unterscheiden sich.

**Verbesserung:** Optional nur die gemeinsame Blockoperation als synchronen, allokationsfreien Helper extrahieren. Manifeste, Routing und spezifische Commands getrennt halten. Das reduziert Wartungsduplikation, ein Laufzeitgewinn ist nicht belegt.

**Akzeptanztests:** `tests/adapterBlockProcessing.test.ts:406–520`, ergänzt um leere und mehrkanalige Blöcke, In-place-Identität und ungewöhnliche Parameterwerte; danach `audit:rt:gate` unter geeigneten Bedingungen.

### 5. Eigentümerprüfung für Agent-Routen wiederholt

**Beleg:** `server/routes/agentRoutes.ts:108–150` wiederholt Authentifizierung, Run-Abruf und Eigentümervergleich für Get, Cancel und Resume. Die Funktionen sind aktive Endpunkte, keine zu löschenden Routen.

**Verbesserung:** gemeinsamen kleinen Helper für autorisierten Zugriff prüfen; Unterschied zwischen 401 und 404 sowie die bestehenden Fehlercodes und jeweiligen Statuscodes beibehalten. Eine reine Extraktion macht Cancel/Resume nicht atomar und beseitigt keine Race Conditions.

**Akzeptanztests:** anonyme, fremde und eigene Identität, unbekannte ID, Runnerfehler, gleichzeitiges Cancel/Resume und bestehende `tests/agentRoutes.test.ts`.

### 6. Audio-Dekodierung doppelt, aber mit unterschiedlichen Grenzen

**Beleg:** `services/audiomonastry-ai-runtime/handlers.py:72–90` und `handlers_runpod.py:59–74` dekodieren Base64 ähnlich. Die erste Variante begrenzt auf 25 MiB und mindestens 44 Bytes, die zweite auf 100 MiB ohne diese Mindestgrenze. Beide Pfade sind nicht gleichwertig.

**Verbesserung:** wenn wirtschaftlich, nur Dekodierkern mit expliziten Grenzwerten und erhaltenen Fehlermeldungen teilen; die separaten Policy-Grenzen nicht durch einen gemeinsamen Default ersetzen.

**Akzeptanztests:** Bytes, Data-URL, invalider Base64-Input und Grenzwerte beider Varianten; bestehende Handler-/Stem-Tests ausführen. Keine Modell-Caches ohne eigene Lebenszyklusanalyse zusammenlegen.

### 7. Meter-/HRTF-Views pro Audioblock

**Beleg:** `src/audio/worklets/v2SinkProcessor.ts:656–663` erzeugt zwei `subarray`-Views für das Metering. `src/audio/worklets/spatialProcessor.ts:422–434` erstellt im High/WASM-Pfad vier neue Views pro aktiver Quelle und Block. Bei 48 kHz/128 Frames entsprechen diese Codepfade rechnerisch 750 Meter-Views/s bzw. 1.500 WASM-Views/s je aktiver Quelle; Blockgrößen und Laufzeitpfade sind abhängig von der Umgebung. Dies ist **keine gemessene GC- oder CPU-Last**.

**Verbesserung:** Metering bei exakt passender Länge Originalarrays übergeben; abweichende Längen explizit behandeln. WASM-Views nur nach Prüfung von `memory.buffer`/Pointers wiederverwenden und nach Memory-Growth erneuern; der Kommentar `:424–428` dokumentiert die Gefahr abgekoppelter Views. Nicht blind cachen und zuerst Befund 1 beheben.

**Akzeptanztests:** Mono/Stereo, ungleiche Längen, variable Blockgrößen, Meter-Parität, tatsächliches WASM-Memory-Growth und IR-Wechsel; Audio-Ausgangsvergleich und GC-/Deadline-Messungen im Browser.

### 8. Render-Kopien und getrennte Getter auf tatsächliche Verbraucher prüfen

**Beleg:** `src/core/audio/live/V2SinkEngine.ts:838–850` kopiert pro Render-Block zwei Monitor-Kanäle in `_lastLeftChannel`/`_lastRightChannel`; Metering verwendet im Worklet den Output (`v2SinkProcessor.ts:645–663`). Die getrennten Getter und Arrays in `V2LiveSink.ts:171–183` werden laut lokaler Referenzsuche nicht befüllt. Für die Getter wurde kein interner Aufrufer gefunden; externe Verbraucher und API-Vertrag sind damit nicht ausgeschlossen. Bei 48 kHz stereo entspräche das rechnerisch 96.000 kopierten Float-Werten pro Sekunde bei durchgehendem Rendern.

**Verbesserung:** Schnittstellen- und Consumer-Vertrag klären, dann Kopien entfernen oder nur bei tatsächlichem Bedarf aktivieren. Vorher insbesondere Monitor/Main/Cue, Layout 2.1 und Capture-Taps nachverfolgen. Kein gemessener CPU-Effekt behauptet.

**Akzeptanztests:** Getter-Vertrag, aktives Metering, Monitor und Audio-Capture über alle unterstützten Layouts; Laufzeit- und Speicherprofil vor/nach dem Umbau.

### 9. SFZ-Bridge verwaltet parallele Stimme zusätzlich zum Worklet

**Beleg:** `src/audio/sfzBridge.ts:42–55,62–69` lädt eine lokale Bank und leitet Note-on/off sowohl an sie als auch an den Sink weiter; die private lokale Bank wird in dieser Klasse nicht gerendert. Die Worklet-Bank ist separat. Die Quell-Array-Kopien schützen die Besitzverhältnisse beim Transfer und sind nicht pauschal redundant.

**Verbesserung:** erst Zweck der lokalen Bank, Tests mit injizierter Factory und Verhalten bei getrenntem bzw. wiederverbundenem Sink klären; nur anschließend eventuell entbehrliche Stimmenverwaltung entfernen. Kein öffentliches Laden oder Cache-Verhalten blind entfernen.

**Akzeptanztests:** Laden vor und nach Verbindung, Reconnect, Round-Robin, Note-off, Transfer-Besitz und reale Audiowiedergabe; bestehende `tests/sfzBridge.test.ts` erweitern.

### 10. Doppelte UI-Reglerlogik – gezielt und verhaltensgleich

**Beleg:** `src/components/am/amUi.tsx:192–248` und `:628–688` wiederholen Normalisierung, SVG sowie Pointer-/Tastatur-Interaktion in `AmKnob` und `AmParamRow`. `AmKnob` wird z. B. von `src/components/mixer/MixerDesk.tsx:169–175` genutzt; Unterschiede bei Beschriftung, IDs, Styling und Optionen sind Teil des Verhaltens.

**Verbesserung:** Gemeinsames internes Regler-Primitiv bzw. Hook erwägen; öffentliche Komponenten und visuelle Struktur erhalten. Kein pauschales Zusammenwerfen mit horizontalen/vertikalen Fadern, deren Interaktionssemantik abweicht.

**Akzeptanztests:** Tastatur, Pointer-Capture/-Cancel, Feineinstellung, Double-Click, disabled, ARIA-Namen/-Werte, mehrfach gleiche Labels und visuelle Regression.

## P3 – konkrete kleine Rückstände

### 11. Nicht angebundener Speicherentwurf im Preset-Browser

**Beleg:** `src/components/drop/DropPresetBrowser.tsx:13–33` enthält einen lokal nicht aufgerufenen `handleSaveNew`, dafür exklusiven Dialog-/Namenszustand und dort nicht benutzte Context-Bindings. Die Komponente selbst und die Context-API sind aktiv; `Load` und `Select` haben unterschiedliche synchrone/asynchrone Wirkung (`:99–110`). Lösch-, Export- und Import-Buttons `:115–117,140–147` haben in diesem Ausschnitt keine Handler.

**Verbesserung:** Produktentscheidung treffen: Entwurf fertigstellen oder nur lokal ungenutzte Bindings/Zustände entfernen. Sichtbare Funktionen nicht stillschweigend löschen oder als implementiert behaupten. Select-/Load-Verhalten separat klären, inklusive schneller konkurrierender Auswahlen.

**Akzeptanztests:** Laden, Auswahl, Favorit, Fehler/Verzögerung, parallele Auswahl und gegebenenfalls Speichern/Import/Export mit explizitem Nutzerentscheid.

### 12. Unbenutzte lokale Berechnungen im Analyzer

**Beleg:** `src/utils/audioAnalyzer.ts:153–160,217–220`: `binHz`, `center` und der hochgezählte `fn` werden nicht gelesen; der Flux-Durchschnitt nutzt `fluxArr.length`. Diese lokalen Werte sind keine externen APIs.

**Verbesserung:** Nur die ungenutzten Berechnungen, den Zähler und zugehörige Lint-Unterdrückungen entfernen; Sampling, BPM-/Key-Algorithmus und öffentliches Ergebnis unverändert lassen.

**Akzeptanztests:** deterministische Audio-Fixtures für BPM, Key, Flux und Energy, auch leere/kurze Inputs. Kein dedizierter Analyzer-Test wurde bei der Untersuchung identifiziert; dies ist keine Garantie, dass kein indirekter Test existiert.

### 13. Unerreichbarer Mixer-Zweig und ungenutzte lokale Konstante

**Beleg:** `server/realtime.ts:670–687` lehnt beim Unlock `pluginId === 'mixer'` mit anschließendem `return` ab; dieselbe Bedingung in `:687` ist danach unerreichbar. Der Unlock-Handler ist aktiv und darf nicht entfernt werden. `scripts/deep-audit/pattern.ts:3–4` definiert `GLOB_META`, für das die lokale Quelltextsuche keine weitere Referenz fand; es ist nicht exportiert.

**Verbesserung:** nur den unerreichbaren Zweig bzw. die ungenutzte Konstante samt Lint-Ausnahme entfernen. Mixer-Transferregel und Socket-Protokoll erhalten.

**Akzeptanztests:** Mixer-Unlock bleibt abgelehnt; gewöhnlicher Unlock, Revision und Broadcast bleiben erhalten; `tests/deepAuditLib.test.ts` für Glob-Verhalten.

## Weitere Kandidaten – nicht ungeprüft löschen

- `src/components/SpatialScene.tsx:230–236,303–310`: wiederholte Quellenanlage; Claim, IDs, Master-Tap und Cleanup unterscheiden sich. Gemeinsamen Teil nur mit Routing-/Race-Tests extrahieren.
- `server/routes/voiceRoutes.ts:612–643,699–779`: ähnliche Runtime-Blöcke, aber unterschiedliche optionale Backends und Fallback-Reihenfolge. Allenfalls Aufrufkern teilen und beide API-Verträge testen.
- `scripts/runpod-deploy.py:762–790` und `scripts/runpod-warm.py:313–338`: ähnliche HTTP-Transporte. Ein Helper darf Mock-Eintrittspunkte, Fehlerverhalten, Readback und unabhängige CLI-Startwege nicht brechen. Die lokale Python-Testsuite besteht, aber das beweist noch keine Extraktion.
- `scripts/visual-vorrat/build-datasets-v2.py:124–154` / `build-datasets-v3.py:86–116`: ähnliche Bildverarbeitung. Dokumentation bezeichnet v2 als historisch; unterschiedliche Auswahlregeln nicht zusammenlegen und Archivierung erst nach Produktentscheidung.
- `src/audio/worklets/drumSynthProcessor.ts:26–31,55`: kostenverdächtiger Worklet-Pfad, aber aktueller App-Aufrufer nicht abschließend belegt; Registrierung/Manifest und externe Verbraucher vor Änderung prüfen. Kein Totcode-Nachweis.

## Konkrete Reihenfolge

1. Mehrquellen-HRTF und SFZ-Release mit fehlschlagenden Regressionstests absichern, dann beheben und unabhängiges Review durchführen.
2. Diagnose-Skript durch vollständig gemockte Pod-/Storage-Tests absichern und bereinigen; kein produktiver Pod-Test ohne klaren Rahmen.
3. Kleine P3-Rückstände einzeln mit Tests bereinigen; Funktionslücken im Preset-Browser getrennt entscheiden.
4. Wartungs-Duplikate einzeln extrahieren; Sicherheits-, Größen- und Antwortverträge nicht verändern.
5. Erst danach Audio-Allokationen messen und gezielt optimieren; `npm run audit:rt:gate`, mehrkanalige Parität und reale Browser-/Gerätetests als Freigabevoraussetzung.
6. Knip-Ressourcenfehler untersuchen und den vollständigen, unterstützten Qualitätslauf wiederherstellen. Automatische Löschungen bleiben deaktiviert.

## Ausgeführte Prüfungen und Grenzen

Unter **Node 22.23.4**, jeweils ein Vitest-Worker:

- `tests/adapterBlockProcessing.test.ts`: **86/86 bestanden**.
- `tests/agentRoutes.test.ts`: **4/4 bestanden**.
- `tests/sfzVoice.test.ts tests/sfzBridge.test.ts tests/spatialProcessor.test.ts tests/wasmHrtf.test.ts tests/deepAuditLib.test.ts tests/voiceRoleRouting.test.ts tests/da013VoiceModelOverride.test.ts`: **40/40 bestanden**. Diese Tests belegen den Ist-Zustand, nicht die vorgeschlagenen Änderungen oder Mehrquellen-Isolation.
- `python3 -m unittest tests.test_runpod_warm tests.test_runpod_deploy_defaults -q`: **77/77 bestanden** mit Python 3.14; beim Import wurde ein `SyntaxWarning` für `return` im `finally` gemeldet. Die ausgeführten Tests verwenden simulierte Abläufe; keine Aussage über echte Cloud-Pods.
- `tests/sfuAuthorization.test.ts tests/sfuMembershipRevocationRegression.test.ts`: **7 fehlgeschlagen, 2 bestanden**. Lokale Socket-Tests mit gemocktem Mediasoup-Worker; dies bestätigt offene SFU-Autorisierungsprobleme, nicht reales RTP.
- `git diff --check` vor Berichtserstellung: ohne Befund. Vollständiges `npm run verify`, Browser-/Hardware-Audio, Vier-Nutzer-Livebetrieb und reale Infrastruktur wurden nicht ausgeführt. Die bereits bekannten offenen SFU-, Migration-, Checkpoint-/Fleet- und Docker-Befunde stehen ergänzend in `docs/AUDIT_WIP_HANDOFF.md`.
