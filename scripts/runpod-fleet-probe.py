#!/usr/bin/env python3
"""Read-only RunPod v2 auth, fleet-cost and GPU-catalog preflight.

Intended to run in CI with the existing RP_API_KEY secret. Never emits the key.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request


def request(path):
    key = os.environ.get("RP_API_KEY") or os.environ.get("RUNPOD_API_KEY")
    if not key:
        raise RuntimeError("RunPod API secret is missing")
    req = urllib.request.Request("https://api.runpod.io/v2" + path,
                                 headers={"Authorization": "Bearer " + key, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"RunPod read-only request failed: HTTP {exc.code}") from None


def probe():
    fleet = json.loads(Path("deploy/runpod/pod-fleet.json").read_text())
    def collection(path, field):
        rows, seen = [], set()
        while True:
            data = request(path)
            if not isinstance(data.get(field), list):
                raise RuntimeError("Unexpected RunPod list response")
            rows.extend(data[field])
            page = data.get("pagination", {})
            if not page.get("hasNextPage"):
                return rows
            cursor = page.get("nextCursor")
            if not cursor or cursor in seen:
                raise RuntimeError("Invalid RunPod pagination")
            seen.add(cursor)
            base = path.split("&cursor=", 1)[0].split("?cursor=", 1)[0]
            path = base + ("&" if "?" in base else "?") + urllib.parse.urlencode({"cursor": cursor})
    pods = collection("/pods?includeClusterPods=true", "pods")
    # Do not publish environment values, proxy/SSH addresses or registry secrets.
    active = [p for p in pods if p.get("status") not in ("EXITED", "TERMINATED")]
    rates = [float(p["cost"]) for p in active]
    if any(not math.isfinite(rate) or rate < 0 for rate in rates):
        raise RuntimeError("Invalid existing Pod rate")
    rate = sum(rates)
    budget = fleet["budget"]
    catalog = request("/catalog/gpus?include=AVAILABILITY&product=POD")
    prices = {g["id"]: g.get("price", {}).get("serverless") for g in catalog.get("gpus", [])}
    endpoints = collection("/serverless", "endpoints")
    workers, unknown_worker_cost = [], False
    serverless_rate = 0.0
    for endpoint in endpoints:
        for worker in request("/serverless/" + endpoint["id"] + "/workers").get("workers", []):
            if worker.get("status") in ("EXITED", "TERMINATED", "STOPPED"):
                continue
            workers.append(worker)
            price = prices.get(worker.get("gpuTypeId"))
            if price is None:
                unknown_worker_cost = True
            else:
                serverless_rate += float(price) * int(worker.get("gpuCount") or 1)
    total = rate + serverless_rate
    gross = total * budget["usdToEur"] * budget["taxMultiplier"] + budget["unbilledEurPerHourReserve"]
    allowed = set(budget["allowedGpus"])
    gpu = [{k: g.get(k) for k in ("id", "memory", "price", "availability", "cudaVersions")}
           for g in catalog.get("gpus", []) if g.get("id") in allowed]
    return {
        "checkedAt": datetime.now(timezone.utc).isoformat(), "apiVersion": 2,
        "authenticated": True, "readOnly": True, "createdPods": 0,
        "podCount": len(pods), "activePodCount": len(active),
        "endpointCount": len(endpoints), "activeWorkerCount": len(workers),
        "budgetVerified": not unknown_worker_cost,
        "existingPodComputeUsdPerHour": round(rate, 4),
        "existingServerlessComputeUsdPerHour": round(serverless_rate, 4),
        "existingComputeUsdPerHour": round(total, 4),
        "existingEstimatedGrossEurPerHour": round(gross, 4),
        "fleetLimitEurPerHour": budget["maxEurPerHour"],
        "budgetHeadroomEurPerHour": round(max(0, budget["maxEurPerHour"] - gross), 4) if not unknown_worker_cost else None,
        "allowedGpuCatalog": gpu,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("runpod-fleet-preflight.json"))
    args = parser.parse_args()
    try:
        report = probe()
        code = 0
    except Exception as exc:
        report = {"authenticated": False, "readOnly": True, "createdPods": 0,
                  "error": str(exc)}
        code = 1
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
