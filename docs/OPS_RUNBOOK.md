# audioMONASTRY OPS-Runbook (PREP-8)

Betreiber-/Security-Aufgaben, die nur mit externen Zugängen (Cloud-Konsole,
HF, GitHub) gehen. Kein Code nötig – aber jeder Punkt ist ein Security/Compliance-Gate.

## 1. HF-Endpoint-Secret rotieren (halbjährlich oder bei Verdacht)
1. HuggingFace-Konto → *Settings → Access Tokens*.
2. Neues Token erzeugen (`read` für Inference-Endpoints genügt; für Deployment `write`).
3. In `~/.env` (bzw. Remote-`.env` im Flotten-Root) `HF_TOKEN=…` ersetzen.
4. `npm run verify` + Smoke: `npx tsx scripts/replicate-smoke.ts` (nur Replicate),
   AI-Fallback-Test: `node scripts/verify-ai.ts` (falls vorhanden) bzw. einen
   echten LLM-Aufruf via DeepSeek/HF-Router starten.
5. Altes Token sofort widerrufen.
6. Secret nie in Git/Logs – `git log -S` gegen den alten Wert prüfen.

## 2. Logging & Telemetrie
- Abgelehnte Socket-Handshakes loggt `services/signaling` seit 2026-09-06 mit
  IP-Hash (`ip#<hash>`) + ISO-Zeit – keine Klartext-PII.
- Ziel: abgelehnte Handshakes zusätzlich als Metrik an `/api/telemetry`
  (offen, PREP-8-Teilaufgabe für Flotten-Betrieb).

## 3. Flotten-Lebenszyklus
| Aktion | Befehl |
|---|---|
| Start (Git-Pull + Flotte + Deploy + Smoke) | `npm run fleet:start` |
| Stop (Snapshot-Backup + Server löschen, 0 €) | `npm run fleet:stop:yes` |
| Status | `bash scripts/hetzner/fleet-status.sh` |

Snapshots: `scripts/hetzner/lifecycle.sh stop` erzeugt `<name>-auto-<ts>`.
Wiederherstellung: `npm run fleet:start` provisioniert aus dem aktuellen Repo;
aus Snapshots booten erfordert `provision-fleet.sh` mit `IMAGE=<snapshot>`.

## 4. Supabase
- Migrationen live: `npm run supabase:apply`
- RLS: anon = lesen, service_role = schreiben (Migration 006).
- Keys: `SUPABASE_PAT` für Management-API, nie in den Client bauen.

## 5. Rotations-Checkliste (Sicherheit)
- [ ] HF_TOKEN rotiert
- [ ] `npm audit` 0 Vulnerabilities
- [ ] `git log --all -S` zeigt keine Secrets
- [ ] Workflow-Actions auf Commit-SHAs (AUD-2609-1)
- [ ] Nightly-CI-Lauf auf GitHub bestätigt

## 6. Rotations-Drill (2026-09-14, lokal ausgeführt)

Ablauf (gegen `node dist/server.cjs`, `NODE_ENV=production`, Port 3907):

```
Phase A: STUDIO_ACCESS_TOKEN=old-token-A
  curl -H "x-studio-token: old-token-A" /api/online  -> 200
  curl -H "x-studio-token: new-token-B" /api/online  -> 401
Phase B: Neustart mit STUDIO_ACCESS_TOKEN=new-token-B
  curl -H "x-studio-token: old-token-A" /api/online  -> 401
  curl -H "x-studio-token: new-token-B" /api/online  -> 200
```

Erkenntnis aus dem Drill: Nach dem Kill muss der Port tatsächlich frei sein
(`ss -ltnp | grep <port>`), sonst startet die neue Instanz mit `EADDRINUSE`
und die alte Instanz beantwortet weiter — das fällt bei `curl` nicht sofort
auf, weil die Antworten identisch aussehen. Deshalb im Deploy-Skript nach
`kill` immer erst `ss`/Health prüfen, bevor `up -d` läuft.

## 7. Backup & Restore (Off-Site, PROD-P0-002 — 2026-09-14 real durchgespielt)

**Ziel:** `BACKUP_S3_*`/`HOS_S3_*` (Hetzner Object Storage, Bucket
`audiomonastry-backups` in `nbg1`). Lokal bleibt der tar.gz mit Rotation.

```
# taeglich (Cron): lokales Backup + Off-Site-Kopie + Verifikation per HeadObject
BACKUP_DIR=/var/backups/audiomonastry bash scripts/backup.sh --offsite

# Kontrolle
node scripts/r2-backup.mjs buckets          # Bucket sichtbar?
node scripts/r2-backup.mjs list             # vorhandene Backups (Groesse/Datum)

# Restore
node scripts/r2-backup.mjs restore backups/audiomonastry_<stamp>.tar.gz /tmp/restore.tar.gz
sha256sum <lokal> /tmp/restore.tar.gz        # muss identisch sein
tar -xzf /tmp/restore.tar.gz -C /var/www/audiomonastry
```

**Scope:** `dist` + `public` OHNE `dist/data`, `dist/music`, `public/data`,
`public/music` → ~47 MB statt 5 GB (dist enthaelt beim Build Kopien der Medien).
Die 3 GB Orchestral-Samples sind Inhalt, kein Zustand; fuer eine Vollsicherung
`--full` verwenden. `public/uploads` (Nutzersamples) ist immer enthalten.

**Drill 2026-09-14 (echt):** Backup 48 253 484 Bytes → Upload nach
`nbg1.your-objectstorage.com/audiomonastry-backups` (etag verifiziert) →
Restore → **SHA-256 identisch** (`7889efda…39ddd`) → 311 Dateien entpackt →
`dist/server.cjs` byte-identisch und `node --check` OK.

**RPO/RTO:** taeglicher Lauf ⇒ RPO 24 h (mit `--offsite` auch off-site);
RTO ~2 min (entpacken) bzw. ~10 min inkl. `npm ci` + `npm run build`.

**Nicht im Backup (bewusst):** `.env`/Secrets (getrennt verwahren), Supabase-DB
(eigene Backups), statische Medienbibliothek (siehe Scope).
