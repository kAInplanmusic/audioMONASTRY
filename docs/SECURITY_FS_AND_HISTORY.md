# Zwei offene Sicherheits-Reste (Stand 2026-11-06)

Beide Punkte lassen sich nicht im Repo lösen. Sie brauchen root bzw. eine
Entscheidung, und beide kosten Ausfallzeit — deshalb stehen sie hier als
ausführbare Anleitung statt als halb gemachter Eingriff.

## 1. `.env` ist auf diesem Volume nicht einschränkbar (Dateirechte)

**Gemessen:**

```
mount   → /dev/sdb1 on /mnt/wd-elements type fuseblk
          (rw,relatime,user_id=0,group_id=0,default_permissions,allow_other,umask=0022)
fstab   → UUID=F64899274898E79F /mnt/wd-elements ntfs-3g
          defaults,uid=30000,gid=30000,umask=0022,nofail,...  0 0
chmod 600 .permprobe → Datei bleibt 755
```

NTFS über `ntfs-3g` kennt keine POSIX-Modi. Die Rechte kommen aus `umask=0022`
beim Mount, nicht aus dem Inode. `chmod` meldet deshalb **Erfolg (Exit 0) und
ändert nichts**, `setfacl` ebenso. Das ist kein Fehler in `scripts/fix-env-permissions.sh`
— das Skript warnt genau davor.

**Konsequenz:** jede `.env*` in diesem Repo ist für jeden lokalen Nutzer lesbar,
der Zugriff auf `/mnt/wd-elements` hat. Auf dem Hetzner-Knoten gilt das nicht
(ext4, `deploy.sh` setzt dort 0600).

**Optionen, bewertet:**

| Option | Wirkung | Preis |
|---|---|---|
| `umask=0077` in der fstab-Zeile | alle Dateien des 2-TB-Laufwerks nur für den Eigentümer | trifft alle Projekte auf dem Laufwerk, nicht nur dieses Repo |
| `permissions` + `usermapping` | echte POSIX-Modi auf NTFS | braucht eine User-Mapping-Datei, `uid=30000`-Setup muss mit; NTFS-Sonderfälle (Symlinks) bleiben |
| Secrets aus dem Laufwerk nehmen | `.env` liegt z. B. unter `~/.secrets/` (ext4) und wird per `EnvironmentFile`/Symlink eingebunden | Symlinks auf `ntfs-3g` sind unzuverlässig; die App liest `.env` relativ zum Repo |
| Akzeptieren + rotieren | was heute gilt | Rechte bleiben offen, Rotation ist die einzige echte Mitigation |

**Empfehlung:** Option 1 oder 2 nur zusammen mit einem Zeitfenster (remount
braucht `umount`, das bricht laufende Prozesse auf dem Laufwerk). Bis dahin:
Secrets in diesem Baum als lesbar für alle lokalen Nutzer behandeln.

**Wenn du es umsetzen willst** (Reihenfolge zählt, nichts davon im laufenden Betrieb):

```bash
# 1) alles stoppen, was auf /mnt/wd-elements arbeitet (Dev-Server, Agenten, Sync)
sudo umount /mnt/wd-elements
# 2) fstab-Zeile anpassen: umask=0022 -> umask=0077  (oder permissions,usermapping=...)
sudo mount /mnt/wd-elements
# 3) Gegenprobe - muss 600 zeigen:
touch /mnt/wd-elements/Medien/Projekte/audioMONASTRY/.permprobe && \
  chmod 600 /mnt/wd-elements/Medien/Projekte/audioMONASTRY/.permprobe && \
  stat -c '%a' /mnt/wd-elements/Medien/Projekte/audioMONASTRY/.permprobe
```

## 2. Der geleakte `AI_POD_TOKEN` steckt noch in der Git-History

**Sachstand:** `fb771a36^:.env` enthält den Token im Klartext, der Blob ist
weiterhin abrufbar (`git cat-file -p fb771a36^:.env`). Der Wert wurde am
2026-11-06 **rotiert** (48 → 43 Zeichen, `sha256 908e76f0` → `f5e90bcd`), ist also
tot: wer ihn aus der History zieht, bekommt 401 von jeder Pod-Route.

**Warum noch nicht bereinigt:** ein History-Rewrite ändert **jede** Commit-Hash
im Repo (Force-Push, alle Klone müssen neu ziehen, offene PRs/Branches brechen).
Das ist eine Betreiberentscheidung, keine Aufräumroutine — und der Nutzen ist
heute rein kosmetisch, weil der Wert ungültig ist.

**Wenn du es machen willst:**

```bash
pip install git-filter-repo
git clone --mirror https://github.com/kAInplanmusic/audioMONASTRY.git repo.git
cd repo.git
git filter-repo --path .env --invert-paths
git push --force --mirror
# danach: alle Arbeitskopien neu klonen; lokale Branches mit alten Hashes verwerfen
```

**Kontrolle danach:** `git log --all --oneline -- .env` muss leer sein, und
`git cat-file -p fb771a36^:.env` darf nicht mehr existieren.

## Was bereits erledigt ist

- `.env*` ist aus dem Docker-Build-Kontext ausgeschlossen (Fail-fast-Guard in
  beiden Dockerfiles) — der eigentliche Leak-Pfad ins Image ist zu.
- Der Token ist rotiert; alle Konsumenten prüfen nur `>= 32` Zeichen.
- `.env.bak-20261104-*` liegen ausserhalb des Repos unter
  `~/.env-backups/audiomonastry/` mit 600 (Home ist ein POSIX-FS, dort greift
  `chmod`).
