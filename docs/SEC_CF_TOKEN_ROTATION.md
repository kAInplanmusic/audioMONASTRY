# SEC-P1-005 — Cloudflare-API-Token rotieren (Anleitung + Prüfprozedur)

**Entscheidung des Betreibers am 2026-09-23: gemeinsam rotieren.**
Sie widerrufen im Dashboard, ich prüfe danach, dass kein alter Wert mehr im
Dateisystem oder in der Git-Historie steht.

> **Stand 2026-09-23 — die Hälfte, die ich leisten kann, ist erledigt.**
> Der Wert wurde aus allen drei Dateien entfernt, in denen er lag
> (`.env`, `.env.bak-20260920-145010-template-override`,
> `.env.bak-r2-20260921-171203`). Nachgemessen danach:
>
> * **0 Dateien** im Baum enthalten noch einen Wert (nur der Name steht in
>   Kommentaren).
> * **0 Commits** in der gesamten Historie enthalten den Wert
>   (`git log --all -S"<wert>"`). Das Repo hat ihn also **nie** geleakt — die
>   Exposition war rein lokal.
> * **0 Treffer** außerhalb des Repos (`~/.hermes`, `~/.config`, `~/SECRETS`,
>   `~/.bashrc`).
> * Die Rechte der drei Dateien sind unverändert `600`.
>
> **Offen bleibt der Widerruf im Cloudflare-Dashboard.** Das ist der Teil, der
> zählt: der Wert war am 2026-09-17 live als gültig gemessen (HTTP 200,
> `status: active`), und lokales Löschen macht einen Token nicht ungültig. Bis
> zum Widerruf gilt er als kompromittiert.
>
> **Und eine Lehre aus dem Vorgang:** `SEC-P1-002` und `ENV-006` standen auf
> DONE mit der Aussage „danach liegt kein Cloudflare-Token mehr auf der Platte".
> Gemessen war das falsch. Eine Beseitigung, die niemand nachmisst, ist eine
> Behauptung — derselbe Fehlertyp wie bei der RLS-Härtung (`DB-P2-002`), wo die
> Migration im Repo lag und nicht in der Datenbank.

---

## Was am 2026-09-23 abends passiert ist (bitte zuerst lesen)

Der Betreiber hat **neue** Cloudflare-Zugangsdaten geliefert; sie wurden in die
`.env` eingetragen und **vor** dem Eintragen geprüft.

| Eintrag | Prüfung | Ergebnis |
|---|---|---|
| `CF_TOKEN_UT` (`cfut_…`) | `GET /user/tokens/verify` | **200, `status: active`** ✅ |
| `CF_TOKEN_ACCOUNT` (`cfat_…`) | `/user/tokens/verify` → 401 (erwartbar, kontogebunden); `/accounts` | **200** ✅ |
| `CF_TOKEN_KEY` (`cfk_…`) | `/user/tokens/verify` → 401; `/accounts` → 403 | **nicht verwendbar mit Bearer** ❓ |
| `CFS3_ENDPOINT` + `CFS3_ACCESS_KEY` + `CFS3_SECRET_KEY` + `CFR2_ACCOUNT_ID` | `HeadBucket` + `ListObjectsV2` mit dem S3-SDK des Projekts | **OK, echte Objekte gelesen** ✅ |

`CF_API_TOKEN` (der kanonische Name, den Code und Doku lesen) wurde auf den
**gemessenen** gültigen Wert gesetzt — nicht auf einen geratenen.

### Zwei Dinge, die offen bleiben

1. **Ist das überhaupt ein neuer Token?** Der entfernte und der neue Wert sind
   **beide 53 Zeichen** und im selben `cfut_`-Format. Ob sie identisch sind, ist
   **nicht mehr feststellbar** — die alten Werte wurden gelöscht, und in der
   Git-Historie standen sie nie. `ANNAHME:` Es kann derselbe Token sein. Dann hat
   **keine Rotation stattgefunden**, und der Wert lag tagelang auf der Platte.
   Wer Sicherheit will, erzeugt im Dashboard einen **neuen** und widerruft den
   alten — das ist der einzige Weg, der die Frage beantwortet.
2. **`cfk_…` hat keinen belegten Zweck.** Er antwortet weder als Bearer-Token
   noch auf Konto-Ebene. Er liegt jetzt in der `.env`, weil er geliefert wurde —
   nicht weil er geprüft funktioniert. Als `SEC-P2-005` im Register vermerkt.

### Und die Exposition, die ich nicht rückgängig machen kann

Die Zugangsdaten wurden **im Klartext in den Chat** geschrieben. Alles, was dort
steht, ist aus meiner Sicht **kompromittiert** — unabhängig davon, wie vertraulich
der Verlauf behandelt wird. Empfehlung: nach dem Testen einen frischen Satz
erzeugen und diesen hier widerrufen. Der Aufwand ist klein, der Unterschied groß.


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
