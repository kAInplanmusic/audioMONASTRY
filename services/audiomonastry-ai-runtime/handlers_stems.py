"""
AudioMONASTRY AI Runtime – RP5 stems: MSST-Stem-Handler (FLEET-P1-006)
====================================================================
Ein Handler hinter ``stem.separate`` fuer die Modelle des stems-Pods
(docs/AI_FLEET_STARTPLAN.md, Abschnitt RP5):

- ``bs-roformer-sw-6stem`` – Hauptmodell, 6 Stems (bass, drums, other, vocals,
  guitar, piano) -> 5 stemMONK-Stems per Crossover (``stem_crossover``).
- ``scnet-xl-ihf`` – Fallback (kommerziell), 4 Stems (bass, drums, vocals,
  other); Melodie bleibt leer und das Ergebnis sagt es (``melodyAvailable``).
- ``mel-roformer-karaoke`` / ``mel-roformer-dereverb`` – NUR auf ausdruecklichen
  Wunsch (``payload.karaoke`` / ``payload.dereverb``), angewendet auf den
  Vocals-Stem.

Inferenz-Code: ZFTurbo/Music-Source-Separation-Training (MSST, MIT). Davon wird
NICHTS kopiert: dieses Modul ist ein duenner eigener Adapter, der die
Modellklassen aus einem MSST-Checkout importiert (``MSST_ROOT``, Pin siehe
``MSST_PIN``) und Chunking/Overlap-Add selbst macht (``stem_crossover``).
Fehlt MSST, fehlen Gewichte oder passt ein Hash nicht, bricht der Handler mit
klarer Meldung ab – es gibt KEINEN Rueckfall auf ein anderes Modell.

Gewichte: Repository UND Revision kommen aus dem Manifest-Eintrag
(``definition.repository`` / ``definition.revision``) und gehen unveraendert an
``huggingface_hub.hf_hub_download``; die Datei wird gegen den SHA-256 aus
``STEM_MODEL_SPECS`` geprueft (Quelle je Eintrag dokumentiert, nichts erfunden).
Modelle ohne Hash-Pin oder ohne HF-Repo werden abgelehnt.

Praezision: ``definition.quantization == "bf16"`` -> torch.autocast(bfloat16)
auf CUDA. Auf CPU laeuft fp32 (bf16-Autocast auf CPU ist langsam und hier nicht
gemessen).

NICHT auf GPU verifiziert (Stand 2026-10-13): Laden des Checkpoints in die
MSST-Klasse, bf16-Ausgabequalitaet, Realtime-Faktor und VRAM. Belegt sind nur
die Unit-Tests ohne GPU (tests/test_stem_handler.py, tests/test_stem_crossover.py).
"""
from __future__ import annotations

import base64
import hashlib
import importlib
import io
import os
import sys
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

import numpy as np

from model_manager import ModelDefinition, ModelUnavailableError
from stem_crossover import (
    DEFAULT_LOW_HZ,
    DEFAULT_MID_HIGH_HZ,
    FIVE_STEM_KEYS,
    form_five_stems,
    overlap_add_separate,
)

#: MSST-Code-Pin. Tag v1.0.15 -> Commit per `git ls-remote` am 2026-10-13
#: gelesen (lightweight Tag, zeigt direkt auf den Commit). Lizenz MIT (LICENSE im
#: Checkout gelesen). Python-Abhaengigkeiten fuer die hier genutzten Klassen laut
#: requirements.txt dieses Commits: einops==0.8.1, beartype==0.14.1,
#: rotary_embedding_torch==0.3.5, librosa (MelBandRoformer), pyyaml, torch.
MSST_PIN = {
    "repository": "https://github.com/ZFTurbo/Music-Source-Separation-Training",
    "tag": "v1.0.15",
    "commit": "a8a862231de29e6832a26c590e5c29f82f736f66",
}
MSST_ROOT_ENV = "MSST_ROOT"
MSST_ROOT_DEFAULT = "/opt/msst"

#: Platzhalter fuer Gewichte ohne gepinnte Revision (registry._PIN_REQUIRED).
_PIN_REQUIRED = "PIN-ERFORDERLICH"


@dataclass(frozen=True)
class StemModelSpec:
    """Was der Handler ueber ein Stem-Modell wissen muss (ausser Repo/Revision)."""

    msst_module: str
    msst_class: str
    checkpoint: str
    config: str
    #: SHA-256 der Dateien; None = Pin fehlt -> Modell wird abgelehnt.
    checkpoint_sha256: Optional[str]
    config_sha256: Optional[str]
    #: Woher der Hash stammt (Pruefpfad fuer Reviewer).
    hash_source: str
    usage: str  # main | fallback | onRequest


STEM_MODEL_SPECS: Dict[str, StemModelSpec] = {
    "bs-roformer-sw-6stem": StemModelSpec(
        msst_module="models.bs_roformer",
        msst_class="BSRoformer",
        checkpoint="BS-Rofo-SW-Fixed.ckpt",
        config="BS-Rofo-SW-Fixed.yaml",
        checkpoint_sha256="24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e",
        config_sha256="f9fada9f94e5ba2d2e4600196299459294bc5f532b314c209cc156ac63e4329b",
        hash_source="README.md + SHA256SUMS von FractalSurfer/BS-RoFormer-SW-6stem (HF, gelesen 2026-10-13)",
        usage="main",
    ),
    "scnet-xl-ihf": StemModelSpec(
        msst_module="models.scnet",
        msst_class="SCNet",
        checkpoint="model_scnet_ep_36_sdr_10.0891.ckpt",
        config="config_musdb18_scnet_xl_more_wide_v5.yaml",
        checkpoint_sha256=None,
        config_sha256=None,
        hash_source="offen: GitHub-Release v1.0.15 nicht gespiegelt/gehasht (FLEET-P1-006)",
        usage="fallback",
    ),
    "mel-roformer-karaoke": StemModelSpec(
        msst_module="models.bs_roformer",
        msst_class="MelBandRoformer",
        checkpoint="mel_band_roformer_karaoke_becruily.ckpt",
        config="config_karaoke_becruily.yaml",
        checkpoint_sha256=None,
        config_sha256=None,
        hash_source="offen: HF-Repo ohne veroeffentlichte Hashes (FLEET-P1-006)",
        usage="onRequest",
    ),
    "mel-roformer-dereverb": StemModelSpec(
        msst_module="models.bs_roformer",
        msst_class="MelBandRoformer",
        checkpoint="dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
        config="dereverb_mel_band_roformer_anvuew.yaml",
        checkpoint_sha256=None,
        config_sha256=None,
        hash_source="offen: HF-Repo ohne veroeffentlichte Hashes (FLEET-P1-006)",
        usage="onRequest",
    ),
}

#: Auf-Wunsch-Modelle: Payload-Schalter -> Modell-ID.
ON_REQUEST_MODELS = {"karaoke": "mel-roformer-karaoke", "dereverb": "mel-roformer-dereverb"}


def is_stem_model(model_id: str) -> bool:
    return model_id in STEM_MODEL_SPECS


# ---------------------------------------------------------------------------
# Gewichte: Repo + Revision aus dem Manifest, Hash aus STEM_MODEL_SPECS
# ---------------------------------------------------------------------------
_VERIFIED: Dict[Tuple[str, int, int], str] = {}
_VERIFIED_LOCK = threading.Lock()


def _sha256_file(path: str) -> str:
    stat = os.stat(path)
    key = (os.path.realpath(path), int(stat.st_size), int(stat.st_mtime_ns))
    with _VERIFIED_LOCK:
        cached = _VERIFIED.get(key)
    if cached:
        return cached
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    value = digest.hexdigest()
    with _VERIFIED_LOCK:
        _VERIFIED[key] = value
    return value


def _hub_download(repo_id: str, filename: str, revision: str) -> str:
    try:
        hub = importlib.import_module("huggingface_hub")
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"dependency missing for huggingface_hub (pip install huggingface_hub): {exc}") from exc
    try:
        return str(hub.hf_hub_download(repo_id=repo_id, filename=filename, revision=revision))
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(
            f"Gewichte nicht verfuegbar: {repo_id}@{revision}/{filename} ({type(exc).__name__}: {exc}). "
            "Pod-Start laedt sie aus dem Spiegel (scripts/weights-mirror.py) – kein Rueckfall auf ein anderes Modell."
        ) from exc


def resolve_weights(model_id: str, definition: ModelDefinition) -> Tuple[str, str]:
    """(Checkpoint-Pfad, Config-Pfad) – Repo/Revision aus dem Manifest, Hash geprueft."""
    spec = STEM_MODEL_SPECS.get(model_id)
    if spec is None:
        raise ModelUnavailableError(f"kein Stem-Handler fuer Modell {model_id!r}")
    repo = (definition.repository or "").strip()
    revision = (definition.revision or "").strip()
    if not revision or revision.upper() == _PIN_REQUIRED:
        raise ModelUnavailableError(
            f"{model_id}: Revision nicht gepinnt ({revision or '-'}) – Gewichte werden nicht geladen (FLEET-P1-006)"
        )
    if repo.count("/") != 1 or repo.startswith(("http:", "https:")):
        raise ModelUnavailableError(f"{model_id}: kein Hugging-Face-Repo ({repo or '-'}) – Spiegel fehlt (FLEET-P1-006)")
    if not spec.checkpoint_sha256 or not spec.config_sha256:
        raise ModelUnavailableError(
            f"{model_id}: SHA-256-Pin fehlt ({spec.hash_source}) – Gewichte werden nicht ungeprueft geladen"
        )
    paths = []
    for filename, expected in ((spec.checkpoint, spec.checkpoint_sha256), (spec.config, spec.config_sha256)):
        path = _hub_download(repo, filename, revision)
        actual = _sha256_file(path)
        if actual != expected:
            raise ModelUnavailableError(
                f"{model_id}: SHA-256 von {filename} passt nicht (erwartet {expected[:12]}…, ist {actual[:12]}…) – Abbruch"
            )
        paths.append(path)
    return paths[0], paths[1]


# ---------------------------------------------------------------------------
# Config (YAML mit !!python/tuple, ohne unsicheren Loader)
# ---------------------------------------------------------------------------
def load_stem_config(path: str) -> Dict[str, Any]:
    try:
        yaml = importlib.import_module("yaml")
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"dependency missing for yaml (pip install pyyaml): {exc}") from exc

    class _TupleSafeLoader(yaml.SafeLoader):  # type: ignore[misc, name-defined]
        pass

    _TupleSafeLoader.add_constructor(
        "tag:yaml.org,2002:python/tuple",
        lambda loader, node: tuple(loader.construct_sequence(node)),
    )
    with open(path, "r", encoding="utf-8") as fh:
        data = yaml.load(fh, Loader=_TupleSafeLoader)  # noqa: S506 - SafeLoader-Ableitung
    if not isinstance(data, dict) or not isinstance(data.get("model"), dict):
        raise ModelUnavailableError(f"Stem-Config {os.path.basename(path)}: Block 'model' fehlt")
    return data


def config_instruments(config: Dict[str, Any]) -> Tuple[str, ...]:
    training = config.get("training") or {}
    instruments = training.get("instruments") or []
    target = training.get("target_instrument")
    if target:
        return (str(target),)
    if not instruments:
        raise ModelUnavailableError("Stem-Config: training.instruments fehlt")
    return tuple(str(i) for i in instruments)


def config_sample_rate(config: Dict[str, Any]) -> int:
    return int((config.get("audio") or {}).get("sample_rate", 44100))


def config_chunking(config: Dict[str, Any]) -> Tuple[int, int]:
    audio = config.get("audio") or {}
    inference = config.get("inference") or {}
    chunk = int(audio.get("chunk_size", 0) or 0)
    overlap = int(inference.get("num_overlap", 2) or 2)
    if chunk <= 0:
        raise ModelUnavailableError("Stem-Config: audio.chunk_size fehlt")
    return chunk, overlap


# ---------------------------------------------------------------------------
# Modell (torch + MSST) – nur hier wird torch benoetigt
# ---------------------------------------------------------------------------
def _import_msst_class(spec: StemModelSpec) -> Any:
    root = os.environ.get(MSST_ROOT_ENV, "").strip() or MSST_ROOT_DEFAULT
    if not os.path.isdir(os.path.join(root, "models")):
        raise ModelUnavailableError(
            f"MSST fehlt: {MSST_PIN['repository']} @ {MSST_PIN['commit']} nach {root} auschecken "
            f"(Umgebung {MSST_ROOT_ENV}); kein Rueckfall auf ein anderes Modell"
        )
    if root not in sys.path:
        sys.path.insert(0, root)
    try:
        module = importlib.import_module(spec.msst_module)
        return getattr(module, spec.msst_class)
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(
            f"MSST-Import {spec.msst_module}.{spec.msst_class} fehlgeschlagen ({type(exc).__name__}: {exc}); "
            "Abhaengigkeiten: einops, beartype, rotary_embedding_torch, librosa"
        ) from exc


def build_chunk_fn(
    model_id: str,
    definition: ModelDefinition,
    spec: StemModelSpec,
    config: Dict[str, Any],
    checkpoint_path: str,
) -> Callable[[np.ndarray], np.ndarray]:
    """Laedt das MSST-Modell und liefert ``(C, T) numpy -> (S, C, T) numpy``."""
    try:
        torch = importlib.import_module("torch")
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"dependency missing for torch (pip install torch): {exc}") from exc
    model_cls = _import_msst_class(spec)
    model = model_cls(**dict(config["model"]))
    try:
        state = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    except Exception:  # noqa: BLE001
        # Datei ist per SHA-256 gegen den dokumentierten Hash geprueft; manche
        # MSST-Checkpoints enthalten Nicht-Tensor-Objekte (weights_only bricht).
        state = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    if isinstance(state, dict):
        for key in ("state", "state_dict"):
            if key in state and isinstance(state[key], dict):
                state = state[key]
    model.load_state_dict(state)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = model.to(device).eval()
    use_bf16 = (definition.quantization or "").lower() == "bf16" and device.type == "cuda"

    def run(chunk: np.ndarray) -> np.ndarray:
        with torch.inference_mode():
            tensor = torch.from_numpy(np.ascontiguousarray(chunk, dtype=np.float32))[None].to(device)
            if use_bf16:
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    out = model(tensor)
            else:
                out = model(tensor)
            return out[0].float().cpu().numpy()

    return run


@dataclass
class LoadedSeparator:
    model_id: str
    repository: str
    revision: str
    instruments: Tuple[str, ...]
    sample_rate: int
    chunk_size: int
    num_overlap: int
    chunk_fn: Callable[[np.ndarray], np.ndarray]

    def separate(self, mix: np.ndarray) -> Dict[str, np.ndarray]:
        out = overlap_add_separate(mix, self.chunk_fn, chunk_size=self.chunk_size, num_overlap=self.num_overlap)
        if out.shape[0] != len(self.instruments):
            raise ModelUnavailableError(
                f"{self.model_id}: Modell liefert {out.shape[0]} Stems, Config nennt {len(self.instruments)}"
            )
        return {name: out[i] for i, name in enumerate(self.instruments)}


_SEPARATORS: Dict[str, LoadedSeparator] = {}
_SEPARATORS_LOCK = threading.Lock()


def get_separator(model_id: str, definition: ModelDefinition) -> LoadedSeparator:
    cache_key = f"{model_id}@{definition.repository}@{definition.revision}"
    with _SEPARATORS_LOCK:
        if cache_key in _SEPARATORS:
            return _SEPARATORS[cache_key]
    spec = STEM_MODEL_SPECS[model_id]
    checkpoint_path, config_path = resolve_weights(model_id, definition)
    config = load_stem_config(config_path)
    chunk_size, num_overlap = config_chunking(config)
    separator = LoadedSeparator(
        model_id=model_id,
        repository=definition.repository,
        revision=definition.revision,
        instruments=config_instruments(config),
        sample_rate=config_sample_rate(config),
        chunk_size=chunk_size,
        num_overlap=num_overlap,
        chunk_fn=build_chunk_fn(model_id, definition, spec, config, checkpoint_path),
    )
    with _SEPARATORS_LOCK:
        _SEPARATORS[cache_key] = separator
    return separator


# ---------------------------------------------------------------------------
# Audio-Ein-/Ausgabe (soundfile; Resampling per scipy, nur wenn noetig)
# ---------------------------------------------------------------------------
def decode_audio(raw: bytes) -> Tuple[np.ndarray, int]:
    """WAV/FLAC/... -> (Kanaele, T) float32 und Abtastrate."""
    try:
        sf = importlib.import_module("soundfile")
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"dependency missing for soundfile (pip install soundfile): {exc}") from exc
    samples, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    return np.ascontiguousarray(np.asarray(samples, dtype=np.float32).T), int(sr)


#: WAV-Formate der Ergebnis-Stems. Standard FLOAT (32 bit): kein Clipping bei
#: Stems ueber 0 dBFS (Weichen-Ueberschwinger), die Summe bleibt = Mix. PCM_24
#: ist 3/4 so gross, clippt aber oberhalb 0 dBFS. PCM_16 bewusst nicht angeboten.
WAV_SUBTYPES = {"pcm24": "PCM_24", "float": "FLOAT"}


def encode_wav(samples: np.ndarray, sample_rate: int, subtype: str = "FLOAT") -> str:
    """(Kanaele, T) -> WAV als Base64."""
    try:
        sf = importlib.import_module("soundfile")
    except Exception as exc:  # noqa: BLE001
        raise ModelUnavailableError(f"dependency missing for soundfile (pip install soundfile): {exc}") from exc
    buf = io.BytesIO()
    sf.write(buf, np.asarray(samples, dtype=np.float32).T, int(sample_rate), format="WAV", subtype=subtype)
    return base64.b64encode(buf.getvalue()).decode()


def prepare_mix(samples: np.ndarray, sample_rate: int, target_rate: int, channels: int = 2) -> np.ndarray:
    x = np.asarray(samples, dtype=np.float32)
    if x.ndim == 1:
        x = x[None, :]
    if x.shape[0] == 1 and channels == 2:
        x = np.repeat(x, 2, axis=0)
    elif x.shape[0] > channels:
        x = x[:channels]
    if int(sample_rate) != int(target_rate):
        try:
            signal = importlib.import_module("scipy.signal")
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailableError(
                f"Abtastrate {sample_rate} Hz != {target_rate} Hz und scipy fehlt fuer das Resampling: {exc}"
            ) from exc
        from math import gcd

        g = gcd(int(sample_rate), int(target_rate))
        x = signal.resample_poly(x, int(target_rate) // g, int(sample_rate) // g, axis=-1).astype(np.float32)
    return np.ascontiguousarray(x)


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------
def _flag(payload: Dict[str, Any], key: str) -> bool:
    value = payload.get(key, False)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value) if isinstance(value, (int, float)) else False


def _cutoff(payload: Dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    raw = payload.get(key)
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise ModelUnavailableError(f"{key} muss eine Zahl sein") from exc
    if not (low <= value <= high):
        raise ModelUnavailableError(f"{key}={value} ausserhalb [{low}, {high}] Hz")
    return value


def _manifest_definition(model_id: str) -> ModelDefinition:
    """Definition eines Auf-Wunsch-Modells aus dem Manifest (Repo/Revision von dort)."""
    from registry import read_manifest

    for entry in read_manifest().get("models", []):
        if entry.get("id") == model_id:
            return ModelDefinition.from_dict(entry)
    raise ModelUnavailableError(f"{model_id} fehlt im Manifest")


def msst_stem_separate(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Any:
    """stem.separate fuer die RP5-Modelle: 5 Stems, Fallback 4->5 mit leerer Melodie."""
    if not is_stem_model(model_id):
        raise ModelUnavailableError(f"kein Stem-Handler fuer Modell {model_id!r}")
    if STEM_MODEL_SPECS[model_id].usage == "onRequest":
        raise ModelUnavailableError(
            f"{model_id} ist ein Auf-Wunsch-Zusatz (karaoke/dereverb) und kein Trennmodell fuer stem.separate"
        )

    from handlers_runpod import _audio_bytes

    low_hz = _cutoff(payload, "lowHz", DEFAULT_LOW_HZ, 40.0, 500.0)
    mid_high_hz = _cutoff(payload, "midHighHz", DEFAULT_MID_HIGH_HZ, 1000.0, 8000.0)
    requested = [name for name in ON_REQUEST_MODELS if _flag(payload, name)]
    sample_format = str(payload.get("sampleFormat", "float")).strip().lower()
    if sample_format not in WAV_SUBTYPES:
        raise ModelUnavailableError(f"sampleFormat {sample_format!r} unbekannt (erlaubt: {', '.join(WAV_SUBTYPES)})")
    subtype = WAV_SUBTYPES[sample_format]

    # Auf-Wunsch-Modelle VOR der teuren Trennung pruefen: fehlt ihr Pin, bricht
    # der Auftrag sofort mit klarer Meldung ab (keine halbe Antwort).
    extras_defs = {name: _manifest_definition(ON_REQUEST_MODELS[name]) for name in requested}
    extra_separators = {
        name: get_separator(ON_REQUEST_MODELS[name], extras_defs[name]) for name in requested
    }

    separator = get_separator(model_id, definition)
    samples, sr = decode_audio(_audio_bytes(payload))
    mix = prepare_mix(samples, sr, separator.sample_rate)
    raw = separator.separate(mix)
    five, info = form_five_stems(
        raw, separator.sample_rate, mix=mix, low_hz=low_hz, mid_high_hz=mid_high_hz
    )

    notes = []
    if not info["melodyAvailable"]:
        notes.append(
            f"{model_id} trennt nur {', '.join(separator.instruments)}: Melodie (guitar+piano) ist leer, "
            "melodische Anteile liegen in Mids/Highs."
        )
    if sr != separator.sample_rate:
        notes.append(f"Eingang {sr} Hz auf {separator.sample_rate} Hz umgerechnet.")

    extras: Dict[str, Dict[str, str]] = {}
    for name, extra in extra_separators.items():
        vocals = np.asarray(five["vocals"], dtype=np.float32)
        parts = extra.separate(prepare_mix(vocals, separator.sample_rate, extra.sample_rate))
        extras[name] = {
            "model": extra.model_id,
            **{stem: encode_wav(data, extra.sample_rate, subtype) for stem, data in parts.items()},
        }

    result: Dict[str, Any] = {
        "stems": {key: encode_wav(five[key], separator.sample_rate, subtype) for key in FIVE_STEM_KEYS},
        "stemSet": list(FIVE_STEM_KEYS),
        "format": "wav",
        "sampleFormat": sample_format,
        "sampleRate": separator.sample_rate,
        "model": model_id,
        "repository": separator.repository,
        "revision": separator.revision,
        "modelStems": list(separator.instruments),
        "melodyAvailable": info["melodyAvailable"],
        "residualDb": info["residualDb"],
        "crossover": info["crossover"],
        "notes": notes,
    }
    if _flag(payload, "includeModelStems"):
        result["modelStemAudio"] = {k: encode_wav(v, separator.sample_rate, subtype) for k, v in raw.items()}
    if extras:
        result["extras"] = extras
    return result
