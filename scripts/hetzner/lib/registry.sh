#!/usr/bin/env bash
# =============================================================================
# scripts/hetzner/lib/registry.sh – Registry-Weg (GHCR) fuer die Hetzner-Flotte
# -----------------------------------------------------------------------------
# WARUM diese Datei existiert (gemessen 2026-09-21):
#
#   Die Leitung Betreiber-Rechner -> Knoten macht ~1 MB/s hoch. Das App-Image ist
#   1,43 GB, das master-player-Image 1,22 GB - ein Rollout mit `docker save | ssh
#   docker load` dauert damit 25-40 min PRO KNOTEN, und der zweite Knoten zahlt
#   jedes Mal denselben Preis. Eine Registry dreht das um: EINMAL langsam
#   hochschieben, danach zieht jeder Knoten mit Rechenzentrums-Tempo (GHCR haengt
#   am schnellen Backbone des Knotens, nicht an der Leitung des Betreibers).
#
# Diese Bibliothek ist die EINE Shell-Umsetzung fuer:
#   * den Namen der Bilder      (registry_image / registry_app_name ...)
#   * die Tag-Bildung           (registry_default_tag: git-Kurzhash, sonst Version)
#   * den Owner                 (registry_default_owner: aus dem git-Remote)
#   * die Zugangsdaten          (registry_load_credentials, Wert NIE in Ausgabe/argv)
#   * Login + Pull + Tag        (registry_pull_images: der Knoten zieht statt zu laden)
#
# Sie wird GESOURCET, nicht ausgefuehrt:
#   * scripts/hetzner/registry-push.sh   - baut/taggt/pusht die zwei Images
#   * deploy.sh                          - DEPLOY_IMAGE_SOURCE=registry
#   * scripts/hetzner/fleet-deploy-live.sh - derselbe Modus fuer Live-Beweise
#   * tests/test_hetzner_scripts.py      - faehrt die Funktionen mit Fake-docker/ssh
#
# Vertrag (in Tests festgenagelt):
#   * Der Registry-Weg zieht nur (`docker pull` + `docker tag` auf die lokalen
#     Namen, die die Compose-Dateien erwarten). KEIN `docker save` - genau der
#     Transfer ist der Engpass.
#   * Der Default bleibt der lokale Weg (DEPLOY_IMAGE_SOURCE=local): niemand
#     schwenkt still um, nur weil jetzt ein zweiter Weg existiert.
#   * Zugangsdaten (GHCR_TOKEN/GHCR_PASSWORD) erscheinen NIE in einer Ausgabe und
#     NIE als Kommandozeilen-Argument - sie laufen ausschliesslich durch eine Pipe
#     in `docker login --password-stdin`.
#   * Idempotenz: derselbe Tag wird nicht zweimal gepusht (Press-Check ueber
#     `docker manifest inspect`).
# =============================================================================

#: Registry-Host (GHCR). Ueberschreibbar fuer einen Mirror/Test.
registry_host() { printf '%s\n' "${REGISTRY_HOST:-ghcr.io}"; }

#: Repo-/Bildname der App auf der Registry (kleingeschrieben - GHCR lehnt
#: Grossbuchstaben ab). Entspricht dem lokalen Tag `audiomonastry:hetzner`.
registry_app_name() { printf '%s\n' "${REGISTRY_APP_NAME:-audiomonastry}"; }

#: Repo-/Bildname des master-player (lokales Tag `audiomonastry-master-player:hetzner`).
registry_master_name() { printf '%s\n' "${REGISTRY_MASTER_NAME:-audiomonastry-master-player}"; }

#: Lokale Namen, die die Compose-Dateien erwarten (docker-compose.hetzner.yml).
registry_local_app() { printf '%s\n' "${REGISTRY_LOCAL_APP:-audiomonastry:hetzner}"; }
registry_local_master() { printf '%s\n' "${REGISTRY_LOCAL_MASTER:-audiomonastry-master-player:hetzner}"; }

# registry_default_owner <repo_root> -> Owner (klein), sonst leer.
# Quelle ist das git-Remote (`origin`), NICHT ein hartkodierter Konto-Name: ein
# Fork/ein umbenanntes Konto darf nicht auf ein fremdes Paket zeigen.
registry_default_owner() {
  local root="${1:-.}" url owner
  url="$(git -C "$root" remote get-url origin 2>/dev/null || true)"
  [[ -n "$url" ]] || return 0
  # ssh-Form  git@github.com:owner/repo.git
  # https-Form https://github.com/owner/repo.git
  url="${url##*:}"
  url="${url#*github.com/}"
  owner="${url%%/*}"
  owner="${owner%.git}"
  printf '%s\n' "$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')"
}

# registry_owner <repo_root> -> effektiver Owner (REGISTRY_OWNER gewinnt).
registry_owner() {
  local root="${1:-.}"
  if [[ -n "${REGISTRY_OWNER:-}" ]]; then
    printf '%s\n' "$(printf '%s' "$REGISTRY_OWNER" | tr '[:upper:]' '[:lower:]')"
    return 0
  fi
  registry_default_owner "$root"
}

# registry_default_tag <repo_root> -> Tag aus `git rev-parse --short HEAD`,
# sonst die package.json-Version. Kein Raten: gibt es beides nicht, kommt "dev"
# zurueck (der Aufrufer meldet das).
registry_default_tag() {
  local root="${1:-.}" tag version
  tag="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || true)"
  tag="$(printf '%s' "$tag" | tr -d '[:space:]')"
  if [[ -n "$tag" ]]; then printf '%s\n' "$tag"; return 0; fi
  version="$(node -p "require('$root/package.json').version" 2>/dev/null || true)"
  version="$(printf '%s' "$version" | tr -d '[:space:]')"
  printf '%s\n' "${version:-dev}"
}

# registry_version <repo_root> -> Release-Version (fuer --also-version).
registry_version() {
  local root="${1:-.}" version
  version="$(node -p "require('$root/package.json').version" 2>/dev/null || true)"
  printf '%s\n' "$(printf '%s' "$version" | tr -d '[:space:]')"
}

# registry_image <owner> <name> <tag> -> vollstaendige Referenz.
registry_image() {
  local owner="${1:?Owner fehlt}" name="${2:?Bildname fehlt}" tag="${3:?Tag fehlt}"
  printf '%s/%s/%s:%s\n' "$(registry_host)" "$owner" "$name" "$tag"
}

# registry_env_value <datei> <schluessel> -> Wert auf stdout, sonst leer.
# Liest die Betreiber-Env-Datei OHNE sie zu sourcen (kein `set -a`, keine
# Nebeneffekte, kein Export in die Umgebung des Skripts).
registry_env_value() {
  local file="${1:-}" key="${2:-}" line
  [[ -n "$file" && -f "$file" && -n "$key" ]] || return 0
  line="$(grep -m1 "^${key}=" "$file" 2>/dev/null || true)"
  [[ -n "$line" ]] || return 0
  line="${line#*=}"
  line="${line%$'\r'}"
  # Umgebende Anfuehrungszeichen entfernen, Wert bleibt sonst unveraendert.
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

# registry_load_credentials <repo_root> [env_datei]
#   setzt REGISTRY_USER + REGISTRY_PASS (globale Variablen des SOURCENDEN Skripts).
#   Reihenfolge: explizite REGISTRY_USER/REGISTRY_PASSWORD > Umgebung
#   (GHCR_USERNAME + GHCR_TOKEN/GHCR_PASSWORD/GHCR_PAT_ALL_ACCESS) > Env-Datei.
#   Die WERTE werden nie ausgegeben; REGISTRY_ENV_FILE=none schaltet die Datei ab.
#   Rueckgabe: 0 = Paar vorhanden, 1 = nicht vorhanden (Aufrufer meldet das laut).
registry_load_credentials() {
  local root="${1:-.}" file="${2:-${REGISTRY_ENV_FILE:-$root/.env}}"
  REGISTRY_USER=""
  REGISTRY_PASS=""

  if [[ -n "${REGISTRY_PASSWORD:-}" ]]; then
    REGISTRY_USER="${REGISTRY_USER:-${GHCR_USERNAME:-}}"
    REGISTRY_PASS="$REGISTRY_PASSWORD"
  else
    REGISTRY_USER="${GHCR_USERNAME:-}"
    REGISTRY_PASS="${GHCR_TOKEN:-${GHCR_PASSWORD:-${GHCR_PAT_ALL_ACCESS:-}}}"
  fi

  if [[ -z "$REGISTRY_PASS" && "$file" != "none" && -f "$file" ]]; then
    [[ -n "$REGISTRY_USER" ]] || REGISTRY_USER="$(registry_env_value "$file" GHCR_USERNAME)"
    REGISTRY_PASS="$(registry_env_value "$file" GHCR_TOKEN)"
    [[ -n "$REGISTRY_PASS" ]] || REGISTRY_PASS="$(registry_env_value "$file" GHCR_PASSWORD)"
    [[ -n "$REGISTRY_PASS" ]] || REGISTRY_PASS="$(registry_env_value "$file" GHCR_PAT_ALL_ACCESS)"
  fi

  if [[ -z "$REGISTRY_USER" ]]; then
    # Ohne Benutzer kein Login - der Owner der Referenz ist der naechstbeste Wert,
    # den ein PAT-Login bei GHCR akzeptiert.
    REGISTRY_USER="$(registry_owner "$root")"
  fi
  [[ -n "$REGISTRY_PASS" && -n "$REGISTRY_USER" ]]
}

# registry_credentials_state <repo_root> [env_datei] -> "ja"/"nein" (BOOLEAN).
# Fuer Trockenlaeufe: zeigt, OB Zugangsdaten vorliegen, ohne einen Wert zu nennen.
registry_credentials_state() {
  if registry_load_credentials "${1:-.}" "${2:-}" 2>/dev/null; then
    printf 'ja\n'
  else
    printf 'nein\n'
  fi
}

# registry_login_local <repo_root>
#   Login am BETREIBER-Rechner (fuer den Push). Das Passwort laeuft durch stdin.
registry_login_local() {
  local root="${1:-.}"
  registry_load_credentials "$root" || {
    echo "❌ Keine GHCR-Zugangsdaten gefunden (GHCR_TOKEN/GHCR_PASSWORD in der Env-Datei oder als Env-Variable)." >&2
    echo "   Die Werte werden nie ausgegeben - bitte nur setzen, nicht zeigen." >&2
    return 1
  }
  printf '%s' "$REGISTRY_PASS" | docker login "$(registry_host)" -u "$REGISTRY_USER" --password-stdin >/dev/null
}

# registry_remote <ssh_key> <ziel> <befehl> - ein Kommando auf dem Knoten.
registry_remote() {
  local ssh_key="${1:-}" target="${2:?Ziel fehlt}" cmd="${3:?Kommando fehlt}"
  if [[ -n "$ssh_key" ]]; then
    ssh -i "$ssh_key" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$target" "$cmd"
  else
    ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$target" "$cmd"
  fi
}

# registry_login_remote <ssh_key> <ziel> <repo_root> [env_datei]
#   Login auf dem KNOTEN (er muss ziehen koennen). Passwort wieder nur per Pipe.
registry_login_remote() {
  local ssh_key="$1" target="$2" root="${3:-.}" file="${4:-}"
  registry_load_credentials "$root" "$file" || return 1
  printf '%s' "$REGISTRY_PASS" \
    | registry_remote "$ssh_key" "$target" "docker login $(registry_host) -u $REGISTRY_USER --password-stdin" >/dev/null
}

# registry_pull_images <ssh_key> <ziel> <repo_root> [env_datei] <lokal> <referenz> [...]
#   Der Registry-Weg des Deploys, in EINER Umsetzung fuer deploy.sh und
#   fleet-deploy-live.sh:
#     1. Rollback-Tag <lokal>-rollback sichern - VOR dem Ersetzen des Images,
#        sonst zeigt der Rueckweg auf den neuen Stand (gleiche Regel wie im
#        Transfer-/Build-Weg).
#     2. Login auf dem Knoten (nur mit Zugangsdaten; fehlen sie, wird das LAUT
#        gemeldet und der Pull trotzdem versucht - ein oeffentliches Paket zieht
#        auch ohne Login).
#     3. `docker pull <referenz>` + `docker tag <referenz> <lokal>`: die
#        Compose-Dateien erwarten ihre lokalen Namen, ein Pull allein wuerde
#        sie nicht treffen. KEIN `docker save` - der Transfer ist der Engpass.
registry_pull_images() {
  local ssh_key="$1" target="$2" root="$3" file="$4"
  shift 4
  [[ $# -ge 2 ]] || { echo "registry_pull_images: Paar <lokal> <referenz> fehlt" >&2; return 2; }

  local pairs=("$@") i
  # 1. Rueckweg zuerst.
  for ((i = 0; i < ${#pairs[@]}; i += 2)); do
    registry_remote "$ssh_key" "$target" \
      "docker image tag ${pairs[i]} ${pairs[i]}-rollback 2>/dev/null || true"
  done

  # 2. Login auf dem Knoten (Wert nur ueber stdin).
  if registry_load_credentials "$root" "$file"; then
    echo "--- GHCR-Login auf dem Knoten (Benutzer $REGISTRY_USER, Token wird nie ausgegeben) ---"
    registry_login_remote "$ssh_key" "$target" "$root" "$file" \
      || echo "⚠️  GHCR-Login auf dem Knoten fehlgeschlagen - Pull versucht es trotzdem." >&2
  else
    echo "⚠️  Keine GHCR-Zugangsdaten gefunden - Pull ohne Login (funktioniert nur bei oeffentlichem Paket)."
    echo "    Zugangsdaten: GHCR_USERNAME + GHCR_TOKEN in der Env-Datei (\$REGISTRY_ENV_FILE, Default <repo>/.env)." >&2
  fi

  # 3. Ziehen und auf die lokalen Namen taggen.
  for ((i = 0; i < ${#pairs[@]}; i += 2)); do
    echo "--- docker pull ${pairs[i + 1]} ---"
    registry_remote "$ssh_key" "$target" \
      "docker pull ${pairs[i + 1]} && docker tag ${pairs[i + 1]} ${pairs[i]}"
  done
}
