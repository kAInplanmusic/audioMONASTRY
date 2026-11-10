# audioMONASTRY · RunPod SSOT – Ziel A01–A05 und ausführbarer Ist-Stand

**Stand:** 10. November 2026. **Verbindliche Zielentscheidung A01–A05; ausführbares JSON/Manifest NOCH NICHT aktualisiert und nicht live auf GPU geprüft.** Ziel-SSOT und technischer Ist-Stand sind getrennt zu lesen.

## Bisherige ausführbare Architektur (ALT, nur technischer Ist-Stand)

Im alten JSON noch **acht NVIDIA A40 mit 48 GB**. Der Zielplan behält acht 48-GB-GPUs, jedoch Ada für A01/A04; **maximal 42 GB reale Nutzlast** plus mindestens 6 GB Reserve. Das aktive JSON `deploy/runpod/pod-fleet.json` bestimmt die sieben KI-Pods und den Visual-Pod. `model_manifest.json` enthält gepinnte Repositories und Revisionen.

| Pod | Residenter Modell-/Gewichtsplan | Geplante Last |
|---|---|---:|
| `brain` | `qwen3-30b-a3b-awq`, `qwen3-4b` | 29 GB |
| `ears` | `whisper-large-v3`, `clap-music`, `mert-v2-330m`, `qwen2-audio-7b`, `pyannote-diarization`, `ast-audioset`, `essentia` | 26 GB |
| `voice` | `qwen3-tts-17b`, `qwen3-tts-voicedesign`, `qwen3-tts-06b-base`, `moss-soundeffect-v2.0`, `acestep-v15-xl-base`, `acestep-v15-shared` | 39 GB |
| `music` | `acestep-v15-xl-sft`, `acestep-v15-xl-turbo`, `acestep-5hz-lm-4b`, `acestep-v15-shared` | 37 GB |
| `studio` | `sonicmaster`, `meanvc2`, `universr`, `scnet-xl-4stem`, `bs-roformer-sw-6stem`, `htdemucs-6s` | 36 GB |
| `audio-brain` | `qwen3-omni-30b` | 28 GB |
| `song` | `yue2-3b` | 24 GB |
| `vis` | `music-flamingo` = NVIDIA Music Flamingo 2601 (17 GB) + Rendering/NVENC vorhandener Medien (8 GB) | **25 GB** |

## Alte Quantisierung und Gewichte je Pod (noch im Manifest, nicht der Zielplan)

| Pod | Modell-ID | Manifest-Quantisierung | Geschätzter Modell-VRAM |
|---|---|---|---:|
| `brain` | `qwen3-30b-a3b-awq` | AWQ-INT4 | 20 GB |
| `brain` | `qwen3-4b` | FP16 | 9 GB |
| `ears` | `whisper-large-v3` | INT8 | 5 GB |
| `ears` | `clap-music` | FP16 | 4 GB |
| `ears` | `mert-v2-330m` | FP16 | 3 GB |
| `ears` | `qwen2-audio-7b` | AWQ-INT4 | 8 GB |
| `ears` | `pyannote-diarization` | FP16 | 3 GB |
| `ears` | `ast-audioset` | FP16 | 3 GB |
| `ears` | `essentia` | NONE | 0 GB |
| `voice` | `qwen3-tts-17b` | BF16 | 8 GB |
| `voice` | `qwen3-tts-voicedesign` | BF16 | 8 GB |
| `voice` | `qwen3-tts-06b-base` | BF16 | 3 GB |
| `voice` | `moss-soundeffect-v2.0` | BF16 | 8 GB |
| `voice` | `acestep-v15-xl-base` | BF16 | 10 GB |
| `voice` | `acestep-v15-shared` | BF16 | 2 GB |
| `music` | `acestep-v15-xl-sft` | BF16 | 10 GB |
| `music` | `acestep-v15-xl-turbo` | BF16 | 10 GB |
| `music` | `acestep-5hz-lm-4b` | BF16 | 9 GB |
| `music` | `acestep-v15-shared` | BF16 | 2 GB |
| `studio` | `sonicmaster` | FP16 | 8 GB |
| `studio` | `meanvc2` | FP16 | 2 GB |
| `studio` | `universr` | FP16 | 4 GB |
| `studio` | `scnet-xl-4stem` | FP32 | 8 GB |
| `studio` | `bs-roformer-sw-6stem` | BF16 | 6 GB |
| `studio` | `htdemucs-6s` | FP16 | 8 GB |
| `audio-brain` | `qwen3-omni-30b` | INT4 | 28 GB |
| `song` | `yue2-3b` | BF16 | 24 GB |
| `vis` | `music-flamingo` | BF16 | 17 GB |

**Zusätzliche GPU-Last:** `music` +6 GB KV-/Runtime-Reserve, `vis` +8 GB Chromium/WebGL/NVENC. Damit bleiben alle acht Pods unter 42 GB planbarer Last. Die übrigen 6 GB pro GPU sind Sicherheitsreserve und **nicht** bereits gemessene freie Kapazität.

**Präzisions-Drift vor Deployment prüfen:** Die Modell-ID `qwen3-30b-a3b-awq` und ihr Manifestwert `awq-int4` widersprechen dem gepinnten Repository-Namen `Qwen/Qwen3.5-35B-A3B-GPTQ-Int4`. Das ist ein Metadatenkonflikt; die tatsächliche Checkpoint-Quantisierung muss am geladenen Gewicht geprüft werden. `qwen2-audio-7b` ist als `awq-int4` verzeichnet, aber sein Repository-Name weist nicht ausdrücklich auf eine AWQ-Variante hin. Keine dieser Unklarheiten wurde stillschweigend umetikettiert.

## Verbindliche Ziel-SSOT A03 / A04 / A05

**Ziel-SSOT ist beschlossen**, nicht implementiert. Das alte `deploy/runpod/pod-fleet.json` und `services/audiomonastry-ai-runtime/model_manifest.json` gelten derzeit ausschließlich als *technischer Ist-Stand*. Folgeagenten sollen die ausführbare SSOT später atomar mit Model-Pins, Handlers, Pod-Images und Routing umstellen. In der README [`Abschnitt 8.5–8.9`](../README.md#85-a03-voice--fest-5-komponenten-kein-cloning) stehen die vollständigen Aufgaben, Revisions-Hashes, Qualitätsschranken und Prüfanforderungen.

| Pod | Final gewählte Modelle/Assets | Präzision | Nominal-/Mindestbudget | GPU |
|---|---|---|---:|---|
| **A03 voice** | `qwen3-tts-17b`, `qwen3-tts-voicedesign`, `moss-soundeffect-v2.0`, `acestep-v15-xl-base`, `acestep-v15-shared` | alle BF16, XL Base beim Laden aus F32 | **36 GB** | A40 48 GB zunächst |
| **A04 music** | `acestep-v15-xl-turbo`, `acestep-5hz-lm-4b`, `acestep-v15-shared` | **BF16**; plus 6 GB vLLM/KV-Runtime | **27 GB** | **RTX 6000 Ada 48 GB**, L40S/L40 Hardware-Alternativen |
| **A05 studio** | `sonicmaster`, `bs-roformer-sw-6stem`, **`mvsep-mega-53`**, **`mel-roformer-bve`** | FP16, BF16-Autocast, Originalformat, FP32-Ziel | **≥33 GB**, max. Peak **42 GB noch unbewiesen** | A40 48 GB zunächst |
| **A08 teilweise reserviert** | **`universr` (4 GB) + `mel-roformer-dereverb` (3 GB)** plus bisheriges Visual-Rendering (8 GB) | FP16 / FP32 | **15 GB Teilbudget ohne Music Flamingo/Runtime** | A08 wird separat finalisiert |

**A03:** Fünf Komponenten, vier funktionale Modellaufgaben + ACE Shared-Pack. TTS CustomVoice BF16 8 GB, VoiceDesign BF16 8 GB, MOSS-SFX BF16 8 GB, XL Base BF16 10 GB, Shared BF16 2 GB. **Kein** `qwen3-tts-06b-base`, keine Referenzstimmen-Clone-Funktion, keine Voice-Conversion. CustomVoice verwendet feste künstliche Stimmen; VoiceDesign neue Stimmen per Textbeschreibung. ACE-Step XL Base für LEGO/Extract/Complete zwingend erhalten. Nominelle 36 GB sind *nicht* der gemessene Spitzenverbrauch.

**A04:** XL Turbo BF16 10 GB, 5Hz LM 4B BF16 9 GB, Original-`vae/` + `Qwen3-Embedding-0.6B/` BF16 2 GB, vLLM-KV-/Basisreserve 6 GB. **Kein** `acestep-v15-xl-sft`, keine zusätzliche INT8/INT4-Quantisierung, keine fremden VAE-/Embedding-Gewichte. Die Modellrevisionen stammen aus dem noch vorhandenen Manifest; Gewichts-Shards/Configs/Tokenizer/Hashes beim Umsetzen vollständig übernehmen. Das 4B-LM darf **nicht** mit `llm_handler=None` abgekoppelt bleiben. `gpu_memory_utilization` so begrenzen, dass Turbo und LM gleichzeitig funktionieren. **RTX 6000 Ada** primär; **L40S/L40** Hardware-Ausweichoptionen; A40 als günstige Möglichkeit. Stundensatz vor Buchung ≤1 USD verifizieren.

**A05:** SonicMaster FP16 (8 GB), BS-RoFormer SW 6-Stem BF16-Autocast (6 GB), **Mega53 Originalcheckpoint** (ab **16 GB**, keine Peak-Obergrenze!), **Gonzaluigi Mel-Band RoFormer BVE** für Lead-/Backing-Vocals (FP32 initial, 3 GB). Neues Alias `mvsep-mega-53`: [MSST Release v1.0.21](https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/tag/v1.0.21), `mvsep_mega_model_bs_roformer_53_stems_v1.ckpt` + zugehörige YAML. Neues Alias `mel-roformer-bve`: [Gonzaluigi/Mel-Band-Roformer-BVE-Gonzaluigi](https://huggingface.co/Gonzaluigi/Mel-Band-Roformer-BVE-Gonzaluigi), `config_bve_gonza.yaml` + zugehörige Gewichte; genaue Revisionspins und SHA256 **noch offen**. Mega53-Stems können **überlappen**; 53 Stems nicht automatisch zur Ursprungsspur addieren.

**A05 Speicherarithmetik:** **8 + 6 + 16 + 3 = 33 GB als MINDEST-/BASISWERT**, höchstens **9 GB** bis 42 GB für den **gesamten** ungemessenen Mega53-Mehrbedarf, Aktivierungen, CUDA-Kontext, Buffers, 4-Nutzer-Parallelität. 42 GB ist eine **strikte Freigabesperre**; 6 GB Hardware-Reserve müssen real erhalten bleiben. A05 **nicht als nachweislich passend markieren**, solange keine Peaks mit allen residenten Modellen vorliegen. Im Fall >42 GB den **BVE-Baustein zusätzlich auslagern** oder explizit neu planen; **keine** ungeprüfte INT4-/INT8-Quantisierung und **kein Modell-Fallback**.

**Aus A05 entfernen:** `meanvc2`, `scnet-xl-4stem`, `htdemucs-6s`, `universr`. UniverSR (4 GB FP16) zusammen mit `mel-roformer-dereverb` (3 GB FP32, im Altmanifest vorhanden) **auf A08 als auszulagernde Restaurierungsfunktionen reservieren**. **A08 noch nicht final**; Music Flamingo ist im alten JSON noch resident, soll nach A02-MOSS-Analyse verdrängt werden. Restaurierungs-Endpunkte dürfen bei einer Migration nicht ersatzlos wegfallen. Keine Fallback-Separatoren, kein Klonen, keine Voice-Conversion.

**Model-Revisionen A03/A04/A05 aus Altmanifest (Full SHA):**

| Alias | Revision |
|---|---|
| `qwen3-tts-17b` | `0c0e3051f131929182e2c023b9537f8b1c68adfe` |
| `qwen3-tts-voicedesign` | `5ecdb67327fd37bb2e042aab12ff7391903235d3` |
| `moss-soundeffect-v2.0` | `e35df4d82fbe87fcd5d14e5d100e349c0c3c076d` |
| `acestep-v15-xl-base` | `220c1166efbdd9583eafcb12eb160594bbfcb241` |
| `acestep-v15-shared` | `19671f406d603126926c1b7e2adc169acbcade22` |
| `acestep-v15-xl-turbo` | `d4a0b288b83ebb7e25a8c0b32c573c22e134e8ee` |
| `acestep-5hz-lm-4b` | `0a3ec94b557aea7d508da38b31cfe7341f6ff737` |
| `sonicmaster` | `93c7fa73c4dd446c9e656af34524b5f6a416afda` |
| `bs-roformer-sw-6stem` | `2b98254b19bdab07ce225d884ec4aa9dd8aafce1` |
| `universr` | `1c3294844285af851b6ffa56cbde4e43cd41fc2b` |
| `mel-roformer-dereverb` | `cef05ad2b5b3145ea5c149d3ad5d1f8439b34d06` |

**Offene Implementierungsmessung:** echte Hörproben/WAVs pro Task (TTS, SFX, LEGO, XL Turbo, Mastering, 6-/53-Stem, BVE, Restaurierung), Checkpoint-Hash/Safety, GPU-Spitzenverbrauch und Inferenzzeit bei vier simultanen Sessions, Audioqualität und Output-Validierung. **Ziel-SSOT ≠ Code-Fertigstellung**.

## Songgenerator

Der ausgewählte **Suno-Ersatz** ist `m-a-p/YuE2-3B`, lokaler Manifest-Alias `yue2-3b`, im **`song`-Pod**. **Nicht** MiniMax Music 3. Der bisherige Facebook/Meta-MusicGen-Default wird bei `AI_FLEET_MODE=pods` durch YuE2 ersetzt; ACE-Step bleibt separat für Remix, LEGO und Repaint.

**Benchmark 12.09.2026, WildSongBench (192 Prompts, automatisiert):** YuE2 Best-of-8 **6,9632**, Suno v6 **6,5562**, YuE2 Standard **6,7316**. Das Best-of-8-Ergebnis setzt **acht generierte Kandidaten + Selektion** voraus. Es ist KEINE andere Quantisierung oder Modellgewichtsvariante. Eine einzelne YuE2-Generierung erreicht nicht automatisch 6,9632.

**Lizenz:** YuE2 `CC-BY-NC-4.0` (nichtkommerziell). Keine kommerzielle Freigabe aus dieser SSOT ableiten. Vor kommerziellem Betrieb gesonderte Lizenz einholen oder alternative erlaubte Gewichte festlegen.

## Vis

`vis` erhält **Music Flamingo 2601 exklusiv** als Musikverständnis und Steuerung der Asset-Auswahl. Der Visual-Player darf ausschließlich bereits vorhandene Fotos und Videos suchen, schneiden, abspielen und streamen. Keine Bild-/Videogenerierungsmodelle und keine Meta-MusicGen-Gewichte auf `vis`. Music Flamingo wird nicht auf `song` oder `audio-brain` dupliziert.

**Technische Freigabesperre:** Das bisherige reine Masterplayer-Image kann Music Flamingo nicht laden. Bevor `up` acht Pods provisioniert, muss das gemeinsame Chromium/NVENC/Torch-Image bewiesen sein (`RP_VIS_AI_IMAGE_READY=1` erst nach Test). Im aktuellen RunPod-Pod-Code existiert noch kein nachgewiesener YuE2-3B-Inferenzadapter; die App gibt deshalb für YuE2 ein klares Nicht-bereit statt still auf MusicGen zurückzufallen.

## Mess- und Rechtegrenzen

Die Modelle sind **nur als Repositories/Revisionen zugeordnet**, nicht tatsächlich auf der A40 gemessen. BF16 beim YuE2 und Music Flamingo ist unverändert; keine unbelegte AWQ/GPTQ-Variante. Vor Livebetrieb: Image-Build, Model-Load, echte generierte Songdatei, Music-Flamingo-Cues, 4-User-Last, VRAM-Peaks, Checkpoint-Lizenzen, Best-of-8-Sampling und GPU-Kosten prüfen.

Die Git-Historie bewahrt frühere Entwürfe; die aktive Flottenkonfiguration hat **nur diese eine Zuordnung**.
