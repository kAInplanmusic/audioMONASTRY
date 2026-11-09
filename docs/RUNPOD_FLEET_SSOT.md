# audioMONASTRY · RunPod SSOT – acht A40, YuE2 statt Suno, Music Flamingo nur auf vis

**Stand:** 9. November 2026. **Review-Branch – nicht auf laufende GPUs deployed.**

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
