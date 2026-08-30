FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes --only-binary :all: -r requirements.lock

# Nur die benötigten Dienstdateien kopieren (kein rekursives COPY . .).
COPY tagger.py ./

# Nicht als root laufen (Semgrep-Audit: missing-user)
RUN useradd -m -u 10001 appuser && chown -R appuser:appuser /app
USER appuser

CMD ["python", "tagger.py"]
