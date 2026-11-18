# Golden Master: Startplan der AI-Flotte

Stand 2026-11-18. Betreibervorgabe: App nach `up` in **unter 15 Minuten** bereit; eine einzelne Rolle darf bis zu 15 Minuten länger laufen, bevor sie
abgeschaltet wird; jede Rolle über 15 Minuten erzeugt einen Hinweis zur Workflow-Optimierung (`cold-start-report.json`, siehe `docs/FLEET_EVIDENCE.md`).
Das Label „Golden Master" bekommt ein Stand **erst**, wenn ein vollständiger Lauf `up → messen → down` alle Kriterien in Abschnitt 4 erfüllt.
Kein Wert in diesem Plan ist ohne Quelle: Doku-Belege stehen in `docs/FLEET_EVIDENCE.md`, Messwerte kommen aus `scripts/vast-observe.py` (`timeline.jsonl`, Pod-Logs).

## 1. Ablauf (je Schritt: Vorgabe → Beleg → Abbruchbedingung)

| # | Schritt | Vorgabe | Beleg / Werkzeug | Abbruch |
| --- | --- | --- | --- | --- |
| 0 | Zugangsdaten | klassisches GHCR-PAT (`read:packages`), R2-Schlüssel, Vast-Schlüssel, Pod-Token | `ghcr_token_problem()`; Doku G1 | Token fehlt/falscher Typ → Start gesperrt |
| 1 | Plan | frische Angebote, Rollen→Host, Kosten ≤ 8 €/h | `vast-fleet-plan.py` | Plan älter als der Lauf → neu erzeugen |
| 2 | Preflight | mietet nichts; Kosten, Images (Digests), Gewichts-Links (Test-PUT/GET) | `vast-pods.py preflight` | jedes Rot |
| 3 | Gate: `audio-brain` | erste Instanz muss `/ready` + Modellinventar liefern, bevor weitere gemietet werden (Executor-Frist ≤ Ziel) | `verify_executor_before_other_rentals` | Frist → `down` |
| 4 | Restliche 7 Rollen | gemietet in einem Zug, **parallel** ladend; Host nicht auf Deny-Liste, kein zweiter Vertrag je Rolle | `fresh_offer`, `DENIED_MACHINES` | `no_such_ask` → nur ohne bestehende Miete mit frischem Plan wiederholen |
| 5 | Bereitschaft | Zeit je Rolle bis authentifiziertes `/models` + `/ready` | `wait_ready()` → `readyAtSeconds` | siehe Abschnitt 2 |
| 6 | Messung | echte Inferenz je Rolle (normale Handler-Defaults), vis: 1080p30 | `vis-pod-measure.py`, Handler-Tests | Messung rot ≠ Startfehler; getrennt melden |
| 7 | `down` | alle Instanzen zerstört, `status` zeigt 0 | `vast-pods.py down --yes` | verbleibende Instanz = Alarm, von Hand löschen |

## 2. Zeitregeln (Betreiber 2026-11-18)

- **Ziel 15 min** ab `up`-Start. Alle acht Rollen bereit → Ziel erreicht, kein Hinweis.
- **Genau eine Rolle** am Ziel noch nicht bereit → sie läuft weiter bis **30 min** (Ziel + 15; gedeckelt durch `maxTestMinutes − 2 = 30`).
- **Zwei oder mehr** Rollen am Ziel nicht bereit → Abbruch bei 15 min, `down`.
- Über 30 min → Abbruch, `down`.
- Immer: Bericht mit Zeit je Rolle, Payload, gemeldeter Bandbreite, Idealzeit, Hinweisen. Ein Treffer des Ziels ist **kein** Golden Master, wenn die Messung (Schritt 6) scheitert.

## 3. Was die Zeit bestimmt (bekannt / zu messen)

| Größe | Stand | Quelle |
| --- | --- | --- |
| Payload je Rolle | brain 39,4 GB, ears 26,4 GB, voice 54,7 GB, music 44,4 GB, audio-brain 13,5 GB | `vast_transfer_budget.payloads` |
| Image-Pull (`loading`) | gemessen 473 s auf einem Host, ein großer Layer in 80 s auf einem anderen: **Hostabhängig, Streuung > 5×** | Beobachter, Lauf 2026-11-18 |
| Gemeldete Bandbreite (`inet_down`) | vom Host gemeldet, **nicht prognosefähig** | Doku V15/Messung |
| Gewichts-Download aus R2 | **noch nicht gemessen** (Range-GET, 8 Streams) | offen, Lauf 2026-11-18 liefert erste Werte |
| Modell-Laden in GPU | **noch nicht gemessen** | offen |

Folge: Für brain/ears/voice/music (26–55 GB) ist 15 min **nicht aus Rechnung belegbar**, nur durch Messung. Der laufende Volllauf liefert die erste reale Verteilung.

## 4. Abnahmekriterien „Golden Master" (alle erforderlich, ein Lauf)

1. Preflight grün; kein manuelles Eingreifen im Lauf.
2. Alle 8 Instanzen mit exakt den sieben attestierten Image-Digests und geladenem Modellinventar (22 Einträge, keine FLUX/Wan).
3. Zeit-Kriterium: alle Rollen ≤ 15 min, **oder** genau eine ≤ 30 min **mit** ausgegebenem Hinweis.
4. Echte Inferenz je Rolle erfolgreich (normale Defaults); vis liefert ≥ 29 fps bei 1080p30 über den Pod.
5. Kosten des Laufs ≤ Obergrenze aus Preflight (`coldStartUpperEur` + Testfenster), Kontostand vorher/nachher dokumentiert.
6. `down` bestätigt 0 Instanzen; `cold-start-report.json`, `timeline.jsonl` und Pod-Logs (ohne Zugangsdaten) archiviert.
7. Reproduzierbarkeit: Lauf wiederholt sich mit demselben Commit; Abweichung der Rollen-Zeiten dokumentiert.

## 5. Optimierungsreihenfolge bei verfehltem Ziel (nur nach Messung)

1. Rolle mit größter Abweichung zwischen gemessener und Idealzeit finden (Bericht `hints`).
2. Host-Auswahl nach **gemessener** Pull-Zeit (`deploy/vast/host-health.json`) statt nach gemeldeter Bandbreite; schlechte Hosts auf die Deny-Liste.
3. Große Images in mehrere Schichten teilen (paralleler Pull); nur belegen, wenn der Pull die Zeit dominiert.
4. Gewichte: Download-Parallelität/Ort prüfen, wenn nicht der Pull dominiert.
5. Warm-Halten (stoppen/fortsetzen) für die langsamste Rolle; Kosten des gestoppten Speichers gegen Kaltstart abwägen (Doku V10).
6. Payload verkleinern (Quantisierung, Modelle je Rolle) – braucht Betreiberfreigabe, weil Modellidentität betroffen ist.

## 6. Offene Punkte

- „Hinweis in unserer Basis": derzeit Bericht-Datei + Lauf-Ausgabe; Ziel (Doku-Log `docs/COLD_START_LOG.md` oder App-Oberfläche) vom Betreiber festzulegen.
- Der laufende Volllauf (Start 14:27:52) nutzt den alten Code (harte 15-min-Frist, keine Nachfrist); seine Zeiten sind Messwerte, **kein** Golden-Master-Nachweis.
- Temporärer GHCR-Token nach dem Lauf widerrufen; übrige Schlüssel nach erfolgreichem Preflight rotieren (Betreiber).
