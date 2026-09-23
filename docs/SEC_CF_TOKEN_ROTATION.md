# SEC-P1-005 — Cloudflare-API-Token rotieren (Anleitung + Prüfprozedur)

**Entscheidung des Betreibers am 2026-09-23: gemeinsam rotieren.**
Sie widerrufen im Dashboard, ich prüfe danach, dass kein alter Wert mehr im
Dateisystem oder in der Git-Historie steht.

## Warum überhaupt

Befund `SEC-P1-005` (Audit 2026-09-23): Der `CF_API_TOKEN` liegt **wieder auf
der Platte** (`-rw------- .env`, Zeile `CF_API_TOKEN`, 664 → am 2026-09-23 auf
600 korrigiert). Ein Token, der die Cloudflare-Zone und DNS-Einträge ändern
kann, ist der Hebel, mit dem ein Angreifer die Domain umlenken könnte. Ein
Token, der einmal auf der Platte lag, gilt als kompromittierbar — deshalb
rotieren, nicht nur verstecken.

Zusätzlich gemessen (Iteration 1): Der im Portal-Worker hinterlegte Token hatte
**kein DNS-Recht**, weshalb `POST /api/wire-fleet` mit
`Cloudflare-Zone nicht gefunden` scheiterte. Beim Rotieren also gleich die
richtigen Rechte vergeben oder bewusst minimal halten.

## Schritt 1 — Betreiber: widerrufen und neu erzeugen

1. Cloudflare Dashboard → **My Profile → API Tokens**.
2. Beim alten Token (`audioMONASTRY`-Token, in `.env` als `CF_API_TOKEN`):
   **Roll** oder **Delete**. Nach dem Widerruf ist er sofort tot.
3. Neuen Token anlegen. **Minimalrechte** wählen — nur was gebraucht wird:

   | Berechtigung | Scope | Wofür |
   |---|---|---|
   | `Zone → DNS → Edit` | die eine Zone | `syncOriginDns` (Wake verdrahtet die Domain) |
   | `Zone → Zone → Read` | die eine Zone | Zonen-ID auflösen |
   | `Account → Workers KV → Edit` | nur falls Snapshots genutzt werden | Portal-Worker |

   **Nicht** vergeben: `Zone → Zone → Edit`, `Account → Account Settings`,
   Tokens-Rechte. Ein Token ohne DNS-Edit macht den Wake blind (siehe oben).
4. `TTL`/Ablauf setzen (empfohlen: 90 Tage) und das Ablaufdatum notieren.

## Schritt 2 — Betreiber: Werte ablegen (nicht in den Chat!)

Betroffen sind **drei** Dateien mit Token-Bezug:

| Datei | Zweck |
|---|---|
| `.env` | `CF_API_TOKEN`, `CF_ACCOUNT_ID` (Server/Skripte) |
| `.env.portal` | Portal-Worker (Worker-Deploy + KV) |
| `.env.deploy` | Deploy-Skripte (`scripts/hetzner/`) |

Für den **Worker** muss der Wert zusätzlich als Secret gesetzt werden, nicht nur
in der Datei liegen:

```bash
cd services/portal-worker
npx wrangler secret put CF_API_TOKEN     # Wert interaktiv eingeben
npx wrangler deploy
```

Rechte nach jedem Schreiben prüfen:

```bash
chmod 600 .env .env.portal .env.deploy
stat -c '%a %n' .env .env.portal .env.deploy    # muss 600 zeigen
```

## Schritt 3 — Ich prüfe danach (das ist der Gegenbeweis)

Sobald die neuen Werte liegen, führe ich aus:

1. **Alter Wert weg?** Der alte Token-String darf in keiner Datei im Baum
   vorkommen — geprüft über alle Textdateien außer `node_modules`/`dist`, ohne
   den Wert selbst auszugeben (nur Trefferzahl).
2. **Historie sauber?** Scan der Git-Historie auf Token-Formate
   (`[A-Za-z0-9_-]{40}` im Kontext von `CF_API_TOKEN`). Stand 2026-09-23:
   nur `*.example`-Dateien mit Platzhaltern im Index, **kein** echter Wert.
3. **Rechte korrekt?** `stat` auf alle `.env*` — nur die drei
   `.example`-Templates dürfen gruppen-/weltlesbar sein (sie enthalten nur
   Platzhalter).
4. **Token funktioniert und reicht?** Read-Probe gegen die Cloudflare-API
   (Zonen-ID auflösen) — ohne den Wert im Output.
5. **Wake-Diagnose:** `POST /api/wire-fleet` muss jetzt `dns.ok: true` melden.
   Bleibt es bei `false`, fehlt weiterhin das DNS-Recht (siehe Schritt 1, Tabelle).

## Was ich NICHT kann

Ich habe keinen Cloudflare-Zugang. Widerrufen, Erzeugen und Ablegen der Werte
ist Betreibersache — ich kann nur davor und danach messen. Ein „erledigt" von
mir wäre an dieser Stelle eine Behauptung ohne Deckung.

## Offene Folgeposition

`TOKEN-P1-002` (Betreiber-Entscheidung): Ob der Token dauerhaft auf der Platte
liegen muss oder ob Deploy-Skripte ihn zur Laufzeit aus einem Secret-Store
beziehen können. Solange er liegt, ist `chmod 600` die Mindestmaßnahme — und
jede Rotation eine manuelle Aufgabe.
