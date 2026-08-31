# SampleMONK AI Runtime – HF Custom Container
# ==========================================
# Basis: pytorch/pytorch (torch+cu124 vorinstalliert) → spart ~4 GB Build-Disk
# und Buildzeit. Keine Secrets im Image, Gewichte kommen aus dem HF-Hub-Cache.
FROM pytorch/pytorch:2.4.1-cuda12.4-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/data/hf-cache \
    PORT=8000

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 sox curl passwd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/samplemonk-ai

# Deterministische Dependencies (torch kommt aus dem Basisimage, wird NICHT neu geladen)
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock

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
