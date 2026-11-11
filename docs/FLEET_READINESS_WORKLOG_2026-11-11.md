# Acht Rollen betriebsbereit machen – laufende Implementierung

Dieser Nachtrag erweitert den abgeschlossenen Sechs-Befunde-Auftrag. Noch keine Freigabe der vollständigen Flotte.

## Zusätzlich behobene Aufruf- und Startfehler

- Qwen3.5 Executor: native multimodale Transformers-Klasse statt falschem CausalLM-Autoload. Echter A40-Test bestanden: `transport.setTempo` mit `bpm=120`, ausschließlich vorgeschlagen und nicht ausgeführt. 26,171 s Handler-Zeit einschließlich Modellladen; Peak 9.264.609.280 Bytes. Run 42967346554, Image `sha256:1b5ec11acd59d8e1c273ebec5e4f15f9cf38b5968372f7cd84f253bf5a720549`.
- ACE-Step Textgenerierung: tatsächlicher AceStepHandler/generate_music-Aufruf statt generischer Diffusers-Pipeline. Separater Planner- und Shared-Asset-Pfad.
- MOSS-Music: dynamisch aufgelöste, gepinnte Klasse; Upstream bietet keinen AutoModel-Eintrag.
- SongFormer: privates Source-Staging für entfernten Transformers-Deepspeed-Import; HF-Cache-Blobs bleiben unverändert.
- Pod-Start: ausdrücklicher Start von pod_start.py/HTTP-App statt Serverless-Worker.
- Readiness: wirkliche Start-Inferenz; leere beziehungsweise nicht endliche Audiodaten blockieren die Bereitschaft. Fehlerhafte Loader geben ihr VRAM-Budget wieder frei.
- Deployment-Budget: Live-Angebot und ganze Kontobelegung einschließlich Serverless statt ausschließlich eigener Pod-Namen.
- SonicMaster: persistenter isolierter Prozess, eigener gepinnter Upstream-Code, zusätzliche T5-/VAE-Revisionen. Geschützter VAE-Abruf mit vorhandenem HF-Zugang erfolgreich geprüft. GPU-Inferenz noch nicht bestanden.

## Builds

Voice/Music, Ears und Executor wurden erfolgreich mit den neuen Abhängigkeiten gebaut. Die letzten Laufzeitkorrekturen werden als kleine Images auf diese unveränderlichen Abhängigkeits-Images gelegt. Song- und Vis-Build ebenfalls erfolgreich; Brain und SonicMaster benötigen korrigierte Builds und echte GPU-Prüfung.

Der erste Brain-Build scheiterte am fehlenden `python`-Alias. Das Runpod-SDK 1.12 kollidiert zusätzlich mit vLLMs FastAPI-Version; der Brain-Stack verwendet deshalb SDK 1.10 und FastAPI 0.136.0. Der erste SonicMaster-Build deckte einen NumPy/PyArrow-Konflikt auf; PyArrow 17 wurde gepinnt. Fehlgeschlagene Builds sind ausdrücklich kein Laufzeitnachweis.

Die übrigen GPU-Prüfungen laufen schrittweise mit begrenzten, anschließend gelöschten Ressourcen. Der frühere Nachweis für sieben Modelle bleibt gültig; ein vollständiger Betrieb aller 22 Einträge auf acht Pods ist weiterhin ausstehend.

## Weiterer tatsächlicher GPU-Befund

Run 42968099721: Qwen3-TTS CustomVoice und VoiceDesign erfolgreich auf A40; MOSS-SFX konnte Modellgewichte laden, scheiterte aber in Triton/Inductor an `/home/audiomonastry` (nicht schreibbar). Eigene Cache-Verzeichnisse und Compiler-Voraussetzungen sind ergänzt, erneuter Lauf ausstehend. Damit sind einschließlich der sieben ursprünglichen Modelle zehn Einträge tatsächlich ausgeführt. Die JSON-Datei `RUNPOD_VOICE_FIRST_GPU_VALIDATION_2026-11-11.json` hält den gemischten Erfolg ausdrücklich mit `passed=false` fest.

Alle Abhängigkeitsprofile sind inzwischen gebaut. Für Studio wird zusätzlich auf CUDA-12.8-Wheels umgestellt und `sm_120` im Build geprüft: Die ausgewählte 96-GB-Blackwell-GPU ist mit dem bisherigen CUDA-12.6-Image nicht abgesichert. Der Brain-Build mit SDK 1.10/FastAPI 0.136.0 besteht.

TypeScript-Typecheck und ESLint bestehen erneut. Ears-CPU-Modelle werden jetzt explizit vorgeladen, damit `residentOnly` sie nicht als ungeladen ablehnt. Fünf neue Readiness-/Rollback-Regressionstests bestehen.

## Zwischenstand beim angeforderten GitHub-Push

16 von 22 ausgewählten Einträgen sind bestätigt: 15 mit echter Inferenz und ACE-Step Shared als gemeinsamem Gewichtsbestand (zusätzlich durch erfolgreiche XL-Base-Generierung verwendet). MOSS-Music, CLAP, Beat This!, DSP und Basic Pitch bestanden im zweiten Ears-Lauf. SongFormer scheiterte noch an einer BF16-zu-NumPy-Konvertierung in seiner Nachverarbeitung; die private Source-Kompatibilitätsanpassung ist erweitert.

Brain hat im ersten GPU-Lauf noch nicht bestanden: vLLMs Engine-Core-Initialisierung schlug fehl. Der Elternprozess liefert nur den allgemeinen Initialisierungsfehler; der nächste QA-Lauf erfasst auch native und Unterprozess-Diagnosen, bereinigt um Zugangsdaten und URLs. Kein erfolgreicher Brain-Betrieb wird behauptet.

Die App verwendet im Pod-Modus jetzt die 22 Manifest-Einträge und alle acht Rollen einschließlich Vis. Modell-IDs bestimmen den tatsächlichen Ziel-Pod; damit landen Executor, Mastering und Upsampling nicht mehr auf dem falschen Container. Neue Task-Typen sind in Routing und Job-Grenzen erfasst. Standardmodelle und deklarierte residente Bestände entsprechen der ausgewählten Flotte. Nicht vorhandene Legacy-Modelle werden im Pod-MCP nicht als verfügbare Generierungswerkzeuge angeboten.

Runpod-Start/Stop verwendet die API-v2-Aktionsroute. Teardown verarbeitet die v2-Pod-Liste einschließlich Pagination und schützt fremde Pods weiterhin. Die gezielten TypeScript-Routing-, Identitäts-, Queue- und Teardown-Prüfungen bestehen; Typecheck und ESLint ebenfalls. Die vollständige Flotte ist noch nicht ausgerollt oder freigegeben.

## Diagnose-Wrapper korrigiert

Die Läufe 42977734636 (Brain) und 42977722022 (SonicMaster/BS-RoFormer) erreichten die Modell-Inferenz nicht: Ein zweiter lokaler `import tempfile` im Render-Zweig überschattete den Modulimport für die gesamte Handler-Funktion. Schon die Diagnose-Erfassung brach mit `UnboundLocalError` ab. Der doppelte Import ist entfernt. Ein hardwareunabhängiger Regressionstest führt den Wrapper wirklich aus, prüft den Aufruf des Produktionshandlers, native Diagnose-Erfassung, Geheimnis-/URL-Redaktion und die Wiederherstellung der Dateideskriptoren und des Inferenzhandlers; bestanden.

Beide Test-Endpunkte sind laut abschließenden Ressourcenartefakten gelöscht. Beim Studio-Lauf schlug zunächst DELETE mit HTTP 400 fehl; der anschließende Cleanup-Safeguard war erfolgreich. Aus diesen Läufen folgt keine neue Aussage über die drei Modelle. Der bestätigte Bestand bleibt 16/22. Das korrigierte Ears-Image ist gebaut (`sha256:59d39cdf86c3c0c18e58169a46f3bdd569c546ea28afa4d5444704ffa2bc0703`); SongFormer benötigt damit noch seinen erneuten GPU-Lauf.

## Fortsetzung: Kostenkontrolle und Brain-Ursache

Die parallelen Wiederholungen 42980575549/42980576469/42980576733 wurden durch die Gesamtkostenkontrolle abgebrochen: Die API meldete zunächst drei, dann sechs aktive Worker; berechnete Bruttorate 10,1547 EUR/h trotz workers.max=1 je Endpunkt. Alle drei Endpunkte sind gelöscht. Weitere GPU-Tests werden einzeln ausgeführt; die Kontrolle wird nicht gelockert.

Der einzelne Brain-Lauf 42980967894 erreichte vLLM und lieferte endlich den nativen Fehler: CUDA OutOfMemory während `profile_cudagraph_memory`/Gated-Delta-Rule, 768 MiB zusätzliche Anforderung bei 668 MiB freiem Speicher. Kein Beleg für fehlende Gewichte. Der Loader begrenzt nun `max_num_seqs=1` und `max_num_batched_tokens=1024`, passend zur Rollen-Konkurenz von eins; der 8192-Token-Kontext und die gepinnten FP8-Gewichte bleiben erhalten. Erneuter GPU-Nachweis ausstehend.

Der Pod-Start rollt bei einem Fehler nach dem ersten Anlegen nun die in diesem Aufruf neu angelegten Pods zurück. Vorher vorhandene Pods bleiben erhalten. Regression mit Fehler in der abschließenden Kostenprüfung: neuer Pod gelöscht, vorhandener Ears-Pod erhalten. 14 R2-/Hardware-/Startprüfungen bestanden. Typecheck und die sechs gezielten TypeScript-Suiten mit 43 Tests bestanden ebenfalls. Die historische `test_runpod_pods.py`-Suite enthält noch Erwartungen an ausgemusterte Modelle/Hardware und besteht nicht; sie ist kein erfolgreicher Nachweis für diese Flotte.

Aktuelles Music-Image erfolgreich gebaut: `sha256:af5c29843a962150469632bfdc6efc035539d3cd88cf53b7776fa6144adbff4b`. Turbo und der tatsächliche 5Hz-Planer benötigen damit weiterhin ihren GPU-Lauf.

## SongFormer bestätigt – 17/22

Run 43005028903: SongFormer besteht echte A40-Inferenz und Ergebnisvalidierung (eine Struktursektion für das vier Sekunden lange synthetische Signal). Handler einschließlich Laden 10,548 s, Peak 4.118.347.264 Bytes. Test-Endpunkt gelöscht. Der Bestätigungsstand steigt auf 17/22. Brain-Image mit begrenztem Profiling erfolgreich gebaut: `sha256:a6250cbcca6e2b0a8c1d054664d77dc79890ce625ab943b5950625a349e56fbd`; erneuter GPU-Lauf wird separat ausgeführt.

## Brain bestätigt – 18/22

Run 43013867990 besteht mit dem korrigierten vLLM-Profiling echte GPU-Inferenz und Text-Ergebnisvalidierung. Bericht: RUNPOD_BRAIN_GPU_VALIDATION_2026-11-11.json. Bestätigter Stand 18/22. Vor den nächsten Tests: keine Pods, Endpunkte oder aktiven Worker; Kontoguthaben 5,0512 USD.

Die verbleibenden Prüfungen werden im Workflow runpod-remaining-qa als serielle Kohorten ausgeführt (max-parallel=1, kein Abbruch der übrigen Kohorten beim Modellfehler): Studio mit SonicMaster/BS-RoFormer, Music mit XL Turbo/5Hz-Planer, anschließend Vis mit UniverSR/DeReverb und echtem Chromium/NVENC-Probe. Jede Kohorte verwendet unveränderliche Image-Digests, die bestehende Registry, den bisherigen Gesamtkostenwächter, Ergebnisvalidierung und always-Cleanup. Ergebnisse werden je Kohorte als getrennte Artefakte aufgehoben. Das Starten dieser Folge ist noch kein bestandener Nachweis.

## 21/22 – SonicMaster und Music bestätigt

Run 43035829050: SonicMaster, ACE-Step XL Turbo und der tatsächliche 5Hz-Planer bestehen echte GPU-Inferenz und die Ergebnisverträge. Studio ist insgesamt fehlgeschlagen, weil BS-RoFormer SW im Upstream `torch.view_as_complex(mask)` einen BF16-Tensor erzeugt: diese Operation akzeptiert dort BF16 nicht. Die Manifestpräzision ist für dieses Modell auf FP32 korrigiert; Modell, Checkpoint, Config und Revision bleiben unverändert. Der bestehende FP32-SDPA-Pfad aus dem erfolgreichen Mega-Test wird dadurch genutzt. Erneuter GPU-Lauf ausstehend; noch kein 22/22. Getrennte Berichte halten den gemischten Studio-Erfolg ausdrücklich fest.

## 22/22 Einzelbestände bestätigt – Flottenbetrieb noch offen

Run 43038786137 besteht den BS-RoFormer-SW-FP32-GPU-Lauf samt dekodierter Audio-/Rekonstruktionsprüfung: A40, Torch 2.8.0+cu128, 13,108 s Handlerzeit einschließlich Laden, 1.913.979.392 Bytes Peak. Fünf App-Stems mit vier Sekunden Stereo 44,1 kHz. Der Test-Endpunkt ist gelöscht. Damit sind alle 22 ausgewählten Einträge bestätigt: 21 ausführbare Modellpfade plus ACE-Step Shared als gemeinsamer Gewichtsbestand, der zusätzlich in der tatsächlichen Base-Generierung verwendet wurde.

Dies ist ausdrücklich noch keine Freigabe des gemeinsamen Acht-Pod-Betriebs. Der zusätzliche Vis-Renderlauf scheiterte im QA-Wrapper, weil Playwright Sync API innerhalb der Runpod-Asyncio-Schleife aufgerufen wurde. Das ist kein neuer Gewichtsfehler bei UniverSR; dessen frühere GPU-Inferenz bleibt bestätigt. DeReverb bestand auch im Vis-Image. Chromium/NVENC als kombinierter Renderpfad und die vollständigen acht HTTP-Readiness-/App-Aufrufe sind weiterhin offen. Die Vis-Kohorte bleibt als fehlgeschlagen gewertet, obwohl der bisherige Analyzer den komplett fehlgeschlagenen Job ohne output-Feld übersprang und deshalb nur DeReverb im Teilergebnis zeigte.

## Gemeinsamer Start/API-Test angefordert – Live-Verfügbarkeit blockiert

Vis-QA-Wrapper korrigiert: Playwright Sync API läuft in einem eigenen Thread ohne die SDK-Asyncio-Schleife. Der Analyzer wertet jetzt auch fehlgeschlagene Jobs ohne output-Feld als Fehler. Erneuter Vis-Lauf: 43047224737, noch kein Render-Erfolgsnachweis.

Alle acht Rollen haben nun passende unveränderliche Image-Digests als eigene Defaults. Gemeinsamer Plan: 6,958 EUR/h einschließlich Steuer-/Pufferannahme. Der erste reale HTTP-Pod-Start wurde mit --only brain --wait 1200 versucht; Exit 2 vor Erstellung, da kein zugelassenes Angebot mit erforderlichem VRAM und CUDA verfügbar war. Kein Brain-Pod angelegt. Live-POD-Katalog: A40, A6000, RTX 6000 Ada Generation, L40/L40S und RTX 4090 alle NONE. Verfügbar waren im relevanten Preisbereich RTX 5090 32GB und RTX PRO 6000 Blackwell Server Edition 96GB; damit ist die konfigurierte gemeinsame Acht-Rollen-Flotte derzeit nicht startbar. Zwei zuvor verkürzte GPU-Namen sind auf die tatsächlichen Katalog-IDs korrigiert. Keine Budget- oder VRAM-Prüfung wird dafür abgeschaltet.
