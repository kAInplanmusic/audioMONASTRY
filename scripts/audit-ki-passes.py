#!/usr/bin/env python3
"""audit-ki-passes.py — KI-Review-Pässe für audioMONASTRY (Anbieter-Rotation + Budget-Gate).

Fokussierte KI-Pässe Ergänzung zum Deep-Audit-300 (scripts/deep-audit). Learnings vom
2026-09-29 sind eingebaut:

  * DeepSeek-Reasoning-Falle: `deepseek-flash` denkt mit — max_tokens MUSS hoch genug
    sein (default 8000), sonst ist der Content leer. Ein leerer Content führt zu
    automatischem Retry mit verdoppeltem Budget (max. 1x).
  * Blocked-Key-Erkennung: 401 "invalid, blocked or out of funds" (Nous-Portal-Muster)
    markiert den Anbieter dauerhaft unerreichbar; 404 "no longer free" weicht auf das
    Paid-Modell-Präfix aus bzw. springt zum nächsten Free-Anbieter.
  * Free-Fallback-Kette: nous (:free) -> llm7 (gratis Katalog) -> FreeLLMAPI-Router
    (lokal 31415, free-only durch Paid-Model-Lock).
  * Budget-Gate: AUDIT_BUDGET_USD (default 6). Vor jedem bezahlten Pass Balance-Check
    (DeepSeek /user/balance), nach jedem Pass Verbrauch = Balance-Delta in
    logs/audit-budget-<datum>.md. Deckel erreicht -> nur noch Free-Pässe.

Aufruf:
  python3 scripts/audit-ki-passes.py --list
  python3 scripts/audit-ki-passes.py --pass rootcause            # DeepSeek, bezahlt (klein)
  python3 scripts/audit-ki-passes.py --pass adversarial          # Free (nous->llm7->router)
  python3 scripts/audit-ki-passes.py --pass all --budget 4
  python3 scripts/audit-ki-passes.py --pass adversarial --dry-run

Ergebnisse: test-results/deep-audit/ki-passes/<pass>-<anbieter>.md (+ Konsolen-Zusammenfassung).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "test-results" / "deep-audit" / "ki-passes"
LOG_DIR = ROOT / "logs"
ROUTER = "http://127.0.0.1:31415/v1"
MAX_OUT_CHARS = 6000

# --------------------------------------------------------------------------
# Env laden (.env + ~/.hermes/.env + ~/.config/monk/keys.env, erstes Vorkommen)
# --------------------------------------------------------------------------
def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    import os
    for p in (
        pathlib.Path(".env"),
        pathlib.Path.home() / ".hermes/.env",
        pathlib.Path.home() / ".config/monk/keys.env",
    ):
        if p.is_file():
            for line in p.read_text(errors="replace").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env.setdefault(k.strip(), v.strip())
    env.update({k: v for k, v in os.environ.items() if v})
    return env


ENV = load_env()


def post_chat(base: str, key: str, model: str, system: str, user: str,
              max_tokens: int, timeout: int = 300) -> dict:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "max_tokens": max_tokens, "temperature": 0.2,
    }).encode()
    req = urllib.request.Request(base.rstrip("/") + "/chat/completions", data=body,
                                 headers={"Authorization": f"Bearer {key}",
                                          "Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.load(r)
    d["_elapsed_s"] = round(time.time() - t0, 1)
    return d


def deepseek_balance() -> float | None:
    key = ENV.get("DEEPSEEK_API_KEY")
    if not key:
        return None
    try:
        req = urllib.request.Request("https://api.deepseek.com/user/balance",
                                     headers={"Authorization": f"Bearer {key}"})
        d = json.load(urllib.request.urlopen(req, timeout=20))
        return float(d["balance_infos"][0]["total_balance"])
    except Exception as e:
        print(f"  ! Balance-Check fehlgeschlagen: {e}")
        return None


def excerpt(path: str, start: int | None = None, length: int = 12000) -> str:
    text = (ROOT / path).read_text(errors="replace")
    if start is not None:
        text = text[max(0, start - 3000): start + 4500]
    return text[:length]


# --------------------------------------------------------------------------
# Pässe: Fokus, Quellexzerpte und Prompt je Track
# --------------------------------------------------------------------------
def build_passes() -> dict[str, dict]:
    def server_gate_excerpt() -> str:
        server = (ROOT / "server.ts").read_text(errors="replace")
        idx = server.find("studioTokenMissing")
        return server[max(0, idx - 3500): idx + 4500] if idx >= 0 else server[:8000]

    return {
        "rootcause": {
            "title": "Root-Cause/Auth-Review (Studio-Gate, aiRoutes, Rate-Limits)",
            "provider_pref": ["deepseek"],
            "files": ["server.ts", "tests/aiRoutes.test.ts", "server/routes/aiRoutes.ts"],
            "system": "Du bist Senior Security/Node-Reviewer. Antworte kompakt auf Deutsch, "
                      "nur Fakten mit Datei-/Zeilenbezug, keine Höflichkeiten.",
            "user": f"""Root-Cause-Analyse: In tests/aiRoutes.test.ts liefern ALLE /api/ai/*-Requests 503
(code STUDIO_TOKEN_MISSING) statt 200/422/400.

=== server.ts (Auth-Gate) ===
{server_gate_excerpt()}
=== tests/aiRoutes.test.ts (Setup, vor 4.5k Zeichen) ===
{excerpt("tests/aiRoutes.test.ts", length=4500)}
=== FRAGEN ===
1) Exakte Root-Cause-Kette (Reihenfolge dotenv -> Konstanten -> Middleware).
2) Sauberster Fix — bewerte (a) Test-Setup (setupFiles, NODE_ENV=test, dotenv deaktivieren)
   vs (b) Server-Gate aufweichen. Risiken je Option (fail-closed? CI? Modul-Cache?).
3) Security-Befunde im Gate selbst (Timing-Vergleich, decodeURIComponent, Scrape-Pfad,
   TRUST_PROXY, 503-vs-401).
Max 350 Wörter, nummeriert.""",
        },
        "adversarial": {
            "title": "Adversarial-Review MoA-Orchestrator (Injection, Allowlist, Path-Traversal)",
            "provider_pref": ["nous", "llm7", "router"],
            "files": ["services/audiomonastry-ai-runtime/moa_orchestrator.py"],
            "system": "You are an adversarial systems reviewer. Answer in German, concise, "
                      "evidence-based, no pleasantries.",
            "user": f"""Adversarial-Review dieses MoA-Orchestrators (audioMONASTRY, RunPod-Flotte):
=== moa_orchestrator.py (Auszug) ===
{excerpt("services/audiomonastry-ai-runtime/moa_orchestrator.py", length=14000)}
=== FRAGEN ===
1) Failure-Modes: Parser-Ausfälle, Prompt-Injection im Planner-Output, doppelte
   Tool-Steps, Timeout eines Planner-LLMs?
2) Wo fehlt Validierung/Autorisierung der LLM-Steps (tool-allowlist? args-Schema?
   Path-Traversal in args)?
3) Top-3 konkrete Härtungen mit Zeilenbezug.
Max 400 Wörter, nummeriert.""",
        },
        "archdrift": {
            "title": "Architektur-/Konsistenz-Review (Manifest vs Registry vs Deploy vs Docs)",
            "provider_pref": ["nous", "llm7", "router"],
            "files": ["services/audiomonastry-ai-runtime/model_manifest.json",
                      "src/core/ai/orchestrator/endpointRegistry.ts",
                      "scripts/runpod-deploy.py"],
            "system": "Du bist Infrastruktur-Auditor. Antworte kompakt auf Deutsch, nur Befunde mit Beleg.",
            "user": f"""Konsistenz-Check der Modell-/Flotten-Definitionen (read-only):
=== model_manifest.json (imageHq + flux-Abschnitt) ===
{excerpt("services/audiomonastry-ai-runtime/model_manifest.json", length=9000)}
=== endpointRegistry.ts (Auszug) ===
{excerpt("src/core/ai/orchestrator/endpointRegistry.ts", length=6000)}
=== runpod-deploy.py (PREBUILT_IMAGES/ROLE_DEFAULTS-Kommentarzone) ===
{excerpt("scripts/runpod-deploy.py", length=6000)}
=== FRAGEN ===
1) Widersprüche zwischen den drei Quellen (Modell-IDs, VRAM, Pools, Idle-Timeouts, Images)?
2) Welcher Befund blockiert den nächsten Deploy?
Max 300 Wörter, nummeriert.""",
        },
    }


# --------------------------------------------------------------------------
# Anbieter
# --------------------------------------------------------------------------
def call_deepseek(pass_def: dict, max_tokens: int) -> tuple[str | None, dict]:
    key = ENV.get("DEEPSEEK_API_KEY")
    if not key:
        return None, {"error": "kein DEEPSEEK_API_KEY"}
    b0 = deepseek_balance()
    if b0 is not None:
        print(f"  balance vor: ${b0:.2f}")
    last_err = None
    for mt in (max_tokens, max_tokens * 2):
        try:
            d = post_chat("https://api.deepseek.com/v1", key, "deepseek-flash",
                          pass_def["system"], pass_def["user"], mt)
            content = d["choices"][0]["message"].get("content") or ""
            u = d.get("usage", {})
            reason = u.get("completion_tokens_details", {}).get("reasoning_tokens", 0)
            if content.strip():
                b1 = deepseek_balance()
                spent = (b0 - b1) if (b0 is not None and b1 is not None) else None
                meta = {"provider": "deepseek", "model": "deepseek-flash",
                        "usage": u, "reasoning_tokens": reason,
                        "elapsed_s": d["_elapsed_s"], "spent_usd": spent}
                return content, meta
            print(f"  ! leerer Content (reasoning={reason} fraß max_tokens={mt}) — Retry mit {mt*2}")
            last_err = "leerer Content (nur Reasoning)"
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:200]
            print(f"  ! deepseek {e.code}: {body}")
            last_err = f"{e.code} {body}"
            break
        except Exception as e:
            last_err = str(e); print(f"  ! {e}"); break
    return None, {"error": last_err, "provider": "deepseek"}


_NOUS_STATE: dict[str, bool | None] = {"available": None}


def call_nous(pass_def: dict, max_tokens: int) -> tuple[str | None, dict]:
    if _NOUS_STATE["available"] is False:
        return None, {"error": "nous dauerhaft blocked (früher geprüft)"}
    key = ENV.get("NOUS_API_KEY")
    if not key:
        return None, {"error": "kein NOUS_API_KEY"}
    try:
        req = urllib.request.Request("https://inference-api.nousresearch.com/v1/models",
                                     headers={"Authorization": f"Bearer {key}"})
        models = json.load(urllib.request.urlopen(req, timeout=20))["data"]
    except Exception as e:
        _NOUS_STATE["available"] = False
        return None, {"error": f"nous models: {e}"}
    free = [m["id"] for m in models if m["id"].endswith(":free")]
    for model in (free[:2] or ["meituan/longcat-2.0:free"]):
        try:
            d = post_chat("https://inference-api.nousresearch.com/v1", key, model,
                          pass_def["system"], pass_def["user"], max_tokens)
            content = d["choices"][0]["message"].get("content") or ""
            if content.strip():
                _NOUS_STATE["available"] = True
                return content, {"provider": "nous", "model": model, "usage": d.get("usage", {}),
                                 "elapsed_s": d["_elapsed_s"], "spent_usd": 0.0}
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:220]
            print(f"  ! nous {model}: {e.code} {body}")
            if e.code == 401 and ("blocked" in body or "out of funds" in body or "invalid" in body):
                _NOUS_STATE["available"] = False
                return None, {"error": f"nous key blocked: {body}", "provider": "nous"}
            if e.code == 404 and "no longer free" in body:
                continue
        except Exception as e:
            print(f"  ! nous {model}: {e}")
    return None, {"error": "nous: alle Free-Modelle fehlgeschlagen", "provider": "nous"}


def call_llm7(pass_def: dict, max_tokens: int) -> tuple[str | None, dict]:
    key = ENV.get("LLM7_API_KEY")
    if not key:
        return None, {"error": "kein LLM7_API_KEY"}
    for model in ("DeepSeek-V4.1-Flash", "Inkling-Small", "codestral-latest"):
        try:
            d = post_chat("https://api.llm7.io/v1", key, model,
                          pass_def["system"], pass_def["user"], max_tokens)
            content = d["choices"][0]["message"].get("content") or ""
            if content.strip():
                return content, {"provider": "llm7", "model": model, "usage": d.get("usage", {}),
                                 "elapsed_s": d["_elapsed_s"], "spent_usd": 0.0}
        except urllib.error.HTTPError as e:
            print(f"  ! llm7 {model}: {e.code} {e.read().decode(errors='replace')[:120]}")
        except Exception as e:
            print(f"  ! llm7 {model}: {e}")
    return None, {"error": "llm7: alle Modelle fehlgeschlagen", "provider": "llm7"}


def call_router(pass_def: dict, max_tokens: int) -> tuple[str | None, dict]:
    key = ENV.get("FREELLMAPI_API_KEY")
    if not key:
        return None, {"error": "kein FREELLMAPI_API_KEY (Router)"}
    for model in ("auto", "codestral-latest"):
        try:
            d = post_chat(ROUTER, key, model, pass_def["system"], pass_def["user"], max_tokens)
            content = d["choices"][0]["message"].get("content") or ""
            if content.strip():
                return content, {"provider": "router", "model": model, "usage": d.get("usage", {}),
                                 "elapsed_s": d["_elapsed_s"], "spent_usd": 0.0}
        except Exception as e:
            print(f"  ! router {model}: {e}")
    return None, {"error": "router fehlgeschlagen", "provider": "router"}


PROVIDERS = {"deepseek": call_deepseek, "nous": call_nous, "llm7": call_llm7, "router": call_router}


# --------------------------------------------------------------------------
# Orchestrator
# --------------------------------------------------------------------------
def budget_spent_today() -> float:
    log = LOG_DIR / f"audit-budget-{dt.date.today():%Y%m%d}.md"
    if not log.is_file():
        return 0.0
    total = 0.0
    for line in log.read_text().splitlines():
        if line.startswith("verbrauch_usd:"):
            try:
                total += float(line.split(":", 1)[1])
            except ValueError:
                pass
    return total


def log_budget(pass_name: str, meta: dict) -> None:
    LOG_DIR.mkdir(exist_ok=True)
    log = LOG_DIR / f"audit-budget-{dt.date.today():%Y%m%d}.md"
    u = meta.get("usage") or {}
    line = (f"## {dt.datetime.now():%F %T} — {pass_name}\n"
            f"anbieter: {meta.get('provider')} / {meta.get('model')}\n"
            f"tokens: prompt={u.get('prompt_tokens')} completion={u.get('completion_tokens')} "
            f"reasoning={meta.get('reasoning_tokens', '-')}\n"
            f"verbrauch_usd: {meta.get('spent_usd') if meta.get('spent_usd') is not None else 0.0:.4f}\n\n")
    with log.open("a") as f:
        f.write(line)


def run_pass(name: str, pass_def: dict, budget: float, dry_run: bool, max_tokens: int) -> dict:
    print(f"\n===== PASS {name}: {pass_def['title']} =====")
    print(f"  dateien: {', '.join(pass_def['files'])}")
    if dry_run:
        print("  (dry-run: kein Aufruf)")
        return {"pass": name, "status": "dry-run"}
    spent_before = budget_spent_today()
    result, meta = None, {}
    for prov in pass_def["provider_pref"]:
        if prov == "deepseek" and spent_before >= budget:
            print(f"  skip deepseek: Tagesbudget ${spent_before:.2f} >= Deckel ${budget:.2f}")
            continue
        fn = PROVIDERS[prov]
        print(f"  -> anbieter {prov} …")
        result, meta = fn(pass_def, max_tokens)
        if result:
            break
    if not result:
        print(f"  PASS FEHLGESCHLAGEN: {meta.get('error')}")
        return {"pass": name, "status": "failed", "error": meta.get("error")}
    log_budget(name, meta)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = OUT_DIR / f"{name}-{meta.get('provider')}-{stamp}.md"
    u = meta.get("usage") or {}
    header = (f"# KI-Pass: {pass_def['title']}\n\n"
              f"- anbieter: {meta.get('provider')} / {meta.get('model')} ({meta.get('elapsed_s')}s)\n"
              f"- tokens: prompt={u.get('prompt_tokens')} completion={u.get('completion_tokens')}"
              f" reasoning={meta.get('reasoning_tokens', '-')}\n"
              f"- verbrauch: ${meta.get('spent_usd') if meta.get('spent_usd') is not None else 0.0:.4f}\n\n"
              "---\n\n")
    out.write_text(header + result.strip() + "\n")
    print(f"  OK ({meta.get('provider')}/{meta.get('model')}, {meta.get('elapsed_s')}s) -> {out.relative_to(ROOT)}")
    print("  " + result.strip()[:1200].replace("\n", "\n  "))
    if len(result) > 1200:
        print("  … (Rest im Report)")
    return {"pass": name, "status": "ok", "provider": meta.get("provider"),
            "spent_usd": meta.get("spent_usd") or 0.0, "report": str(out.relative_to(ROOT))}


def main() -> int:
    ap = argparse.ArgumentParser(description="KI-Review-Pässe mit Budget-Gate")
    ap.add_argument("--pass", dest="passes", default="all",
                    help="rootcause|adversarial|archdrift|all (kommasepariert)")
    ap.add_argument("--budget", type=float,
                    default=float(ENV.get("AUDIT_BUDGET_USD", "6")),
                    help="Tagesdeckel in USD (default AUDIT_BUDGET_USD oder 6)")
    ap.add_argument("--max-tokens", type=int, default=8000,
                    help="max_tokens je Aufruf (default 8000 — DeepSeek-Reasoning braucht Luft)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    passes = build_passes()
    if args.list:
        for name, p in passes.items():
            print(f"{name:12} [{','.join(p['provider_pref'])}] {p['title']}")
        return 0
    wanted = list(passes) if args.passes == "all" else [p.strip() for p in args.passes.split(",")]
    unknown = [w for w in wanted if w not in passes]
    if unknown:
        print(f"unbekannte Pässe: {unknown} (verfügbar: {', '.join(passes)})")
        return 2
    print(f"Budget heute verbraucht: ${budget_spent_today():.2f} | Deckel: ${args.budget:.2f}")
    results = [run_pass(w, passes[w], args.budget, args.dry_run, args.max_tokens) for w in wanted]
    total = sum(r.get("spent_usd") or 0.0 for r in results)
    print(f"\n== Zusammenfassung: {sum(1 for r in results if r['status']=='ok')}/{len(results)} OK, "
          f"Verbrauch heute gesamt ${budget_spent_today():.4f} (dieser Lauf: ${total:.4f}) ==")
    return 0 if all(r["status"] in ("ok", "dry-run") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
