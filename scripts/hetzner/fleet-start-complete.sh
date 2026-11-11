#!/bin/bash
set -uo pipefail
#
# audioMONASTRY Fleet Start Script
# =================================
# Dieses Script startet die vollständige audioMONASTRY-Flotte:
# - 1 Hetzner-Server (App)
# - 5 RunPod AI-Pods (brain, ears, voice, stems, music)
# - RTC-Verbindungen (SFU/TURN)
#
# ABSOLUTER START: Dieses Script kann von dir ODER einem Agenten gestartet werden.
#
# Usage:
#   ./fleet-start-complete.sh [--dry-run] [--log FILE]
#
# Requirements:
#   - .env.deploy with all required secrets
#   - git config user.email/name
#   - ssh access to Hetzner server (if exists)
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="${LOG_FILE:-$PROJECT_ROOT/logs/fleet-start-$TIMESTAMP.log}"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Logging function
log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg" | tee -a "$LOG_FILE"
}

# Error handler
error_exit() {
    log "ERROR: $*"
    exit 1
}

# Load environment
load_env() {
    local env_file="$PROJECT_ROOT/.env.deploy"
    if [[ ! -f "$env_file" ]]; then
        error_exit ".env.deploy nicht gefunden at $env_file"
    fi
    
    log "Lade Umgebungsvariablen aus $env_file"
    set -a
    source "$env_file"
    set +a
    
    # Validate required variables
    local required=(RP_API_KEY HCLOUD_TOKEN AI_POD_TOKEN)
    for var in "${required[@]}"; do
        if [[ -z "${!var:-}" ]]; then
            error_exit "Variable $var ist nicht gesetzt"
        fi
    done
    
    log "Umgebungsvariablen geladen"
}

# Backup existing instances before any changes
backup_instances() {
    log "=== BACKUP: Bestehende Instanzen sichern ==="
    
    # Hetzner servers backup
    log "Checkung Hetzner-Server..."
    local servers
    servers=$(hcloud server list --label app=audiomonastry --format json 2>/dev/null | \
              jq -r '.[].id' 2>/dev/null) || servers=""
    
    if [[ -n "$servers" ]]; then
        log "Found $(echo "$servers" | wc -l) Hetzner-Server(n) - erstelle Snapshots"
        for server_id in $servers; do
            local server_name
            server_name=$(hcloud server describe "$server_id" --format json 2>/dev/null | \
                         jq -r '.server.name' 2>/dev/null)
            log "Snapshot von Server $server_id ($server_name)..."
            if ! hcloud snapshot create "$server_id" \
                --description "audiomonastry-backup-$TIMESTAMP-$server_name" 2>&1 | \
               tee -a "$LOG_FILE"; then
                log "WARNING: Snapshot erstellt aber mit Warnungen"
            fi
        done
    else
        log "Keine Hetzner-Server mit app=audiomonastry gefunden"
    fi
    
    # RunPod pods backup (export pod configs)
    log "Exportiere RunPod Pod-Konfiguration..."
    if command -v python3 &>/dev/null; then
        python3 "$PROJECT_ROOT/scripts/runpod-pods.py" export \
            --output "$PROJECT_ROOT/logs/runpod-backup-$TIMESTAMP.json" 2>&1 | \
            tee -a "$LOG_FILE" || log "WARNING: RunPod Export mit Fehler"
    fi
    
    log "Backup abgeschlossen"
}

# Provision Hetzner server
provision_hetzner() {
    log "=== HETZNER: Server provisionieren ==="
    
    # Check if server already exists
    local server_id
    server_id=$(hcloud server list --label app=audiomonastry --format value --column id 2>/dev/null | head -1)
    
    if [[ -n "$server_id" ]]; then
        log "Server existiert bereits: $server_id"
        export DEPLOY_HOST=$(hcloud server list --label app=audiomonastry --format value --column ip_address 2>/dev/null | head -1)
    else
        log "Neuer Hetzner-Server wird erstellt..."
        python3 "$SCRIPT_DIR/provision.py" --type cx43 --location fsn1 --role sfu 2>&1 | \
            tee -a "$LOG_FILE"
        
        export DEPLOY_HOST=$(hcloud server list --label app=audiomonastry --format value --column ip_address 2>/dev/null | head -1)
        log "Server-Provisionierung abgeschlossen, DEPLOY_HOST=$DEPLOY_HOST"
    fi
}

# Build and push images
build_images() {
    log "=== BUILD: Images bauen und pushen ==="
    
    export REGISTRY_TAG=$(git rev-parse --short HEAD 2>/dev/null || echo "local")
    export GHCR_USERNAME GHCR_PASSWORD
    
    bash "$SCRIPT_DIR/registry-push.sh" 2>&1 | tee -a "$LOG_FILE"
    log "Image Build abgeschlossen"
}

# Deploy Hetzner app
deploy_app() {
    log "=== DEPLOY: Hetzner App starten ==="
    
    DEPLOY_IMAGE_SOURCE=registry \
    DEPLOY_REGISTRY_IMAGE="ghcr.io/kainplanmusic/audiomonastry:$REGISTRY_TAG" \
    DEPLOY_REGISTRY_IMAGE_MASTER="ghcr.io/kainplanmusic/audiomonastry-master-player:$REGISTRY_TAG" \
    DEPLOY_HOST="$DEPLOY_HOST" \
    DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-hallerbans.de}" \
    DEPLOY_SMOKE=1 \
    bash "$PROJECT_ROOT/deploy.sh" 2>&1 | tee -a "$LOG_FILE"
    
    log "Hetzner App deployed"
}

# Start RunPod pods
start_runpod() {
    log "=== RUNPOD: Pods starten ==="
    
    # Check RunPod capacity
    log "Checkung RunPod Kapazität..."
    python3 "$PROJECT_ROOT/scripts/runpod-pods.py" capacity 2>&1 | tee -a "$LOG_FILE" || true
    
    # Push the image to RunPod's registry first
    log "Pushing image to RunPod registry..."
    RP_IMAGE="ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod:$REGISTRY_TAG"
    
    # Create pods
    log "Starte RunPod Pods..."
    python3 "$PROJECT_ROOT/scripts/runpod-pods.py" up --yes --wait 900 2>&1 | \
        tee -a "$LOG_FILE"
    
    log "RunPod Pods gestartet"
}

# Wire RTC connections
wire_rtc() {
    log "=== RTC: Verbindungen herstellen ==="
    
    # Get server IP
    local server_ip="$DEPLOY_HOST"
    
    # Transfer TURN/RTC configuration
    rsync -av "$PROJECT_ROOT/deploy/runpod/pod-config.env" \
        "root@$server_ip:/opt/audiomonastry/.env.runpod" 2>&1 | \
        tee -a "$LOG_FILE" || log "WARNING: RTC Config Transfer"
    
    # Restart services to pick up config
    ssh root@"$server_ip" 'cd /opt/audiomonastry && docker compose -f docker-compose.hetzner.yml restart' \
        2>&1 | tee -a "$LOG_FILE"
    
    log "RTC Verbindungen hergestellt"
}

# Print status
print_status() {
    log "=== STATUS: System-Status ==="
    
    echo ""
    echo "Hetzner Server:"
    hcloud server list --label app=audiomonastry --format table 2>/dev/null || echo "  Keine Server gefunden"
    
    echo ""
    echo "RunPod Pods:"
    python3 "$PROJECT_ROOT/scripts/runpod-pods.py" status 2>&1 | head -20
    
    echo ""
    echo "=== Fertig ==="
    echo "Log-Datei: $LOG_FILE"
    echo "App URL: https://${DEPLOY_DOMAIN:-hallerbans.de}"
}

# Cleanup function for errors
cleanup() {
    log "Cleanup aufgerufen"
}

# Main execution
main() {
    local dry_run=false
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run) dry_run=true ;;
            --log) LOG_FILE="$2"; shift 2 ;;
            *) log "Unknown option: $1"; exit 1 ;;
        esac
    done
    
    if [[ "$dry_run" == true ]]; then
        log "DRY-RUN MODE - keine Änderungen"
        return 0
    fi
    
    log "=== audioMONASTRY Fleet Start ==="
    log "Timestamp: $TIMESTAMP"
    log "Log: $LOG_FILE"
    
    # Setup
    load_env
    backup_instances
    
    # Deploy
    provision_hetzner
    build_images
    deploy_app
    start_runpod
    wire_rtc
    
    print_status
}

# Run main
main "$@"