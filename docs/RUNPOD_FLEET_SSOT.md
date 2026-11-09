# audioMONASTRY · RunPod-Fleet-SSOT

**Verbindlicher Stand: 9. November 2026.** Basis: [Commit 686a5bf](https://github.com/kAInplanmusic/audioMONASTRY/commit/686a5bfcecbd55a0d8e4523252930b3cdfaf9816) plus Modellumverteilung aus [874838f](https://github.com/kAInplanmusic/audioMONASTRY/commit/874838fe7ddeed4fdf5a8465a45920232f89406c).

**Ausschließlich diese RunPod-Architektur ist gültig:** genau **acht Pods**, jeder mit **einer NVIDIA A40 (48 GB)**. Sieben KI-Pods sowie ein Visual-Pod, aktiv. Keine anderen GPU-Typen, keine Serverless-/MusicGen-Zusatzflotte, keine parallelen Zielkonfigurationen.

## Einzige Quellen

- **Deploy, Rollen, Start-Trigger, GPU, Modell-IDs:** `deploy/runpod/pod-fleet.json`.
- **Repos, Modellrevisionen und VRAM-Schätzwerte:** `services/audiomonastry-ai-runtime/model_manifest.json`.
- **Pod-Start, Gewichts-/Hash-Prüfung, Kosten-Guard:** `scripts/runpod-pods.py`.

## Acht Pods und ihre residenten Gewichte

| # | Pod | Modellgewichte (genaue Manifest-IDs) | VRAM Modellschätzung | KV/Reserve | Gesamt geplant |
|---|---|---|---:|---:|---:|
| 1 | `brain` | `qwen3-30b-a3b-awq`, `qwen3-4b` | 29 GB | 0 GB | **29 GB** |
| 2 | `ears` | `whisper-large-v3`, `clap-music`, `mert-v2-330m`, `qwen2-audio-7b`, `pyannote-diarization`, `ast-audioset`, `essentia` | 26 GB | 0 GB | **26 GB** |
| 3 | `voice` | `qwen3-tts-17b`, `qwen3-tts-voicedesign`, `qwen3-tts-06b-base`, `moss-soundeffect-v2.0`, `acestep-v15-xl-base`, `acestep-v15-shared` | 39 GB | 0 GB | **39 GB** |
| 4 | `music` | `acestep-v15-xl-sft`, `acestep-v15-xl-turbo`, `acestep-5hz-lm-4b`, `acestep-v15-shared` | 31 GB | 6 GB | **37 GB** |
| 5 | `studio` | `sonicmaster`, `meanvc2`, `universr`, `scnet-xl-4stem`, `bs-roformer-sw-6stem`, `htdemucs-6s` | 36 GB | 0 GB | **36 GB** |
| 6 | `audio-brain` | `qwen3-omni-30b` | 28 GB | 0 GB | **28 GB** |
| 7 | `song` | `yue2-3b`, `music-flamingo` | 41 GB | 0 GB | **41 GB** |
| 8 | `vis` | keine KI-Gewichte; bestehende Visuals rendern/streamen | 8 GB geschätzte Renderlast | 0 GB | **8 GB** |

**Rechenregel:** 48 GB A40, abzüglich 6 GB Sicherheitsmarge = **42 GB planbare Nutzung** je Pod. Die Modell-Summen stammen aus `estimatedVRAM` des Manifests; `music` reserviert zusätzlich 6 GB für den vLLM-KV-Cache. `vis` benötigt laut Planung 8 GB für Rendering/NVENC. Diese Werte sind **keine GPU-Messungen** und garantieren keine OOM-freie gleichzeitige Inferenz. Höchste Summe: `song` 41 GB; vor Produktivbetrieb auf echter A40 vermessen.

## Ausführung und Grenzen

Alle sieben KI-Pods besitzen `startTrigger=always` (bei aktivierter Studiositzung); `vis` ist ebenfalls aktiviert. Das Startskript provisioniert nur auf **NVIDIA A40** und lehnt Abweichungen ab. `RP_POD_IMAGE` liefert das KI-Image, `RP_VIS_IMAGE` das Visual-Image. Authentisierung: `AI_POD_TOKEN` (mindestens 32 Zeichen). `pod_start.py` lädt gepinnte Gewichte aus R2 mit SHA-256-Prüfung; nur explizit gekennzeichnete `directRepo`-Modelle dürfen direkt aus ihrem gepinnten Repository geladen werden.

```bash
python3 scripts/runpod-pods.py plan
python3 scripts/runpod-pods.py weights-check
python3 scripts/runpod-pods.py up --yes --wait 900
python3 scripts/runpod-pods.py status
python3 scripts/runpod-pods.py down --yes
```

**Planpreis, nicht Livepreis:** 8 × 0,35 USD/h = 2,80 USD/h ≈ 2,576 €/h (Umrechnung 0,92). Harte Flottenobergrenze 6 €/h, pro Pod 1 USD/h. Verfügbarkeit und tatsächlich berechneten Preis vor und nach dem Start prüfen; bei fehlendem A40-Bestand **nicht** auf andere GPUs wechseln.

## Freigabe / Evidenz

1. Statische Prüfung: acht A40-Pods, Modell-IDs vorhanden, gepinnte Revisionen, keine alternativen Deploy-Konfigurationen, alle geplanten Speicherbudgets höchstens 42 GB.
2. Live-Prüfung: **acht echte Pods**, je `/ready`, echte Inferenz, maximaler VRAM inklusive Aktivierungen/KV-Cache, Kaltstart und 4-Nutzer-Last.
3. **Lizenzprüfung vor kommerziellem Betrieb:** insbesondere `mert-v2-330m` (CC-BY-NC), `yue2-3b` (CC-BY-NC), `music-flamingo` (spezielle NVIDIA-Lizenz), `bs-roformer-sw-6stem` (ungeklärt). Repo-Status ist keine kommerzielle Freigabe.

Dies ist eine **Architektur- und Gewichts-SSOT**, keine Aussage, dass die Pods derzeit laufen oder sämtliche Gewichte auf echter A40 erfolgreich geladen wurden.
