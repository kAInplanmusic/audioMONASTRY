#!/usr/bin/env python3
"""Zero-rental preflight for audioMONASTRY's eight Vast.ai GPU roles.

No GPU allocations, writes to R2, secrets in reports or destructive actions.
Use --check-r2 for read-only signed HEAD/GET of every required production weight.
Use --check-vast to verify live offer/account readiness (no rentals).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ROLES = {"brain", "ears", "voice", "music", "studio", "audio-brain", "song", "vis"}


def audit(root: Path = ROOT) -> dict:
    policy = json.loads((root / "deploy/gpu-provider.json").read_text())
    fleet = json.loads((root / "deploy/gpu/pod-fleet.json").read_text())
    manifest = json.loads((root / "services/audiomonastry-ai-runtime/model_manifest.json").read_text())
    candidates = json.loads((root / "deploy/gpu/frontier-candidates.json").read_text())
    pods = fleet["pods"] + [fleet["visPod"]]
    ids = [p["role"] for p in pods]
    models = {m["id"]: m for m in manifest["models"]}
    missing = sorted(set(mid for p in pods for mid in p["models"]) - models.keys())
    invalid = sorted(m["id"] for m in manifest["models"] if
                     not (re.fullmatch(r"[0-9a-f]{40}", str(m.get("revision") or ""))
                          or str(m.get("revision")) in ("cpu-only", "system")))
    problems = []
    if policy.get("provider") != "vast":
        problems.append("active GPU provider is not Vast.ai")
    if len(ids) != 8 or set(ids) != ROLES or len(ids) != len(set(ids)):
        problems.append("eight-role assignment is incomplete or duplicated")
    if missing:
        problems.append("production model IDs missing in manifest: " + ", ".join(missing))
    if invalid:
        problems.append("unpinned manifest entries: " + ", ".join(invalid))
    if policy.get("maxTotalEurPerHour", 99) > 8:
        problems.append("GPU hourly cap exceeds 8 EUR")
    if policy.get("promoteOnlyAfterReadiness") is not True:
        problems.append("readiness gating disabled")
    if (root / ".github/workflows/hf-endpoint.yml").exists():
        problems.append("unwanted billed HF endpoint workflow still present")
    if (root / "services/audiomonastry-ai-runtime/hf_manage_endpoint.py").exists():
        problems.append("unwanted HF endpoint provisioning manager still present")
    return {
        "status": "pass" if not problems else "blocked",
        "provider": policy["provider"],
        "gpuHourlyCapEUR": policy["maxTotalEurPerHour"],
        "idleDeleteMinutes": 30,
        "gpuAction": "dry-run-only",
        "modelSource": "services/audiomonastry-ai-runtime/model_manifest.json",
        "productionModelIds": len(models),
        "candidateModelIds": len(candidates["models"]),
        "candidatePromotion": "disabled-until-handler-and-licence-validation",
        "roles": {p["role"]: list(p["models"]) for p in pods},
        "problems": problems,
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--check-r2", action="store_true", help="read-only verify eight roles' required R2 weights")
    p.add_argument("--check-vast", action="store_true", help="read-only Vast capacity and account preflight")
    args = p.parse_args(argv)
    report = audit()
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if report["problems"]:
        return 2
    for enabled, cmd in (
        (args.check_r2, [sys.executable, "scripts/gpu-pods.py", "weights"]),
        (args.check_vast, [sys.executable, "scripts/gpu-pods.py", "preflight"]),
    ):
        if enabled:
            result = subprocess.run(cmd, cwd=ROOT, check=False)
            if result.returncode:
                return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
