# AI_FLEET_STARTPLAN: 5 RunPod-Pods und ihre Start-Trigger

Stand: 2026-10-12 · Entscheidung des Betreibers · gilt zusammen mit `docs/AI_FLEET_6X48_PLAN.md` (Herleitung) und `deploy/runpod/pod-fleet.json` (Deploy-Quelle).

| Pod | Rolle | Start-Trigger | Hinweis |
|---|---|---|---|
| RP1 | brain | **immer an bei Start** | Steuerung, Executor, Streaming; Ziel: warm, TTFT < 300 ms |
| RP2 | ears | **immer an bei Start** | Analyse (Sprache, Klang, Messwerte) |
| RP3 | music | wenn AI-Generierung gestartet wird | ACE-Step (sft, turbo, 4B-Planer), Gesang (Bark) |
| RP4 | voice | wenn AI-Generierung gestartet wird | TTS, Stimmdesign, SFX **und LEGO** (`acestep-v15-xl-base`, ca. 9 GB) |
| RP5 | stems | wenn stemMONK gestartet wird | HTDemucs-Trennung |

## LEGO-Zuordnung (Entscheidung 2026-10-12)

`music.lego`, `music.extract`, `music.complete` laufen nur mit `acestep-v15-xl-base`. Dieses Modell liegt auf **RP4 (voice)**:

- RP4 startet mit der AI-Generierung, LEGO ist eine Generierung, der Pod laeuft dann ohnehin. RP5 startet erst mit dem stemMONK.
- VRAM: voice 24 GB + xl-base 9 GB = 33 von 42 nutzbaren GB, ca. 9 GB frei.
- RP5 (stems, 8 GB belegt) bleibt fuer die Trennung frei, damit lange Song-Trennungen LEGO und TTS nicht bremsen.
- Fuer `music.repaint` bleibt der 4B-Planer auf RP3.
- Offener Risikopunkt: TTS (live) und LEGO-Laeufe teilen sich RP4. TTS bekommt in der Warteschlange Vorrang (Live-Mandat, AGENTS.md 1.3).

## VRAM-Bilanz (nutzbar 42 GB je 48-GB-Karte)

| Pod | belegt (Ziel) | frei |
|---|---|---|
| RP1 brain | 36 | 6 |
| RP2 ears | 38 | 4 |
| RP3 music | 28 (ausgerollt) / 38 (Zielbild) | 14 / 4 |
| RP4 voice + xl-base | 33 | 9 |
| RP5 stems | 8 | 34 |

Kosten: 5 A40-Pods, nur in Betrieb nach Trigger; Grenze AI_MAX_AI_EUR_PER_HOUR = 4 €/h.

## Offen (Umsetzung, siehe FLEET-P1-001)

- Start-Trigger im Code (`fleetWake.ts`/Orchestrator) pro Pod pruefen und angleichen.
- `acestep-v15-xl-base` in Manifest, Flottenplan und `pod-fleet.json` (Pod voice) eintragen; Audio-Eingang im Worker.
- Drift zwischen `aiInfrastructure.ts` (Zielbild) und `pod-fleet.json` (ausgerollt) bereinigen.
