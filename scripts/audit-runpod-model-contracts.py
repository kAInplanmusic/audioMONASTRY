#!/usr/bin/env python3
"""Offline 22-entry RunPod model-to-task audit.

STATIC EVIDENCE ONLY. Neither model loading nor CUDA/R2/quality is asserted.
Exit 4 if any active direct model has a known missing handler or invalid pin.
This audit is intentionally strict: a green CI does not replace GPU tests.
"""
from __future__ import annotations
import json
from pathlib import Path
import re
import sys

ROOT=Path(__file__).resolve().parent.parent
RUNTIME=ROOT/"services/audiomonastry-ai-runtime"
fleet=json.loads((ROOT/"deploy/runpod/pod-fleet.json").read_text())
manifest=json.loads((RUNTIME/"model_manifest.json").read_text())
models={m["id"]:m for m in manifest["models"]}
pods=[*fleet["pods"],fleet["visPod"]]
hex40=re.compile(r"^[0-9a-f]{40}$")

# Mapping is an audit contract, NOT an assertion of live GPU success.
# Direct task exposure must be backed by a concrete code path in handlers.py.
routes={
"qwen38-27b-fp8":("llm","handlers_fleet2026.py","brain_infer"),
"moss-music-8b-instruct":("understand","handlers_fleet2026.py","music_understand"),
"clap-music":("embed","handlers.py","hf_embed"),
"beat-this":("analyze","handlers_ears.py","beat_this_track"),
"songformer":("analyze","handlers_ears.py","songformer_structure"),
"dsp-analysis":("analyze","handlers_fleet2026.py","dsp_analyze"),
"basic-pitch":("analyze","handlers_fleet2026.py","basic_pitch_midi"),
"qwen3-tts-17b":("tts","handlers.py","qwen3_tts"),
"qwen3-tts-voicedesign":("tts","handlers_fleet2026.py","voice_design"),
"moss-soundeffect-v2.0":("generate","handlers_voice.py","moss_soundeffect"),
"acestep-v15-xl-base":("song","handlers_voice.py","acestep_context_task"),
"acestep-v15-xl-turbo":("song","handlers_runpod.py","acestep_generate"),
"sonicmaster":("master","handlers_sonicmaster.py","sonicmaster_master"),
"bs-roformer-sw-6stem":("stem.separate","handlers_stems.py","msst_stem_separate"),
"mvsep-mega-53":("stem.separate","handlers_stems.py","mvsep_mega53_separate"),
"mel-roformer-bve":("stem.separate","handlers_stems.py","roformer_pair_separate"),
"qwen3-4b":("gui.execute","handlers_fleet2026.py","gui_execute"),
"yue2-3b":("song","handlers_fleet2026.py","yue2_song"),
"universr":("upsample","handlers_fleet2026.py","universr_enhance"),
"mel-roformer-dereverb":("stem.separate","handlers_stems.py","roformer_pair_separate"),
}
dependencies={"acestep-v15-shared":"shared ACE-Step encoders/VAE asset, not independent inference",
              "acestep-5hz-lm-4b":"ACE-Step LM/planning asset, not independent inference"}
stems=(RUNTIME/"handlers_stems.py").read_text()
from_text=(RUNTIME/"handlers.py").read_text()
errors=[]
entries=[]
seen=set()
for pod in pods:
    for mid in pod["models"]:
        model=models.get(mid)
        if model is None:
            errors.append(f"{pod['role']}: model {mid} absent")
            continue
        seen.add(mid)
        raw_task=model["task"]
        task=raw_task[6:] if raw_task.startswith("audio.") else raw_task
        reasons=[]
        kind="dependency" if mid in dependencies else ("cpu-tool" if model.get("revision")=="cpu-only" else "direct")
        if kind=="dependency":
            state="DEPENDENCY_NOT_STANDALONE"
            reasons.append(dependencies[mid])
        else:
            route=routes.get(mid)
            if not route:
                reasons.append("no explicit model-to-handler contract")
            elif route[0]!=task:
                reasons.append(f"task mismatch: manifest {task} != route {route[0]}")
            elif route[1] is None:
                reasons.append("no concrete inference handler implemented")
            else:
                src=(RUNTIME/route[1]).read_text()
                if not re.search(r"^def\s+"+re.escape(route[2])+r"\s*\(",src,re.M):
                    reasons.append(f"handler {route[2]} missing in {route[1]}")
                if task not in from_text and task not in ("analyze","understand","tts"):
                    reasons.append(f"dispatcher does not reference task {task}")
        rev=model.get("revision","")
        if rev!="cpu-only" and not hex40.fullmatch(rev):
            reasons.append("revision not immutable 40-char SHA")
        if mid=="mel-roformer-dereverb":
            reasons.append("dereverb config SHA256 not pinned in stem loader")
        if mid=="mel-roformer-bve":
            reasons.append("BVE config SHA256 not pinned; 40-char HF revision required")
        if mid=="mvsep-mega-53" and "c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f" not in stems:
            reasons.append("MVSEP official checkpoint digest missing from adapter")
        if mid=="sonicmaster" and '"master": _fleet_master' not in from_text:
            reasons.append("audio.master is not registered in HANDLERS")
        state=("BLOCKED_STATIC" if reasons else "ROUTED_NOT_GPU_VERIFIED") if kind!="dependency" else state
        if state=="BLOCKED_STATIC":
            errors.append(f"{pod['role']}/{mid}: "+ "; ".join(reasons))
        entries.append({"pod":pod["role"],"model":mid,"kind":kind,"task":raw_task,"status":state,"findings":reasons})
for mid in sorted(set(models)-seen):
    errors.append(f"orphan model in manifest: {mid}")
unique={m["model"]:m for m in entries}
if len(unique)!=22:
    errors.append(f"expected 22 unique entries, got {len(unique)}")
if len(models)!=22:
    errors.append(f"manifest has {len(models)} entries, not 22")
print(json.dumps({"staticComplete":not errors,"gpuVerified":False,"r2Verified":False,
                  "uniqueModels":len(unique),"assignments":len(entries),
                  "blocked":[x["model"] for x in unique.values() if x["status"]=="BLOCKED_STATIC"],
                  "issues":errors,"models":list(unique.values())},
                 ensure_ascii=False,indent=2))
sys.exit(4 if errors else 0)
