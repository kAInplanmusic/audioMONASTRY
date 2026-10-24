#!/usr/bin/env python3
"""Apptest-Gate: fuehrt die automatisierbaren Abhak-Schritte der PARTIAL-Tickets aus.

Quelle der Wahrheit ist `MASTERTODOENDE.json` (nur Tickets mit status PARTIAL) und
die Zuordnung in `docs/APPTEST_ABHAK_LISTE.md`. Dieses Skript ist die
maschinenlesbare Haelfte davon: es laeuft die Kommandos, die OHNE Flotte und ohne
GPU beweisbar sind, und schreibt je Ticket PASS/FAIL/SKIP nach
`test-results/apptest/<datum>/gate.json`.

    python3 scripts/apptest-gate.py               # Plan zeigen (nichts ausfuehren)
    python3 scripts/apptest-gate.py --run         # Gruppe local ausfuehren
    python3 scripts/apptest-gate.py --group all --run
    python3 scripts/apptest-gate.py --group cost --run   # 0-EUR-Beweis

Absichtlich NICHT enthalten: alles, was Server oder GPU startet. Das steht in der
Abhakliste als Handgriff - ein Skript, das versehentlich eine Flotte hochfaehrt,
waere genau der Kostentreiber, den Regel 1 verbietet.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SSOT = os.path.join(ROOT, "MASTERTODOENDE.json")
OUT_DIR = os.path.join(ROOT, "test-results", "apptest")

RUNTIME = "services/audiomonastry-ai-runtime/tests"

#: ticket -> Liste von Schritten. `cmd` laeuft als Prozess, `fn` ist eine interne
#: Pruefung. `needs_env` laedt .env.deploy nur fuer diesen Schritt.
CHECKS: dict[str, list[dict]] = {
    "RT-AUDIT-P1-015": [
        {"label": "tsc", "cmd": ["npx", "tsc", "--noEmit"], "timeout": 300},
        {"label": "eslint", "cmd": ["npx", "eslint", ".", "--max-warnings=0"], "timeout": 300},
        {"label": "vitest (Suite)", "cmd": ["npx", "vitest", "run"], "timeout": 900},
        {"label": "deadfiles", "cmd": ["npm", "run", "check:deadfiles"], "timeout": 300},
        {"label": "boundary", "cmd": ["npm", "run", "verify:boundary"], "timeout": 300},
        {"label": "audit:rt", "cmd": ["npm", "run", "audit:rt"], "timeout": 600},
    ],
    "AI-P2-006": [
        {"label": "drop-cache", "cmd": ["npx", "vitest", "run", "tests/aiGenerateDropCache.test.ts"], "timeout": 300},
    ],
    "IDEA-2026-10-07-A-F1": [
        {
            "label": "capture-Suiten",
            "cmd": [
                "npx", "vitest", "run",
                "tests/captureRelay.test.ts",
                "tests/captureRelayTwoClients.test.ts",
                "tests/captureRelayHub.test.ts",
                "tests/captureControl.test.tsx",
            ],
            "timeout": 400,
        },
    ],
    "COLLAB-P0-005": [
        {"label": "collab+revision", "cmd": ["npx", "vitest", "run", "tests/collab.test.ts", "tests/pluginRevisionTracker.test.ts"], "timeout": 400},
    ],
    "LEGO-P1-001": [
        {"label": "music-context", "cmd": ["npx", "vitest", "run", "tests/mcpMusicContext.test.ts"], "timeout": 300},
        {"label": "acestep-context", "cmd": ["python3", f"{RUNTIME}/test_acestep_context.py"], "timeout": 300},
    ],
    "FLEET-P1-002": [{"label": "voice-handlers", "cmd": ["python3", f"{RUNTIME}/test_voice_handlers.py"], "timeout": 300}],
    "FLEET-P1-003": [{"label": "voice-handlers", "cmd": ["python3", f"{RUNTIME}/test_voice_handlers.py"], "timeout": 300}],
    "FLEET-P1-004": [{"label": "voice-handlers", "cmd": ["python3", f"{RUNTIME}/test_voice_handlers.py"], "timeout": 300}],
    "FLEET-P1-005": [{"label": "voice-handlers", "cmd": ["python3", f"{RUNTIME}/test_voice_handlers.py"], "timeout": 300}],
    "FLEET-P1-006": [
        {"label": "stem-crossover", "cmd": ["python3", f"{RUNTIME}/test_stem_crossover.py"], "timeout": 300},
        {"label": "stem-handler", "cmd": ["python3", f"{RUNTIME}/test_stem_handler.py"], "timeout": 300},
    ],
    "FLEET-P1-007": [{"label": "tts-cloning", "cmd": ["python3", f"{RUNTIME}/test_qwen3_tts_handler.py"], "timeout": 300}],
    "FLEET-P1-008": [
        {"label": "song-dispatch", "cmd": ["python3", f"{RUNTIME}/test_song_dispatch.py"], "timeout": 300},
        {"label": "voice-handlers", "cmd": ["python3", f"{RUNTIME}/test_voice_handlers.py"], "timeout": 300},
    ],
    "FLEET-P1-009": [
        {"label": "acestep-context", "cmd": ["python3", f"{RUNTIME}/test_acestep_context.py"], "timeout": 300},
        {"label": "pod-routes", "cmd": ["python3", f"{RUNTIME}/test_pod_routes.py"], "timeout": 300},
    ],
    "FLEET-P1-010": [{"label": "song-dispatch", "cmd": ["python3", f"{RUNTIME}/test_song_dispatch.py"], "timeout": 300}],
    "FLEET-P1-012": [{"label": "autostop", "cmd": ["npx", "vitest", "run", "tests/fleetAutostop.test.ts"], "timeout": 400}],
    "FLEET-P1-014": [
        {"label": "worker-syntax", "cmd": ["node", "--check", "workers/weights-mirror.js"], "timeout": 60},
        {"label": "pod-mode", "cmd": ["python3", f"{RUNTIME}/test_pod_mode.py"], "timeout": 300},
        {"label": "r2-checkpoint", "cmd": ["python3", "scripts/mirror-beat-this.py", "--check"], "timeout": 180, "needs_env": True},
    ],
    "FLEET-P1-015": [
        {"label": "preis-tabelle", "cmd": ["npx", "vitest", "run", "tests/aiInfrastructure.test.ts", "tests/podFleetConfig.test.ts"], "timeout": 400},
    ],
    "AI-RUNPOD-SING-002": [
        {"label": "gewichte-soll", "fn": "weights_contains_bark", "timeout": 240, "needs_env": True},
    ],
    "LIVE-P1-004": [{"label": "AI_MODE im Aufbaupfad", "fn": "ai_mode_in_bringup", "timeout": 30}],
    "FLEET-P1-011": [
        {"label": "vram-probe", "cmd": ["python3", f"{RUNTIME}/test_vram_probe.py"], "timeout": 300},
        {"label": "vram-collector", "cmd": ["python3", "tests/test_collect_vram_report.py"], "timeout": 120},
    ],
    "ZUK-001": [
        {
            "label": "piano-roll",
            "cmd": ["npx", "vitest", "run", "tests/pianoRollModel.test.ts", "tests/pianoRoll.test.tsx"],
            "timeout": 400,
        },
    ],
    "ZUK-003": [
        {"label": "dsp-kernel (echtes wasm)", "cmd": ["npx", "vitest", "run", "tests/dspKernelWasm.test.ts"], "timeout": 300},
    ],
    "ZUK-004": [
        {"label": "faltungshall", "cmd": ["npx", "vitest", "run", "tests/partitionedConvolver.test.ts"], "timeout": 300},
    ],
    "ZUK-005": [
        {
            "label": "automation",
            "cmd": ["npx", "vitest", "run", "tests/automationTimeline.test.ts", "tests/v2Phase5.test.ts"],
            "timeout": 300,
        },
    ],
}

#: Gruppe B/C brauchen Flotte bzw. GPU - hier nur als Handgriff gelistet.
MANUAL: dict[str, str] = {
    "PLUGIN-V2-D": "Live: /api/health + npm run test:e2e:live-smoke",
    "LIVE-P1-004": "Live: npx playwright test tests/e2e/aiNegative.spec.ts",
    "COLLAB-P0-005": "Live: 4 Browser, gleichzeitig auf dieselbe Basis senden",
    "VISUAL-P0-010": "Live: Schalter, Upload/Transcode/Index, On-Beat-Story, 1080p60",
    "AI-INFRA-001": "Live: keine Visual-Generierung im Automatik-Pfad, Budget <= 4 EUR/h",
    "IDEA-2026-10-07-A-F1": "Live: 2 Geraete, Latenz-Versatz messen",
    "INFRA-RUNPOD-018": "Live: gh run view 36580686816 + runpod-pods.py status",
    "FLEET-P1-001": "GPU: Session starten, 'fleet pod ...' im Log",
    "FLEET-P1-011": "GPU: python3 scripts/collect-vram-report.py --group all",
    "FLEET-P1-002": "GPU: POST /infer transcribe (Deutsch)",
    "FLEET-P1-003": "GPU: POST /infer understand",
    "FLEET-P1-004": "GPU: POST /infer diarize",
    "FLEET-P1-005": "GPU: POST /infer analyze (SongFormer/beat_this)",
    "FLEET-P1-006": "GPU: POST /infer stem.separate",
    "FLEET-P1-007": "GPU: POST /infer tts mit referenceAudio",
    "FLEET-P1-008": "GPU: POST /infer audio.generate + /ready-Gating",
    "FLEET-P1-009": "GPU: POST /infer aceTask=lego mit contextAudio",
    "FLEET-P1-010": "GPU: POST /api/voice/sing mit lyrics",
    "FLEET-P1-012": "GPU: Pod wecken, 15 min Leerlauf, Stopp beobachten",
    "FLEET-P1-015": "GPU: Welcome-Probe fuer (b)/(c)/(d)/(f)",
    "LEGO-P1-001": "GPU: lego/extract/complete/repaint",
    "AI-RUNPOD-SING-002": "GPU: POST /api/voice/sing ohne VOICE_AI_RUNTIME_URL",
    "INFRA-RUNPOD-012": "GPU: nach Aufladung echter music-Job",
    "INFRA-RUNPOD-013": "GPU: Job-Historie je Endpoint",
    "INFRA-RUNPOD-019": "Betreiber: RunPod-Guthaben aufladen",
}


def load_env_deploy() -> dict[str, str]:
    env = dict(os.environ)
    path = os.path.join(ROOT, ".env.deploy")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env.setdefault(key, value.strip('"').strip("'"))
    return env


def run_cmd(step: dict) -> tuple[bool, str]:
    env = load_env_deploy() if step.get("needs_env") else os.environ
    try:
        proc = subprocess.run(
            step["cmd"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=step.get("timeout", 300),
        )
    except subprocess.TimeoutExpired:
        return False, f"timeout nach {step.get('timeout')} s"
    except FileNotFoundError as exc:
        return False, f"Kommando fehlt: {exc}"
    tail = (proc.stdout or "").strip().splitlines()[-3:]
    if proc.returncode != 0:
        tail = ((proc.stderr or "").strip().splitlines() or tail)[-3:]
    return proc.returncode == 0, " | ".join(tail)


def fn_ai_mode_in_bringup(_step: dict) -> tuple[bool, str]:
    """LIVE-P1-004: AI_MODE=off muss im REGULAEREN Aufbaupfad stehen."""
    targets = [
        os.path.join(ROOT, "scripts/hetzner/bring-up-fleet.sh"),
        os.path.join(ROOT, "scripts/hetzner/lib/env_token_override.py"),
    ]
    hits = {}
    for path in targets:
        if not os.path.exists(path):
            return False, f"fehlt: {os.path.relpath(path, ROOT)}"
        text = open(path, encoding="utf-8").read()
        hits[os.path.basename(path)] = "AI_MODE" in text
    missing = [name for name, ok in hits.items() if not ok]
    if missing:
        return False, f"AI_MODE fehlt in {', '.join(missing)}"
    return True, "AI_MODE in bring-up-fleet.sh und env_token_override.py"


def fn_weights_contains_bark(_step: dict) -> tuple[bool, str]:
    """AI-RUNPOD-SING-002: bark-small muss im Gewichte-Soll liegen (read-only)."""
    env = load_env_deploy()
    proc = subprocess.run(
        [sys.executable, "scripts/runpod-pods.py", "weights"],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=240,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        return False, f"runpod-pods.py weights exit {proc.returncode}"
    has_bark = "weights/bark-small" in out
    all_present = "Alle Gewichte vorhanden" in out
    return (has_bark and all_present), f"bark-small={has_bark}, alle_vorhanden={all_present}"


def fn_cost_zero(_step: dict) -> tuple[bool, str]:
    """Regel 1: 0 Server und 0 Floating-IPs mit label app=audiomonastry."""
    env = load_env_deploy()
    token = env.get("HCLOUD_TOKEN", "")
    if not token:
        return False, "HCLOUD_TOKEN fehlt (.env.deploy)"
    counts = {}
    for name, endpoint in (("servers", "servers"), ("floating_ips", "floating_ips")):
        req = urllib.request.Request(
            f"https://api.hetzner.cloud/v1/{endpoint}?limit=50",
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.load(resp)
        except Exception as exc:  # noqa: BLE001
            return False, f"{name}: {type(exc).__name__}: {exc}"
        counts[name] = sum(
            1 for entry in data.get(endpoint, []) if (entry.get("labels") or {}).get("app") == "audiomonastry"
        )
    ok = all(v == 0 for v in counts.values())
    return ok, f"servers={counts['servers']}, floating_ips={counts['floating_ips']}"


FUNCS = {
    "ai_mode_in_bringup": fn_ai_mode_in_bringup,
    "weights_contains_bark": fn_weights_contains_bark,
}


def partial_ids() -> list[str]:
    doc = json.load(open(SSOT, encoding="utf-8"))
    return [item["id"] for item in doc["items"] if item.get("status") == "PARTIAL"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", choices=["local", "cost", "all"], default="local")
    ap.add_argument("--only", action="append", default=[], help="nur dieses Ticket (mehrfach erlaubt)")
    ap.add_argument("--run", action="store_true", help="wirklich ausfuehren (sonst nur Plan)")
    args = ap.parse_args()

    ids = partial_ids()
    if args.only:
        ids = [i for i in ids if i in set(args.only)]
        if not ids:
            print(f"kein PARTIAL-Ticket passt zu {args.only}")
            return 2
    plan: list[tuple[str, list[dict]]] = []

    if args.group == "cost":
        plan = [("REGEL-1", [{"label": "0 Server / 0 Floating-IPs", "fn": "cost_zero"}])]
    else:
        covered = [i for i in ids if i in CHECKS]
        plan = [(i, CHECKS[i]) for i in covered]
        missing = [i for i in ids if i not in CHECKS]
        if args.group == "all":
            plan.append(("REGEL-1", [{"label": "0 Server / 0 Floating-IPs", "fn": "cost_zero"}]))

    if not args.run:
        print(f"PARTIAL-Tickets: {len(ids)}  |  automatisierbar: {sum(1 for i in ids if i in CHECKS)}")
        print()
        for ticket, steps in plan:
            print(f"{ticket}")
            for step in steps:
                what = " ".join(step["cmd"]) if "cmd" in step else f"(intern) {step['fn']}"
                print(f"   - {step['label']}: {what}")
        print()
        rest = [i for i in ids if i not in CHECKS]
        if rest:
            print("Nur als Handgriff (Flotte/GPU/Betreiber):")
            for ticket in rest:
                print(f"   - {ticket}: {MANUAL.get(ticket, 'siehe docs/APPTEST_ABHAK_LISTE.md')}")
        print("\nMit --run ausfuehren.")
        return 0

    results = []
    failed = 0
    for ticket, steps in plan:
        for step in steps:
            label = step["label"]
            if "fn" in step:
                fn = FUNCS.get(step["fn"]) or (fn_cost_zero if step["fn"] == "cost_zero" else None)
                if fn is None:
                    ok, detail = False, f"unbekannte Pruefung {step['fn']}"
                else:
                    ok, detail = fn(step)
            else:
                ok, detail = run_cmd(step)
            failed += 0 if ok else 1
            results.append({"ticket": ticket, "step": label, "ok": ok, "detail": detail})
            print(f"{'PASS' if ok else 'FAIL'}  {ticket:24s} {label:24s} {detail}")

    stamp = dt.datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    out_dir = os.path.join(OUT_DIR, stamp)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "gate.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"date": stamp, "group": args.group, "failed": failed, "results": results}, fh,
                  ensure_ascii=True, indent=2)
    print(f"\n{failed} Fehler. Bericht: {os.path.relpath(out_path, ROOT)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
