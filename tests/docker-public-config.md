# Docker-Build: öffentliche Vite-Konfiguration

`.env` und `.env.*` werden auf allen Ebenen aus dem Docker-Kontext ausgeschlossen. Bestehende `.env`-Dateien bleiben unverändert; ihr Inhalt wird im Container-Build nicht mehr automatisch gelesen. Den Build aus dem Projektverzeichnis starten und benötigte, **öffentliche** Werte explizit angeben, z. B.:

```sh
docker build --build-arg VITE_API_BASE_URL=https://api.example.invalid \
  --build-arg VITE_SB_URL=https://project.example.invalid \
  --build-arg VITE_SB_ANON_PUB=example-publishable-key -t audiomonastry .
```

Die im Dockerfile deklarierten `ARG VITE_*` erlauben auch die URL-/Signaling-, STUN- und öffentlichen R2-Konfigurationen sowie die Supabase-Aliasnamen. Ohne Übergabe gelten die Fallbacks der Anwendung, etwa Same-Origin-API und deaktivierte Cloud-Konfiguration. Vite schreibt diese Werte beim Build in öffentlich ausgelieferte Browserdateien; Docker kann Build-Argumente in Metadaten oder Cache speichern. **Keine Geheimnisse**, Service-Role-Keys oder dauerhaften TURN-Credentials als Build-Argument übergeben. Für TURN ist die Server-Konfiguration mit kurzlebigen Credentials über `/api/webrtc-config` vorgesehen.

Server-Geheimnisse getrennt zur Container-Laufzeit über die jeweilige Deployment-/Secret-Verwaltung bereitstellen; nicht ins Image oder den Build-Kontext kopieren. Bei schon veröffentlichten Credentials sind Rotation/Widerruf, Untersuchung bestehender Images/Caches sowie die Bereinigung der Git-Historie separat nötig; diese Änderung erledigt das nicht. Andere Dockerfiles und alternative Build-Kontexte müssen eigenständig geprüft werden.
