"""FLEET-P1-011 – VRAM-Messung **im Pod**, nicht auf der Agenten-Maschine.

Warum dieses Modul existiert
----------------------------
`scripts/vram_measure.py` (2026-10-13) las `device 0` der Agenten-Maschine bzw.
rief dort `nvidia-smi` auf; `simulate_concurrent_users` war ein `time.sleep` ohne
GPU-Wirkung. Ergebnis: `{"error": "No such file or directory: 'nvidia-smi'"}`.
Die Messung muss dort laufen, wo die Gewichte liegen – im Runtime-Container
(`services/audiomonastry-ai-runtime/`, torch + CUDA). Dieses Modul ist die
Mess-Sonde; `app.py` stellt sie unter `GET/POST /vram/report` bereit,
`scripts/collect-vram-report.py` holt sie je Pod-Rolle ab.

Was gemessen wird
-----------------
* **Gerätesicht** (`torch.cuda.mem_get_info`): `total - free` = wirklich belegter
  Speicher der Karte, inklusive fremder Prozesse – dieselbe Zahl wie `nvidia-smi`.
* **Prozesssicht** (`torch.cuda.memory_allocated` / `memory_reserved`): nur was
  dieser Runtime-Prozess hält (Allokator-Pool).
* **Prozess-Spitze** (`torch.cuda.max_memory_allocated`): Spitze seit dem letzten
  `reset_peak_memory_stats()` – der Sampler setzt die Statistik zu Beginn des
  Messfensters zurück, damit die Spitze das Fenster meint und nicht die
  Prozess-Lebenszeit.
* **Rückfall** ohne torch/CUDA: `nvidia-smi --query-gpu=...` (Gerätesicht, keine
  Prozess-Spitze). Fehlt beides, sagt der Report das ausdrücklich
  (`gpu.gpuVisible=false`, `notes`), statt Nullwerte als Messung auszugeben.

Phasen
------
`cold`   – Momentaufnahme vor dem Laden der Modelle (setzt `app.py` beim Import),
`warmup` – nach `ModelManager.preload()` (residente Modelle im VRAM),
`load`   – Momentaufnahme am Ende eines Lastfensters; Spitze/Mittel des Fensters
           stehen unter `load.devices` (peakMb/avgMb).

Keine Abhängigkeit außer torch (stdlib + optional nvidia-smi als Unterprozess).
"""
from __future__ import annotations

import math
import os
import platform
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence

TICKET = "FLEET-P1-011"
SCHEMA_VERSION = 1
MIB = 1024.0 * 1024.0
#: 42 GB nutzbar je A40 (48 GB minus 6 GB Marge) – dieselbe Grenze wie
#: `USABLE_VRAM_GB` in scripts/runpod-pods.py und `roles.*.vramBudgetGb`.
BUDGET_MB = 42 * 1024
#: Obergrenze gegen unbegrenztes Wachstum, wenn jemand ein langes Fenster startet.
MAX_SAMPLES = 20000
#: Schlaf-Scheibe im Sampler: so schnell reagiert `stop()` auf einen Abbruch.
STOP_SLICE_S = 0.25
_UNSET = object()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def to_mb(value: Optional[int | float]) -> Optional[float]:
    """Bytes → MiB (1 Nachkommastelle). `None` bleibt `None` (nicht 0!)."""
    if value is None:
        return None
    return round(float(value) / MIB, 1)


def clamp_float(value: Any, low: float, high: float, default: float) -> float:
    """Zahl aus einem HTTP-Body, hart begrenzt; Müll → Default (nie 500)."""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(parsed):
        return default
    return min(high, max(low, parsed))


def clamp_int(value: Any, low: int, high: int, default: int) -> int:
    return int(clamp_float(value, float(low), float(high), float(default)))


def _import_torch() -> Any:
    """torch ist im Pod-Image da, im Test/auf der Agenten-Maschine oft nicht."""
    try:
        import torch  # type: ignore

        return torch
    except Exception:  # noqa: BLE001 – fehlendes torch ist ein gültiger Zustand
        return None


def run_nvidia_smi(fields: Sequence[str]) -> Optional[List[List[str]]]:
    """`nvidia-smi --query-gpu=<fields>` als Zeilen/Spalten; None = nicht verfügbar."""
    try:
        result = subprocess.run(
            ["nvidia-smi", f"--query-gpu={','.join(fields)}", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:  # noqa: BLE001 – kein Binary, kein Treiber, kein Container
        return None
    if result.returncode != 0:
        return None
    rows = [[cell.strip() for cell in line.split(",")] for line in result.stdout.splitlines() if line.strip()]
    return rows or None


@dataclass
class DeviceSnapshot:
    """Belegung einer Karte zu einem Zeitpunkt (Bytes, Quelle)."""

    index: int
    name: str
    total_bytes: int
    used_bytes: int
    free_bytes: int
    source: str
    torch_allocated_bytes: Optional[int] = None
    torch_reserved_bytes: Optional[int] = None
    torch_peak_allocated_bytes: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "name": self.name,
            "source": self.source,
            "totalMb": to_mb(self.total_bytes),
            "usedMb": to_mb(self.used_bytes),
            "freeMb": to_mb(self.free_bytes),
            "usedPercent": round(100.0 * self.used_bytes / self.total_bytes, 1) if self.total_bytes else None,
            "torchAllocatedMb": to_mb(self.torch_allocated_bytes),
            "torchReservedMb": to_mb(self.torch_reserved_bytes),
            "torchPeakAllocatedMb": to_mb(self.torch_peak_allocated_bytes),
            # Rohbytes: Aggregation rechnet damit exakt, ohne Rundungsverluste.
            "totalBytes": int(self.total_bytes),
            "usedBytes": int(self.used_bytes),
            "torchAllocatedBytes": self.torch_allocated_bytes,
            "torchPeakAllocatedBytes": self.torch_peak_allocated_bytes,
        }


class LoadSampler:
    """Sammelt während eines Zeitfensters GPU-Belegung und aggregiert Spitze + Mittel.

    Der Sampler läuft in einem eigenen Thread, damit die Inferenz-Anfragen der
    4 Nutzer (die den Event-Loop des Pods blockieren können) die Messung nicht
    anhalten. Die Last selbst erzeugt der Aufrufer (scripts/collect-vram-report.py
    schickt 4 parallele `POST /infer`); dieser Sampler misst nur.
    """

    def __init__(
        self,
        probe: "VramProbe",
        duration_s: float = 20.0,
        interval_s: float = 0.5,
        users: int = 4,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self.probe = probe
        self.duration_s = max(0.1, float(duration_s))
        self.interval_s = max(0.05, float(interval_s))
        self.users = max(1, int(users))
        self._clock = clock
        self._sleep = sleeper
        self._lock = threading.Lock()
        self._samples: List[Dict[str, Any]] = []
        self._running = False
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.started_at: Optional[str] = None
        self.finished_at: Optional[str] = None
        self.final_snapshot: Optional[Dict[str, Any]] = None

    # ------------------------------------------------------------------ Lauf
    @property
    def running(self) -> bool:
        return self._running

    @property
    def samples(self) -> List[Dict[str, Any]]:
        with self._lock:
            return list(self._samples)

    def start(self) -> bool:
        """Startet den Sampler-Thread. False = es läuft bereits einer."""
        with self._lock:
            if self._running:
                return False
            self._running = True
            self._stop.clear()
        self.started_at = now_iso()
        self._thread = threading.Thread(target=self._run_guarded, name="vram-sampler", daemon=True)
        self._thread.start()
        return True

    def _run_guarded(self) -> None:
        try:
            self.run()
        finally:
            with self._lock:
                self._running = False
            self.finished_at = now_iso()
            try:
                self.final_snapshot = self.probe.capture("load")
            except Exception:  # noqa: BLE001 – ein fehlender Abschluss-Snapshot kippt nichts
                self.final_snapshot = None

    def run(self) -> None:
        """Blockierend bis Fensterende/`stop()` – auch direkt (Test, Skript) nutzbar."""
        # Prozess-Spitze auf Fensterbeginn zurücksetzen: sonst meldet
        # `max_memory_allocated` die Spitze der gesamten Prozess-Lebenszeit.
        self.probe.reset_peak_stats()
        started = self._clock()
        while not self._stop.is_set():
            try:
                snapshot = self.probe.snapshot()
            except Exception as exc:  # noqa: BLE001 – ein Fehl-Sample beendet die Messung nicht
                snapshot = {
                    "capturedAt": now_iso(),
                    "source": "none",
                    "cudaAvailable": False,
                    "gpuVisible": False,
                    "devices": [],
                    "notes": [f"sample_failed:{type(exc).__name__}"],
                }
            with self._lock:
                if len(self._samples) < MAX_SAMPLES:
                    self._samples.append(snapshot)
            elapsed = self._clock() - started
            remaining = self.duration_s - elapsed
            if remaining <= 0:
                break
            # In kurzen Scheiben schlafen, damit `stop()` nicht ein ganzes
            # Intervall lang warten muss (HTTP-Abbruch, Testlauf).
            target = elapsed + min(self.interval_s, remaining)
            while not self._stop.is_set():
                elapsed = self._clock() - started
                if elapsed >= target:
                    break
                self._sleep(min(STOP_SLICE_S, target - elapsed))

    def stop(self) -> None:
        self._stop.set()

    def wait(self, timeout_s: float) -> bool:
        """Wartet auf das Thread-Ende; True = fertig."""
        thread = self._thread
        if thread is None:
            return True
        thread.join(max(0.0, float(timeout_s)))
        return not thread.is_alive()

    # -------------------------------------------------------------- Auswertung
    def aggregate(self) -> Dict[str, Any]:
        """Spitze + Durchschnitt je Device über alle Samples des Fensters."""
        samples = self.samples
        per_device: Dict[int, Dict[str, Any]] = {}
        for snapshot in samples:
            for device in snapshot.get("devices") or []:
                index = int(device.get("index", 0))
                entry = per_device.setdefault(
                    index,
                    {
                        "index": index,
                        "name": device.get("name", ""),
                        "totalBytes": int(device.get("totalBytes") or 0),
                        "usedCount": 0,
                        "sumUsedBytes": 0,
                        "peakUsedBytes": 0,
                        "allocCount": 0,
                        "sumAllocatedBytes": 0,
                        "peakAllocatedBytes": 0,
                        "peakTorchReportedBytes": 0,
                    },
                )
                used = int(device.get("usedBytes") or 0)
                entry["usedCount"] += 1
                entry["sumUsedBytes"] += used
                entry["peakUsedBytes"] = max(entry["peakUsedBytes"], used)
                allocated = device.get("torchAllocatedBytes")
                if allocated is not None:
                    allocated = int(allocated)
                    entry["allocCount"] += 1
                    entry["sumAllocatedBytes"] += allocated
                    entry["peakAllocatedBytes"] = max(entry["peakAllocatedBytes"], allocated)
                reported_peak = device.get("torchPeakAllocatedBytes")
                if reported_peak is not None:
                    entry["peakTorchReportedBytes"] = max(entry["peakTorchReportedBytes"], int(reported_peak))

        devices: List[Dict[str, Any]] = []
        for index in sorted(per_device):
            entry = per_device[index]
            peak_used = entry["peakUsedBytes"]
            avg_used = entry["sumUsedBytes"] / entry["usedCount"] if entry["usedCount"] else 0
            avg_allocated = entry["sumAllocatedBytes"] / entry["allocCount"] if entry["allocCount"] else None
            peak_torch = max(entry["peakAllocatedBytes"], entry["peakTorchReportedBytes"]) or None
            devices.append(
                {
                    "index": index,
                    "name": entry["name"],
                    "samples": entry["usedCount"],
                    "totalMb": to_mb(entry["totalBytes"]),
                    "peakMb": to_mb(peak_used),
                    "avgMb": to_mb(avg_used),
                    "peakUsedPercent": round(100.0 * peak_used / entry["totalBytes"], 1) if entry["totalBytes"] else None,
                    "peakTorchAllocatedMb": to_mb(peak_torch),
                    "avgTorchAllocatedMb": to_mb(avg_allocated),
                }
            )

        # Summe über alle Karten (bei einer A40 ist das genau deren Spitze).
        peak_total = sum(per_device[i]["peakUsedBytes"] for i in per_device)
        avg_total = sum(
            (per_device[i]["sumUsedBytes"] / per_device[i]["usedCount"]) if per_device[i]["usedCount"] else 0
            for i in per_device
        )
        return {
            "gpuVisible": bool(devices),
            "devices": devices,
            "peakMb": to_mb(peak_total) if devices else None,
            "avgMb": to_mb(avg_total) if devices else None,
            "peakBytes": peak_total if devices else None,
            "avgBytes": round(avg_total, 1) if devices else None,
        }

    def state(self) -> Dict[str, Any]:
        aggregated = self.aggregate()
        with self._lock:
            sample_count = len(self._samples)
            running = self._running
        return {
            "running": running,
            "users": self.users,
            "durationSeconds": round(self.duration_s, 3),
            "intervalSeconds": round(self.interval_s, 3),
            "sampleCount": sample_count,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "finalSnapshot": self.final_snapshot,
            **aggregated,
        }


class VramProbe:
    """Mess-Sonde eines Pods: Snapshots, Phasen, Lastfenster, Report.

    `torch_module`/`smi_runner` sind injizierbar, damit die Tests ohne GPU und
    ohne nvidia-smi den echten Pfad (inkl. Rückfall) durchspielen können.
    """

    def __init__(
        self,
        role: str = "",
        *,
        torch_module: Any = _UNSET,
        smi_runner: Optional[Callable[[Sequence[str]], Optional[List[List[str]]]]] = None,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self.role = role
        self._torch_fixed = torch_module is not _UNSET
        self._torch_cache: Any = torch_module if self._torch_fixed else _UNSET
        self._smi = smi_runner or run_nvidia_smi
        self.clock = clock
        self.sleeper = sleeper
        self._lock = threading.RLock()
        self.phases: Dict[str, Dict[str, Any]] = {}
        self._last: Optional[Dict[str, Any]] = None
        self._driver: Optional[str] = None
        self._driver_checked = False
        self._sampler: Optional[LoadSampler] = None

    # ------------------------------------------------------------------ torch
    def torch(self) -> Any:
        with self._lock:
            if self._torch_cache is _UNSET:
                self._torch_cache = _import_torch()
            return self._torch_cache

    def cuda_version(self) -> Optional[str]:
        torch_module = self.torch()
        if torch_module is None:
            return None
        try:
            value = str(getattr(getattr(torch_module, "version", None), "cuda", "") or "")
        except Exception:  # noqa: BLE001
            return None
        return value or None

    def driver_version(self) -> Optional[str]:
        """Treiberversion aus nvidia-smi (gehört in jeden Messbericht)."""
        with self._lock:
            if self._driver_checked:
                return self._driver
        rows = self._smi(["driver_version"])
        value = rows[0][0] if rows and rows[0] else None
        with self._lock:
            self._driver = value
            self._driver_checked = True  # auch "nicht verfügbar" cachen: kein Prozess je Report
        return value

    def reset_peak_stats(self) -> bool:
        """Setzt die torch-Peak-Statistik zurück, damit `max_memory_allocated`
        die Spitze DIESES Fensters meldet. Ohne CUDA: False (kein Fehler)."""
        torch_module = self.torch()
        if torch_module is None:
            return False
        try:
            torch_module.cuda.reset_peak_memory_stats()
            return True
        except Exception:  # noqa: BLE001
            return False

    # --------------------------------------------------------------- Snapshots
    def _torch_devices(self, torch_module: Any) -> List[DeviceSnapshot]:
        cuda = torch_module.cuda
        devices: List[DeviceSnapshot] = []
        for index in range(int(cuda.device_count())):
            try:
                name = str(cuda.get_device_name(index))
            except Exception:  # noqa: BLE001
                name = ""
            total = used = free = 0
            try:
                free_b, total_b = cuda.mem_get_info(index)
                total, free = int(total_b), int(free_b)
                used = max(0, total - free)
            except Exception:  # noqa: BLE001 – MIG/ältere torch-Versionen
                try:
                    total = int(cuda.get_device_properties(index).total_memory)
                except Exception:  # noqa: BLE001
                    total = 0
                try:
                    used = int(cuda.memory_allocated(index))
                except Exception:  # noqa: BLE001
                    used = 0
                free = max(0, total - used)
            try:
                allocated: Optional[int] = int(cuda.memory_allocated(index))
            except Exception:  # noqa: BLE001
                allocated = None
            try:
                reserved: Optional[int] = int(cuda.memory_reserved(index))
            except Exception:  # noqa: BLE001
                reserved = None
            try:
                peak: Optional[int] = int(cuda.max_memory_allocated(index))
            except Exception:  # noqa: BLE001
                peak = None
            if peak is not None and allocated is not None:
                peak = max(peak, allocated)
            devices.append(
                DeviceSnapshot(
                    index=index,
                    name=name,
                    total_bytes=total,
                    used_bytes=used,
                    free_bytes=free,
                    source="torch",
                    torch_allocated_bytes=allocated,
                    torch_reserved_bytes=reserved,
                    torch_peak_allocated_bytes=peak,
                )
            )
        return devices

    def _smi_devices(self) -> List[DeviceSnapshot]:
        rows = self._smi(["index", "name", "memory.total", "memory.used"])
        devices: List[DeviceSnapshot] = []
        for row in rows or []:
            if len(row) < 4:
                continue
            try:
                index = int(row[0])
                total = int(float(row[2]) * MIB)  # nounits = MiB
                used = int(float(row[3]) * MIB)
            except ValueError:
                continue
            devices.append(
                DeviceSnapshot(
                    index=index,
                    name=row[1],
                    total_bytes=total,
                    used_bytes=used,
                    free_bytes=max(0, total - used),
                    source="nvidia-smi",
                )
            )
        return devices

    def snapshot(self) -> Dict[str, Any]:
        """Eine Momentaufnahme je Device. torch zuerst, nvidia-smi als Rückfall."""
        notes: List[str] = []
        devices: List[DeviceSnapshot] = []
        cuda_available = False
        torch_module = self.torch()
        if torch_module is None:
            notes.append("torch_not_installed")
        else:
            try:
                cuda_available = bool(getattr(torch_module, "cuda", None) is not None and torch_module.cuda.is_available())
            except Exception as exc:  # noqa: BLE001
                notes.append(f"cuda_is_available_failed:{type(exc).__name__}")
                cuda_available = False
            if cuda_available:
                try:
                    devices = self._torch_devices(torch_module)
                except Exception as exc:  # noqa: BLE001
                    notes.append(f"torch_read_failed:{type(exc).__name__}")
            else:
                notes.append("cuda_unavailable")

        source = "torch" if devices else "none"
        if not devices:
            devices = self._smi_devices()
            if devices:
                source = "nvidia-smi"
                notes.append("fallback_nvidia-smi")
            else:
                notes.append("no_gpu_visible")

        snapshot = {
            "capturedAt": now_iso(),
            "source": source,
            "cudaAvailable": cuda_available,
            "gpuVisible": bool(devices),
            "devices": [device.to_dict() for device in devices],
            "notes": notes,
        }
        with self._lock:
            self._last = snapshot
        return snapshot

    def capture(self, label: str) -> Dict[str, Any]:
        """Snapshot unter einem Phasennamen ablegen (`cold`, `warmup`, `load`, …).

        Wirft nie: ein fehlgeschlagener Snapshot wird als Phase mit `notes`
        abgelegt, damit der Start des Pods davon unberührt bleibt.
        """
        key = (label or "manual").strip()[:32] or "manual"
        try:
            phase = dict(self.snapshot())
        except Exception as exc:  # noqa: BLE001
            phase = {
                "capturedAt": now_iso(),
                "source": "none",
                "cudaAvailable": False,
                "gpuVisible": False,
                "devices": [],
                "notes": [f"snapshot_failed:{type(exc).__name__}"],
            }
        phase["label"] = key
        with self._lock:
            self.phases[key] = phase
        return phase

    # ------------------------------------------------------------ Lastfenster
    def start_load(self, duration_s: float = 20.0, interval_s: float = 0.5, users: int = 4) -> bool:
        """Startet das Lastfenster im Hintergrund. False = es läuft schon eins."""
        with self._lock:
            if self._sampler is not None and self._sampler.running:
                return False
            sampler = LoadSampler(
                self,
                duration_s=duration_s,
                interval_s=interval_s,
                users=users,
                clock=self.clock,
                sleeper=self.sleeper,
            )
            self._sampler = sampler
        return sampler.start()

    def stop_load(self) -> None:
        with self._lock:
            sampler = self._sampler
        if sampler is not None:
            sampler.stop()

    def load_state(self) -> Dict[str, Any]:
        with self._lock:
            sampler = self._sampler
        if sampler is None:
            return {
                "running": False,
                "sampleCount": 0,
                "devices": [],
                "peakMb": None,
                "avgMb": None,
                "gpuVisible": False,
            }
        return sampler.state()

    def wait_for_load(self, timeout_s: float = 5.0) -> bool:
        with self._lock:
            sampler = self._sampler
        if sampler is None:
            return True
        return sampler.wait(timeout_s)

    # ------------------------------------------------------------------ Report
    def _gpu_summary(self, snapshot: Dict[str, Any]) -> Dict[str, Any]:
        devices = snapshot.get("devices") or []
        total = sum(int(device.get("totalBytes") or 0) for device in devices)
        used = sum(int(device.get("usedBytes") or 0) for device in devices)
        process_peak = max(
            (int(device.get("torchPeakAllocatedBytes") or 0) for device in devices), default=0
        )
        return {
            "source": snapshot.get("source", "none"),
            "gpuVisible": bool(snapshot.get("gpuVisible")),
            "cudaAvailable": bool(snapshot.get("cudaAvailable")),
            "deviceCount": len(devices),
            "names": [device.get("name", "") for device in devices],
            "driverVersion": self.driver_version(),
            "cudaVersion": self.cuda_version(),
            "totalMb": to_mb(total) if devices else None,
            "usedMb": to_mb(used) if devices else None,
            "usedPercent": round(100.0 * used / total, 1) if total else None,
            "processPeakAllocatedMb": to_mb(process_peak) if devices else None,
            "notes": list(snapshot.get("notes") or []),
        }

    def report(self) -> Dict[str, Any]:
        with self._lock:
            phases = {label: dict(phase) for label, phase in self.phases.items()}
            last = self._last
        if last is None:
            last = self.snapshot()
        load = self.load_state()
        peak_mb = load.get("peakMb")
        return {
            "schemaVersion": SCHEMA_VERSION,
            "ticket": TICKET,
            "collectedAt": now_iso(),
            "runtime": {
                "role": self.role,
                "pid": os.getpid(),
                "host": platform.node(),
                "python": platform.python_version(),
            },
            "gpu": self._gpu_summary(last),
            "phases": phases,
            "load": load,
            "verdict": {
                "budgetMb": BUDGET_MB,
                "peakMb": peak_mb,
                "avgMb": load.get("avgMb"),
                "withinBudget": None if peak_mb is None else bool(float(peak_mb) <= BUDGET_MB),
                "measured": bool(load.get("gpuVisible") and load.get("sampleCount")),
            },
        }
