FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
# NOSONAR: Lifecycle-Skripte (mediasoup/esbuild) werden für den Build benötigt
RUN npm ci
# NOSONAR: Projekt-Build benötigt den vollständigen Kontext; .dockerignore filtert Secrets
COPY . .
# Nur öffentliche Vite-Konfiguration: Build-ARGs erscheinen im Browser/Image.
# Niemals Passwörter, Service-Keys oder TURN-Credentials übergeben.
ARG VITE_API_BASE_URL
ARG VITE_SFU_URL
ARG VITE_SB_URL
ARG VITE_SB_ANON_PUB
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_PUB
ARG VITE_CFR2_PUBLIC_URL
ARG VITE_CFR2_ACCOUNT_ID
ARG VITE_CFR2_BUCKET
ARG VITE_CFS3_BUCKET
ARG VITE_ICE_STUN
ARG VITE_SOCKET_IO_SIGNALING_URL
ARG VITE_SIGNALING_WS_URL
ARG VITE_SIGNALING_HTTP_URL
ARG VITE_SIGNALING_TRANSPORT_URL
RUN npm run build
# Kopiere optionale statische Assets nach dem Build, wenn sie vorhanden sind
RUN if [ -f static_assets/general_midi.sf2 ]; then mkdir -p dist/samples/instruments && cp static_assets/general_midi.sf2 dist/samples/instruments/; fi

# VisualMONK #5: Show-Merge nutzt ffmpeg (mehrere Clips zu einem mp4).
RUN apk add --no-cache ffmpeg

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 8080
CMD ["npm", "start"]
