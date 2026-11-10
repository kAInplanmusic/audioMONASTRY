#!/usr/bin/env python3
"""Sequential RunPod Pod verification with ownership-safe cleanup and JSONL evidence.

This intentionally NEVER deletes pre-existing pods. It refuses to test a role
if an active pod already has the same name. All provisioning goes through the
canonical runpod-pods.py CLI, including its SSOT, weights and cost guards.
One role per invocation; external supervisor should enforce job timeout.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "scripts/runpod-pods.py"
SPEC = importlib.util.spec_from_file_location("runpod_pods", CLI)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)
LOG_DIR = ROOT / "deploy" / "logs"
VALID_ROLES = ("brain", "ears", "voice", "music", "studio", "audio-brain", "song", "vis")

def log(logfile: Path, event: str, **values: object) -> None:
    record = {"ts": datetime.now(timezone.utc).isoformat(), "event": event, **values}
    with logfile.open("a", encoding="utf8") as fd:
        fd.write(json.dumps(record, ensure_ascii=False) + "\n")
        fd.flush()
        os.fsync(fd.fileno())
    print(json.dumps(record, ensure_ascii=False), flush=True)

def run(role: str, fixture: Path | None, max_seconds: int, logfile: Path) -> int:
    fleet = mod.load_fleet()
    verification_id = uuid.uuid4().hex[:10]
    expected_name = fleet["namePrefix"] + "verify-" + role.replace("-", "") + "-" + verification_id
    before = {p["id"]: p for p in mod.fleet_pods(fleet) if p.get("desiredStatus") != "TERMINATED"}
    if any(p.get("name") == expected_name for p in before.values()):
        log(logfile, "blocked_existing_pod", role=role)
        return 4
    created = set()
    try:
        payload = None
        if fixture is not None:
            if not fixture.is_file():
                log(logfile, "blocked_fixture_missing", role=role)
                return 4
            payload = json.loads(fixture.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or not isinstance(payload.get("input"), dict):
                log(logfile, "blocked_invalid_fixture", role=role)
                return 4
        log(logfile, "provision_begin", role=role, testPodName=expected_name)
        try:
            p = subprocess.run([sys.executable, str(CLI), "up", "--yes", "--only", role,
                              "--verification-id", verification_id, "--wait", str(max_seconds)],
                               cwd=ROOT, capture_output=True, text=True, timeout=max_seconds + 180)
        except subprocess.TimeoutExpired:
            log(logfile, "provision_timeout", role=role)
            return 4
        # No secret-bearing output persisted in the evidence log.
        log(logfile, "provision_exit", role=role, code=p.returncode)
        after = {p["id"]: p for p in mod.fleet_pods(fleet) if p.get("desiredStatus") != "TERMINATED"}
        created = {pid for pid,pod in after.items() if pid not in before and pod.get("name") == expected_name}
        if len(created) != 1:
            log(logfile, "blocked_pod_identity", role=role, newIds=len(created))
            return 4
        pod_id = next(iter(created))
        if p.returncode:
            log(logfile, "blocked_provision_failed", role=role)
            return 4
        ok, state = mod.ready(pod_id, int(fleet["port"]), os.environ.get("AI_POD_TOKEN",""))
        log(logfile, "ready_probe", role=role, passed=ok, state=state)
        if not ok:
            return 4
        token = os.environ.get("AI_POD_TOKEN","")
        ready_url = mod.proxy_url(pod_id, int(fleet["port"])) + "/ready"
        status, raw = mod.transport("GET", ready_url,
                                   {"Authorization": f"Bearer {token}"}, None, 15)
        if status != 200:
            log(logfile,"blocked_proof_not_available",role=role,httpStatus=status)
            return 4
        proof = json.loads(raw.decode()).get("modelProof") or {}
        expected = sorted(set(next(p for p in ([*fleet["pods"],fleet["visPod"]])
                                   if p["role"] == role)["models"]) -
                          {"acestep-v15-shared","acestep-5hz-lm-4b"})
        attested = sorted(proof.get("verified") or [])
        verified = proof.get("gpuVerified") is True and expected == attested
        log(logfile, "model_proof", role=role, passed=verified,
            attestedModels=attested, expectedModels=expected)
        if not verified:
            return 4
        if payload is None:
            # Startup probe executes EVERY direct model; no extra API task needed.
            return 0
        url = mod.proxy_url(pod_id, int(fleet["port"])) + "/runsync"
        status, raw = mod.transport("POST", url,
            {"Authorization": f"Bearer {token}", "Content-Type":"application/json"},
            json.dumps(payload).encode(), min(120, max_seconds))
        try:
            response = json.loads(raw.decode())
        except (ValueError, UnicodeDecodeError):
            response = {}
        success = status == 200 and response.get("status") == "COMPLETED" and response.get("output",{}).get("status") == "success"
        log(logfile,"inference_probe",role=role,httpStatus=status,passed=success,
            runpodStatus=response.get("status"),outputStatus=(response.get("output") or {}).get("status"))
        return 0 if success else 4
    finally:
        # Recover newly created pod IDs even if an exception occurs after API creation.
        try:
            now = {p["id"]: p for p in mod.fleet_pods(fleet) if p.get("desiredStatus") != "TERMINATED"}
            created |= {pid for pid,pod in now.items() if pid not in before and pod.get("name") == expected_name}
            for pid in sorted(created):
                status,_ = mod.api("DELETE", f"/pods/{pid}")
                log(logfile, "cleanup_delete", role=role, podId=pid, httpStatus=status,
                    accepted=status in (200,202,204,404))
                # Provider termination is eventually consistent. Never treat a
                # DELETE 202 as evidence that billing actually stopped.
                terminated = False
                for attempt in range(8):
                    check = {p["id"]:p for p in mod.fleet_pods(fleet)
                             if p.get("desiredStatus") != "TERMINATED"}
                    if pid not in check:
                        terminated = True
                        break
                    time.sleep(3)
                log(logfile, "cleanup_verified", role=role, podId=pid,
                    terminated=terminated, testPodName=expected_name)
                if not terminated:
                    raise RuntimeError("owned test pod termination not provider-confirmed")
        except Exception as exc:
            log(logfile, "cleanup_unconfirmed", role=role, error=type(exc).__name__)
            raise

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", choices=VALID_ROLES, required=True)
    parser.add_argument("--fixture", type=Path, help="optional extra DAW contract job; /ready attests every model")
    parser.add_argument("--max-seconds", type=int, default=900)
    parser.add_argument("--yes-billable", action="store_true")
    parser.add_argument("--max-spend-eur",type=float,default=3.0,
                        help="estimated per-pod time-budget cap, before starting a GPU")
    args = parser.parse_args()
    if not args.yes_billable:
        print("Refusing billable verification without --yes-billable", file=sys.stderr)
        return 3
    if args.max_seconds < 60 or args.max_seconds > 1800:
        print("max-seconds must be between 60 and 1800", file=sys.stderr)
        return 2
    if not 0 < args.max_spend_eur <= 8:
        parser.error("--max-spend-eur must be within (0,8]")
    fleet = mod.load_fleet()
    role_def = next(x for x in ([*fleet["pods"],fleet["visPod"]]) if x["role"]==args.role)
    estimated_usd = mod.gpu_details(fleet,role_def)["usdPerHour"]
    estimated_eur = mod.gross_eur(fleet,float(estimated_usd)) * (args.max_seconds / 3600)
    if estimated_eur > args.max_spend_eur:
        print("Refusing pod: estimated test duration exceeds per-run spending cap", file=sys.stderr)
        return 4
    LOG_DIR.mkdir(parents=True,exist_ok=True)
    logpath = LOG_DIR / ("runpod-live-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8] + ".jsonl")
    log(logpath, "verification_start", role=args.role, artifact=str(logpath))
    try:
        code = run(args.role, args.fixture, args.max_seconds, logpath)
        log(logpath, "verification_end", role=args.role, code=code)
        return code
    except Exception as exc:
        log(logpath, "verification_failed", role=args.role, error=type(exc).__name__)
        return 4

if __name__ == "__main__":
    raise SystemExit(main())
