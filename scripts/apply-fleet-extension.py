#!/usr/bin/env python3
"""Erweitert Manifest + pod-fleet.json um die Struktur A (studio), B (audio-brain), C (song).

Idempotent: fuehrt jedes Modell/Rolle/Pod nur ein, wenn die ID noch fehlt.
Aufruf: python3 scripts/apply-fleet-extension.py [--dry-run]
"""
from __future__ import annotations
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "services" / "audiomonastry-ai-runtime" / "model_manifest.json"
FLEET = ROOT / "deploy" / "runpod" / "pod-fleet.json"

# ---------------------------------------------------------------- neue Modelle
# directRepo=True: Gewichte werden NICHT nach R2 gespiegelt, der Pod laedt sie
# beim Start direkt von HuggingFace (Betreiber-Entscheid 2026-11-08: R2 nicht
# zumuellen). Die Revision bleibt trotzdem gepinnt, damit der Lauf reproduzierbar ist.
NEW_MODELS = [
    {
        "id": "sonicmaster",
        "repository": "amaai-lab/SonicMaster",
        "revision": "93c7fa73c4dd446c9e656af34524b5f6a416afda",
        "task": "audio.master",
        "framework": "custom",
        "estimatedVRAM": 8,
        "estimatedRAM": 12,
        "loadPriority": 3,
        "preload": True,
        "loadClass": "CORE",
        "quantization": "fp16",
        "dependencies": ["torch", "diffusers", "transformers"],
        "inputFormats": ["wav"],
        "outputFormats": ["wav"],
        "maxDuration": 300,
        "concurrency": 1,
        "timeout": 600,
        "license": "Apache-2.0",
        "directRepo": True,
        "note": "Audio-Reparatur + Auto-Mastering per Textsteuerung (EQ/Dynamik/Reverb/Amplitude/Stereo), Flow-Matching, 863M. Direkt vom HF-Repo (directRepo), kein R2-Spiegel.",
    },
    {
        "id": "meanvc2",
        "repository": "ASLP-lab/MeanVC2",
        "revision": "39cdd19522fe896c227da691314d9a0e3b995486",
        "task": "voice.convert",
        "framework": "custom",
        "estimatedVRAM": 2,
        "estimatedRAM": 4,
        "loadPriority": 3,
        "preload": True,
        "loadClass": "CORE",
        "quantization": "fp16",
        "dependencies": ["torch"],
        "inputFormats": ["wav"],
        "outputFormats": ["wav"],
        "maxDuration": 120,
        "concurrency": 2,
        "timeout": 300,
        "license": "Apache-2.0",
        "directRepo": True,
        "note": "Streaming Voice-Conversion, 18M, 110 ms Latenz, RTF < 0.633 auf 1 CPU-Kern. Direkt vom HF-Repo.",
    },
    {
        "id": "universr",
        "repository": "woongzip1/universr-audio",
        "revision": "1c3294844285af851b6ffa56cbde4e43cd41fc2b",
        "task": "audio.upsample",
        "framework": "custom",
        "estimatedVRAM": 4,
        "estimatedRAM": 8,
        "loadPriority": 3,
        "preload": True,
        "loadClass": "CORE",
        "quantization": "fp16",
        "dependencies": ["torch"],
        "inputFormats": ["wav"],
        "outputFormats": ["wav"],
        "maxDuration": 300,
        "concurrency": 1,
        "timeout": 600,
        "license": "CC-BY-4.0",
        "directRepo": True,
        "note": "Audio-Super-Resolution 8 kHz -> 48 kHz (ICASSP 2026). Direkt vom HF-Repo.",
    },
    {
        "id": "scnet-xl-4stem",
        "repository": "Aname-Tommy/Huge-SCNet-4stems",
        "revision": "1d9ae5091dad91ae675667505d6ed664a70fc168",
        "task": "stem.separate",
        "framework": "custom",
        "estimatedVRAM": 8,
        "estimatedRAM": 12,
        "loadPriority": 3,
        "preload": True,
        "loadClass": "CORE",
        "quantization": "fp32",
        "dependencies": ["torch", "msst"],
        "inputFormats": ["wav"],
        "outputFormats": ["wav"],
        "maxDuration": 600,
        "concurrency": 1,
        "timeout": 900,
        "license": "Apache-2.0",
        "directRepo": True,
        "note": "Kommerziell saubere 4-Stem-Alternative (SCNet XL). Direkt vom HF-Repo.",
    },
    {
        "id": "yue2-3b",
        "repository": "m-a-p/YuE2-3B",
        "revision": "8f24312f187763b9854adeec87e437e2b03bbff1",
        "task": "song",
        "framework": "custom",
        "estimatedVRAM": 24,
        "estimatedRAM": 32,
        "loadPriority": 3,
        "preload": True,
        "loadClass": "CORE",
        "quantization": "bf16",
        "dependencies": ["torch", "transformers"],
        "inputFormats": ["text"],
        "outputFormats": ["wav"],
        "maxDuration": 600,
        "concurrency": 1,
        "timeout": 1200,
        "license": "CC-BY-NC-4.0",
        "directRepo": True,
        "note": "Frontier-Songgenerierung (WildSongBench 6.96 vs Suno v6 6.56), editierbare Scores, 48 kHz stereo. Nur R&D/Testbetrieb (NC). Direkt vom HF-Repo.",
    },
    {
        "id": "music-flamingo",
        "repository": "nvidia/music-flamingo-hf",
        "revision": "e560c33247f20e2f735c87ce9adebb8e53befe69",
        "task": "audio.understand",
        "framework": "transformers",
        "estimatedVRAM": 24,
        "estimatedRAM": 32,
        "loadPriority": 3,
        "preload": True,
        "loadClass": "CORE",
        "quantization": "bf16",
        "dependencies": ["torch", "transformers"],
        "inputFormats": ["audio", "text"],
        "outputFormats": ["json"],
        "maxDuration": 600,
        "concurrency": 1,
        "timeout": 600,
        "license": "other (nicht-kommerziell, NVIDIA-Lizenz)",
        "directRepo": True,
        "note": "Musik-Reasoning/Critique: Harmonie-, Struktur-, Mix-Analyse, Captioning. 8.27B, ~20-24 GB bf16. Nur nicht-kommerziell. Direkt vom HF-Repo.",
    },
    {
        "id": "qwen3-omni-30b",
        "repository": "Qwen/Qwen3-Omni-30B-A3B-Instruct",
        "revision": "26291f793822fb6be9555850f06dfe95f2d7e695",
        "task": "audio.understand",
        "framework": "transformers",
        "estimatedVRAM": 20,
        "estimatedRAM": 32,
        "loadPriority": 3,
        "preload": True,
        "loadClass": "CORE",
        "quantization": "int4",
        "dependencies": ["torch", "transformers"],
        "inputFormats": ["audio", "text", "image"],
        "outputFormats": ["json"],
        "maxDuration": 1800,
        "concurrency": 1,
        "timeout": 600,
        "license": "other (Qwen-Lizenz)",
        "directRepo": True,
        "note": "Multimodales Audio-LLM (30B MoE, 3B aktiv), ~18-20 GB int4, 30-min-Audio-Kontext. Ersetzt qwen2-audio-7b auf eigenem Pod. Direkt vom HF-Repo.",
    },
]

# ---------------------------------------------------------------- neue Rollen
NEW_ROLES = {
    "studio": {
        "label": "Postproduktion: Audio-Reparatur, Mastering, Voice-Conversion, Super-Resolution",
        "gpuId": "NVIDIA GeForce RTX 4090",
        "gpuCount": 1,
        "vramBudgetGb": 48,
        "vramSafetyMarginGb": 6,
        "maxConcurrentInference": 1,
        "preloadModels": ["sonicmaster", "meanvc2", "universr", "scnet-xl-4stem"],
        "models": ["sonicmaster", "meanvc2", "universr", "scnet-xl-4stem", "beat-this"],
        "idleTimeoutSeconds": 120,
    },
    "audioBrain": {
        "label": "Audio-LLM: Qwen3-Omni + Music Flamingo (Musik-Reasoning, Critique)",
        "gpuId": "NVIDIA GeForce RTX 4090",
        "gpuCount": 1,
        "vramBudgetGb": 48,
        "vramSafetyMarginGb": 6,
        "maxConcurrentInference": 1,
        "preloadModels": ["qwen3-omni-30b", "music-flamingo"],
        "models": ["qwen3-omni-30b", "music-flamingo"],
        "idleTimeoutSeconds": 120,
    },
    "song": {
        "label": "Song-Generierung: YuE2 (Frontier-Qualitaet)",
        "gpuId": "NVIDIA GeForce RTX 4090",
        "gpuCount": 1,
        "vramBudgetGb": 48,
        "vramSafetyMarginGb": 6,
        "maxConcurrentInference": 1,
        "preloadModels": ["yue2-3b"],
        "models": ["yue2-3b"],
        "idleTimeoutSeconds": 120,
    },
}

# ---------------------------------------------------------------- neue Pods
NEW_PODS = [
    {
        "role": "studio",
        "label": "Postproduktion: Audio-Reparatur, Mastering, Voice-Conversion, Super-Resolution",
        "aiRole": "studio",
        "startTrigger": "aiGeneration",
        "models": ["sonicmaster", "meanvc2", "universr", "scnet-xl-4stem"],
        "gpuPool": "24gb-nvenc",
        "gpuPoolId": "NVIDIA GeForce RTX 4090",
        "containerDiskGb": 120,
        "covers": ["studio"],
        "target": {
            "models": ["sonicmaster", "meanvc2", "universr", "scnet-xl-4stem", "beat-this"],
            "vramGb": 22,
            "params": {"dtype": "fp16", "directRepo": "Gewichte werden beim Start direkt von HuggingFace geladen, kein R2-Spiegel"},
            "retireAfter": {},
            "note": "Neu 2026-11-08 (Variante A): deckt Audio-Reparatur, Mastering, Voice-Conversion, Super-Resolution ab - keine dieser Faehigkeiten hat ein bestehender Pod. Alle Modelle kommerziell nutzbar (Apache/CC-BY).",
        },
        "startOrder": 6,
    },
    {
        "role": "audio-brain",
        "label": "Audio-LLM: Qwen3-Omni + Music Flamingo (Musik-Reasoning, Critique)",
        "aiRole": "audioBrain",
        "startTrigger": "always",
        "models": ["qwen3-omni-30b", "music-flamingo"],
        "gpuPool": "48gb",
        "gpuPoolId": "NVIDIA GeForce RTX 4090",
        "containerDiskGb": 150,
        "covers": ["audioBrain"],
        "target": {
            "models": ["qwen3-omni-30b", "music-flamingo"],
            "vramGb": 44,
            "params": {"dtype": "bf16/int4", "directRepo": "Gewichte direkt von HuggingFace"},
            "retireAfter": {},
            "note": "Neu 2026-11-08 (Variante B): Qwen3-Omni (30B MoE int4, ~20 GB) + Music Flamingo (8.27B bf16, ~24 GB). Entlastet ears (dort faellt qwen2-audio-7b weg). Beide Lizenzen nur nicht-kommerziell -> Testbetrieb.",
        },
        "startOrder": 7,
    },
    {
        "role": "song",
        "label": "Song-Generierung: YuE2 (Frontier-Qualitaet, besser als Suno v6)",
        "aiRole": "song",
        "startTrigger": "aiGeneration",
        "models": ["yue2-3b"],
        "gpuPool": "48gb",
        "gpuPoolId": "NVIDIA GeForce RTX 4090",
        "containerDiskGb": 120,
        "covers": ["song"],
        "target": {
            "models": ["yue2-3b"],
            "vramGb": 26,
            "params": {"dtype": "bf16", "directRepo": "Gewichte direkt von HuggingFace"},
            "retireAfter": {},
            "note": "Neu 2026-11-08 (Variante C): YuE2-3B, WildSongBench 6.96 vs Suno v6 6.56, editierbare Scores, 48 kHz stereo. CC-BY-NC-4.0 -> nur R&D/Testbetrieb.",
        },
        "startOrder": 8,
    },
]


def main() -> int:
    dry = "--dry-run" in sys.argv

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    existing_ids = {m["id"] for m in manifest["models"]}
    added_models = []
    for m in NEW_MODELS:
        if m["id"] not in existing_ids:
            manifest["models"].append(m)
            added_models.append(m["id"])
    for role, cfg in NEW_ROLES.items():
        if role not in manifest["roles"]:
            manifest["roles"][role] = cfg

    fleet = json.loads(FLEET.read_text(encoding="utf-8"))
    existing_roles = {p["role"] for p in fleet["pods"]}
    added_pods = []
    for pod in NEW_PODS:
        if pod["role"] not in existing_roles:
            fleet["pods"].append(pod)
            added_pods.append(pod["role"])

    print(f"Manifest: +{len(added_models)} Modelle {added_models}")
    print(f"Manifest: +{sum(1 for r in NEW_ROLES if r in manifest['roles'])} Rollen")
    print(f"Fleet: +{len(added_pods)} Pods {added_pods}")

    if dry:
        print("DRY-RUN: nichts geschrieben.")
        return 0
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    FLEET.write_text(json.dumps(fleet, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("Geschrieben.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
