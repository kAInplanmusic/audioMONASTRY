# =============================================================================
# midi-bridge – MIDI <-> WebSocket <-> OSC (audioMONASTRY Sidecar)
# -----------------------------------------------------------------------------
# Linux-Build braucht libasound2-dev (RtMidi/midi-Paket kompiliert nativ).
# =============================================================================
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libasound2-dev python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./

USER node
EXPOSE 9100
CMD ["node", "index.js"]
