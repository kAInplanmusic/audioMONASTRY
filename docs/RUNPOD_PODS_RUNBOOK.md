# RunPod-Pods: Deploy, Start, Betrieb (Stand 2026-10-07)

Entscheidung Betreiber 2026-10-07: **Pods statt Serverless**, **8 → 5 Instanzen**, alles
resident (beim Start einmal laden, danach nichts tauschen), AI-Aufpreis höchstens **4 €/h**,
keine lokalen oder API-Fallbacks, keine Bild-/Video-Generierung. Quelle der Flotte:
`deploy/runpod/pod-fleet.json`. Hintergrund und Modellwahl: `docs/AI_FLEET_6X48_PLAN.md`.

| Pod | `AI_ROLE` | Modelle (resident) | VRAM | Aufgaben |
|---|---|---|---|---|
| brain | `brain+orchestrator` | Qwen3-30B-A3B-AWQ, Qwen3-4B | 29 GB | App/DAW per Text, Tool-Calls, MoA-Planung |
| ears | `ears` | Whisper-v3, CLAP, MERT, Qwen2-Audio, pyannote, AST, essentia | 26 GB | Analyse |
| voice | `voiceGen` (Teilmenge) | Qwen3-TTS ×2, Stable Audio Open | 26 GB | Sprache, Geräusche |
| stems | `voiceGen` (Teilmenge) | HTDemucs 6s | 8 GB | Stem-Trennung |
| music | `music` (Teilmenge) | ACE-Step 1.5 XL sft + turbo + LM-4B | 26 GB | Song, Remix, Drop/Übergang |

Kosten: 5 × A40/A6000 = **2,25–2,44 €/h** (Pod-Preise 0,49/0,53 $/h). Bei 40 h im Monat ≈ 98 €.
Speicher: Gewichte als Archive in R2 (≈ 2 €/Monat), Pod-Disk nur solange er läuft.
Die Vis-Instanz (eigener Pod mit NVENC-GPU, ≈ 0,25 €/h) ist vorbereitet, aber aus
(`visPod.enabled=false`), bis Phase V1 der Visual-Spec gebaut ist.

## Einmalig

1. **Image mit allen Bausteinen bauen** (die CI baut heute ohne vLLM; das Gehirn braucht es):
   ```bash
   cd services/audiomonastry-ai-runtime
   docker build -f Dockerfile.runpod \
     --build-arg AI_INSTALL_AUDIO_AI=1 --build-arg AI_INSTALL_VOICE_AI=1 \
     --build-arg AI_INSTALL_VLLM=1 --build-arg AI_BAKE_ROLE= \
     -t ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod:pods-$(git rev-parse --short HEAD) .
   docker push ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod:pods-$(git rev-parse --short HEAD)
   ```
   Das Image enthält `pod_start.py` und `pod_jobs.py`; auf dem Pod startet es per
   `dockerEntrypoint ["python","pod_start.py"]` statt des Serverless-Workers.
2. **`.env` ergänzen** (siehe `.env.example`, Block „RunPod-Pods"):
   `RP_API_KEY`, `RP_POD_IMAGE=<Tag aus Schritt 1>`, `AI_POD_TOKEN` (≥ 32 Zeichen,
   z. B. `openssl rand -hex 32`), `CFS3_*`/`CFR2_ACCOUNT_ID` (wie für den Server),
   `HF_TOKEN` (pyannote, Stable Audio).
3. **Gewichte spiegeln** (einmal, auf einem Rechner mit Platz, z. B. CPU-Pod oder media-Knoten):
   ```bash
   pip install huggingface_hub
   python3 scripts/weights-mirror.py          # zeigt, was fehlt
   python3 scripts/weights-mirror.py --yes    # lädt von HF, legt tar + sha256 nach R2
   python3 scripts/runpod-pods.py weights     # Kontrolle: alles da?
   ```

## Starten (AI an)

```bash
python3 scripts/runpod-pods.py plan                 # Belegung + Kosten, kein Netz
python3 scripts/runpod-pods.py up --yes --wait 900  # startet, meldet jede Instanz einzeln als bereit
```
`up` gibt die Zeilen `RP_POD_ID_<ROLLE>=…` aus. Auf dem App-Server setzen:
```
AI_FLEET_MODE=pods
AI_POD_TOKEN=<derselbe Wert>
RP_POD_ID_BRAIN=…  RP_POD_ID_EARS=…  RP_POD_ID_VOICE=…  RP_POD_ID_STEMS=…  RP_POD_ID_MUSIC=…
```
Danach gehen alle AI-Aufgaben an die Pods (`src/core/ai/orchestrator/podRouting.ts`),
nicht mehr an Serverless. `AI_FLEET_MODE` weglassen = alter Serverless-Weg.

Schutz im Werkzeug: ohne `--yes` kein einziger HTTP-Aufruf; fehlende Gewichte → kein Start;
Ist-Kosten über 4 €/h → die Flotte wird sofort wieder beendet; laufende Pods werden nicht
doppelt angelegt. Teilstart: `--only brain` (z. B. für den ersten Test).

## Betrieb und Ende

```bash
python3 scripts/runpod-pods.py status      # Pods, $/h, Bereitschaft
python3 scripts/runpod-pods.py down --yes  # alle Pods der Flotte beenden → keine Kosten
```
Pods speichern nichts: Beenden statt Stoppen (ein gestoppter Pod bekommt nicht sicher
dieselbe GPU zurück und kostet Disk). Nächster Start lädt die Gewichte frisch aus R2.

## Was der Pod tut

`pod_start.py`: Presigned-URLs aus `AI_WEIGHTS_URLS` laden → SHA-256 prüfen → sicher
entpacken → `HF_HUB_OFFLINE=1` → uvicorn auf 0.0.0.0:8000 mit `AI_RESIDENT_ONLY=1`.
`/ready` ist erst 200, wenn **alle** Modelle der Rolle im VRAM liegen; fehlt eins, meldet
`/ready` `failed` mit Grund (kein Teilbetrieb). Alle Routen außer `/health` verlangen
`Authorization: Bearer $AI_POD_TOKEN` (die Proxy-URL ist öffentlich).
Jobs: `/runsync` wartet höchstens 80 s (der RunPod-Proxy schneidet nach 100 s ab) und
antwortet sonst mit `IN_PROGRESS`; der Orchestrator pollt dann `/status/{id}`.

## Noch nicht live belegt (erster Lauf = Messung)

- **brain**: Qwen3-30B-A3B-AWQ läuft im Manifest über vLLM; im eigenen Runtime-Image auf
  einem Pod noch nie gestartet (live lief das Gehirn bisher im vLLM-Worker-Image).
- **music**: Der Runtime-Handler lädt ACE-Step über `diffusers.DiffusionPipeline` je Aufruf;
  live lief Musik bisher im ComfyUI-ACE-Step-Worker. Vor dem Dauerbetrieb prüfen und den
  Handler auf eine residente ACE-Step-Pipeline umstellen.
- **ears/pyannote**: braucht offline zwei weitere Repos; `weights-mirror.py` legt sie mit ins
  Archiv (`EXTRA_REPOS`).
- Startzeit (Gewichte 8–30 GB je Pod aus R2) und VRAM unter Last: messen.
- Bewährt auf dem eigenen Image (Serverless): TTS (Qwen3-TTS), Analyse (CLAP u. a.),
  Stem-Trennung (Demucs), MoA-Orchestrierung.

Empfohlener erster Lauf: `up --yes --only stems --wait 900` (kleinstes Risiko), dann
`--only brain`, dann der Rest.
