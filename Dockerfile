FROM node:22-alpine
WORKDIR /app

# SEC-2026-11-06-002: Dieses Image ist SINGLE-STAGE - es gibt keine Builder-Stage,
# aus der .env wieder herausfaellt. Alle .env* sind deshalb in .dockerignore
# ausgeschlossen (Ausnahmen: *.example). Die einzigen Werte, die `vite build`
# frueher aus der lokalen .env gezogen hat, sind die OEFFENTLICHEN Frontend-Keys
# (Supabase-URL + anon key landen sowieso im Browser-Bundle); sie kommen als
# Build-Arg und werden nur fuer den Build-Layer gesetzt. Leer = same-origin/offline.
# Ein NEUER Build-Time-VITE-Wert braucht hier ein eigenes ARG - `COPY . .` bringt
# keine .env mehr mit, aus der Vite ihn ziehen koennte.
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_ANON_PUB=""
# Die Knoten-Vorlage (.env.hetzner.example) fuehrt die Supabase-Werte als
# VITE_SB_URL / VITE_SB_ANON_PUB; cloudConfig liest beide Namen. Ohne diese
# beiden ARGs waere cloudEnabled im Prod-Bundle false (seit .env nicht mehr
# im Build-Kontext liegt, kommt nichts mehr "von selbst" an).
ARG VITE_SB_URL=""
ARG VITE_SB_ANON_PUB=""
ARG VITE_V2_AUDIO_MODE=""

COPY package*.json ./
# NOSONAR: Lifecycle-Skripte (mediasoup/esbuild) werden für den Build benötigt
RUN npm ci
# NOSONAR: Projekt-Build benötigt den vollständigen Kontext; .dockerignore filtert Secrets
COPY . .
# Fail-fast statt Augen zu: wenn .dockerignore fehlt/umgangen wird (z. B. Build aus
# einem anderen Kontext), bricht der Build hier ab, bevor Secrets in einem Layer
# landen. Erlaubt sind nur die Beispiel-Dateien.
RUN node -e "const fs=require('fs');const bad=fs.readdirSync('.').filter(f=>/^\.env($|\.)/.test(f)&&!/\.example$/.test(f));if(bad.length){console.error('SEC-2026-11-06-002: Secret-Dateien im Build-Kontext:',bad);process.exit(1)}"
RUN VITE_SUPABASE_URL="$VITE_SUPABASE_URL" \
    VITE_SUPABASE_ANON_PUB="$VITE_SUPABASE_ANON_PUB" \
    VITE_V2_AUDIO_MODE="$VITE_V2_AUDIO_MODE" \
    npm run build
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
