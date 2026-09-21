#!/usr/bin/env bash
# =============================================================================
# delete-fleet.sh – audioMONASTRY Hetzner-Flotte KOMPLETT löschen (0 €)
# -----------------------------------------------------------------------------
# Löscht alle 5 Server. Die Floating-IP (3 €/Monat) bleibt bewusst erhalten,
# damit die DNS (anunnakitools.de) weiterhin auf die feste IP zeigen kann.
#
# WICHTIG: Nur LÖSCHEN stoppt die Hetzner-Kosten – ausgeschaltete Server
# werden weiter berechnet (Ressourcen bleiben reserviert).
#
# FIREWALL-LEBENSZYKLUS (Entscheid 2026-09-21, INFRA-HETZNER-014):
# Server ja, FIREWALLS NEIN. Sie kosten bei Hetzner nichts, und der naechste
# Aufbau BRAUCHT ihren Regelbestand:
#   * provision.py (`ensure_firewall`) und der Portal-Worker (`ensureFirewall`)
#     finden sie ueber den NAMEN wieder - ein geloeschter Bestand waere nur
#     Mehrarbeit, kein Sicherheitsgewinn;
#   * die Cross-Node-Regeln (app:8080 fuer edge-1, ai:8000/11434 und
#     master:8000 fuer app-1) legt die Provisionierung NICHT an -
#     `firewall-ensure.py` gleicht ausschliesslich VORHANDENE Quell-IPs ab und
#     meldet fehlende Regeln nur. Wer die Regeln beim Abbau entfernt, bekommt
#     beim naechsten CLI-Aufbau einen STUMMEN Block (edge->app-Scrape,
#     app->ai, app->master), bis der Portal-Wake laeuft;
#   * deshalb: der Abbau laesst alles stehen und LISTET die Firewalls hier nur
#     auf (lesend). Veraltete Quell-IPs sind erwartet - Schritt 3/9 von
#     bring-up-fleet.sh gleicht sie auf die neuen Knoten-IPs ab.
#   * geloescht wird nur fachlich Toter Bestand: ungenutzte Firewalls des
#     Alt-Praefixes per scripts/hetzner/cleanup-legacy-firewalls.py [--apply].
#
# Aufruf:
#   bash scripts/hetzner/delete-fleet.sh          (mit Rückfrage)
#   bash scripts/hetzner/delete-fleet.sh --yes    (ohne Rückfrage)
#
# Die Env-Datei ist per DELETE_FLEET_ENV_FILE umstellbar (Default .env.deploy);
# Tests setzen sie auf eine eigene Datei, damit nie die echte Betreiber-.env
# gelesen wird.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE="${DELETE_FLEET_ENV_FILE:-.env.deploy}"
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi
[[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN fehlt ($ENV_FILE)" >&2; exit 1; }

# NOMEN-P1-001: Aufraeumen darf NICHTS uebersehen - ein Altname, der nicht
# geloescht wird, kostet weiter Geld. Deshalb beide Schreibweisen.
source "$(dirname "$0")/fleet-names.sh"
NAMES=(audiomonastry-app-1 audiomonastry-sfu-1 audiomonastry-ai-1 audiomonastry-master-1 audiomonastry-edge-1)
ALL_NAMES=()
for n in "${NAMES[@]}"; do
  while read -r candidate; do ALL_NAMES+=("$candidate"); done < <(fleet_candidates "$n")
done

# API-Helfer fuer die LESENDEN Aufrufe: der Token steht nur im Header und wird
# nie ausgegeben.
api() {
  local method="$1" path="$2"
  curl -s -X "$method" -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1${path}"
}

if [[ "${1:-}" != "--yes" ]]; then
  echo "Folgende Server werden ENDGÜLTIG gelöscht:"
  printf '  - %s\n' "${ALL_NAMES[@]}"
  echo "Floating-IPs: keine mehr im Projekt (seit 2026-09-21 wird fuer die App-Rolle keine angelegt;"
  echo "  der Portal-Worker loescht vorhandene beim Flotten-Abbau selbst - sie kostete 3 EUR/Monat ohne Funktion)."
  echo "Firewalls und ihre Regeln: bleiben bestehen (kostenlos, Namens-Wiederverwendung beim naechsten"
  echo "  Aufbau; Schritt 3/9 des Flottenstarts gleicht die Quell-IPs ab) - docs/HETZNER_DEPLOY.md,"
  echo "  INFRA-HETZNER-014."
  read -r -p "Wirklich löschen? [j/N] " ans
  [[ "$ans" == "j" || "$ans" == "J" ]] || { echo "Abgebrochen."; exit 0; }
fi

for name in "${ALL_NAMES[@]}"; do
  id=$(api GET "/servers?name=$name" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['servers'][0] if d['servers'] else None; print(s['id'] if s else '')")
  if [[ -n "$id" ]]; then
    echo -n "Lösche $name (id=$id) … "
    code=$(curl -s -X DELETE -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/servers/$id")
    echo "$code"
  else
    echo "Überspringe $name (existiert nicht)."
  fi
done

echo
echo "== Verbleibende Server =="
api GET "/servers" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Anzahl Server:', len(d['servers']))"
echo "== Floating-IPs (bleiben) =="
api GET "/floating_ips" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(' ', f['ip'], '| server:', f.get('server')) for f in d['floating_ips']]"

# --- Firewalls: LESEND auflisten (Entscheid im Kopfkommentar) ----------------
# Kein DELETE und kein set_rules: dieser Schritt macht die alte Regel-Lage nur
# sichtbar, damit sie beim naechsten Aufbau nicht als Ueberraschung auftritt.
# Die veralteten Quell-IPs sind der ERWARTETE Zustand nach einem Abbau.
echo "== Firewalls (bleiben bestehen - kein Loeschen, keine Regel-Aenderung) =="
api GET "/firewalls?per_page=50" | python3 -c '
import json, sys
data = json.load(sys.stdin)
firewalls = data.get("firewalls") or []
if not firewalls:
    print("  keine Firewall im Projekt - die Provisionierung legt sie beim naechsten Aufbau an")
for fw in sorted(firewalls, key=lambda f: str(f.get("name", ""))):
    rules = fw.get("rules") or []
    gebunden = len(fw.get("applied_to") or [])
    print("  %-26s %2d Regeln, %d Zuweisung(en)" % (str(fw.get("name")), len(rules), gebunden))
print("  Die Quell-IPs der Cross-Node-Regeln zeigen jetzt auf GELOESCHTE Knoten - das ist")
print("  erwartet; der naechste Flottenstart gleicht sie in Schritt 3/9 ab")
print("  (python3 scripts/hetzner/firewall-ensure.py, Trockenlauf: --dry-run).")
print("  Loeschen ist nur fuer ungenutzte Alt-Firewalls vorgesehen:")
print("    python3 scripts/hetzner/cleanup-legacy-firewalls.py [--apply]")
'
echo
echo "✅ Flotte gelöscht – es fallen keine Server-Kosten mehr an."
echo "   Firewalls bleiben bestehen (kostenlos, Namens-Wiederverwendung beim naechsten Aufbau)."
echo "   Wieder hochfahren:  bash scripts/hetzner/bring-up-fleet.sh"
