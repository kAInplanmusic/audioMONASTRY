FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
# Nur die benötigten Dienstdateien kopieren (kein rekursives COPY . .).
COPY index.js ./

# Run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3001
CMD ["node", "index.js"]
