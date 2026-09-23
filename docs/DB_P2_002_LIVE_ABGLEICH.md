# Live-Abgleich des RLS-Zustands (`DB-P2-002`)

**Stand: 2026-09-23 · Status: umgesetzt und live bewiesen, noch nicht automatisch ausgeführt**

---

## 1. Warum es diesen Abgleich gibt

Am 2026-09-23 fiel beim **ersten Live-Blick** in die Datenbank auf, dass die RLS-Härtung
`RC1-004` seit Iteration 2 committet im Repo lag — und **nie angewendet** worden war.

`pg_policies` zeigte vorher:

> `anon` durfte SELECT auf **13 Tabellen**, darunter `system_prompts` (53 Zeilen),
> `ai_evaluations` (285), `plugin_prompt_versions` (20), `ai_errors` (21).

Der anon-Key liegt im **öffentlichen Client-Bundle**. Diese Tabellen waren also für jeden
lesbar, der das Bundle kennt — während im Repo „DONE" stand.

**Und alle Gates waren grün.** `tests/supabaseRls.test.ts` prüft die Migrations**dateien** auf
einen Zustandsvertrag; der Test konnte den Unterschied nicht sehen.

> **Eine Migrationsdatei ist kein Vollzug.** Für die Sicherheit zählt nur, was in der Datenbank
> steht. Jede RLS-Aussage ist eine **Datei**-Aussage, bis sie gemessen wurde.

---

## 2. Was gebaut wurde

| Baustein | Datei | Aufgabe |
|---|---|---|
| Messstelle in der DB | `supabase/migrations/014_rls_contract_report.sql` | Funktion `public.rls_contract_report()` liefert je Tabelle: RLS-Status, jede Policy mit Rollen, Befehl und **Bedingung** |
| Vertrag + Prüfung | `server/rlsContract.ts` | Soll-Zustand und die reine Prüffunktion (ohne Datenbank, daher überall testbar) |
| Abgleich | `scripts/verify-rls-live.ts` | `npm run verify:rls-live` — holt den Bericht und vergleicht |
| Absicherung | `tests/rlsContract.test.ts` | 11 Tests, inklusive der Fälle, die den Vorfall erkennen |

**Die Funktion ist `SECURITY DEFINER` und nur für `service_role` freigegeben.** Sie offenbart die
Sicherheitslage der Datenbank und darf nicht am anon-Key hängen, den jeder im Bundle findet.

### Warum die *Bedingung* mitgeliefert wird

`pg_policies.roles` allein ist irreführend. Die Policies `visual_*_service_only` gelten formal für
die Rolle `public` — wer nur die Rolle liest, hält sie für offen. Nachgesehen in `qual` und
`with_check`:

```
(auth.role() = 'service_role'::text)
```

Sie sind gesperrt. **Genau dieser Fehlschluss ist mir am 2026-09-23 passiert** — ich habe die
`visual_*`-Tabellen für ein Loch gehalten, bis ich die Bedingung gelesen habe. Der Vertrag prüft
deshalb auf die Rolle `anon`, nicht auf `public`, und ein Test hält diesen Unterschied fest.

---

## 3. Der Vertrag

| Regel | Wert | Beleg |
|---|---|---|
| `anon` darf lesen | **genau** `samples` und `music_tracks` | `src/lib/supabaseClient.ts` liest nur diese beiden (Zeile 73/85); die übrigen Tabellennamen haben 0 Treffer in `dist/assets/*.js` |
| RLS aktiv | auf **jeder** Tabelle im Schema `public` | sonst greift keine Policy |
| Leerer Bericht | gilt als **nicht messbar**, nicht als bestanden | ein fehlender Messwert ist kein grünes Ergebnis |

Der Vertrag steht in `server/rlsContract.ts` (`RLS_CONTRACT`). **Jede Änderung dort ist eine
Sicherheitsentscheidung**, keine Formatierung: eine zusätzliche Tabelle in `anonReadTables` gibt
dem öffentlichen Schlüssel Lesezugriff.

---

## 4. Aufruf und Ergebnis

```bash
set -a && . ./.env && set +a
npm run verify:rls-live
```

Rückgaben: **0** = Vertrag erfüllt · **1** = Verstoß · **2** = nicht messbar (fehlende
Zugangsdaten oder fehlende Funktion — ausdrücklich **kein** bestandener Test).

Gemessen am 2026-09-23 gegen das Projekt `audioMONASTRY` (`pwtwtqbcynsjtkxlkrwh`):

```
Tabellen im Schema public: 20
davon ohne RLS:           keine
anon-Lese-Policies:       2
anon liest:               music_tracks, samples

✅ Vertrag erfuellt
```

---

## 5. Beweis, dass der Abgleich greifen kann

Ein grüner Lauf allein beweist nichts — ein Skript, das immer „ok" sagt, wäre wertlos.
Deshalb wurde eine **Negativprobe an der echten Datenbank** gefahren:

1. Temporär eine `anon`-SELECT-Policy auf `library_links` angelegt.
   (Bewusst diese Tabelle: sie ist leer — 0 Zeilen — und hat keinen Codepfad, es wurde also
   für die Dauer der Probe nichts exponiert.)
2. Abgleich laufen lassen → **exit 1**:

   ```
   anon liest: library_links, music_tracks, samples
   VERSTOESSE GEGEN DEN VERTRAG:
     - anon darf LESEN, was es nicht darf: library_links — das ist eine Exposition
       gegenueber jedem, der das Client-Bundle hat.
   ```
3. Probe wieder entfernt, nachgemessen → **exit 0**, `probe_noch_da = false`.

Der Abgleich erkennt den Vorfall also tatsächlich — nicht nur theoretisch.

---

## 6. Betrieb: Entscheidung und Stand

**Der Abgleich läuft nicht von selbst.** Er braucht `SB_URL` und `SB_SERVICE_ROLE` und ist deshalb
**nicht** Teil von `npm run verify` (das ohne Zugangsdaten laufen muss).

**Entscheidung des Betreibers am 2026-09-23:** *„rls abgleich wenn nur hetzner und auto aus
danach ja"* — also: **nur auf dem Hetzner-Knoten**, und **nicht von selbst scharf**.

Umgesetzt als `scripts/hetzner/rls-live-check.sh`. Der Skript ist **absichtlich nicht aktiv**:
Scharfmachen ist ein eigener, bewusster Schritt. Die vollständige Einrichtung (systemd-Service
und -Timer, `OnCalendar=*-*-* 03:30:00`) steht als Kommentarblock im Skriptkopf; Ausschalten mit
`systemctl disable --now audiomonastry-rls-check.timer`.

**Warum Hetzner und nicht CI:** die `.env` mit dem Dienstschlüssel liegt auf dem Knoten ohnehin.
Ein zusätzlicher Dienstschlüssel in GitHub wäre ein neues Ziel — und der Abgleich braucht keinen.

Rückgabe des Skripts:

| Code | Bedeutung | Wirkung |
|---|---|---|
| `0` | Vertrag erfüllt | nur Protokollzeile |
| `1` | **Verstoß gegen den Vertrag** — die Datenbank erlaubt mehr, als das Repo beschreibt | Alarm über den bestehenden Webhook (`critical`) |
| `2` | nicht messbar (Zugangsdaten oder Funktion fehlen) | als solches protokolliert, **nicht** als Erfolg |

Ein `2` ist ausdrücklich **kein** grünes Ergebnis: ein fehlender Messwert ist kein bestandener
Vertrag. Das ist derselbe Grundsatz wie in `QUAL-P2-008`.

> **Noch nicht eingerichtet.** Der Skript liegt im Repo, der Timer ist auf keinem Knoten scharf.
> Bis dahin gilt: nach jedem Deploy `npm run verify:rls-live` von Hand ausführen; Rückgabe 1
> blockiert die Freigabe.

