"""
sampleMONK AI Runtime – RunPod Serverless Worker
=================================================
Wrapper für RunPod Serverless. Der Worker übernimmt Jobs von der RunPod-Queue
und führt sie über den vorhandenen ModelManager/handlers aus.

Job-Input:
{
  "task": "tts",
  "model": "xtts-v2",
  "input": { ... modellspezifisch ... }
}

Flotten-Rolle (`AI_ROLE`):
  brain     → llm, nlu                (lokales LLM, vLLM)
  ears      → audio.*                 (STT, Embeddings, Klassifikation)
  voiceGen  → tts/sing/song/generate/stem.separate
  (leer)    → Legacy-Single-Endpoint: alle Modelle des Manifests

Sonderaufgabe `warmup` (kein Inferenz-Job): lädt die Preload-Modelle der Rolle
in VRAM. Wird vom Session-Wake (`src/core/ai/orchestrator/fleetWake.ts`) genutzt,
damit der erste echte Task keinen Modell-Load mehr bezahlt.

Output (kleine Ergebnisse):
{
  "status": "success",
  "task": "tts",
  "model": "xtts-v2",
  "result": { ... }
}

Für große Audio-Dateien gilt später:
- Input enthält R2-URLs statt Base64
- Output enthält R2-URLs zu generierten Dateien
- Dieses File bleibt die zentrale Worker-Schnittstelle

Lizenz/Hinweis: Keine Secrets loggen, keine Raw-Exceptions ausgeben.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict

try:  # runpod ist nur im Serverless-Image nötig; lokal optional
    import runpod  # type: ignore
except Exception:  # pragma: no cover
    runpod = None

from model_manager import ModelManager, ModelUnavailableError
from registry import ROLE_IDS, load_manifest

_SAFE_TASK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SAFE_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")

manager = ModelManager()
_ready = False
_startup_errors: list[str] = []
_preload_done = False
# Einmal pro Worker-Instanz: verhindert doppelte Downloads bei mehreren Jobs.
_predownload_done = False


def log_event(level: str, msg: str, **fields: Any) -> None:
    record: Dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "service": "samplemonk-ai-runtime-runpod-worker",
        "msg": msg,
        **fields,
    }
    print(json.dumps(record, ensure_ascii=False), flush=True)


def _debug_detail() -> bool:
    return os.environ.get("AI_RUNTIME_DEBUG", "").strip().lower() in ("1", "true", "yes")


def _with_detail(payload: Dict[str, Any], exc: BaseException) -> Dict[str, Any]:
    """Hängt die echte Fehlermeldung an – nur im Debug-Modus.

    Ohne Zugriff auf die Serverless-Container-Logs ist das der einzige Weg, einen
    Handler-Fehler zu diagnostizieren. Default ist AUS, damit keine internen
    Details (Pfade, Tokens, Stacktraces) nach außen gelangen.
    """
    if _debug_detail():
        payload["detail"] = f"{type(exc).__name__}: {exc}"[:400]
    return payload


def _role() -> str:
    """Flotten-Rolle dieses Workers ('' = Legacy-Single-Endpoint-Betrieb)."""
    role = os.environ.get("AI_ROLE", "").strip()
    if role and role not in ROLE_IDS:
        raise ValueError(f"unbekannte AI_ROLE {role!r} (erwartet: {', '.join(ROLE_IDS)})")
    return role


def _init_manager() -> None:
    """Lädt das Rollen-Manifest und konfiguriert den ModelManager einmalig."""
    global _ready
    try:
        role = _role()
        manifest = load_manifest(role or None)
        manager.configure(manifest)
        _ready = True
        log_event(
            "INFO",
            "model manager configured",
            role=role or "legacy",
            models=len(manager.get_model_info()),
            skippedPlanned=manifest.get("skippedPlanned", []),
        )
    except Exception as exc:  # noqa: BLE001
        _startup_errors.append(f"{type(exc).__name__}: {exc}")
        log_event("FATAL", "model manager init failed", error=type(exc).__name__)


def _preload_background() -> None:
    """CORE/FREQUENT im Hintergrund laden – blockiert den Worker-Start nicht."""
    global _preload_done
    try:
        log_event("INFO", "preload started")
        manager.preload()
        _preload_done = True
        log_event("INFO", "preload finished", models_loaded=len(manager.get_status()))
    except Exception as exc:  # noqa: BLE001
        log_event("WARN", "preload failed", error=type(exc).__name__)


def _dir_size_gb(path: str) -> float:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                continue
    return round(total / 1024**3, 2)


def _free_gb(path: str) -> float:
    try:
        stat = os.statvfs(path)
        return round(stat.f_bavail * stat.f_frsize / 1024**3, 2)
    except OSError:
        return -1.0


def _handle_predownload(role: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Lädt die Gewichte der Rolle in den PERSISTENTEN HF-Cache.

    Nutzt dieselben Libraries und dasselbe `HF_HOME` wie die echte Inferenz –
    damit passt der Cache-Layout garantiert. Ziel: mit einem RunPod
    Network-Volume auf `/data` ist der Kaltstart danach nur noch Platte→VRAM
    statt ein 30-GB-Download pro Session.

    Wählt pro Repo das günstigste Format: gibt es `.safetensors`, werden die
    (gleich großen) `.bin`-Duplikate sowie TF/Flax/ONNX-Varianten übersprungen.
    Repos ohne `.safetensors` (z. B. CLAP) liefern weiterhin `.bin`.
    """
    global _predownload_done
    if _predownload_done:
        return {
            "status": "success",
            "task": "predownload",
            "result": {"role": role, "skipped": "already downloaded in this worker", "cachedGb": _dir_size_gb(_hf_home())},
        }

    try:
        import predownload  # gemeinsame Logik mit dem Dockerfile-Baking
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "code": "HF_HUB_MISSING", "message": f"{type(exc).__name__}: {exc}"[:200]}

    hf_home = _hf_home()
    try:
        os.makedirs(hf_home, exist_ok=True)
        probe = os.path.join(hf_home, ".write-probe")
        with open(probe, "w", encoding="utf-8") as fh:
            fh.write("ok")
        os.remove(probe)
        writable = True
        write_error = ""
    except Exception as exc:  # noqa: BLE001
        writable = False
        write_error = f"{type(exc).__name__}: {exc}"[:200]

    info = {m["id"]: m for m in manager.get_model_info()}
    requested = payload.get("models")
    if isinstance(requested, list) and requested:
        targets = [str(m) for m in requested if str(m) in info]
    else:
        targets = [mid for mid, m in info.items() if m.get("preload")]

    free_before = _free_gb(hf_home if writable else "/")
    started = time.time()
    done: Dict[str, float] = {}
    skipped: Dict[str, str] = {}
    failed: Dict[str, str] = {}

    for model_id in targets:
        repo = str(info[model_id].get("repository") or "").strip()
        revision = str(info[model_id].get("revision") or "").strip()
        if not predownload.is_hf_repo(repo):
            # z. B. `demucs/demucs` (kein HF-Repo) oder `essentia/essentia` (CPU).
            skipped[model_id] = f"kein HF-Repo: {repo or '-'}"
            continue
        try:
            # Gemeinsame Logik mit dem Build (Dockerfile-Baking): gleiche
            # Format-Auswahl, gleiches Cache-Layout.
            files = predownload.selected_files(repo, revision)
            predownload.download_group(repo, revision, files)
            done[model_id] = 0.0
        except Exception as exc:  # noqa: BLE001
            failed[model_id] = f"{type(exc).__name__}: {exc}"[:160]

    cached_gb = _dir_size_gb(hf_home)
    duration_ms = int((time.time() - started) * 1000)
    _predownload_done = True
    result = {
        "role": role,
        "hfHome": hf_home,
        "volumeWritable": writable,
        "writeError": write_error,
        "freeGbBefore": free_before,
        "freeGbAfter": _free_gb(hf_home if writable else "/"),
        "cachedGbTotal": cached_gb,
        "targets": targets,
        "downloaded": sorted(done),
        "skipped": skipped,
        "failed": failed,
        "durationMs": duration_ms,
    }
    log_event(
        "INFO",
        "predownload finished",
        role=role,
        cachedGbTotal=cached_gb,
        downloaded=len(done),
        failed=len(failed),
        durationMs=duration_ms,
    )
    return {"status": "success" if not failed else "success", "task": "predownload", "model": "", "result": result, "durationMs": duration_ms}


def _hf_home() -> str:
    return os.environ.get("HF_HOME", "").strip() or "/data/hf-cache"


def _handle_warmup(role: str) -> Dict[str, Any]:
    """Lädt alle Preload-Modelle der Rolle – Grundlage für den Session-Wake.

    Kein Inferenz-Job: der Aufrufer (fleetWake) will nur sicherstellen, dass der
    erste echte Task keinen Modell-Load mehr bezahlt.
    """
    started = time.time()
    targets = [info["id"] for info in manager.get_model_info() if info.get("preload")]
    loaded: list[str] = []
    failed: list[str] = []
    warmed: list[str] = []
    warmup_failed: dict[str, str] = {}
    warmup_ms: dict[str, int] = {}
    for model_id in targets:
        try:
            manager.load(model_id)
            loaded.append(model_id)
        except ModelUnavailableError as exc:
            failed.append(model_id)
            log_event("WARN", "warmup model unavailable", model=model_id, error=str(exc))

    # ECHTES Vorwaermen (AUDIT-F-012).
    #
    # `manager.load()` ist reine Buchhaltung (VRAM-Ledger) – die Gewichte kommen
    # erst im Handler per `from_pretrained`, also beim ERSTEN echten `infer()`.
    # Ein Warmup, das nur `load()` aufruft, ist deshalb ein Placebo: der erste
    # Nutzeraufruf zahlt weiterhin Download + Load (gemessen: 201 s beim Brain).
    # Hier laeuft daher pro Modell eine minimale echte Inferenz, damit diese
    # Kosten in den Session-Wake fallen – die App braucht ohnehin 5–10 min zum
    # Start, der Nutzer merkt davon nichts.
    #
    # Nur textbasierte Handler koennen mit einem Mini-Prompt gewaermt werden;
    # Audio-Modelle (Whisper/CLAP/AST) brauchen echtes Audio und werden
    # uebersprungen – das wird ehrlich als `warmupSkipped` gemeldet, statt als
    # Erfolg ausgegeben zu werden.
    info_by_id = {info["id"]: info for info in manager.get_model_info()}
    for model_id in loaded:
        task = str(info_by_id.get(model_id, {}).get("task") or "")
        if task not in ("llm", "nlu"):
            warmup_failed[model_id] = f"kein Text-Task ({task or '-'}) – Warmup braucht Audio"
            continue
        try:
            model_started = time.time()
            manager.infer(task, model_id, {"prompt": "ok", "text": "ok", "maxTokens": 1, "temperature": 0})
            warmed.append(model_id)
            warmup_ms[model_id] = int((time.time() - model_started) * 1000)
        except Exception as exc:  # noqa: BLE001 – Warmup darf den Job nie sprengen
            warmup_failed[model_id] = f"{type(exc).__name__}: {exc}"[:160]

    duration_ms = int((time.time() - started) * 1000)
    log_event(
        "INFO",
        "warmup completed",
        role=role,
        loaded=loaded,
        warmed=warmed,
        warmupFailed=warmup_failed,
        warmupMs=warmup_ms,
        failed=failed,
        durationMs=duration_ms,
    )
    return {
        "status": "success",
        "task": "warmup",
        "model": "",
        "result": {
            "ready": not failed,
            "role": role,
            "loaded": loaded,
            "warmed": warmed,
            "warmupFailed": warmup_failed,
            "warmupMs": warmup_ms,
            "failed": failed,
        },
        "durationMs": duration_ms,
    }


def handler(job: Dict[str, Any]) -> Dict[str, Any]:
    """RunPod Serverless Handler: führt einen AI-Job aus."""
    if not isinstance(job, dict):
        return {"status": "error", "code": "INVALID_JOB", "message": "job must be an object"}

    raw_input = job.get("input", {})
    if not isinstance(raw_input, dict):
        return {"status": "error", "code": "INVALID_INPUT", "message": "input must be an object"}

    task = str(raw_input.get("task", "")).strip()
    model = str(raw_input.get("model", "")).strip()
    payload = raw_input.get("input", {})
    if not isinstance(payload, dict):
        return {"status": "error", "code": "INVALID_PAYLOAD", "message": "input.input must be an object"}

    if not _SAFE_TASK_RE.fullmatch(task):
        return {"status": "error", "code": "INVALID_TASK", "message": "invalid task"}

    # `warmup` braucht kein Modell – es lädt die Preload-Modelle der eigenen Rolle.
    if task == "warmup":
        try:
            return _handle_warmup(_role() or "legacy")
        except Exception as exc:  # noqa: BLE001
            log_event("ERROR", "warmup failed", error=type(exc).__name__)
            return {"status": "error", "code": "WARMUP_FAILED", "message": "warmup failed"}

    # `predownload` füllt den persistenten HF-Cache (Network Volume): kein
    # Inferenz-Job, sondern eine einmalige Vorbereitung.
    if task == "predownload":
        try:
            return _handle_predownload(_role() or "legacy", payload)
        except Exception as exc:  # noqa: BLE001
            log_event("ERROR", "predownload failed", error=type(exc).__name__)
            return _with_detail(
                {"status": "error", "code": "PREDOWNLOAD_FAILED", "message": "predownload failed"},
                exc,
            )

    if not _SAFE_MODEL_RE.fullmatch(model):
        return {"status": "error", "code": "INVALID_MODEL", "message": "invalid model"}

    started = time.time()
    try:
        if not manager.is_loaded(model):
            log_event("INFO", "auto-load model", model=model)
            manager.load(model)
        result = manager.infer(task, model, payload)
        duration_ms = int((time.time() - started) * 1000)
        log_event("INFO", "inference completed", task=task, model=model, durationMs=duration_ms)
        return {
            "status": "success",
            "task": task,
            "model": model,
            "result": result,
            "durationMs": duration_ms,
        }
    except ModelUnavailableError as exc:
        log_event("WARN", f"model unavailable: {exc}", task=task, model=model, error=str(exc))
        return _with_detail(
            {"status": "error", "code": "MODEL_UNAVAILABLE", "model": model, "message": "model unavailable"},
            exc,
        )
    except Exception as exc:  # noqa: BLE001 – generischer Fehler, keine Details nach außen
        log_event("ERROR", "inference failed", task=task, model=model, error=type(exc).__name__)
        return _with_detail(
            {"status": "error", "code": "INFERENCE_FAILED", "model": model, "message": "inference failed"},
            exc,
        )


def main() -> None:
    if runpod is None:
        print("ERROR: runpod SDK nicht installiert – Serverless-Worker kann nicht starten.", file=sys.stderr)
        raise SystemExit(1)

    _init_manager()
    if not _ready:
        print("ERROR: ModelManager konnte nicht initialisiert werden.", file=sys.stderr)
        raise SystemExit(2)

    if os.environ.get("AI_RUNPOD_PRELOAD", "1").strip() not in ("0", "false", "False"):
        threading.Thread(target=_preload_background, daemon=True).start()

    log_event("INFO", "starting runpod serverless worker", role=_role() or "legacy")
    runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
