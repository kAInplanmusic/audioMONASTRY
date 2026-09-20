# Flottenverifikation 2026-09-20

Verifikation aller acht RunPod-Serverless-Rollen mit **echten** Jobs (keine Trockenläufe).
Freigabe des Betreibers: maximal 4 EUR GPU-Kosten für die gesamte Runde.

Alle Rohantworten und die daraus extrahierten Medien liegen unter
`logs/fleet-verify-20260920/` (nicht im Git, nur lokal).

## Ergebnis pro Rolle

| Rolle | Ergebnis | Beleg | Kaltstart |
| --- | --- | --- | --- |
| `brain` | ✅ echte Inferenz | vLLM-Completion mit Text (`finish_reason: length` bei `max_tokens=16`), `exec 732 ms` | 701 s (11,7 min) |
| `ears` | ✅ bereit | Warmup `status: success`, `ready: true`, 7 Modelle geladen (`ast-audioset`, `clap-music`, `essentia`, `mert-v1-330m`, `pyannote-diarization`, `qwen2-audio-7b`, `whisper-large-v3`) | 136 s |
| `voiceGen` | ✅ Ton erzeugt | 4 Modelle geladen (`ready: true`); echte Synthese: 3/3 WAVs à 24 kHz (`logs/mos-20260920/`) | 497 s |
| `orchestrator` | ✅ bereit | Warmup `status: success`, `qwen3-4b` (26,6 s) + `qwen3-8b` (17,7 s) geladen | 136 s |
| `imageHq` | ✅ Bild erzeugt | `imageHq.png`: gültige PNG-Signatur, **1024×1024**, 853 708 B, Seed 56524 | ~1 min |
| `music` | ✅ Audio erzeugt | `ACESTEP_00001.mp3` (ID3v4), **3 579 569 B**; zusätzlich ComfyUI-Vertrag gepinnt (A40, 47,7 GB VRAM, ComfyUI 1.48.7, `required_templates_version 0.11.39`, Nutzlast `{"workflow": <ComfyUI API-Format>}`) | 902 s + Entsperrung |
| `videoReal` | ✅ Video erzeugt | `videoReal.mp4` (`ftypisom`, H.264), **963 115 B** | 246 s |
| `videoAbstract` | ✅ Video erzeugt | `videoAbstract.mp4` (`ftypisom`), **1 199 871 B** | 235 s |

**8 von 8 Rollen** haben ein echtes Ergebnis geliefert (Bild, Video, Audio, Inferenz oder
geladene Modellgewichte).

## Befunde aus der Runde

1. **Derselbe Ausfallmodus zweimal an einem Tag, an zwei verschiedenen Rollen.** `voiceGen`
   (vormittags) und `music` (mittags) blieben hängen, weil ein Worker belegte und die Queue
   nicht abarbeitete — bei `music` stand der Job 15 min auf `IN_QUEUE`, während `/health`
   `running: 1` meldete. In beiden Fällen löste `workersMax` von 1 auf 2 die Lage sofort:
   bei `music` war die Queue danach leer und der hängende Job durch (`completed: 4 → 5`),
   die echte Musik-Erzeugung lief anschließend in 48 s an. **Offene Betreiberentscheidung:**
   diese Selbstheilung flottenweit setzen (kostet nichts im Leerlauf, erlaubt nur bei Bedarf
   einen zweiten Worker) oder weiter nur punktuell.
2. **Der Rauchtest des Repos kann `brain` nicht prüfen.** `scripts/runpod-smoke.py` führte
   `brain` als „warmup-fähige" Rolle; der Endpoint fährt aber RunPods offiziellen
   vLLM-Worker, der `openai_input`/`route`/`prompt`/`messages` erwartet. Der Job endete mit
   `worker_error: "Job input must contain one of: …"` — kein Flottenfehler, sondern eine
   falsche Anfrage. Behoben: `brain` ist aus `WARMUP_ROLES` entfernt, mit Hinweis auf den
   echten Vertrag (`RUNPOD_SMOKE_PAYLOAD`).
3. **Die Wache hatte zwei eigene Schwächen** (beide im Live-Betrieb aufgefallen und behoben,
   siehe `docs/RUNPOD_COLDSTART.md`): ein Fehlalarm im Kaltstart-Fenster
   (`orchestrator`) und eine Lücke bei „Worker läuft, arbeitet aber nicht" (neuer Status
   `VERDAECHTIG`, bewusst kein Alarm).
4. **Kaltstarts bleiben der dominante Kosten- und Wartefaktor**: 11,7 min (`brain`),
   8,3 min (`voiceGen`), 2,3 min (`ears`/`orchestrator`), 15 min (`music`, inkl. Hänger).
   Das bestätigt die Abwägung in `docs/RUNPOD_COLDSTART.md` (Bake vs. Volume vs. Warmhalter).

## Kostenschätzung

Summe der beobachteten Kaltstarts und Laufzeiten über alle acht Rollen: grob **60–70 Minuten
Worker-Zeit**, davon ein Teil Leerlauf vor dem jeweiligen Job. Bei 0,4–0,7 EUR/h ergibt das
**rund 0,4–0,8 EUR** — deutlich unter dem freigegebenen Deckel von 4 EUR. Die Zahl ist eine
Schätzung aus den `/health`- und Job-Zeiten, keine Abrechnung; die exakte Rechnung steht in
der RunPod-Konsole.
