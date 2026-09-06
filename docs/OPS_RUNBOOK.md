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
