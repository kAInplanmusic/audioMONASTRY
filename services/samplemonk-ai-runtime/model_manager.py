"""
SampleMONK AI Runtime – Model Manager
=====================================
Echter Model Manager: load/unload/isLoaded/getStatus/getMemoryUsage/
getModelInfo/preload/warmup/evict.

Regeln:
- Kein Modell wird blind geladen. Vor jedem Load wird VRAM geprüft
  (available = budget - used - safetyMargin).
- Parallele identische Load-Requests werden dedupliziert (loading-Set).
- Bei VRAM-Engpass: LRU-Eviction (nie CORE), dann Retry, dann kontrollierter
  Fehler – kein OOM-Crash als normaler Kontrollfluss.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import os
import re

try:  # CUDA ist optional – der Manager degradiert kontrolliert ohne torch.
    import torch  # type: ignore

    _HAS_TORCH = True
except Exception:  # pragma: no cover – Umgebungsabhängig
    torch = None  # type: ignore
    _HAS_TORCH = False


class ModelUnavailableError(RuntimeError):
    """Modell ist nicht geladen bzw. kann nicht geladen werden."""


_ALLOWED_LOAD_CLASSES = {"CORE", "FREQUENT", "ON_DEMAND", "RARE"}
_ALLOWED_FRAMEWORKS = {"transformers", "ctranslate2", "vllm", "sentence-transformers", "custom"}
_ALLOWED_QUANTIZATIONS = {"fp16", "bf16", "fp32", "int8", "int4", "none"}
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_REPOSITORY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$")
_SAFE_REVISION_RE = re.compile(r"^[A-Za-z0-9._/-]{1,128}$")


def _finite_float(value: Any, default: float, field_name: str) -> float:
    import math
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid {field_name}: expected number") from exc
    if not math.isfinite(parsed) or parsed < 0:
        raise ValueError(f"invalid {field_name}: must be a finite positive number")
    return parsed


def _finite_int(value: Any, default: int, field_name: str) -> int:
    parsed = _finite_float(value, float(default), field_name)
    return int(parsed)


@dataclass
class ModelDefinition:
    id: str
    repository: str
    revision: str
    task: str
    framework: str = "transformers"
    estimatedVRAM: float = 2.0
    estimatedRAM: float = 4.0
    loadPriority: int = 10
    preload: bool = False
    loadClass: str = "ON_DEMAND"  # CORE | FREQUENT | ON_DEMAND | RARE
    quantization: str = "fp16"
    dependencies: List[str] = field(default_factory=list)
    inputFormats: List[str] = field(default_factory=list)
    outputFormats: List[str] = field(default_factory=list)
    maxDuration: float = 30.0
    concurrency: int = 1
    timeout: float = 120.0
    license: str = "unknown"

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ModelDefinition":
        if not isinstance(data, dict):
            raise ValueError("model definition must be an object")
        model_id = str(data.get("id", "")).strip()
        repository = str(data.get("repository", "")).strip()
        revision = str(data.get("revision", "")).strip()
        load_class = str(data.get("loadClass", "ON_DEMAND")).strip().upper()
        framework = str(data.get("framework", "transformers")).strip().lower()
        quantization = str(data.get("quantization", "fp16")).strip().lower()

        if not _SAFE_ID_RE.fullmatch(model_id):
            raise ValueError(f"invalid model id: {model_id!r}")
        if not _SAFE_REPOSITORY_RE.fullmatch(repository):
            raise ValueError(f"invalid repository: {repository!r}")
        if revision and not _SAFE_REVISION_RE.fullmatch(revision):
            raise ValueError("invalid revision: only letters, digits, . _ / - are allowed")
        if load_class not in _ALLOWED_LOAD_CLASSES:
            raise ValueError(f"invalid loadClass: {load_class!r}")
        if framework not in _ALLOWED_FRAMEWORKS:
            raise ValueError(f"invalid framework: {framework!r}")
        if quantization not in _ALLOWED_QUANTIZATIONS:
            raise ValueError(f"invalid quantization: {quantization!r}")
        if not isinstance(data.get("dependencies", []), list):
            raise ValueError("dependencies must be a list")
        if not isinstance(data.get("inputFormats", []), list):
            raise ValueError("inputFormats must be a list")
        if not isinstance(data.get("outputFormats", []), list):
            raise ValueError("outputFormats must be a list")

        return cls(
            id=model_id,
            repository=repository,
            revision=revision,
            task=str(data.get("task", "unknown")).strip()[:64],
            framework=framework,
            estimatedVRAM=_finite_float(data.get("estimatedVRAM", 2.0), 2.0, "estimatedVRAM"),
            estimatedRAM=_finite_float(data.get("estimatedRAM", 4.0), 4.0, "estimatedRAM"),
            loadPriority=_finite_int(data.get("loadPriority", 10), 10, "loadPriority"),
            preload=bool(data.get("preload", False)),
            loadClass=load_class,
            quantization=quantization,
            dependencies=list(data.get("dependencies", [])),
            inputFormats=list(data.get("inputFormats", [])),
            outputFormats=list(data.get("outputFormats", [])),
            maxDuration=_finite_float(data.get("maxDuration", 30.0), 30.0, "maxDuration"),
            concurrency=_finite_int(data.get("concurrency", 1), 1, "concurrency"),
            timeout=_finite_float(data.get("timeout", 120.0), 120.0, "timeout"),
            license=str(data.get("license", "unknown")).strip()[:128],
        )


class ModelManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._models: Dict[str, ModelDefinition] = {}
        self._loaded: Dict[str, float] = {}          # id -> lastUsed ts
        self._loading: set[str] = set()
        self._errors: Dict[str, str] = {}
        self._budget_vram_gb = 80.0
        self._safety_margin_gb = 6.0
        self._device = os_env_device()
        self._used_vram_gb = 0.0
        self._inference_count = 0
        # FA-P0-2: echte Modell-Instanzen cachen; Handler nutzen diese Instanz
        # statt pro Request `from_pretrained` aufzurufen.
        self._instances: Dict[str, Any] = {}
        self._loader = None  # Callable(model_id, definition) -> instance

    # ------------------------------------------------------------------ Config
    def configure(self, manifest: Dict[str, Any]) -> None:
        with self._lock:
            runtime = manifest.get("runtime", {})
            self._budget_vram_gb = float(runtime.get("vramBudgetGb", 80.0))
            self._safety_margin_gb = float(runtime.get("vramSafetyMarginGb", 6.0))
            if runtime.get("device") and not os.environ.get("AI_RUNTIME_DEVICE"):
                self._device = str(runtime["device"])
            self._models = {}
            for item in manifest.get("models", []):
                definition = ModelDefinition.from_dict(item)
                self._models[definition.id] = definition

    # ------------------------------------------------------------------ GPU
    def gpu_state(self) -> Dict[str, Any]:
        if self._device == "cuda" and _HAS_TORCH and torch is not None and torch.cuda.is_available():
            total = float(torch.cuda.get_device_properties(0).total_memory) / 1024**3
            reserved = float(torch.cuda.memory_reserved(0)) / 1024**3
            return {"available": True, "device": "cuda", "name": torch.cuda.get_device_name(0),
                    "totalGb": round(total, 1), "usedGb": round(reserved, 1)}
        if self._device == "simulated":
            return {"available": True, "device": "simulated",
                    "totalGb": self._budget_vram_gb, "usedGb": round(self._used_vram_gb, 1)}
        return {"available": False, "device": self._device or "unavailable",
                "totalGb": self._budget_vram_gb, "usedGb": 0.0}

    def _available_vram_gb(self) -> float:
        return max(0.0, self._budget_vram_gb - self._used_vram_gb - self._safety_margin_gb)

    # ------------------------------------------------------------------ Load
    def preload(self) -> None:
        """CORE zuerst, dann FREQUENT nach loadPriority – unter VRAM-Budget."""
        ordered = sorted(
            (m for m in self._models.values() if m.loadClass in ("CORE", "FREQUENT")),
            key=lambda m: (m.loadClass != "CORE", m.loadPriority),
        )
        for definition in ordered:
            try:
                self.load(definition.id)
            except ModelUnavailableError as exc:
                self._errors[definition.id] = str(exc)

    def load(self, model_id: str) -> None:
        with self._lock:
            definition = self._models.get(model_id)
            if definition is None:
                raise ModelUnavailableError(f"unknown model: {model_id}")
            if model_id in self._loaded:
                self._loaded[model_id] = time.time()
                return
            if model_id in self._loading:
                raise ModelUnavailableError(f"model already loading: {model_id}")

            self._loading.add(model_id)
            try:
                self._load_locked(definition, attempt=0)
                if self._loader is not None:
                    instance = self._loader(definition.id, definition)
                    self._instances[definition.id] = instance
            except Exception:
                # Lade-Fehler hinterlassen keinen halb geladenen Zustand.
                self._loaded.pop(model_id, None)
                self._instances.pop(model_id, None)
                raise
            finally:
                self._loading.discard(model_id)

    def set_loader(self, loader) -> None:
        """Injizierbaren Modell-Loader setzen (FA-P0-2, testbar ohne GPU)."""
        with self._lock:
            self._loader = loader

    def get_instance(self, model_id: str):
        """Gibt die gecachte Modell-Instanz zurück (oder None)."""
        with self._lock:
            return self._instances.get(model_id)

    def _load_locked(self, definition: ModelDefinition, attempt: int) -> None:
        required = definition.estimatedVRAM
        if required > self._available_vram_gb():
            evicted = self._evict_for(required)
            if evicted:
                time.sleep(0.2)  # GPU-Freigabe abwarten
            if required > self._available_vram_gb():
                if attempt == 0 and evicted:
                    self._load_locked(definition, attempt=1)
                raise ModelUnavailableError(
                    f"VRAM exhausted for {definition.id} (required {required} GB, "
                    f"available {self._available_vram_gb():.1f} GB)"
                )
        self._used_vram_gb += required
        self._loaded[definition.id] = time.time()
        self._errors.pop(definition.id, None)

    def _evict_for(self, required_gb: float) -> bool:
        """LRU-Eviction (nie CORE), bis genug VRAM frei ist."""
        candidates = [
            (ts, mid) for mid, ts in self._loaded.items()
            if self._models.get(mid) and self._models[mid].loadClass != "CORE"
        ]
        candidates.sort(key=lambda pair: pair[0])
        evicted = False
        for _ts, mid in candidates:
            if required_gb <= self._available_vram_gb():
                break
            self.unload(mid)
            evicted = True
        return evicted

    # ------------------------------------------------------------------ Unload
    def unload(self, model_id: str) -> None:
        with self._lock:
            if model_id not in self._loaded:
                return
            definition = self._models.get(model_id)
            self._used_vram_gb = max(0.0, self._used_vram_gb - (definition.estimatedVRAM if definition else 0.0))
            del self._loaded[model_id]
            self._instances.pop(model_id, None)
            if (
                os.environ.get("AI_CUDA_EMPTY_CACHE_ON_UNLOAD", "0") == "1"
                and _HAS_TORCH
                and torch is not None
                and torch.cuda.is_available()
            ):
                # Optional: CUDA-Cache bewusst NICHT im Standard-Unload leeren,
                # weil empty_cache() Latenzspitzen verursachen kann (Echtzeit).
                torch.cuda.empty_cache()

    # ------------------------------------------------------------------ Query
    def is_loaded(self, model_id: str) -> bool:
        with self._lock:
            return model_id in self._loaded

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            # FA-P1-2: Alle Klassen IMMER liefern (kein KeyError, kein toter on_demand-Key).
            by_class: Dict[str, str] = {"core": "available", "frequent": "available", "onDemand": "available", "rare": "available"}
            for definition in self._models.values():
                state = "loaded" if definition.id in self._loaded else (
                    "error" if definition.id in self._errors else "available")
                if definition.loadClass == "CORE":
                    by_class["core"] = self._worst(by_class["core"], state)
                elif definition.loadClass == "FREQUENT":
                    by_class["frequent"] = self._worst(by_class["frequent"], state)
                elif definition.loadClass == "RARE":
                    by_class["rare"] = self._worst(by_class["rare"], state)
                else:
                    by_class["onDemand"] = self._worst(by_class["onDemand"], state)
            return by_class

    @staticmethod
    def _worst(a: str, b: str) -> str:
        order = {"available": 0, "loaded": 1, "error": 2}
        return b if order.get(b, 0) > order.get(a, 0) else a

    def get_model_info(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [
                {
                    "id": m.id,
                    "repository": m.repository,
                    "revision": m.revision,
                    "task": m.task,
                    "loadClass": m.loadClass,
                    "loaded": m.id in self._loaded,
                    "estimatedVRAM": m.estimatedVRAM,
                    "license": m.license,
                }
                for m in sorted(self._models.values(), key=lambda x: x.id)
            ]

    def get_metrics(self) -> Dict[str, Any]:
        with self._lock:
            gpu = self.gpu_state()
            return {
                "models_loaded": len(self._loaded),
                "models_total": len(self._models),
                "vram_used_gb": gpu.get("usedGb", 0.0),
                "inference_count": self._inference_count,
            }

    # ------------------------------------------------------------------ Warmup
    def warmup(self, model_id: str) -> None:
        if not self.is_loaded(model_id):
            self.load(model_id)
        # Echte Warmup-Inferenz übernehmen die Handler; hier nur Buchführung.

    # ------------------------------------------------------------------ Infer
    def infer(self, task: str, model_id: str, payload: Dict[str, Any]) -> Any:
        with self._lock:
            if model_id not in self._loaded:
                raise ModelUnavailableError(f"model not loaded: {model_id}")
            definition = self._models.get(model_id)
            if definition is None:
                raise ModelUnavailableError(f"unknown model: {model_id}")
            self._loaded[model_id] = time.time()
            self._inference_count += 1
        from handlers import run_inference

        return run_inference(task, model_id, definition, payload)

    def shutdown(self) -> None:
        with self._lock:
            for mid in list(self._loaded.keys()):
                self.unload(mid)


def os_env_device() -> str:
    import os

    value = (os.environ.get("AI_RUNTIME_DEVICE") or "").strip().lower()
    if value in ("cuda", "cpu", "simulated"):
        return value
    if _HAS_TORCH and torch is not None and torch.cuda.is_available():
        return "cuda"
    return "simulated"  # kontrollierter Degradationsmodus ohne GPU
