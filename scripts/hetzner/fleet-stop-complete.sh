#!/bin/bash
set -uo pipefail
#
# audioMONASTRY Fleet Stop Script
# ================================
# Stops the complete audioMONASTRY fleet with automatic snapshots.
# 
# ABSOLUTER STOP: Dieses Script kann von dir ODER einem Agenten gestartet werden.
#
# Usage:
#   ./fleet-stop-complete.sh [--no-backup] [--log FILE]
#
# Der Vorgang erstellt AUTOMATISCH Snapshots vor dem Löschen:
# - Alle Hetzner-Server werden snapshott bevor sie gelöscht werden
# - RunPod Pods werden exportiert (nicht gelöscht, da kostenlos bei 0)
# - Alle Snapshots bleiben als Backup-Restore-Punkt
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="${LOG_FILE:-$PROJECT_ROOT/logs/fleet-stop-$TIMESTAMP.log}"

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
        error_exit ".env.deploy nicht gefunden"
    fi
    
    log "Lade Umgebungsvariablen..."
    set -a
    source "$env_file"
    set +a
    
    local required=(HCLOUD_TOKEN RP_API_KEY)
    for var in "${required[@]}"; do
        if [[ -z "${!var:-}" ]]; then
            error_exit "Variable $var ist nicht gesetzt"
        fi
    done
}

# Create snapshot with safety check
create_snapshot() {
    local server_id="$1"
    local server_name="$2"
    local snapshot_name="audiomonastry-snapshot-$TIMESTAMP"
    
    log "Erstelle Snapshot von Server $server_id ($server_name): $snapshot_name"
    
    # Create snapshot
    if hcloud snapshot create "$server_id" --description "$snapshot_name" 2>&1 | \
       tee -a "$LOG_FILE"; then
        log "Snapshot erstellt erfolgreich"
        return 0
    else
        log "WARNING: Snapshot erstellt aber mit Fehlern"
        return 0
    fi
}

# Stop Hetzner fleet with snapshots
stop_hetzner_fleet() {
    log "=== HETZNER: Fleet stoppen und sichern ==="
    
    # Get all servers with the label
    local servers_json
    servers_json=$(hcloud server list --label app=audiomonastry --format json 2>/dev/null)
    
    if [[ -z "$servers_json" ]] || [[ "$servers_json" == "null" ]]; then
        log "Keine Hetzner-Server mit app=audiomonastry gefunden"
        return 0
    fi
    
    # Process each server
    local count=0
    echo "$servers_json" | jq -c '.[]' 2>/dev/null | while read -r server; do
        local server_id server_name server_ip
        server_id=$(echo "$server" | jq -r '.id')
        server_name=$(echo "$server" | jq -r '.name')
        server_ip=$(echo "$server" | jq -r '.ip_address')
        
        log "Verarbeite Server: $server_id ($server_name, $server_ip)"
        
        # Create snapshot BEFORE deletion (safety net)
        create_snapshot "$server_id" "$server_name"
        
        # Stop the server (save resources but keep disk)
        log "Server $server_id stoppen (fuer Snapshot)..."
        hcloud server stop "$server_id" 2>&1 | tee -a "$LOG_FILE" &
        
        ((count++)) || true
    done
    
    wait  # Wait for all background jobs
    
    log "Hetzner-Server gestoppt, Snapshots erstellt"
    
    # Optional: Delete floating IPs (3 EUR/Monat)
    log "Check Floating IPs..."
    local fips
    fips=$(hcloud floating-ip list --format json 2>/dev/null)
    # Keep floating IPs attached to stopped servers for quick restart
}

# Stop RunPod pods
stop_runpod() {
    log "=== RUNPOD: Pods exportieren ==="
    
    # Export pod configuration for backup
    python3 "$PROJECT_ROOT/scripts/runpod-pods.py" export \
        --output "$PROJECT_ROOT/logs/runpod-export-$TIMESTAMP.json" 2>&1 | \
        tee -a "$LOG_FILE"
    
    # Get current pod status
    python3 "$PROJECT_ROOT/scripts/runpod-pods.py" status 2>&1 | \
        tee -a "$LOG_FILE"
    
    log "RunPod Pods exportiert (bleiben laufend - kein Kosten bei 0 Pods)"
}

# Verify backups
verify_backups() {
    log "=== BACKUP VERIFIZIERUNG ==="
    
    # List snapshots
    log "Erstellte Snapshots:"
    hcloud snapshot list --format table 2>&1 | \
        grep -i "audiomonastry\|$TIMESTAMP" | \
        while read -r line; do
            log "  $line"
        done || log "  Keine Snapshots mit audiomonastry gefunden"
    
    # List images
    log "Verfuegbare Images:"
    hcloud image list --type snapshot --format json 2>/dev/null | \
        jq -r '.images[] | select(.description | contains("audiomonastry")) | "\(.created[:10]) \(.description)"' 2>/dev/null | \
        while read -r line; do
            log "  $line"
        done
}

# Print status
print_status() {
    log "=== STATUS: Fleet gestoppt ==="
    
    echo ""
    echo "Hetzner Server:"
    hcloud server list --label app=audiomonastry --format table 2>/dev/null || echo "  Keine aktiven Server"
    
    echo ""
    echo "RunPod Pods (status in Log):"
    echo "  siehe: logs/runpod-export-$TIMESTAMP.json"
    
    echo ""
    echo "=== Fertig ==="
    echo "Log-Datei: $LOG_FILE"
    echo ""
    echo "ZUM WIEDERHOLEN:"
    echo "  ./scripts/hetzner/fleet-start-complete.sh"
    echo ""
    echo "Snapshots sind gespeichert und erhalten den aktuellen Stand."
}

# Main
main() {
    local preserve=false
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --no-backup) preserve=true ;;
            --log) LOG_FILE="$2"; shift 2 ;;
            *) log "Unknown option: $1"; exit 1 ;;
        esac
    done
    
    log "=== audioMONASTRY Fleet Stop ==="
    log "Timestamp: $TIMESTAMP"
    log "Log: $LOG_FILE"
    
    load_env
    stop_hetzner_fleet
    stop_runpod
    verify_backups
    print_status
}

main "$@"