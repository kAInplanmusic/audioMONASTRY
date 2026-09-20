#!/usr/bin/env bash
# =============================================================================
# migrate-project-name.sh - F10: Bestands-Knoten auf den kanonischen Namespace
# -----------------------------------------------------------------------------
# Zieht EINEN laufenden Flotten-Knoten idempotent auf:
#   * Compose-Projekt   <Altname>  ->  <kanonischer Name>   (FLEET_COMPOSE_PROJECT)
#   * Deploy-Verzeichnis <Altpfad> ->  <kanonischer Pfad>   (FLEET_HOME)
# OHNE Datenverlust und mit Rueckweg: die Volumes des Alt-Projekts werden
# KOPIERT, nicht verschoben - der Alt-Stand bleibt bis zur ausdruecklichen
# Bestaetigung (--cleanup-legacy) startfaehig.
#
# WARUM: Der Compose-Projektname hing am Verzeichnisnamen (`cd <dir> && docker
# compose ...`). Ein Knoten, dessen Repo in einem anders benannten Verzeichnis
# liegt, bekommt beim naechsten `up` ein ZWEITES Projekt - eigene Volumes
# (`<alt>_caddy_data`), eigene Container-Labels, waehrend die Container-Namen
# (container_name) gleich bleiben. Genau der Zustand aus F10 (Container/Projekt
# auf sfu-1 und master-1). Seit F10 setzen die Skripte COMPOSE_PROJECT_NAME
# explizit und docker-compose.hetzner.yml traegt top-level `name:` - ein
# Bestands-Knoten muss aber einmalig migriert werden, sonst stehen Alt- und
# Neu-Projekt nebeneinander.
#
# Namen/Pfade stehen NIRGENDS in diesem Skript: sie kommen aus
# scripts/hetzner/fleet-names.sh (EINE Quelle, NOMEN-P1-001/F10).
#
# Aufruf:
#   bash scripts/hetzner/migrate-project-name.sh --print-config
#        Trockenlauf OHNE SSH und OHNE Docker: zeigt Namen, Pfade, Plan und
#        Rollback-Kommandos.
#   bash scripts/hetzner/migrate-project-name.sh <ip> --role sfu --dry-run
#        LESENDER Lauf auf dem Knoten (docker ps/volume ls/inspect, kein down,
#        kein mv, kein up) - zeigt, was migriert wuerde.
#   bash scripts/hetzner/migrate-project-name.sh <ip> --role sfu
#        Echte Migration (mit Rueckfrage; --yes ueberspringt sie).
#   bash scripts/hetzner/migrate-project-name.sh <ip> --role sfu --cleanup-legacy
#        Loescht danach die Alt-Volumes (erst nach gruener Verifikation).
#
# Rollback (solange --cleanup-legacy NICHT lief - die Alt-Volumes liegen noch):
#   1. Neu-Projekt stoppen:  cd <FLEET_HOME> && \
#        COMPOSE_PROJECT_NAME=<neu> docker compose <overlays> down
#   2. Alt-Projekt starten:  cd <Alt-/Neu-Pfad> && \
#        COMPOSE_PROJECT_NAME=<alt> docker compose <overlays> up -d <services>
#   Die genauen Kommandos fuer den konkreten Knoten druckt jeder Lauf am Ende.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/hetzner/fleet-names.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/fleet-names.sh"

SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)
# Hilfs-Image fuer das Kopieren der Volumes (klein, wird bei Bedarf gezogen).
VOLUME_COPY_IMAGE="${VOLUME_COPY_IMAGE:-alpine:3.20}"

FLEET_PROJECT="$(fleet_compose_project)"
LEGACY_PROJECT="$LEGACY_COMPOSE_PROJECT"

# Container-Schreibweisen des Stacks (neu zuerst) - fuer Bestands-Erkennung.
CONTAINER_CANDIDATES=()
while read -r candidate; do
  [[ -n "$candidate" ]] && CONTAINER_CANDIDATES+=("$candidate")
done < <(fleet_name_variants "$FLEET_PROJECT")

ROLE=""
IP=""
DRY_RUN="0"
CLEANUP_LEGACY="0"
SKIP_VOLUMES="0"
ASSUME_YES="0"
PRINT_CONFIG="0"

usage() {
  cat >&2 <<USAGE
Nutzung: $0 <ip> [--role app|sfu|master|edge] [--dry-run] [--cleanup-legacy] [--skip-volumes] [--yes]
        $0 --print-config
USAGE
  exit 1
}

# --- Rollen: Service-Liste, Overlays, Health-Pfad ----------------------------
# Dieselben Service-Listen wie bring-up-fleet.sh / der Portal-Worker
# (INFRA-HETZNER-006: edge-1 startet NUR den Monitoring-Stack).
role_spec() {
  case "$1" in
    app)    ROLE_OVERLAYS=();                             ROLE_SERVICES=(caddy audiomonastry) ;;
    sfu)    ROLE_OVERLAYS=(-f docker-compose.sfu.yml);    ROLE_SERVICES=(caddy audiomonastry) ;;
    master) ROLE_OVERLAYS=();                             ROLE_SERVICES=(master-player) ;;
    edge)   ROLE_OVERLAYS=(-f docker-compose.monitoring.yml)
            ROLE_SERVICES=(node-exporter cadvisor prometheus alertmanager grafana) ;;
    *) echo "❌ unbekannte Rolle: $1 (erlaubt: app|sfu|master|edge)" >&2; exit 1 ;;
  esac
}

print_config() {
  role_spec "${ROLE:-app}"
  echo "migrate-project-name.sh - effektive Konfiguration (kein SSH, kein Docker)"
  printf '  Knoten-IP:           %s\n' "${IP:-<keiner>}"
  printf '  Rolle:               %s\n' "${ROLE:-app (Default fuer die Anzeige)}"
  printf '  Compose-Projekt neu: %s   (FLEET_COMPOSE_PROJECT)\n' "$FLEET_PROJECT"
  printf '  Compose-Projekt alt: %s   (LEGACY_COMPOSE_PROJECT, nur Bestand)\n' "$LEGACY_PROJECT"
  printf '  Deploy-Pfad neu:     %s   (FLEET_HOME)\n' "$FLEET_HOME"
  printf '  Deploy-Pfad alt:     %s   (LEGACY_FLEET_HOME, nur Erkennung)\n' "$LEGACY_FLEET_HOME"
  printf '  App-Container:       %s\n' "${CONTAINER_CANDIDATES[*]}"
  printf '  Volumes:             %s_* -> %s_*   (KOPIE, nicht Verschieben)\n' "$LEGACY_PROJECT" "$FLEET_PROJECT"
  printf '  Start-Kommando:      cd %s && COMPOSE_PROJECT_NAME=%s docker compose -f docker-compose.hetzner.yml %s up -d %s\n' \
    "$FLEET_HOME" "$FLEET_PROJECT" "${ROLE_OVERLAYS[*]:-}" "${ROLE_SERVICES[*]}"
  printf '  Volume-Kopier-Image: %s\n' "$VOLUME_COPY_IMAGE"
  printf '  Dry-Run=%s  Cleanup-Legacy=%s  Skip-Volumes=%s\n' "$DRY_RUN" "$CLEANUP_LEGACY" "$SKIP_VOLUMES"
  cat <<PLAN

Plan (idempotent, jeder Schritt prueft seinen Ausgangszustand):
  1. Bestand LESEN: laufende Container + deren Compose-Projekt-Label,
     Alt-Volumes (<alt>_*), beide Verzeichnisse. Ist schon alles im neuen
     Projekt, endet der Lauf hier ohne Aenderung.
  2. Alt-Stack stoppen: docker compose -p <alt> ... down  (OHNE -v: die Volumes
     bleiben liegen - das ist der Rueckweg).
  3. Pfad: <Altpfad> -> <Pfad> verschieben, nur wenn der Zielpfad fehlt/leer ist;
     existiert er schon, bleibt der Altpfad als Sicherung stehen.
  4. Volumes KOPIEREN: <alt>_<suffix> -> <neu>_<suffix> (bereits gefuellte
     Ziel-Volumes werden uebersprungen - idempotent).
  5. Stack starten: COMPOSE_PROJECT_NAME=<neu> docker compose <overlays> up -d.
  6. Verifizieren: compose ps + Health/Port-Probe (Ergebnis wird gemeldet,
     ein fehlgeschlagener Health-Pfad wird NICHT als Erfolg ausgegeben).
  7. Rollback-Hinweis drucken; Alt-Volumes erst mit --cleanup-legacy loeschen.
PLAN
}

expect_role="0"
for arg in "$@"; do
  if [[ "$expect_role" == "1" ]]; then ROLE="$arg"; expect_role="0"; continue; fi
  case "$arg" in
    --print-config) PRINT_CONFIG="1" ;;
    --dry-run) DRY_RUN="1" ;;
    --cleanup-legacy) CLEANUP_LEGACY="1" ;;
    --skip-volumes) SKIP_VOLUMES="1" ;;
    --yes|-y) ASSUME_YES="1" ;;
    --role=*) ROLE="${arg#--role=}" ;;
    --role) expect_role="1" ;;
    --help|-h) usage ;;
    -*) echo "Unbekannte Option: $arg" >&2; usage ;;
    *) IP="$arg" ;;
  esac
done
# Warum `--role <wert>` hier ausdruecklich steht: die Nutzung nennt genau diese
# Form, aber `--role` fiel vorher in den `-*`-Zweig und beendete das Skript mit
# "Unbekannte Option: --role" (live gemessen 2026-09-20 mit
# `migrate-project-name.sh <ip> --role app --dry-run`). Eine zweite Schleife
# danach konnte das nie reparieren - dort war das Skript schon beendet.
if [[ "$expect_role" == "1" ]]; then
  echo "❌ --role ohne Wert (app|sfu|master|edge)" >&2
  usage
fi

# Trockenlauf zuerst: er braucht weder IP noch Rolle (Anzeige-Default ist app)
# und darf keinen SSH-/Docker-Pfad beruehren.
if [[ "$PRINT_CONFIG" == "1" ]]; then print_config; exit 0; fi

[[ -n "$IP" ]] || { echo "❌ Knoten-IP fehlt." >&2; usage; }
[[ -n "$ROLE" ]] || { echo "❌ --role fehlt (app|sfu|master|edge) - ohne Rolle waere unklar, welche Dienste starten." >&2; usage; }
role_spec "$ROLE"

remote() { ssh "${SSH_OPTS[@]}" "root@$IP" "$@"; }

echo "=== F10 · Migration des Compose-Projektnamens auf $IP (Rolle $ROLE) ==="
echo "Ziel: Projekt $LEGACY_PROJECT -> $FLEET_PROJECT | Pfad $LEGACY_FLEET_HOME -> $FLEET_HOME | Dry-Run=$DRY_RUN"

# --- 1. Bestand lesen (nur lesend) ------------------------------------------
echo
echo "--- 1/6 Bestand auf dem Knoten lesen ---"
RUNNING_PROJECTS="$(remote "docker ps --format '{{.Label \"com.docker.compose.project\"}}' 2>/dev/null | sort -u | tr '\n' ' '" || true)"
echo "   laufende Compose-Projekte: ${RUNNING_PROJECTS:-<keine>}"
LEGACY_CONTAINERS="$(remote "for c in ${CONTAINER_CANDIDATES[*]}; do docker inspect -f '{{.Name}} {{ index .Config.Labels \"com.docker.compose.project\"}}' \$c 2>/dev/null || true; done" || true)"
echo "   App-/Caddy-Container (Name + Projekt): ${LEGACY_CONTAINERS:-<keiner gefunden>}"
LEGACY_VOLUMES="$(remote "docker volume ls --filter label=com.docker.compose.project=$LEGACY_PROJECT --format '{{.Name}}' 2>/dev/null | tr '\n' ' '" || true)"
echo "   Volumes im Alt-Projekt: ${LEGACY_VOLUMES:-<keine>}"
TARGET_VOLUMES="$(remote "docker volume ls --filter label=com.docker.compose.project=$FLEET_PROJECT --format '{{.Name}}' 2>/dev/null | tr '\n' ' '" || true)"
echo "   Volumes im Ziel-Projekt: ${TARGET_VOLUMES:-<keine>}"
DIRS="$(remote "for d in $FLEET_HOME $LEGACY_FLEET_HOME; do if [ -f \$d/docker-compose.hetzner.yml ]; then echo \"\$d=installation\"; elif [ -d \$d ]; then echo \"\$d=verzeichnis\"; else echo \"\$d=fehlt\"; fi; done" || true)"
echo "   Verzeichnisse: $DIRS"

# Idempotenz: laeuft schon alles im Zielprojekt und keiner der Container traegt
# mehr das Alt-Projekt, ist hier nichts zu tun.
if [[ "$RUNNING_PROJECTS" == *"$FLEET_PROJECT"* && "$RUNNING_PROJECTS" != *"$LEGACY_PROJECT"* ]]; then
  echo
  echo "✅ Nichts zu tun: der Knoten laeuft bereits im Projekt $FLEET_PROJECT (idempotent)."
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "--- Trockenlauf (--dry-run): keine Aenderung ausgefuehrt. ---"
  echo "Ausgefuehrt wuerde:"
  echo "  2. docker compose -p $LEGACY_PROJECT -f docker-compose.hetzner.yml down --remove-orphans   (ohne -v)"
  echo "  3. [ -d $FLEET_HOME ] || mv $LEGACY_FLEET_HOME $FLEET_HOME"
  echo "  4. Volume-Kopien: $(echo "$LEGACY_VOLUMES" | tr ' ' '\n' | sed -n 's/^/     /p' | head -10)"
  echo "  5. cd $FLEET_HOME && COMPOSE_PROJECT_NAME=$FLEET_PROJECT docker compose ${ROLE_OVERLAYS[*]:-} up -d ${ROLE_SERVICES[*]}"
  exit 0
fi

echo
if [[ "$ASSUME_YES" != "1" ]]; then
  echo "Achtung: Schritt 2 stoppt den laufenden Stack (Container+Netz des Alt-Projekts,"
  echo "Volumes bleiben), Schritt 3 verschiebt das Verzeichnis. Der Rueckweg ist unten beschrieben."
  read -r -p "Jetzt migrieren? [j/N] " ans
  [[ "$ans" == "j" || "$ans" == "J" ]] || { echo "Abgebrochen."; exit 0; }
fi

# --- 2. Alt-Stack stoppen (ohne -v) ----------------------------------------
echo "--- 2/6 Alt-Stack stoppen (Volumes bleiben liegen = Rueckweg) ---"
SOURCE_DIR="$LEGACY_FLEET_HOME"
if [[ "$DIRS" != *"$LEGACY_FLEET_HOME=installation"* && "$DIRS" == *"$FLEET_HOME=installation"* ]]; then
  SOURCE_DIR="$FLEET_HOME"
fi
echo "   Compose-Verzeichnis: $SOURCE_DIR"
remote "cd $SOURCE_DIR && COMPOSE_PROJECT_NAME=$LEGACY_PROJECT docker compose -f docker-compose.hetzner.yml down --remove-orphans" \
  || { echo "❌ down des Alt-Projekts fehlgeschlagen - nichts weiter geaendert." >&2; exit 1; }

# --- 3. Pfad migrieren ------------------------------------------------------
echo "--- 3/6 Deploy-Pfad ---"
if remote "test -d $LEGACY_FLEET_HOME"; then
  if remote "test -e $FLEET_HOME"; then
    echo "   $FLEET_HOME existiert schon - der Altpfad bleibt als Sicherung stehen (nichts verschoben)."
  else
    echo "   $LEGACY_FLEET_HOME -> $FLEET_HOME verschieben"
    remote "mkdir -p \"\$(dirname $FLEET_HOME)\" && mv $LEGACY_FLEET_HOME $FLEET_HOME"
  fi
else
  echo "   kein Altpfad auf dem Knoten - nichts zu verschieben"
fi

# --- 4. Volumes kopieren ----------------------------------------------------
echo "--- 4/6 Volumes kopieren (Kopie, kein Verschieben) ---"
if [[ "$SKIP_VOLUMES" == "1" ]]; then
  echo "   uebersprungen (--skip-volumes) - nur sinnvoll, wenn die Alt-Volumes leer sind."
else
  for volume in $LEGACY_VOLUMES; do
    suffix="${volume#"$LEGACY_PROJECT"_}"
    target="${FLEET_PROJECT}_${suffix}"
    if [[ "$volume" == "$target" ]]; then
      echo "   $volume traegt schon den Zielnamen - uebersprungen"
      continue
    fi
    echo "   $volume -> $target"
    remote bash -s <<REMOTE
set -eu
docker volume create $target >/dev/null
if [ -n "\$(docker run --rm -v $target:/to $VOLUME_COPY_IMAGE sh -c 'ls -A /to' 2>/dev/null)" ]; then
  echo "   Ziel-Volume $target enthaelt schon Daten - uebersprungen (idempotent)"
else
  docker run --rm -v $volume:/from:ro -v $target:/to $VOLUME_COPY_IMAGE \\
    sh -c 'cd /from && tar cf - . | (cd /to && tar xf -)'
  echo "   kopiert nach $target"
fi
REMOTE
  done
fi

# --- 5. Ziel-Stack starten --------------------------------------------------
echo "--- 5/6 Stack im Projekt $FLEET_PROJECT starten ---"
remote "cd $FLEET_HOME && COMPOSE_PROJECT_NAME=$FLEET_PROJECT docker compose -f docker-compose.hetzner.yml ${ROLE_OVERLAYS[*]:-} up -d --remove-orphans ${ROLE_SERVICES[*]}"

# --- 6. Verifizieren --------------------------------------------------------
echo "--- 6/6 Verifikation ---"
remote "cd $FLEET_HOME && COMPOSE_PROJECT_NAME=$FLEET_PROJECT docker compose -f docker-compose.hetzner.yml ${ROLE_OVERLAYS[*]:-} ps --format '{{.Service}}: {{.State}} (projekt={{.Label \"com.docker.compose.project\"}})'"
case "$ROLE" in
  app|sfu|edge)
    # Port 80 gehoert Caddy und ist der oeffentliche Port; JEDE HTTP-Antwort
    # zaehlt. Die App selbst (8080) ist NICHT auf den Host veroeffentlicht.
    HTTP="$(remote "curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:80/ || true")"
    echo "   HTTP 127.0.0.1:80 -> ${HTTP:-keine Antwort}"
    [[ -n "$HTTP" && "$HTTP" != "000" ]] || echo "   ⚠ Caddy antwortet nicht - Log pruefen (docker compose logs caddy)."
    ;;
  master)
    HTTP="$(remote "curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:8000/health || true")"
    echo "   master-player /health -> ${HTTP:-keine Antwort}"
    [[ "$HTTP" == "200" ]] || echo "   ⚠ master-player meldet kein 200 - Log pruefen."
    ;;
esac

echo
echo "=== Ergebnis ==="
if [[ "$CLEANUP_LEGACY" == "1" ]]; then
  echo "Loesche Alt-Volumes (nur mit --cleanup-legacy, Rueckweg entfaellt damit):"
  for volume in $LEGACY_VOLUMES; do
    remote "docker volume rm $volume >/dev/null 2>&1 && echo '   geloescht: $volume' || echo '   nicht geloescht (in Benutzung?): $volume'"
  done
else
  echo "Rueckweg (Alt-Stand bleibt startfaehig, weil die Volumes kopiert wurden):"
  echo "  1. Neu stoppen:  ssh root@$IP 'cd $FLEET_HOME && COMPOSE_PROJECT_NAME=$FLEET_PROJECT docker compose -f docker-compose.hetzner.yml ${ROLE_OVERLAYS[*]:-} down'"
  echo "  2. Alt starten:  ssh root@$IP 'cd $FLEET_HOME && COMPOSE_PROJECT_NAME=$LEGACY_PROJECT docker compose -f docker-compose.hetzner.yml ${ROLE_OVERLAYS[*]:-} up -d ${ROLE_SERVICES[*]}'"
  echo "  3. Alt-Volumes aufraeumen (erst wenn der Neu-Stand bestaetigt ist):"
  echo "     bash $0 $IP --role $ROLE --cleanup-legacy"
fi
echo
echo "Offen (bewusst NICHT behauptet): ob der gesamte Flotten-Fluss (4-User-E2E, SFU-RTP)"
echo "nach der Migration gruen ist - das ist ein Live-Beweis und steht in docs/OPS_RUNBOOK.md."
