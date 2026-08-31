# SampleMONK AI Runtime – HF Custom Container
# ==========================================
# Multi-Stage: deterministischer Build, keine Secrets im Image.
# Gewichte werden NIE ins Image gebacken (HF-Hub + persistenter Cache).

# ---------------------------------------------------------------------------
# Stage 1: CUDA-Basis + System-Abhängigkeiten (Audio/FFmpeg)
# ---------------------------------------------------------------------------
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS runtime-base

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/data/hf-cache \
    PORT=8000

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    ffmpeg libsndfile1 sox curl passwd \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Stage 2: Python-Dependencies (deterministisch via requirements.lock)
# ---------------------------------------------------------------------------
FROM runtime-base AS deps

WORKDIR /opt/samplemonk-ai
COPY requirements.lock ./requirements.lock
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.lock

# ---------------------------------------------------------------------------
# Stage 3: App (Code + Konfiguration, keine Gewichte, keine Secrets)
# ---------------------------------------------------------------------------
FROM runtime-base AS app

WORKDIR /opt/samplemonk-ai
COPY --from=deps /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY app.py model_manager.py registry.py mcp_runtime.py handlers.py ./
COPY model_manifest.json runtime_config.yaml startup.sh ./
RUN chmod +x startup.sh \
    && mkdir -p /data/hf-cache \
    && useradd --system --uid 10001 samplemonk \
    && chown -R samplemonk:samplemonk /opt/samplemonk-ai /data
USER samplemonk

# Healthcheck: Prozess lebt; Readiness liefert der Endpoint selbst.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

EXPOSE 8000
ENTRYPOINT ["./startup.sh"]
