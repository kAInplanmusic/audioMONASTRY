# visualsUMSETZUNGSPLAN

Ziel in einem Satz: **ein** Weg für Bilder, Animationen und fertige Videos — der
Video-/Visuals-Endpoint erzeugt live alles, was der Visualizer braucht, aus
unseren Modellen und unseren Fotos. Der eigene Bild-Endpoint fällt weg; später
wird wieder gelernt und trainiert, aber nicht mehr nebenbei in einer Nacht.

Stand: 28.09.2026. Alle IDs, Größen und Zeiten sind gemessen (RunPod-API,
Worker-Protokolle, eigene Läufe). Was ungeprüft ist, steht als
`TODO(verify):` dabei — nach Regel §9 des Regelwerks wird nichts als fertig
behauptet, was offen ist.

---

## 1. Ist-Stand (gemessen)

### 1.1 Die acht Endpoints

| Rolle | Endpoint | ID | Image | Pools | FlashBoot | Volume |
|---|---|---|---|---|---|---|
| imageHq | `audiomonastry-ai-image` | `wzh9hcbitjnn95` | **prunaai flux-1-dev** (falsch, s. §4) | ADA_24, AMPERE_16 | an | `x8n6oeex5p` |
| videoReal | `audiomonastry-ai-video-real` | `6ghy4fh00zb0j9` | `wlsdml1114-generate-video-ksampler` | ADA_24, ADA_32_PRO | an | **keins** |
| videoAbstract | `audiomonastry-ai-video-abstract` | `fogwdyxp1zj8zv` | `wlsdml1114-generate-video-ksampler` | ADA_24 | an | **keins** |
| brain | `audiomonastry-ai-brain` | `ppxo7wrn599p0q` | `runpod-workers-worker-vllm` | AMPERE_48, ADA_48_PRO | aus | keins |
| ears | `audiomonastry-ai-ears` | `xeax6xrgd0csag` | unser Runtime-Image | AMPERE_48, ADA_48_PRO | aus | keins |
| voiceGen | `audiomonastry-ai-voice` | `gajmangfldpzrk` | unser Runtime-Image | AMPERE_48, ADA_48_PRO | an | keins |
| music | `audiomonastry-ai-music` | `vsbjhw0nnnb47e` | `ryoheitanaka-acestep15xl` | AMPERE_48, ADA_48_PRO | an | keins |
| orchestrator | `audiomonastry-ai-orchestrator` | `xu4sqszdfk8lp8` | unser Runtime-Image | AMPERE_48, ADA_48_PRO | aus | keins |

Alle acht: `workersMin 0`, `idleTimeout 120 s`, `max 1` (Ausnahme music/voice `max 2`).
Ein Endpoint ohne Auftrag kostet nichts — er skaliert auf null.

**Der wichtigste Satz für den Plan — korrigiert am 28.09. abends, live gemessen:**

Beide Video-Endpoints laufen auf demselben Worker (`wlsdml1114-generate-video-ksampler`).
Hier stand vorher: „ein ComfyUI-Worker führt jeden Graph aus, damit ist ein eigener
Bild-Endpoint überflüssig." **Das ist widerlegt.** Der Video-Worker spricht eine
prompt-basierte API, **nicht** den Workflow-Vertrag (`{input:{workflow}}`). Ob er
überhaupt SDXL-/FLUX-Graphen fahren kann, ist offen. Der Bild-Endpoint ist also
**nicht** ohne Weiteres ersetzbar — die Stilllegung (Abschnitt 2, Punkt 1) ruht,
bis das geklärt ist. Messbelege in Abschnitt 11.

### 1.2 Templates (12 vorhanden, 4 davon brauchbar)

| ID | Name | Image | Bewertung |
|---|---|---|---|
| `35rilgx8er` | audiomonastry-ai-image-lora | `runpod/worker-comfyui:5.10.0-flux1-dev-fp8` | **richtig** für Bilder/LoRAs |
| `7xzd1v17dx` | audiomonastry-ai-image-template | `prunaai flux-1-dev` | **falsch** — hängt am Bild-Endpoint |
| `bgh1bodyeq` | audiomonastry-ai-video-real-template | `wlsdml1114-generate-video-ksampler` | Video |
| `7iihy61ouf` | audiomonastry-ai-video-abstract-template-v2 | dito | Video |
| `qsxc8encwr` | audiomonastry-ai-music-template-v2 | ACE-Step 1.5 XL | Musik |
| `wdfrhic0sn`, `42pqqc06vb` | brain-vllm | vLLM | Text |
| `9q019cos0i`, `4kjoanoc91`, `4uzprwb5x8` | orchestrator/voice/ears | unser Runtime-Image | Hausrollen |
| `e4yzwic56u`, `s50qv6n5rr` | samplemonk | anderes Projekt | nicht anfassen |

### 1.3 Das Network Volume — es gibt genau eines

```
id      x8n6oeex5p
name    audiomonastry-image-lora
Größe   20 GB, Typ STANDARD
Land    EU-RO-1          ← bindend: Endpoints müssen hier landen können
Preis   0,05 USD/GB/Monat = 1,00 USD/Monat
```

Layout (nicht frei wählbar, `worker-comfyui` liest `extra_model_paths.yaml`,
geprüft 27.09.2026):

```
/runpod-volume/models/checkpoints/   sd_xl_base_1.0.safetensors        6,46 GB
                 /models/vae/        sdxl-vae-fp16-fix.safetensors     0,33 GB
                 /models/loras/      32 eigene Themen-LoRAs            2,73 GB
                 /models/loras/      kuratierte Fremd-LoRAs          ~1–2 GB
```

### 1.4 Was die App heute aufruft

| Route | Rolle | geht an |
|---|---|---|
| `POST /api/ai/vision` | imageHq | `wzh9hcbitjnn95` |
| `POST /api/ai/vision/video` | videoReal / videoAbstract | `6ghy4fh00zb0j9` / `fogwdyxp1zj8zv` |
| `GET /api/ai/vision/styles` | — | Vorschlagsliste, rein lokal |
| `POST /api/ai/vision/feedback` | — | Bewertung, rein lokal |

Rollen und Namen stehen in `src/config/aiInfrastructure.ts`, die Zuordnung
Rolle → Endpoint in `src/core/ai/orchestrator/endpointRegistry.ts`
(`endpointIdEnv`), die IDs in der `.env`
(`RP_ENDPOINT_ID_IMAGE`, `RP_ENDPOINT_ID_VIDEO_REAL`, `RP_ENDPOINT_ID_VIDEO_ABSTRACT`).

Kalkulierte Rate je visueller Rolle in der Config: **0,49 USD/h**.

### 1.5 Absicht und Wirklichkeit in der Config

`src/config/aiInfrastructure.ts` nennt als Modelle: `imageHq` = FLUX.2 [dev] +
Qwen-Image-2512, `videoReal` = Wan 2.2 A14B, `videoAbstract` = LTXVideo 13B.

Das ist **Absicht, nicht Stand**. Tatsächlich deployed ist beim Bild FLUX.1-dev
(prunaai) und im ComfyUI-Worker `flux1-dev-fp8`; FLUX.2 wurde in
`visualplan.md` §14 mit Zahlen verworfen. Wer den Plan liest, muss diese zwei
Ebenen trennen — sonst sucht er Modelle, die niemand gebaut hat.

---

## 2. Zielzustand

> **Vorbehalt (28.09. abends, live gemessen):** Dieser Zielzustand setzt voraus,
> dass der Video-Worker Graphen fährt. Das ist **nicht** belegt — er spricht eine
> prompt-basierte API (§11). Der Umbau ist deshalb **aufzuhalten**, bis Punkt 8
> der offenen Liste geklärt ist. Was schon läuft: Image-to-Video mit eigenem Foto
> über eine signierte R2-URL (§11.3).

```
                    ┌───────────────────────────────────────────────┐
   App / Visualizer │  ein Endpoint: audiomonastry-ai-video-real     │
   /api/ai/vision   │  Worker: ComfyUI (generate-video-ksampler)     │
   /api/ai/vision/  │  Volume: x8n6oeex5p  (/runpod-volume/models/…) │
   video            │                                                │
                    │  Graph wählt die Ausgabeart:                   │
                    │    image_sdxl.json     → Bild (unsere LoRAs)   │
                    │    image_flux1.json    → Bild (FLUX-Basis)     │
                    │    anim_*.json         → Animation (mehrere    │
                    │                          Frames, ein Graph)     │
                    │    video_*.json        → fertiger Clip         │
                    └───────────────────────────────────────────────┘
```

Vier Änderungen, mehr nicht:

1. **`audiomonastry-ai-image` (`wzh9hcbitjnn95`) stilllegen.** Die Rolle
   `imageHq` zeigt danach auf `audiomonastry-ai-video-real`. Ersparnis: ein
   Endpoint weniger, der falsch konfiguriert ist und dessen Worker bei jedem
   Kaltstart neu aufwärmt.
2. **Volume an die Video-Endpoints hängen** (`x8n6oeex5p`, EU-RO-1). Ohne Volume
   erzeugt der Video-Worker nur, was in seinem Image steckt — nicht unsere
   LoRAs, nicht unsere Basisgewichte.
3. **Graph-Auswahl per Feld statt per Endpoint.** Der Aufruf bekommt `kind`
   (`image`, `anim`, `video`) und `workflow_name`; die Rolle bleibt eine.
4. **Nichts Neues bauen.** Die Graphen `image_sdxl.json` und `image_flux1.json`
   liegen fertig im Repo, der Adapter kettet die LoRAs ein.

---

## 3. Die richtige Konfiguration — und die falschen

### 3.1 Richtig

```jsonc
// Endpoint-Konfiguration, die funktioniert (Bild, gemessen 27./28.09.2026)
{
  "templateId": "35rilgx8er",              // worker-comfyui:5.10.0-flux1-dev-fp8
  "networkVolumeId": "x8n6oeex5p",
  "gpu": { "pools": ["ADA_24"], "minCudaVersion": "12.8" },
  "workers": { "min": 0, "max": 1, "idleTimeout": 120 },
  "flashboot": "FLASHBOOT",
  "env": { "NETWORK_VOLUME_DEBUG": "true" }  // schreibt je Job einen Volumen-Bericht
}
```

Aufruf an den Worker (der Vertrag ist der Grund für die halbe Fehlerliste):

```jsonc
{ "input": { "workflow": { /* ComfyUI-API-JSON, Knoten "1".."N" */ } } }
```

Der Prompt steckt **im** Graphen (`CLIPTextEncode`), die LoRAs als `LoraLoader`-Kette
zwischen Basis-Loader und Sampler:

```
CheckpointLoaderSimple ─▶ LoraLoader(lora1) ─▶ LoraLoader(lora2) ─▶ KSampler.model
                       └▶ LoraLoader(lora1).clip ─▶ … ─▶ CLIPTextEncode.clip
```

### 3.2 Falsch — jede Zeile hat Geld gekostet

| Falsch | Symptom | Richtig |
|---|---|---|
| Template `7xzd1v17dx` (prunaai) am Endpoint | Worker mit fremdem Vertrag; Auftrag scheitert nach **1,3 s**; heute 3× beobachtet, 12 Bilder verloren | `35rilgx8er` |
| `{"input": {"prompt": "…"}}` | Worker kennt kein `prompt`; er liefert stumm das **Demo-Bild** im Workflow und der Aufrufer hält es für sein Ergebnis | `{"input": {"workflow": …}}` |
| `{…}` ohne `"input"`-Hülle | `Job has missing field(s): id or input` — Job kommt nie an, Kaltstart trotzdem bezahlt | Hülle setzen |
| Pool `ADA_24`/`AMPERE_16`, minCuda 12.8 für FLUX | 16-GB-Karten; FLUX fp8 (16,06 GB) → **OOM** (`container is unhealthy: triggered memory limits`), 12 Aufträge verloren; danach nur noch **58 s je Bild** statt 20 s | 24 GB+ (z. B. `ADA_24` mit 24-GB-Karte, `ADA_48_PRO`) |
| Pfad `/runpod-volume/checkpoints/…` | ComfyUI meldet nur `value not in list` — sieht aus wie ein fehlendes Modell | `models/` **muss** im Pfad stehen |
| LoRA im Diffusers-Format | lädt, wirkt aber nicht sichtbar (nur Warnung) | kohya-Format bzw. Format je Datei prüfen |
| Endpoint ohne Volume | erzeugt nur, was im Image liegt | Volume `x8n6oeex5p` anhängen |
| `adb`-Raten (`flashboot: OFF`) bei visuellen Rollen | jeder Kaltstart voll bezahlt | FlashBoot an |

### 3.3 Der Messwert, der alles einordnet

Zwei **identische** Aufträge (Prompt, Seed, Graph) liefern **byte-identische**
Dateien — der Worker rechnet deterministisch. Mittlere Helligkeitsdifferenz:

```
ohne LoRA ↔ ohne LoRA        0,00
ohne LoRA ↔ feuer_flammen    25,70
ohne LoRA ↔ fremd_chrome     14,15
```

Die LoRA-Kette wirkt also nachweislich (und der Graph ist korrekt verdrahtet).
**Was sie nicht tut: den Stil aufprägen.** Bei gleichem Motiv sehen alle acht
SDXL- und alle sieben FLUX-Kombinationen praktisch gleich aus — das Motiv
gewinnt, nicht die LoRA. Details und Belege: `scripts/visual-vorrat/BEFUND.md`.

Folge für diesen Plan: Der Nutzen entsteht **nicht** über „32 Stile", sondern
über Motiv, Ausgabeart (Bild/Animation/Video) und die eigenen LoRAs. Wer Stil
will, muss das Motiv ändern oder ein eigenes LoRA gezielt darauf trainieren —
genau das ist die Trainings-Aufgabe, die später drankommt.

---

## 4. Der aktuelle Schaden: der Bild-Endpoint ist falsch gebunden

`GET /v1/endpoints/wzh9hcbitjnn95` meldet:

```
image  registry.runpod.net/prunaai-runpod-worker-flux-1-dev-main-dockerfile:287a29201
env    AI_ROLE=imageHq
```

Erwartet ist Template `35rilgx8er` (`worker-comfyui:5.10.0`). Beobachtet am
28.09.: Der Endpoint hat **drei Worker** erzeugt, zwei davon mit dem PrunaAI-Image
(14:22, 14:25, nochmals 14:37 auf RTX 4090). Aufträge, die dort landeten,
scheiterten nach 1,3 s — das sind die zwölf verlorenen Bilder 1041–1052.

**Nicht angefasst.** Das ist eine Änderung an RunPod und gehört angesagt
(Regelwerk §4). Wenn der Endpoint ohnehin wegfällt (§2), erledigt sich das
Thema — bis dahin bleibt es eine bekannte Fehlerquelle.

---

## 5. Material — was da ist und wo es liegt

| Material | Menge / Größe | Ort |
|---|---|---|
| SDXL 1.0 Basis | 6,46 GB | Volume `models/checkpoints/`, Quelle HuggingFace (nicht gated) |
| SDXL VAE fp16-fix | 0,33 GB | Volume `models/vae/`, HF `madebyollin` |
| FLUX.1-dev fp8 | 16,06 GB | **im Image** (`worker-comfyui:5.10.0-flux1-dev-fp8`), 0 USD/Monat |
| 32 eigene Themen-LoRAs | 2,73 GB | Volume `models/loras/`; Quelle R2-Präfix `lora-out` (vorab signierte URLs) |
| Kuratierte Fremd-LoRAs | ~1–2 GB | Volume `models/loras/`; Liste mit Herkunft: `LORA-FREMDQUELLEN.md` |
| Fotos der 32 Themen | 32 × 25 = **800 Bilder**, 0 Verwürfe | Quelle `/home/patrick/am-visuals-themen-neu/`, Datensatz `out-v3/<slug>/images/` |
| Vorratsbilder aus dem Lauf | **1061 PNG**, 1,6 GB | `~/lora-themen-2026-09-27/bilder-vorrat/` (nicht im Repo) |
| Prüf-/Vergleichstafeln | 4 PNG | `~/lora-themen-2026-09-27/ergebnisse/`, `/tmp/*.png` |

**In Kopie bereitstellen** — der Weg, der schon gebaut ist und ohne Zugangsdaten
im Pod auskommt (`stage-image-lora-volume.py` signiert R2-URLs vor, der Pod
lädt und schreibt nach `models/…`):

```bash
cd ~/lora-themen-2026-09-27
python3 stage-image-lora-volume.py --volume x8n6oeex5p --data-center EU-RO-1
# nur den Plan ausgeben, ohne Pod und ohne Upload:
python3 stage-image-lora-volume.py --volume x8n6oeex5p --data-center EU-RO-1 --dry-run
```

`TODO(verify):` Der Video-Worker (`wlsdml1114-generate-video-ksampler`) ist
**nicht** `runpod/worker-comfyui`. Ob er dasselbe `extra_model_paths.yaml` liest
und ob er SDXL/FLUX-Graphen überhaupt ausführen kann, ist **nicht geprüft**.
Erster Schritt dazu ist billig: `NETWORK_VOLUME_DEBUG=true` in die
Endpoint-Umgebung, einen Job schicken, den Volumen-Bericht im Log lesen.

---

## 6. Live nutzen — der Ablauf, wenn es läuft

1. **Visuelle Rolle anstoßen** (bestehende Mechanik, `isVisualRole` +
   `fleetWake`): der Endpoint wärmt sich auf, danach läuft er warm.
2. **Auftrag** an `/v2/<id>/runsync` mit `{"input": {"workflow": …}}`.
   Der Adapter (`services/audiomonastry-ai-runtime/comfyui_adapter.py`) baut den
   Graphen: `base` wählt `image_sdxl`/`image_flux1`, `lora_pairs` werden
   eingekettet, Prompt/Seed/Steps landen über die **verdrahteten** Verbindungen
   des Samplers im Graphen.
3. **Ergebnis**: `{images: [{filename, type: "base64", data: "<rohes base64>"}]}`.
   Für große Videos statt base64 besser S3-Ausgabe — dann trägt `type: "s3"` und
   `data` eine URL, und der Transport bleibt klein.
4. **In der App**: `POST /api/ai/vision` (Bild) bzw. `POST /api/ai/vision/video`
   (Clip). Beides existiert; geändert werden muss nur, wohin die Rolle zeigt.

Kosten je Aufruf (gerechnet, nicht gemessen — `TODO(verify)` an einer echten
Reihe): warmes Bild ≈ 20 s (SDXL) bzw. ≈ 58 s (FLUX auf 16-GB-Karte), Video
deutlich mehr. Der Kaltstart ist der große Posten: gemessen **88,9 s** für das
erste Bild, in früheren Messungen bis **13 min**. Deshalb lohnt Bündeln, nicht
Einzelklicks.

---

## 7. Was der Lauf gekostet hat und was der Umbau spart

| Posten | Ist |
|---|---|
| Vorratslauf (1061 Bilder, 5 h 56 min warm) | 2,60 USD |
| Proben und Gegentests (19 Bilder + Kontrolle) | 0,30 USD |
| **Verbraucht** | **≈ 3 USD** |
| Abgebrochen (1035 FLUX-Bilder = 16,7 h) | 7,40 USD **nicht** ausgegeben |
| Volume `x8n6oeex5p` | 1,00 USD/Monat |
| Bild-Endpoint stilllegen | spart dessen Kaltstarts und die 0,49 USD/h bei Nutzung |

Weiteres Training ist **nicht** Teil dieses Plans — es kommt später und
kontrolliert (Abschnitt 9).

---

## 8. Was dieser Plan ausdrücklich NICHT macht

* Er fasst **keine** RunPod-Ressource an. Änderungen an Endpoints, Templates und
  Volume-Zuordnung sind nach §4 des Regelwerks Betreiber-Entscheidungen.
* Er löscht nichts: `wzh9hcbitjnn95` wird **stillgelegt** (Rolle umbiegen), erst
  danach — nach einer Woche ohne Rückgriff — gelöscht.
* Er startet keinen Pod. `stage-image-lora-volume.py` schreibt nur, wenn man es
  ohne `--dry-run` aufruft, und kostet dann einen kleinen Pod.
* Er behauptet keine Zahlen, die nicht gemessen sind; offene Punkte stehen als
  `TODO(verify):`.

---

## 9. Später weiterarbeiten (Training)

Der Zweig `visuals` hält den Stand. Der Weg zurück ins Training ist der, der
schon funktioniert hat (Details: `visualplan.md` §5–§7, `BERICHT.md`):

```bash
# Pod rundenweise starten, mit Kostenbremse im Pod selbst
./start-mit-wiederholung.sh                 # 12 Runden, 240 s Pause
python3 start-pod.py --name lora-p1 --cloud COMMUNITY \
    --anwendung <themen> --steps 800 --max-usd 2.5 --run lora-themen-v3
```

Unverhandelbar (jede Zeile hat schon einmal Geld gekostet):

* `trap 'self_terminate' EXIT` im Pod-Skript — sonst startet RunPod den
  beendeten Container neu und rechnet weiter.
* `SELF_TERMINATE=1` + `RUNPOD_API_KEY` im Pod-Env.
* `MAX_THEME_SECONDS` je Thema, `DEADLINE_EPOCH` als Frist.
* `timeout 900` um Uploads.
* Am Ende **nachsehen**, nicht annehmen: `runpodctl pod list -o json` → `[]`.

Und der Satz aus dem Befund, der das Training betrifft: Ein LoRA wirkt, aber es
prägt seinen Stil nicht auf, wenn das Motiv zu stark beschreibt. Beim nächsten
Trainingslauf gehören dazu **stilfreie Motive** und eine Prüfung am Bild — plus
die Differenzmessung als objektiver Vergleich (Rauschboden ist 0,00).

---

## 10. Offene Punkte

| # | Punkt | Aufwand | Kosten |
|---|---|---|---|
| 1 | Volumen-Bericht des Video-Workers prüfen (`NETWORK_VOLUME_DEBUG=true`) | Minuten | ~0 |
| 2 | Volume `x8n6oeex5p` an `video-real` hängen, einen Bild-Graph dort fahren | Minuten | ~0,10 USD |
| 3 | Einen Animations-Graph bauen (mehrere Frames) und live testen | Stunden | ~0,5 USD |
| 4 | Rolle `imageHq` auf den Video-Endpoint umbiegen, `RP_ENDPOINT_ID_IMAGE` stilllegen | Minuten | 0 |
| 5 | `wzh9hcbitjnn95` nach einer Woche ohne Rückgriff löschen | Minuten | 0 |
| 6 | Motiv/Stil-Frage klären: stilfreie Motive gegen dieselben LoRA-Stapel | ~15 min | ~0,25 USD |
| 7 | `src/config/aiInfrastructure.ts` auf den echten Stand bringen (FLUX.2 steht dort, ist aber nicht gebaut) | Minuten | 0 |
| 8 | Video-Worker auf einen SDXL/FLUX-Graph prüfen, erst dann Bild-Endpoint stilllegen (§11) | ~1 h | ~0,10 USD |
| 9 | Startframes dauerhaft ablegen (R2 `visuals/start-frames/`), statt je Auftrag zu signieren | Minuten | 0 |

---

## 11. Nachtrag: der Video-Worker live gemessen (28.09.2026, abends)

Drei echte Aufträge an `video-real` (`6ghy4fh00zb0j9`), Ergebnisse in
`~/lora-themen-2026-09-27/visuals-live/`. Dauer insgesamt rund sieben Minuten,
Kosten unter 0,10 USD.

### 11.1 Der Vertrag, bestätigt

```
Eingabe  {prompt, negative_prompt, image_url, width, height, length, steps, cfg, seed}
Ausgabe  {video: "<rohes base64 MP4>"}      ← genau ein Schlüssel, bestätigt
```

Gemessen: `width 480`, `height 832`, `length 49`, `steps 20`, `cfg 5.0` ergeben
**480×832, 32 fps, 97 Frames, 3,03 s, h264, 0,6–1,4 MB**. Kaltstart 90–130 s
(FlashBoot an), Rechnen ~120 s, Worker in EUR-IS-2 auf einer RTX 5090.

### 11.2 Drei Funde, von denen jeder still Geld gekostet hätte

1. **Ohne Bild nimmt der Worker ein eingebautes Beispielbild als Startframe.**
   Ein reiner Text-Auftrag lieferte einen Clip, der mit einem **fremden Foto
   (Mann im weißen Hemd)** beginnt und erst danach in Richtung Prompt kippt.
   Kein Fehler, keine Warnung — dieselbe Fehlerklasse wie das Demo-Bild des
   Workflow-Workers. **Text-to-Video gibt es hier praktisch nicht; der Weg ist
   Image-to-Video.**
2. **`image_url` wird per `wget` heruntergeladen.** Ein data-URI mit 142 KB
   Base64 sprengte die Argumentliste:
   `OSError: [Errno 7] Argument list too long: 'wget'` (nach 23 s, FAILED).
   Das Feld braucht eine **echte http(s)-URL**.
3. **Der Ausweg ist der Weg, den wir schon haben:** vorab signierte R2-URL.
   `r2.py presign PUT` → hochladen → `r2.py presign GET` (48 h) → dieser Link
   als `image_url`. So entstand der brauchbare Clip: **eigenes Foto**
   (`am-visuals-themen-neu/Feuer_Flammen/…JPG`), die Flammen bewegen sich, die
   Kamera fährt langsam heran.

`image_base64` wird nicht gelesen (der Worker geht über `wget`); `lora_pairs`
wurden nicht mitgeschickt — der Worker hat **kein Volume**, unsere LoRAs sind
dort also nicht vorhanden. „Aus unseren Modellen" ist damit noch **nicht**
erfüllt, nur „aus unseren Fotos".

### 11.3 Der Rezept, der jetzt funktioniert

```python
import r2
put = r2.presign("PUT", "visuals/start-frame.jpg", **r2._creds(), expires=3600)
# curl -sS -X PUT --data-binary @startframe.jpg "$put"
get = r2.presign("GET", "visuals/start-frame.jpg", **r2._creds(), expires=172800)
# input = {prompt, negative_prompt, image_url: get,
#          width: 480, height: 832, length: 49, steps: 20, cfg: 5.0, seed: 4711}
```

Ablage: `~/lora-themen-2026-09-27/visuals-live/` — `feuer_clip.mp4` ist der
brauchbare, `erster_clip.mp4` zeigt den Beispielbild-Fund.
