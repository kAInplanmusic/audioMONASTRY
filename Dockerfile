FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
# NOSONAR: Lifecycle-Skripte (mediasoup/esbuild) werden für den Build benötigt
RUN npm ci
# NOSONAR: Projekt-Build benötigt den vollständigen Kontext; .dockerignore filtert Secrets
COPY . .
RUN npm run build
# Kopiere optionale statische Assets nach dem Build, wenn sie vorhanden sind
RUN if [ -f static_assets/general_midi.sf2 ]; then mkdir -p dist/samples/instruments && cp static_assets/general_midi.sf2 dist/samples/instruments/; fi

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 8080
CMD ["npm", "start"]
