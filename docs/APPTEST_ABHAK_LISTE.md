# Apptest-Abhakliste (26 PARTIAL-Tickets)

> Stand 2026-10-24. Zweck: **ein** Durchlauf beim bevorstehenden Apptest schliesst
> alle 26 PARTIAL-Tickets mit Beleg. Jede Zeile nennt den Beweis, das Kommando und
> die Schwelle. Wer eine Zeile abhakt, schreibt den Beleg nach
> `test-results/apptest/<datum>/` und ergaenzt im Ticket `note` eine Zeile
> `DONE <datum> (Apptest, Commit <sha>): <Messwert>`.

## Regel 1 gilt auch hier

Die Flotte ist **kostenpflichtig, sobald sie existiert** (Hetzner rechnet ab
Erstellung bis Loeschung, auch ausgeschaltet). Deshalb:

1. Flotte **erst unmittelbar vor** dem Test hochfahren.
2. Nach dem Test `stop` (Snapshots + **loeschen**), nicht `poweroff`.
3. Beweis: `GET /v1/servers` mit `labels.app=audiomonastry` muss **0** Knoten
   listen; RunPod-Pods `down --yes`.

## Ablauf

```bash
# 0) Vor dem Test: lokale Gates, kostet nichts
python3 scripts/apptest-gate.py --group local --run

# 1) Flotte hochfahren (kostenpflichtig)
bash scripts/hetzner/bring-up-fleet.sh --yes

# 2) Apptest: die Gruppen B und C unten der Reihe nach abarbeiten

# 3) RunPod (kostenpflichtig pro Minute)
python3 scripts/runpod-pods.py up --yes --wait 900 --only brain,ears,voice,music

# 4) Abriss + 0-EUR-Beweis
bash scripts/hetzner/lifecycle.sh stop --yes
python3 scripts/runpod-pods.py down --yes
python3 scripts/apptest-gate.py --group cost --run
```

---

## Gruppe A - ohne Flotte (laeuft lokal, jetzt schon)

Diese Zeilen kosten nichts und gehoeren **vor** den Test. Sie belegen den
Code-Anteil; die Live-Zeile derselben Tickets steht in Gruppe B/C.

| Ticket | Beweis | Kommando | Bestanden wenn |
| --- | --- | --- | --- |
| RT-AUDIT-P1-015 | Typen, Lint, Suite, tote Dateien, Boundary, Echtzeit-Bench | `npx tsc --noEmit` · `npx eslint . --max-warnings=0` · `npx vitest run` · `npm run check:deadfiles` · `npm run verify:boundary` · `npm run audit:rt` | alle exit 0, `audit:rt` alle Zeilen gruen |
| AI-P2-006 | Drop-Cache: Schluessel stabil, TTL/Verdraengung, ein Modellaufruf bei zwei identischen Anfragen | `npx vitest run tests/aiGenerateDropCache.test.ts` | 7/7 gruen |
| IDEA-2026-10-07-A-F1 | Capture-Relay: Mehrgeraete-Relay, Halter-Pruefung, Zeitbasis | `npx vitest run tests/captureRelay.test.ts tests/captureRelayTwoClients.test.ts tests/captureRelayHub.test.ts tests/captureControl.test.tsx` | alle gruen |
| COLLAB-P0-005 | Basisrevision: Ablehnung `stale-base-revision`, Revidierung pro Plugin | `npx vitest run tests/collab.test.ts tests/pluginRevisionTracker.test.ts` | alle gruen |
| LEGO-P1-001 | music.lego/.extract/.complete/.repaint, Kontext-Aufloesung, Budget-Guard | `npx vitest run tests/mcpMusicContext.test.ts` · `python3 services/audiomonastry-ai-runtime/tests/test_acestep_context.py` | alle gruen |
| FLEET-P1-002 | Qwen3-ASR-Handler: Streaming, Sprache, Wort-Timestamps abgelehnt | `python3 services/audiomonastry-ai-runtime/tests/test_voice_handlers.py` | 42/42 gruen |
| FLEET-P1-003 | MOSS-Audio-Handler: Thinking-Variante abgelehnt, gated Repo erkannt | dito (`test_voice_handlers.py`) | 42/42 gruen |
| FLEET-P1-004 | pyannote 4.x: torch-Version wird geprueft, kein stiller Fallback | dito (`test_voice_handlers.py`) | 42/42 gruen |
| FLEET-P1-005 | SongFormer/beat_this/CLIP: Handler + Rollenbild | dito (`test_voice_handlers.py`) | 42/42 gruen |
| FLEET-P1-006 | Stems: 6-Stem-Crossover, SCNet-Fallback, Karaoke | `python3 services/audiomonastry-ai-runtime/tests/test_stem_crossover.py` · `test_stem_handler.py` | alle gruen |
| FLEET-P1-007 | TTS-Cloning: Referenz-Audio-Pfad | `python3 services/audiomonastry-ai-runtime/tests/test_qwen3_tts_handler.py` | alle gruen |
| FLEET-P1-008 | MOSS-SFX: Dispatch vor Stable Audio, Warmup vor `/ready` | `python3 .../tests/test_song_dispatch.py` · `test_voice_handlers.py` | 8/8 + 42/42 |
| FLEET-P1-009 | LEGO auf xl-base: Routing, Abbruch-Endpunkt | `python3 .../tests/test_acestep_context.py` · `test_pod_routes.py` | alle gruen |
| FLEET-P1-010 | sing: Lyrics-Feld, ACE-Step statt Bark | `python3 .../tests/test_song_dispatch.py` | 8/8 gruen |
| FLEET-P1-012 | Auto-Stop: 15-min-Fenster, busy-Guard, Sweep | `npx vitest run tests/fleetAutostop.test.ts` | alle gruen |
| FLEET-P1-014 | Direkt-URL-Modus + Zielpfad + R2-Spiegel | `node --check workers/weights-mirror.js` · `python3 services/audiomonastry-ai-runtime/tests/test_pod_mode.py` · `python3 scripts/mirror-beat-this.py --check` (HEAD gegen R2) | JS ok, 28/28, `content-length = 81058141` |
| FLEET-P1-015 | Eine Preis-Tabelle, Guard nie zu niedrig | `npx vitest run tests/aiInfrastructure.test.ts tests/podFleetConfig.test.ts` | alle gruen |
| AI-RUNPOD-SING-002 | bark-small im Gewichte-Soll | `python3 scripts/runpod-pods.py weights` | Zeile `weights/bark-small/...` vorhanden, keine `FEHLT` |
| LIVE-P1-004 | `AI_MODE=off` im regulaeren Aufbaupfad (nicht nur im Testskript) | `grep -n "AI_MODE" scripts/hetzner/bring-up-fleet.sh scripts/hetzner/lib/env_token_override.py` | `AI_MODE` steht in `OVERRIDE_KEYS` und wird von `sync_env` geschrieben |

## Gruppe B - Flotte live (Hetzner)

Kostenpflichtig. Reihenfolge einhalten, damit die Flotte nach dem letzten Punkt
sofort abgerissen werden kann.

| Ticket | Beweis | Kommando / Handgriff | Bestanden wenn |
| --- | --- | --- | --- |
| PLUGIN-V2-D | 4-Server-Strategie laeuft, E2E-Suite gegen die Live-Instanz | `curl -s https://anunnakitools.de/api/health` · `npm run test:e2e:live-smoke` | `{"status":"ok"}`, Smoke 0 failed |
| LIVE-P1-004 | `aiNegative` gegen die laufende Flotte | `npx playwright test tests/e2e/aiNegative.spec.ts` (mit `E2E_BASE_URL=https://anunnakitools.de`, Token aus `.env.deploy`) | 7/7, Antworten `503 AI_DISABLED` |
| COLLAB-P0-005 | Vier Clients, gleiche Basis, ein Commit | 4 Browser, je ein Plugin; gleichzeitig senden | genau ein Commit, die anderen bekommen den kanonischen Stand + Revision |
| VISUAL-P0-010 | Laufzeit-Abnahme der Vis-Instanz | Schalter, Upload/Transcode/Index, On-Beat-Story, 1080p60-Messung | jeder Punkt ein Messwert; `makeClip`-Widerspruch entschieden |
| AI-INFRA-001 | Serverless-Rollen + Visual-Generierung entfernt | `grep -rn "makeClip\|runpodVision\|runpodVideo" src/` · `curl -s .../api/ai/status` | keine Treffer im Automatik-Pfad, Budget `<= 4 EUR/h` |
| IDEA-2026-10-07-A-F1 | Zwei echte Geraete, Latenz-Versatz gemessen | 2 Browser, Capture auf Geraet B, Sequencer auf A | Versatz gemessen (RTT/2 vs. P2P/SFU) und notiert |
| INFRA-RUNPOD-018 | Deploy-Run 36580686816 gegen die Flotte | `gh run view 36580686816 --log` · `python3 scripts/runpod-pods.py status` | Template-Zahl + Endpoint-Env stimmen mit dem Run |

## Gruppe C - RunPod GPU (kostenpflichtig pro Minute)

Vorher: `python3 scripts/runpod-pods.py weights` muss `Alle Gewichte vorhanden.`
melden. Pods **nur** fuer die Dauer der Messung, danach `down --yes`.

| Ticket | Beweis | Kommando | Bestanden wenn |
| --- | --- | --- | --- |
| FLEET-P1-001 | Start-Trigger je Pod, echtes `fleet pod ...` im Server-Log | Session starten, Modul oeffnen | Log-Zeile vorhanden, Pod per REST gestartet |
| FLEET-P1-011 | VRAM je Pod unter 4 Nutzern | `python3 scripts/collect-vram-report.py --group all` | JSON je Rolle mit `peakMb` **und** `avgMb`, Datum/Commit/Treiber |
| FLEET-P1-002 | Qwen3-ASR: Deutsch-Qualitaet, Latenz, VRAM | `POST /infer` mit deutschem Sample | Text korrekt, Latenz + VRAM notiert |
| FLEET-P1-003 | MOSS-Audio-8B: Antwortqualitaet, VRAM 19 GB | dito, Audio-Frage | Antwort plausibel, kein OOM |
| FLEET-P1-004 | pyannote 4.x laedt unter torch>=2.8 | `POST /infer` diarize | Sprecherzahl korrekt, kein Import-Fehler |
| FLEET-P1-005 | SongFormer + beat_this auf echten Dateien | `POST /infer` analyze | Struktur + Beat-Raster geliefert |
| FLEET-P1-006 | BS-RoFormer 6-Stem: bf16 vs fp32, RTF, VRAM | `POST /infer` stem.separate | 6 Stems, RTF gemessen, Qualitaet verglichen |
| FLEET-P1-007 | TTS-Cloning mit Referenz-Audio | `POST /infer` tts mit `referenceAudio` | Stimme aehnlich, kein Fehler |
| FLEET-P1-008 | MOSS-SFX: Qualitaet, Warmup-Zeit, `/ready` | `POST /infer` audio.generate · `GET /ready` | SFX brauchbar, Warmup-Zeit notiert, `/ready` erst nach Warmup 200 |
| FLEET-P1-009 | LEGO auf RP4 mit Kontextspuren | `POST /infer` mit `aceTask=lego` + `contextAudio` | Ergebnis nutzt Kontext, Abbruch funktioniert |
| FLEET-P1-010 | sing ueber ACE-Step-Lyrics | `POST /api/voice/sing` mit `lyrics` | 200 mit WAV, kein Bark |
| FLEET-P1-012 | Auto-Stop nach 15 min Leerlauf | Pod wecken, 15 min warten | Pod gestoppt, Kostenanzeige 0 |
| FLEET-P1-015 | (b)/(c)/(d)/(f) mit echter Flotte | Welcome-Probe | Queue sieht OpenAI-Pfad, warmup, CLI-Jobs, `/api/ai/fleet/wake` weckt |
| LEGO-P1-001 | lego/extract/complete/repaint | 4 Aufrufe mit Kontext | alle 4 liefern Audio; `audio_cover_strength` beachtet |
| AI-RUNPOD-SING-002 | sing ohne `VOICE_AI_RUNTIME_URL` | `POST /api/voice/sing` | 200 mit WAV |
| INFRA-RUNPOD-012 | Nach Aufladung: echter music-Job | `python3 scripts/runpod-pods.py up --only music` + Job | MP3 zurueck |
| INFRA-RUNPOD-013 | Job-Historie der Fehlschlaege | `GET /v1/endpoints/<id>/health` je Rolle | Ursachen benannt, `throttled` transient belegt |
| INFRA-RUNPOD-019 | Guthaben + neue Pod-IDs | Dashboard, dann `.env.deploy` patchen | `clientBalance > 0`, Boot ohne Terminierung |

## Gruppe D - Betreiber (nicht delegierbar)

| Punkt | Was nur der Betreiber kann |
| --- | --- |
| INFRA-RUNPOD-019 | Guthaben im RunPod-Dashboard aufladen (kein API-Weg) |
| FLEET-P1-005 | Lizenz der beat_this-Gewichte und SongFormer klaeren, dann Pin uebernehmen |
| FLEET-P1-014 | Revision-Pin `ad797484...` freigeben (haengt an FLEET-P1-005) |
| MEDIA-P1-002 | Medien-Ingest auf der Maschine mit der BRAIN-Platte starten |
| VISUAL-P0-010 | Entscheiden: GPU-Generierung im Automatik-Pfad erlaubt oder nicht |

---

## Nach dem Test

1. `bash scripts/hetzner/lifecycle.sh stop --yes` (Snapshots + **Loeschung**).
2. `python3 scripts/runpod-pods.py down --yes`.
3. `python3 scripts/apptest-gate.py --group cost --run` - muss 0 Server und
   0 Floating-IPs melden.
4. Fuer jedes abgehakte Ticket: `note` ergaenzen und `status` auf `DONE`, in
   **einem** JSON-Round-Trip (`json.dump(..., ensure_ascii=True, indent=2)`,
   kein Schluss-Newline).
