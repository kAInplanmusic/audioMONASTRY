# audioMONASTRY · RunPod SSOT – acht A40, YuE2 statt Suno, Music Flamingo nur auf vis

**Stand:** 10. November 2026. **Verbindliche Repository-SSOT; nicht auf laufende GPUs deployed.**

## Architekturentscheidung

Genau **acht NVIDIA A40 mit 48 GB**, je höchstens 42 GB geplante Nutzlast plus mindestens 6 GB Reserve. Das aktive JSON `deploy/runpod/pod-fleet.json` bestimmt die sieben KI-Pods und den Visual-Pod. `model_manifest.json` enthält gepinnte Repositories und Revisionen.

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

## Quantisierung und Gewichte je Pod

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
