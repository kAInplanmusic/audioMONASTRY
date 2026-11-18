# Golden Master: Startplan der AI-Flotte (Ist, Soll, Vorschlag)

Stand 2026-11-18, nach den Messläufen des Tages. Es läuft nichts: Vast zeigt 0 Instanzen, keine Hintergrundprozesse.
**Regel ab jetzt:** Kein Live-Lauf ohne ausdrückliche Freigabe des Betreibers und ohne grünen Abschnitt 5.

## 1. Soll (Betreiber)
- App nach `up` in **unter 15 Minuten** bereit.
- Dauert eine **einzelne** Rolle länger, darf sie bis zu **15 Minuten mehr** laufen (Höchstgrenze 30 min), danach Abschaltung.
- Zwei oder mehr Rollen zu spät: Abbruch bei 15 min.
- Jede Rolle über 15 min erzeugt einen **Hinweis** zur Workflow-Optimierung.
- Kosten: erste Stunde unter 8 €/h (bis 9 €/h vom Betreiber zugelassen, falls keine günstigere Karte verfügbar ist).
- „Golden Master" erst nach **einem** sauberen Lauf `up → messen → down`.

## 2. Belegt (aus den Läufen 2026-11-18, Rohdaten: `timeline.jsonl`, Pod-Logs, `cold-start-report.json`)
| # | Befund | Beleg |
| --- | --- | --- |
| B1 | **Image-Pull schwankt stark.** Zeit bis `running`: 45 s, 212 s, über 8 min (drei Läufe `audio-brain`, drei verschiedene Hosts). Im Volllauf 15:36 (gleichzeitig gestartet): ears 48 s, brain 63 s, audio-brain 103 s, studio 164 s, music 217 s, song 291 s, voice 548 s. | Beobachter-Zeitverläufe |
| B2 | **Die vom Host gemeldete Bandbreite sagt die Zeit nicht voraus.** Ein Host mit gemeldeten 4928 Mbit/s zog das Image über 8 min lang; ein Host mit ca. 900 Mbit/s brauchte 201 s. | Läufe 15:20 und 15:04 |
| B3 | **Gewichte (13,5 GB-Rolle audio-brain):** 120 s; danach Uvicorn bereit und Modell geladen 15 s später. Pod war laut eigenem Log ca. 5 min nach der Miete bereit. | Pod-Log Host 142274 |
| B4 | **Aus der Cloud-Sandbox sind Pods per TLS grundsätzlich nicht erreichbar, unabhängig vom Host.** Gegenprobe 16:17: derselbe Abbruch (nach 2 s, 39 B empfangen) bei `www.cloudflare.com:8443`, `1.1.1.1:443` und `1.1.1.1:2053`. Der Proxy dieser Sandbox lässt TLS zu IP-Adressen und Nicht-Standard-Ports nicht durch; Pod-IPs mit Ports wie 16412 sind damit nie erreichbar. Es liegt weder an den Pods noch an den Hosts. | Proxy-Status `recentRelayFailures` (5 Pod-IPs und 3 Gegenproben), curl-Verbose |
| B5 | **Folge von B4:** Bereitschaft (`/models`, `/ready`) war von hier nie messbar. Alle „nicht bereit"-Ergebnisse dieser Sandbox sind kein Beleg gegen die Pods. | – |
| B6 | **Angebotsliste:** Suchlimit 40 verengte voice auf 2 Hosts und machte die Flotte „zu teuer" (9,78 €). Mit 100 passt der Plan (5,6–6,05 €/h). Standard jetzt 100. | Plan-Läufe, Commit `6ecbd83` |
| B7 | **Geister-Angebote:** Ein gelistetes Angebot (voice, Host 144209) war mehrfach nicht mietbar (`no_such_ask`, kein Vertrag). Wiederholung auf anderem Host ist eingebaut und getestet. | Läufe 15:29–15:36 |
| B8 | **Technik funktioniert:** 15/30-Minuten-Regel, Hinweisbericht, Parallelmodus (`VAST_EXECUTOR_GATE=parallel`), Host-Sperrlisten, Beobachter. Alles mit Tests, `down` bestätigte jedes Mal 0 Instanzen. | `tests/test_cold_start_report.py` u. a. |
| B9 | **Falsche Sperren:** Fünf gesunde Hosts wurden wegen B4 als „unerreichbar“ gesperrt (Einträge entfernt). Die Host-Sperre „unerreichbar“ ist nur gültig, wenn der Messweg selbst nachweislich funktioniert; **in der Sandbox ist sie abzuschalten**. | Sperrliste vorher/nachher |

## 3. Nicht belegt (bitte nicht als Tatsache behandeln)
- Ob die **großen Rollen** (brain 39 GB, voice 55 GB, music 44 GB, ears 26 GB) in 15 min bereit sind: Pull und Gewichts-Download wurden dort nie vollständig bis „Modell geladen" gemessen.
- Gewichts-Download-Rate für große Rollen (nur eine Messung: ca. 13,5 GB in 120 s).
- Warum der Weg Sandbox → Pod bricht (Proxy, TLS, Host). Es gibt keinen Beleg, dass er von GitHub Actions oder vom Hetzner-Server aus funktioniert.
- Startzeit einer **gestoppten, warmgehaltenen** Instanz (Vast-Doku: Speicher kostet weiter, Wiederstart nicht garantiert).

## 4. Meine Einschätzung: schnell, einfach, günstig
1. **Nicht aus der Sandbox messen.** Der einzige verlässliche Messort ist der Rechner, der später auch die Flotte startet (Hetzner-Server der App) oder ein GitHub-Actions-Lauf mit freiem Netz. Das ist die Voraussetzung für jede weitere Messung. Kosten: 0 €.
2. **Pull-Schwankung abfangen, statt vorherzusagen (B1, B2).** Gemeldete Bandbreite taugt nicht zur Wahl. Einfachster Hebel: **für jede Rolle zwei Hosts gleichzeitig mieten und den schnelleren behalten**, den langsameren sofort zerstören. Kosten: ca. 0,5–0,9 €/h je Zweitinstanz, also bei 10 Minuten etwa 0,1–0,15 € pro Rolle, insgesamt ca. 1 € pro Start. Das braucht eine Betreiberfreigabe, weil es die Regel „kein zweiter Vertrag je Rolle" bewusst aufhebt.
3. **Parallel starten, nicht nacheinander.** Das Gate vor den anderen Rollen kostet bis zu 8 min des 15-min-Budgets. Der Parallelmodus ist gebaut, aber noch nicht außerhalb der Sandbox erprobt.
4. **Größte Rollen zuerst beobachten.** Wenn voice (55 GB) und brain (39 GB) die 15 min reißen, gilt die Ein-Rollen-Regel nur für eine; die zweite führt zum Abbruch. Dann zuerst Payload der größten Rolle verkleinern (Quantisierung, weniger Modelle, braucht Betreiberfreigabe) oder die Rolle bei Bedarf nachstarten.
5. **Warmhalten nur messen, nicht annehmen.** Ob gestoppte Instanzen schnell genug zurückkommen und den Speicher wert sind, zeigt ein einziger Test (siehe 5).

## 5. Vorab, bevor irgendetwas gemietet wird (alles kostenlos)
- [ ] Messort festlegen (Hetzner-Server oder GitHub Actions) und dort **einmal** prüfen, ob ein Pod per TLS erreichbar ist: ein einzelner `audio-brain`-Pod, ca. 0,05 € (Obergrenze 0,10 €). Erfolg = `/models` und `/ready` antworten.
- [ ] Zugangsdaten am Messort bereit (GHCR-Token klassisch mit `read:packages`, R2, Vast, Pod-Token); keine Schlüssel in Chat oder Repo.
- [ ] `npm run verify`-relevante Python-Tests grün (`tests/test_cold_start_report.py`, `test_vast_*`, `test_fleet_doc_contracts.py`).
- [ ] Preflight grün: Kosten ≤ Limit, Registry-Digests, Gewichts-Links.
- [ ] Abbruchregeln fest: 30 min Höchstzeit, `down` bei jedem Fehler, Kostenobergrenze aus dem Preflight (zuletzt 3,8 €).

## 6. Ablauf des einen Laufs (nach Freigabe)
1. Preflight → 2. Start parallel (optional mit Zweit-Host je Rolle) → 3. Messen: Zeit bis `/ready` je Rolle am Messort → 4. Ergebnis und Hinweisbericht → 5. `down`, 0 Instanzen bestätigt.
Erfolg: alle Rollen ≤ 15 min, oder genau eine ≤ 30 min mit Hinweis; Kosten ≤ Obergrenze; echte Inferenz je Rolle (normale Defaults); vis ≥ 29 fps bei 1080p30.

## 7. Entscheidungen des Betreibers
1. Messort: Hetzner-Server oder GitHub Actions?
2. Zweit-Host je Rolle (ca. 1 € mehr pro Start) erlauben oder nicht?
3. Payload der größten Rollen anfassen dürfen, falls 15 min nicht reichen?
4. „Hinweis in der Basis": nur Berichtsdatei/Konsole (jetzt) oder zusätzlich `docs/COLD_START_LOG.md` bzw. App-Anzeige?

## 8. Hetzner und Vast: Bestand nach den Läufen (geprüft 2026-11-18 16:15–16:20, nur lesend)
- Vast: 0 Instanzen im gesamten Konto.
- Hetzner (Projekt des gespeicherten Tokens): 0 Server, 0 Volumes, 0 Floating IPs, 0 Load Balancer, 0 Firewalls. 1 Snapshot (`projectarmageddon`, 2,1 GB, 10.11.), 1 nicht gebundene Primary-IPv4 `pa-spiel-ipv4` (49.13.138.200). Preis laut Hetzner-Preisliste: Cloud-Primary-IPv4 0,50 €/Monat.
- **Nicht belegt:** Snapshots der App-Server (`audiomonastry-snapshot-{app,sfu,media,edge}`, Doku 2026-11-12) sind in diesem Projekt nicht vorhanden. Entweder gehört das Token zu einem anderen Projekt, oder sie existieren nicht mehr. Vor jeder Löschung klären.

## 9. Aufräumen nach dem Test
Temporären GHCR-Token widerrufen; übrige Schlüssel nach erfolgreichem Preflight rotieren (Betreiber).
