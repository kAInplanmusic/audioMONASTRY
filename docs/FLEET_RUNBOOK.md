# audioMONASTRY Fleet Management

## ABSOLUTER DEPLOY/START SKRIPT

 Diese beiden Skripte sind das einzige was du brauchst:

### Starten:
```bash
cd /mnt/wd-elements/Medien/Projekte/audioMONASTRY
./scripts/hetzner/fleet-start-complete.sh
```

### Stoppen:
```bash
./scripts/hetzner/fleet-stop-complete.sh
```

## Was passiert beim Start?

1. **Backup**: Alle bestehenden Instanzen werden gesichert (Snapshots)
2. **Hetzner**: Neuer Server wird provisioniert (cx43, fsn1)
3. **Images**: Docker Images werden zu GHCR gepusht
4. **App**: audioMONASTRY App wird auf dem Server deployed
5. **RunPod**: 5 AI-Pods werden gestartet (brain, ears, voice, stems, music)
6. **RTC**: WebRTC-Verbindungen werden konfiguriert

## Was passiert beim Stopp?

1. **Hetzner**: Server werden gestoppt + Snapshots erstellt
2. **RunPod**: Pod-Konfiguration exportiert (Pod bleibt laufen = 0 EUR)
3. **Backup**: Alle Snapshots bleiben erhalten

## WICHTIGE FILES

- `.env.deploy` - Alle Secrets (NIEMALS committen!)
- `scripts/hetzner/fleet-start-complete.sh` - Startscript
- `scripts/hetzner/fleet-stop-complete.sh` - Stopscript
- `logs/` - Alle Log-Dateien

## RESTORE

 Um die Flotte wieder zu starten:

```bash
# Prüfe Snapshots
hcloud snapshot list --format table

# Starte neu
./scripts/hetzner/fleet-start-complete.sh
```

## WENN ES NICHT LAEUFT

1. Prüfe Logs: `ls logs/*.log`
2. Prüfe Server: `hcloud server list`
3. Prüfe Pods: `python3 scripts/runpod-pods.py status`
4. Prüfe App: `curl -sk https://hallerbans.de/api/health`

## ENV-VARIABLEN

Erforderlich in `.env.deploy`:
- `RP_API_KEY` - RunPod API Key
- `HCLOUD_TOKEN` - Hetzner API Key
- `AI_POD_TOKEN` - Innerer Token für Pod-Kommunikation
- `GHCR_USERNAME` / `GHCR_PASSWORD` - GitHub Container Registry
- `HF_TOKEN` - HuggingFace Token (fuer bestimmte Modelle)
- `DEPLOY_DOMAIN` - Domain (z.B. hallerbans.de)

## DRY-RUN MODE

```bash
./scripts/hetzner/fleet-start-complete.sh --dry-run
```