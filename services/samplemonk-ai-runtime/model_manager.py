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

try:  # CUDA ist optional – der Manager degradiert kontrolliert ohne torch.
    import torch  # type: ignore

    _HAS_TORCH = True
except Exception:  # pragma: no cover – Umgebungsabhängig
    torch = None  # type: ignore
    _HAS_TORCH = False


class ModelUnavailableError(RuntimeError):
    """Modell ist nicht geladen bzw. kann nicht geladen werden."""


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
        return cls(
            id=str(data["id"]),
            repository=str(data["repository"]),
            revision=str(data.get("revision", "")),
            task=str(data.get("task", "unknown")),
            framework=str(data.get("framework", "transformers")),
            estimatedVRAM=float(data.get("estimatedVRAM", 2.0)),
            estimatedRAM=float(data.get("estimatedRAM", 4.0)),
            loadPriority=int(data.get("loadPriority", 10)),
            preload=bool(data.get("preload", False)),
            loadClass=str(data.get("loadClass", "ON_DEMAND")).upper(),
            quantization=str(data.get("quantization", "fp16")),
            dependencies=list(data.get("dependencies", [])),
            inputFormats=list(data.get("inputFormats", [])),
            outputFormats=list(data.get("outputFormats", [])),
            maxDuration=float(data.get("maxDuration", 30.0)),
            concurrency=int(data.get("concurrency", 1)),
            timeout=float(data.get("timeout", 120.0)),
            license=str(data.get("license", "unknown")),
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
            finally:
                self._loading.discard(model_id)

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
            if _HAS_TORCH and torch is not None and torch.cuda.is_available():
                torch.cuda.empty_cache()  # CUDA Memory sauber freigeben

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
