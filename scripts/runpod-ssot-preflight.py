#!/usr/bin/env python3
"""Offline fail-closed SSOT preflight for audioMONASTRY RunPod fleet.

This is STATIC validation only: does not claim Hugging Face revisions, hashes,
images, R2 archives, loader compatibility or GPU inference have been verified.
"""
from __future__ import annotations
import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FLEET = ROOT / "deploy/runpod/pod-fleet.json"
MANIFEST = ROOT / "services/audiomonastry-ai-runtime/model_manifest.json"
ROLES = ("brain", "ears", "voice", "music", "studio", "audio-brain", "song", "vis")
REV = re.compile(r"^[a-f0-9]{40}$")
MODEL_SHORT_REV = re.compile(r"^[a-f0-9]{7,39}$")

def check(fleet: dict, manifest: dict) -> dict:
    errors, warnings = [], []
    pods = [*fleet.get("pods", []), fleet.get("visPod", {})]
    models = {m["id"]: m for m in manifest.get("models", [])}
    if len(models) != len(manifest.get("models", [])):
        errors.append("duplicate model IDs in manifest")
    if tuple(p.get("role") for p in pods) != ROLES:
        errors.append("active role order/count diverges from canonical eight roles")
    if not fleet.get("visPod", {}).get("enabled"):
        errors.append("visPod must be enabled by SSOT")
    if len({p.get("aiRole") for p in pods}) != len(pods):
        errors.append("duplicate manifest aiRole mappings")
    budget = fleet.get("budget", {})
    if float(budget.get("maxEurPerHour", -1)) != 11:
        errors.append("fleet hard limit must be exactly 11 EUR/h")
    pool_def = fleet.get("gpuPools", {})
    rows = []
    total_usd = 0.0
    for pod in pods:
        name = pod.get("role", "<unknown>")
        role_manifest = manifest.get("roles", {}).get(pod.get("aiRole"))
        ids = pod.get("models", [])
        if not ids or len(ids) != len(set(ids)):
            errors.append(f"{name}: empty or duplicate models")
        if role_manifest is None:
            errors.append(f"{name}: aiRole missing from manifest")
        elif role_manifest.get("models") != ids:
            errors.append(f"{name}: manifest role models do not match fleet model order")
        if role_manifest and role_manifest.get("gpuId") != pod.get("gpuPoolId"):
            errors.append(f"{name}: manifest primary GPU differs from fleet")
        priority = pod.get("gpuPriority", [])
        gpu_pool = pool_def.get(pod.get("gpuPool"), [])
        by_id = {g["id"]: g for g in gpu_pool}
        if not priority or priority[0] != pod.get("gpuPoolId"):
            errors.append(f"{name}: primary GPU not first priority")
        if not set(priority).issubset(by_id):
            errors.append(f"{name}: priority GPUs not in declared pool")
        if not set(priority).issubset(set(budget.get("allowedGpus", []))):
            errors.append(f"{name}: GPU outside budget allowlist")
        demand = sum(float(models[i].get("estimatedVRAM", 0)) for i in ids if i in models)
        extra = float(pod.get("vramReserveGb", 0)) + float(pod.get("vramSafetyMarginGb", 0))
        for mid in ids:
            if mid not in models:
                errors.append(f"{name}: missing model {mid}")
                continue
            m = models[mid]
            rev = str(m.get("revision", ""))
            if rev == "cpu-only":
                if float(m.get("estimatedVRAM", 0)) != 0:
                    errors.append(f"{mid}: cpu-only model has nonzero GPU estimate")
            elif not REV.fullmatch(rev):
                if MODEL_SHORT_REV.fullmatch(rev):
                    errors.append(f"{mid}: short revision ({rev}); full immutable commit required")
                else:
                    errors.append(f"{mid}: invalid/unpinned revision {rev!r}")
            if not m.get("repository") or not m.get("task") or not m.get("framework"):
                errors.append(f"{mid}: incomplete repository/task/framework contract")
            if m.get("trustRemoteCode"):
                warnings.append(f"{mid}: remote custom code requires pinned dependency/security review")
            if not m.get("dependencies"):
                warnings.append(f"{mid}: explicit dependency lock unresolved")
        for gpu_id in priority:
            gpu = by_id.get(gpu_id)
            if gpu and demand + extra > float(gpu["vramGb"]):
                errors.append(f"{name}: {gpu_id} {gpu['vramGb']}GB < estimated demand {demand+extra:g}GB")
        primary = by_id.get(pod.get("gpuPoolId"))
        if primary:
            total_usd += float(primary["usdPerHour"])
        rows.append({"role":name,"models":ids,"gpu":pod.get("gpuPoolId"),
                     "estimatedModelGb":demand,"reserveAndMarginGb":extra,
                     "primaryGpuGb":primary.get("vramGb") if primary else None})
    gross = total_usd * float(budget.get("usdToEur", 0)) * float(budget.get("taxMultiplier", 0)) + float(budget.get("unbilledEurPerHourReserve", 0))
    if gross > float(budget.get("maxEurPerHour", 0)):
        errors.append(f"estimated fleet costs {gross:.2f} EUR/h, above hard cap")
    warnings.extend([
        "STATIC ONLY: upstream revisions, full checkpoint SHA256 and licenses NOT network-verified",
        "STATIC ONLY: model loaders, dependency locks, images and GPU peaks NOT runtime-tested",
        "STATIC ONLY: R2 object existence and RunPod availability/prices NOT queried",
    ])
    return {"ok":not errors,"errors":errors,"warnings":warnings,"roles":rows,
            "estimatedUsdHour":round(total_usd,4),"estimatedGrossEurHour":round(gross,4),
            "gpuVerified":False,"weightsVerified":False,"loaderVerified":False}

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    report = check(json.loads(FLEET.read_text()), json.loads(MANIFEST.read_text()))
    if args.json:
        print(json.dumps(report,indent=2,ensure_ascii=False))
    else:
        for msg in report["errors"]: print("ERROR:",msg)
        for msg in report["warnings"]: print("UNVERIFIED:",msg)
        print(f"Static SSOT preflight: {'PASS' if report['ok'] else 'FAIL'}, {len(report['roles'])} roles, estimated {report['estimatedGrossEurHour']:.2f} EUR/h")
    return 0 if report["ok"] else 4

if __name__ == "__main__":
    sys.exit(main())
