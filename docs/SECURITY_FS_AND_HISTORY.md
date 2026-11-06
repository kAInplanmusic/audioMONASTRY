# Der geleakte `AI_POD_TOKEN` in der Git-History

**Sachstand:** `fb771a36^:.env` enthielt den Token im Klartext. Der Wert wurde am
2026-11-06 rotiert (48 → 43 Zeichen, `sha256 908e76f0` → `f5e90bcd`) und ist damit
tot: wer ihn aus der History zieht, bekommt 401 von jeder Pod-Route.

**Korrektur (2026-11-06):** hier stand vorher ein Abschnitt über Dateirechte auf
`/mnt/wd-elements`. Der war falsch. Das ist die private Platte in einem
Einzelnutzer-Rechner — kein Mehrbenutzer-System, kein Angreifer im Modell. Und
die App läuft auf Hetzner und RunPod, mit eigener `.env` und eigenen Rechten
dort; der Entwicklungsrechner hat damit nichts zu tun. Rechte-Bits auf dieser
Platte sind kein Risiko und kein Ticket.

## Bereinigung

Die History wird mit `git filter-branch` bereinigt (kein `git-filter-repo`
installiert), danach neu gepackt und force-gepusht. Ergebnis: **jede Commit-Hash
ändert sich**, die Commit-Anzahl bleibt.

```bash
# 0) Sicherung, bevor irgendetwas umgeschrieben wird
git clone --mirror . ~/.env-backups/audiomonastry-pre-rewrite-$(date -u +%Y%m%d-%H%M).git

# 1) .env aus JEDEM Commit entfernen (index-filter, kein Checkout)
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --index-filter 'git rm --cached --ignore-unmatch .env' \
  --tag-name-filter cat -- --all

# 2) Original-Refs weg, Reflog leeren, Objekte wirklich loeschen
git for-each-ref --format='%(refname)' refs/original | xargs -r -n1 git update-ref -d
git reflog expire --expire=now --all
git gc --prune=now

# 3) Kontrolle - muss leer sein bzw. "not a valid object name"
git log --all --oneline -- .env
git cat-file -e fb771a36^:.env

# 4) Force-Push (remote existiert nur main, dazu die Tags)
git push --force origin main
git push --force --tags
```

**Danach:** jede andere Arbeitskopie (z. B. auf dem Laptop) muss neu geklont
werden — ein `git pull` auf alten Hashes scheitert oder mischt Historien.

## Was bereits erledigt ist

- `.env*` ist aus dem Docker-Build-Kontext ausgeschlossen (Fail-fast-Guard in
  beiden Dockerfiles) — der Leak-Pfad ins Image ist zu.
- Der Token ist rotiert; alle Konsumenten prüfen nur `>= 32` Zeichen.
- `.env.bak-20261104-*` liegen ausserhalb des Repos unter
  `~/.env-backups/audiomonastry/`.
