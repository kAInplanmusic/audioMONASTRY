# vis-Regie-Agent (2026-11-17)

Ein kleiner Agent steuert den **Look** des Live-Visual-Renderers (`docs/VIS_RENDERER_PLAN.md`): Effektwahl und -anzahl, Preset,
Medien-Stimmung/-Energie, Überblendung, Standzeit. Er arbeitet im Takt von Sekunden, nie pro Frame: die Frame-Ebene bleibt der
deterministische Effekt-Regisseur (`src/core/visual/effects/registry.ts`). Code: `src/core/visual/visAgent.ts`
(Kern, rein, getestet) und `visAgentLlm.ts` (Anbindung an die zwei Modelle).

## Verzweigung: kleines oder großes Modell
| Stufe | Modell | Wann | Zeitlimit |
|---|---|---|---|
| rules | keins | Rückfall bei Ausfall/Zeitüberschreitung/ungültiger Antwort; Grundlinie | sofort |
| small | `qwen3-4b` (audio-brain) | Abschnittswechsel der Musik und alle 12 s Takt; mindestens 4 s Abstand | 1,5 s |
| large | `qwen38-27b-fp8` (brain) | ausdrückliche Anforderung des Mixer-Halters in Worten (mind. 3 s Abstand), Set-Planung alle 5 min, Eskalation nach 2 Fehlern des kleinen Modells | 8 s |

- Ein Aufruf zur Zeit (`busy`), die jüngste Lage gewinnt: kommt eine Antwort nach einem Abschnittswechsel, wird sie verworfen (veraltet).
- Das kleine Modell läuft über `gui.execute` im neuen Format `vis_director` (`handlers_fleet2026.gui_execute`, getestet), das große über den
  allgemeinen Router (`complexity: 'moderate'`). Beides mit Schema für geführte Ausgabe (`DECISION_JSON_SCHEMA`, aus demselben Zod-Schema).

## Sicherheit
Modellantworten sind unvertraut: festes Schema, Werte auf zulässige Bereiche begrenzt (Effekt-IDs aus der Registry, `maxEffects` 1..4,
Überblendung 0..4 s, Standzeit 2..30 s, Preset nur aus dem Katalog, unbekannte Felder verworfen), nichts wird ausgeführt, kein Zugriff auf
Audio, Sitzung oder Sperren. Der Freitext des Halters steht im Prompt als zitierte Daten. Der Pod prüft als letzte Instanz noch einmal
(`validate_effects`, `validate_look`). Modus `off` = Handbetrieb: dann gibt es keine Modellaufrufe.

## Anbindung an den Pod (vorhanden)
| Look-Feld | Pod-Schnittstelle |
|---|---|
| `effects`, `maxEffects` | `POST /visual/effects` |
| `presetId`, `fadeS`, `minDwellS` | `POST /visual/look` (neu) |
| `mood`, `energy` | App-seitig: wählt die Medienliste der nächsten Szenen; **nicht gebaut** (Medien-Warteschlange fehlt) |

## Nicht verdrahtet
Der Agent läuft noch nirgends. Es fehlen: die Schleife im Server (Takt, `step()` alle 1-2 s), die Musikzustände aus ears (`songformer`-Abschnitte,
BPM, Energie), der Schalter für den Mixer-Halter, die Medien-Warteschlange nach Stimmung/Energie und der Eingang für den Halter-Text.
Verdrahtung: `createVisLlm({ runPod: new VastProvider('brain').run, complete: llmRouter.complete })`; die Vast-Provider-Quelle hat zurzeit
Übersetzungsfehler (`ResolvedGpuRole`, `PROVIDER_ID_BY_ROLE`, `warmup`), die schon vor dieser Arbeit bestanden.

## Offene Frage an den Betreiber
AGENTS.md hält aiMONK als Textfeld mit ausdrücklich abgesendeten Anforderungen und schließt periodische Hintergrundläufe aus; KI-Delegationen gibt es
nur für die 16 kanonischen Plugins. Der vis-Agent ist weder aiMONK noch ein Plugin, sondern ein Teil der Visuals-Funktion, die der Mixer-Halter
ein- und ausschaltet. Er läuft deshalb nur auf dessen ausdrücklichen Schalter und ruft nur die bestehenden Modelle. Ob das so gewollt ist (statt einer
Delegation nach Runde 5), bitte bestätigen, bevor er verdrahtet wird.
