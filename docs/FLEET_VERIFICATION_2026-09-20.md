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

## Nachtrag 2026-09-20, 14:30 (die 8/8 gelten nicht mehr unverändert)

**Was sich geändert hat:** Die Musik-Zeile dieses Berichts stammt aus der Erzeugung von
**13:19** (`ACESTEP_00001.mp3`). Seitdem konnte die Rolle **keinen neuen Worker mehr
provisionieren** — der Beleg von damals bleibt gültig, sagt aber nichts über den Zustand
danach.

**Gemessen (read-only, keine GPU-Kosten):**

| Prüfung | Ergebnis |
| --- | --- |
| Endpoint-Bindung `music` | `templateId=qsxc8encwr` (gelistet), `workersMax=2` — Rücklesung bestätigt |
| Health `music` | `inQueue=2`, **alle Worker-Zähler 0**, `delayTime: null` über > 45 min |
| Frischer Job, 5-min-Fenster | kein Worker, kein `initializing` |
| Kontrollrolle `ears` (eigenes, gelistetes Template) | **dasselbe** Bild → nicht rollenspezifisch |
| `myself.clientBalance` | **-0,0877 USD** |
| Alt-Templates `9q9c60p6xh` (music) / `1pip14re7h` (videoAbstract) | `GET /v1/templates/<id>` → **HTTP 404**, in `myself.podTemplates` nicht gelistet |

**Bewertung:** Es waren **zwei** unabhängige Defekte. (1) Beide Endpoints hingen an
Templates, die die Plattform nicht auflöst — das bricht jede Neu-Provisionierung, sobald der
alte Worker weg ist. (2) Der Kontostand ist negativ — das bricht die Provisionierung
**flottenweit**, unabhängig von Template oder Rolle. Defekt (1) ist für `music`
(`qsxc8encwr`) und vorbeugend für `videoAbstract` (**`7iihy61ouf`**) behoben, je mit
Rücklesung; Defekt (2) ist eine Betreiberentscheidung (Aufladung).

**Auswirkung auf die 8/8:** `brain`, `ears`, `voiceGen`, `imageHq` antworten weiter (warme
Worker). `music` ist bis zur Aufladung **nicht erreichbar**; `videoAbstract` und
`videoReal` haben keine Worker mehr, ihre Templates/Images sind aber intakt — sie liefern
nach der Aufladung neu provisioniert, dann ist der Nachweis nachzutragen.

**Ehrliche Ursachenkette (mein Anteil):** Der Recycle (`workersMax` 0 → zurück), mit dem ich
nach dem `zz`-Schreibtest wieder für einen frischen Worker sorgen wollte, hat die letzten
warmen Worker der Musik-Rolle weggeräumt und damit einen **bereits vorhandenen** latenten
Defekt akut gemacht. Ohne die vorherige Reparatur wäre die Rolle aber auch mit gefülltem
Konto nicht zurückgekommen — die Template-Bindung war unauflösbar.

