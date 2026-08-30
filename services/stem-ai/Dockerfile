FROM python:3.12-slim
WORKDIR /app
COPY requirements.lock .
# NOSONAR
# demucs liefert nur ein sdist; Integrität wird durch --require-hashes garantiert
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
# Nur die benötigten Dienstdateien kopieren (kein rekursives COPY . .).
COPY main.py ./

# Nicht als root laufen (Semgrep-Audit: missing-user)
RUN useradd -m -u 10001 appuser && chown -R appuser:appuser /app
USER appuser

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
