# Backup-Konzept & Daten-Landkarte (Stand 2026-09-29, live verifiziert)

## Wo liegt was

| Datentyp | Ort | Bestand (2026-09-29) | Sicherung |
|---|---|---|---|
| **Audios / Sample-Dateien** | Cloudflare **R2**, Bucket `audiomonastrysamples` | **1.094 Objekte · 6,28 GB** (neuestes 28.09.) · öffentlich via `pub-663ece…r2.dev` | ❌ **nicht gesichert** (Option: R2→Hetzner-Spiegel, offen) |
| **Prompts, Sample-Metadaten, Musik-Tracks, AI-Logs** | **Supabase** Postgres (eu-west-1, `db.pwtwtqbcynsjtkxlkrwh.supabase.co`) · Tabellen: `plugin_prompt_versions`, `samples`, `sample_tags`, `music_tracks`, `ai_*`, `mcp_audit_events` | Projekt ACTIVE_HEALTHY | ✅ **täglich** `scripts/backup-supabase.sh` → Offsite (dieses Konzept) |
| **App-Zustand** (`dist/`, `public/` ohne Medien) | **Hetzner Object Storage** (nbg1), Bucket `audiomonastry-backups`, Prefix `backups/` | 1 Archiv vom 14.09. (46 MB) | ⚠️ Timer existiert (`install-backup-timer.sh`, app-1) — **läuft nur, wenn die Flotte läuft** |
| **Supabase-interne Backups / PITR** | — | **0** | ❌ nicht aktiv (Free-Plan); Pro-Plan = 25 $/Monat (Betreiber-Entscheidung) |

Rolle der Credentials (nicht mischen!):
- **`CFS3_*` / `CFR2_*`** = Cloudflare R2 → *App-Uploads* (Samples/Audio). `server/cloud.ts` nutzt `CFS3_*`.
- **`HOS_S3_*` / `BACKUP_S3_*`** = Hetzner Object Storage → *Offsite-Backups* (`scripts/r2-backup.mjs`, Credential-Kette `BACKUP_S3_*` → `HOS_S3_*` → `CFS3_*`).
- **`RP_S3_*`** = RunPod Object Storage (eigene Credentials, nicht mit R2 überschreiben).

## Der tägliche DB-Backup (neu)

```bash
# Secret einmalig hinterlegen (NICHT ins Repo, NICHT in den Chat):
#   Datei: ~/.config/monk/keys.env  (chmod 600)
#   Inhalt: SUPABASE_DB_URL=postgresql://postgres:<PASSWORT>@db.pwtwtqbcynsjtkxlkrwh.supabase.co:5432/postgres
#   (alternativ SUPABASE_DB_PASSWORD)

bash scripts/backup-supabase.sh          # Dump + Offsite-Upload + Retention
bash scripts/backup-supabase.sh --dry-run
bash scripts/backup-watchdog.sh          # Frische-Prüfung (Exit 1 = DB-Dump zu alt/fehlt)
```

Ablauf: `pg_dump` (Schema+ Daten, `--no-owner --no-privileges --clean --if-exists`) → `gzip` →
`scripts/r2-backup.mjs upload db/audiomonastry_db_<stamp>.sql.gz`. Dump-Treiber: lokal, sonst
**Docker** (`postgres:16-alpine`, `--network=host` — nötig, weil die Supabase-DB nur per IPv6
erreichbar ist). Retention: lokal 7 Tage, offsite 14 Dumps.

Timer (systemd `--user`, läuft unabhängig von der Flotte):
- `audiomonastry-dbbackup.timer` → täglich **03:30** (`Persistent=true`)
- `audiomonastry-backup-watchdog.timer` → täglich **10:00**
- Status: `systemctl --user list-timers audiomonastry-*` · Logs: `journalctl --user -u audiomonastry-dbbackup -n 50`

## Wiederherstellen

```bash
node scripts/r2-backup.mjs list db/                       # vorhandene Dumps
node scripts/r2-backup.mjs restore db/<datei>.sql.gz /tmp/restore.sql.gz
gunzip -c /tmp/restore.sql.gz | docker run --rm -i --network=host postgres:16-alpine \
  psql "postgresql://postgres:<PASSWORT>@db.pwtwtqbcynsjtkxlkrwh.supabase.co:5432/postgres"
# App-Bundle-Backup:  node scripts/r2-backup.mjs restore backups/<datei>.tar.gz /tmp/app.tar.gz
```

## Offene Punkte

1. **R2-Audio (6,28 GB) spiegeln** → Hetzner-Bucket (Kosten ~0,03 €/Monat Speicher). Nicht gebaut.
2. **Supabase Pro (PITR + tägliche Managed-Backups)** — 25 $/Monat, Betreiber-Entscheidung.
3. **App-Bundle-Backups** laufen erst wieder mit der Flotte (`install-backup-timer.sh` auf app-1);
   bis dahin meldet der Wächter das bewusst als Warnung.
4. Credential-Rotation: Die alten `CFS3_*`-Keys waren am 29.09. **tot** (HTTP 401) — ersetzt und
   verifiziert (HTTP 200). Bei Rotation immer *beide* Orte prüfen: App (`.env`) und Backups.
