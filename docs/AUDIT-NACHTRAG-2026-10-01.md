# Nachträgliche Einordnung der SSOT
## Nachtrag zum Deep-Audit vom 29.09.2026 und zu den Testläufen

**Datum:** 2026-10-01 · **Basis:** Commit `99797bb` · **SSOT:** `MASTERTODOENDE.json` (237 Items)
**Anlass:** Die 44 Deep-Audit-Funde wurden triagiert; außerdem wurden vier E2E-Läufe vom 29.09.2026
nachträglich ausgewertet und die Host-Befunde vom 30.09./01.10. aufgenommen.

---

## 1. Die Deep-Audit-Funde sind auseinandergezogen

Bei der Übernahme der 44 Funde (`DA-2026-09-29-001..044`) in die SSOT wurde nur nach dem Titel
übernommen. Jetzt liegt an jedem Eintrag ein Triage-Block (`|| TRIAGE 2026-10-01 …`) mit der Prüfung
gegen den aktuellen Stand, einer Aufwandsschätzung und einer Einstufung:

| Einstufung | Anzahl | Bedeutung |
|---|---|---|
| `fixbar-jetzt` | 6 | kleiner, isolierter Codefix, keine Teständerung nötig |
| `fixbar-jetzt-Test-noetig` | 15 | Codefix plus Testanpassung |
| `Betreiber-Entscheidung` | 8 | Kosten, Live-Zugriff oder Recht — nicht durch Code zu klären |
| `bereits-behoben` | 10 | Fund trifft nicht mehr zu, mit Beleg → `status: DONE` |
| `Legacy/toter-Code` | 5 | Fundstelle gehört zu `services/backend-core/**`, das nirgends gebaut/gestartet wird |

**Wichtigster Teil: `bereits-behoben` ist nicht „abgehakt", sondern widerlegt.** Die beiden
Cloud-Routen-Funde (`DA-2026-09-29-011`, `-015`, dort noch als P0/P1 geführt) beruhen auf einem
**Prüfmethoden-Loch des Audits**, nicht auf einer Lücke im Code:

- `server.ts:402-467` registriert eine App-weite Auth-Middleware auf `app.use('/api', …)` mit
  fail-closed-Verhalten (`503 STUDIO_TOKEN_MISSING`, wenn kein Token konfiguriert ist).
- `registerCloudRoutes(app)` wird erst **danach** aufgerufen (`server.ts:707`); `/api/cloud/*`
  steht in keiner der Ausnahmelisten. Für Express wirkt die Middleware damit auf alle fünf Routen.
- Es gibt **bereits grüne Regressionstests**: `tests/security.test.ts:63-70` (Upload ohne Token → 401)
  und `tests/securityProductionAuth.test.ts:55-61` (Produktion ohne Token → 503).
- Ursache des Falsch-Positivs: die Route-Factory ist bewusst abhängigkeitsfrei
  (`server/routes/cloudRoutes.ts:11-12`); eine Prüfung der Datei allein kann die App-weite Kette
  nicht sehen.
- Echter Rest-Gap (bleibt offen, abgestuft auf Härtung): die Factory selbst hat kein
  Defense-in-Depth, es gibt kein Rollen-/Scope-Modell, und **3 von 5** Cloud-Routen sind gegen den
  Auth-Pfad nicht getestet. Remediation-Plan: `/home/patrick/audioMONASTRY-resume/artefakte/remediation-plan.md`.

Dasselbe Muster bei `DA-2026-09-29-030`/`-031` („LoRA wird nie geladen", „Workflow ist statisch"):
`comfyui_adapter.py` patcht den Workflow strukturiert zur Laufzeit (`:335-399`, `:434-523`) — offen
bleibt nur Kosmetik (Titel `:8`, Trigger-Token `:14`).

## 2. 55 Deep-Audit-Findings fehlen in der SSOT

`test-results/deep-audit/findings.json` enthält **99** Findings zum Stand `d1fb16c`; übernommen wurden
44. Es fehlen 55, darunter **alle 12 Duplikat-Funde**, 45× `low`, 4× `info` und 6× `medium`.
Das ist keine Wertung der Funde, sondern ein Zustand: Der Report suggeriert Vollständigkeit, die die
SSOT nicht hat. Siehe `AUDIT-2026-10-01-001` — Entscheidung (übernehmen / begründet verwerfen /
als Sammel-Eintrag) steht aus.

## 3. Vier E2E-Läufe vom 29.09. waren nie ausgewertet

Ausgewertet am 01.10. aus `junit.xml`, `report.json` und den `error-context.md`:

| Lauf | Ergebnis | Bewertung |
|---|---|---|
| `20260929-194105` | 61 Tests: 4 pass / 5 fail / 50 error / 2 skip | **nicht verwertbar** — 43× 30-s-Timeout auf demselben Entry-Gate-Locator (Seite ausgeliefert, Gate nie gerendert) + 7× `ECONNREFUSED` |
| `final-20260929-204649` | 61 Tests: 0 pass / 34 error / 27 skip, nach 66 s | **nicht verwertbar** — Dev-Server tot, 15× `worker process exited unexpectedly (SIGSEGV)` |
| `final-20260929-210450` | 61 Tests: 52 pass / 2 fail / 7 skip | **verwertbar, rot** — 2 echte App-Fehler |
| `final-20260929-211151` | 61 Tests: 53 pass / 1 fail / 7 skip | **verwertbar, rot** — 1 echter App-Fehler, reproduziert |

Die beiden nicht verwertbaren Läufe scheiterten **unterschiedlich** (einmal Serverabriss, einmal
Worker-Crash) — also kein gemeinsamer Harness-Fehler, sondern zwei Ausprägungen desselben
Host-Problems.

**Der belastbarste echte Fund:** `tests/e2e/a11y.spec.ts:68` „prefers-reduced-motion friert die
Canvas-Animation (identische Frames)" — in Lauf 3 (`…:9389335 → …:1305642`) **und** Lauf 4
(`…:9795332 → …:1367464`) aufgetreten und damit reproduzierbar. Die zweite Abweichung
(`visual.spec.ts:47`, Studio-Baseline) trat nur in einem Lauf auf → als flaky zu prüfen.
Belege: `test-results/e2e-hetzner/<lauf>/local/junit.xml` (+ `error-context.md`).

## 4. Host-Befunde, die jeden Testlauf betreffen

Der Arbeitsspeicher dieses Rechners lieferte **auch nach dem Modultausch** verfälschte Bytes:
Nach dem Kaltstart am 01.10. 01:08 meldete der Voll-Integritätslauf über 27.699 `node_modules`-Dateien
**5 verfälschte Dateien** (je gleiche Länge, **ein** falsches Byte: `typescript`, `lightningcss`,
`@sentry/core`, `tar`, `robots-parser`) und am 04:29 einen Kernel-Oops (`refill_obj_stock+0x86`,
Kontext `runc:[2:INIT]`), nach dem der NTFS-Mount in D-State hing. Die Tarball-Integritäten aller fünf
Pakete waren **in Ordnung** — die Verfälschung entstand beim Schreiben, nicht im Paket.

**Konsequenz für jede Aussage aus diesem Repo:** Ergebnisse von Test- und Buildläufen sind auf diesem
Host nur so belastbar wie der Speicher, auf dem sie entstanden sind. Bei jedem Lauf deshalb:
Tally-Zeile zitieren (nicht den Schlusssatz), Host-Crash (`Worker exited unexpectedly`, `2 errors`,
Exitcode 2, massenhaft `ERR_CONNECTION_REFUSED`) von echten Assertion-Fehlschlägen trennen und die
Laufzeit gegen gemessene Referenzwerte stellen.

**Gegenprobe mit Einzelmodul:** Mit nur dem 4-GB-Riegel (`97F6BF8D`) allein in DIMM1 lief derselbe
Datei-Roundtrip (12 × 41,6 MB, SHA256-Vergleich) **fehlerfrei**, dazu `npm test` 289/289 Dateien /
2226/2226 Tests und `npm run build` — `Bad page state` 0 und Segfaults 0 vor **und** nach dem Lauf
(`/tmp/ramtest-dimm1-20261001-1726.log`). Das ist eine gute Probe, aber **kein Unschuldsbeweis**:
Ein Bit-Flip alle paar Stunden ist mit einem Lauf über Minuten nicht widerlegbar.

## 5. Was daraus als nächstes folgt

1. **Einzelmodul-Test fortsetzen** (`HOST-2026-10-01-003`): 4 GB nacheinander in DIMM2/3/4, danach
   8 GB allein in allen vier Slots. Historisch bringt die 8-GB-Bestückung 5 Pieptöne und ein schwarzes
   Bild — das ist die Aussage des Boards (Speicher-Training fehlgeschlagen), kein Riegel-Nachweis.
   Regel: nie mit piependem Board weiterprobieren, sondern Netzschalter aus und den letzten
   lauffähigen Stand herstellen.
2. **a11y-Befund nachstellen** (`TEST-2026-09-29-001`): `prefers-reduced-motion` gegen den aktuellen
   Stand prüfen — das ist der einzige reproduzierte App-Fund aus dem 29.09.
3. **Die 6 `fixbar-jetzt`-Funde abarbeiten** — kleine, isolierte Stellen, in der Triage je Fund mit
   Datei und Zeile benannt.
4. **Entscheidung zu den 55 fehlenden Findings** (`AUDIT-2026-10-01-001`).

Alle Belege und Auswertungen liegen zusätzlich unter `/home/patrick/audioMONASTRY-resume/`
(Systemplatte, überlebt einen NTFS-Ausfall): `artefakte/` enthält die Triage, die E2E-Auswertung, den
Integritäts-Report und die Logs, `hermes-logs/` die extrahierten Hermes-Log-Funde.
