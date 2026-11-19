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

## 2b. Messlauf 2026-11-18 19:03–19:26 (8 Rollen + Zweit-Hosts, Messung von Hetzner, Pod-Logs aus Vast)
Zeiten ab Miete (19:03:54) bis „models ready" laut Pod-Log; Hedge = Zweit-Host. **Kein Rollen-Ergebnis ist ein „bereit"-Nachweis der Gesamtkette**, nur Pod-Log und Probe.
| Rolle | Ergebnis | Zeit / Befund |
| --- | --- | --- |
| audio-brain | bereit | Zweit-Host 6,2 min (Gewichte 124 s), Primär 9,9 min (Gewichte 216 s). Probe von Hetzner: `/ready` 200 bei 98,6 s nach Messbeginn |
| vis | Modell/Runtime „ready" im Log | Zweit-Host 8,5 min, Primär 10,9 min. `/ready` von außen nicht gemessen (zweite Probe, Token-Fehler) |
| music | Zweit-Host bereit | 19,6 min (Gewichte allein 556 s); Primär: Container nach 22 min noch nicht gestartet |
| brain | **Fehler** | `model preload failed: TypeError` auf beiden Hosts, ca. 1 min nach Start (vLLM „Fetching 15 files", Fehlertext nicht geloggt) |
| voice | **Fehler** | `model preload failed: OfflineModeIsEnabled` auf beiden Hosts (HF-Offline-Modus, ein Modell will Dateien vom Hub); Gewichte 229 s bzw. 487 s |
| ears | **Fehler** | Zweit-Host: `resident preload incomplete: songformer`; Primär: Container nach 22 min noch nicht gestartet |
| song | **Fehler (Ursache gefunden)** | Absturzschleife alle 12 s: `FileNotFoundError: /opt/audiomonastry-ai/visual/effects.json`. In `Dockerfile.vast` kopiert die Stufe `song` nur `*.py *.json`, nicht `visual/`; `vast_app.py` importiert `visual_renderer`, das die Datei beim Import liest |
| studio | nicht bereit | Container nach 22 min noch nicht gestartet (kein Zweit-Host: Angebot nicht mietbar) |
Folgerungen: (1) Vier Rollen scheitern an **Image-/Konfigurationsfehlern**, nicht an der Startzeit; sie sind unabhängig vom 15-Minuten-Ziel zu beheben (Rebuild + Attestierung, siehe Betreiberregeln Runde 5). (2) Echte Startzeit nur für audio-brain, vis und music belegt: 6–11 min bzw. 20 min. (3) Drei Primär-Container (studio, ears, music) liefen nach 22 min noch nicht: Pull-Streuung, siehe B1. (4) Zweit-Host hat in 4 von 7 Fällen den schnelleren Weg geliefert (audio-brain, vis, music-bereit, ears-gestartet), bei den Fehlerrollen hilft er nicht.
Messfehler dieses Laufs: erste Probe erfasste wegen 150 s Wartefenster nur 5 von 15 Zielen; die zweite Probe lief mit falschem Pod-Token (HTTP 401 überall) und ist ungültig. Kosten ca. 4 € (Schätzung aus Laufzeit und Preflight, nicht aus der Abrechnung). Aufgeräumt: Vast 0 Instanzen, Hetzner 0 Server/0 IPs, Snapshot 457927664 unverändert.

## 2c. Stand 2026-11-18 ca. 22:45 (nach dem Messlauf): Korrekturen, Rebuild, Komplett-App
- Korrekturen im Code (Commit `0ae0537`, `cc60bc6`): song (`vast_app.py` lädt `visual_renderer` nur wenn im Image), ears (SongFormer-Pakete im Lock, Build prüft Imports), voice (Qwen3-TTS-Lader nehmen den lokalen Snapshot-Pfad), brain (vLLM bekommt lokalen Pfad; **Ursache nur begründete Vermutung**, nicht live belegt), alle Preload-Fehler loggen jetzt Text und Frames.
- Image-Rebuild: GitHub-Lauf `vast-fleet-images` #17 (Run 44412828901) auf `cc60bc6`; Ergebnis und Attestierung folgen (Workflow schreibt die Digests per Commit in den Branch).
- Werkzeuge (offline getestet, noch nicht live): `scripts/finalize-runtime-from-probe.py` (schnellerer Host je Rolle, anderer wird zerstört, Runtime-Umgebung ohne Vast-Schlüssel), `scripts/hetzner/app-from-snapshot.py` (App-Server aus Snapshot 457927664 mit Pod-Adressen per Cloud-Init, optional HTTP-Prüfung), `scripts/hetzner/http_check_probe.py`.
- Betreiberauftrag: innerhalb von 60 Minuten eine komplette App (1 Hetzner + 8 Vast), „alles genehmigt".
- **Bekannte Grenzen:** DNS wird nicht geändert (Cloudflare-Tokens dieser Umgebung ungültig; die App läuft auf neuer IP); der Vast-Schlüssel liegt nicht auf dem App-Server (Pods werden nicht von der App beendet, Timer nach 2 h); ob die App im Browser funktioniert, ist ungeprüft; die vier Fixes sind noch nicht live bestätigt.

## 2d. brain-Ursache belegt (Build-Lauf 44412828901, 22:41)
Der Build-Schritt „Canonical pinned model config" scheiterte für brain mit demselben `TypeError` wie der brain-Pod, diesmal mit Stack: `huggingface_hub.file_download.http_get` → `httpx2 _models.iter_bytes` → `_decoders.decode` → `_decompress(data, output_buffer_limit=...)` → **`TypeError: process() takes no keyword arguments`**. Das ist `brotli < 1.2.0` (Decompressor.process kennt `output_buffer_limit` erst ab 1.2.0) zusammen mit `httpx2 2.16.2`/`huggingface-hub 2.4.0`. Jeder Hub-Download mit Content-Encoding br scheitert. Die frühere Vermutung (Fortschrittsbalken/`DisabledTqdm`) war **falsch**. Korrektur: `brotli>=1.2.0` im Image samt Build-Prüfung (`Dockerfile.vast`, Commit `e5fb61b`); Rebuild als Lauf #18. Der lokale Snapshot-Pfad für vLLM bleibt als zusätzliche Absicherung.
Offen bleibt voice (`OfflineModeIsEnabled`): Korrektur (lokaler Snapshot-Pfad) ist begründet, aber nicht live bestätigt.

## 2e. Stand 2026-11-19 und „Nächster Lauf" (Vast-Guthaben fehlt)
**Lage:** Das Vast-Konto steht im Minus (Guthaben 0, Kontostand −0,28 $), Mieten sind gesperrt. Es läuft nichts: Vast 0 Instanzen, Hetzner 0 Server/0 IPs, Snapshot 457927664 unverändert. Der Betreiber kann frühestens in zwei Tagen aufladen. Die Images aus Build #19 (gcc, SonicMaster-Umgebung, brotli) sind gebaut und attestiert (Commit `e3005c1`), aber **noch nicht live erprobt**.

**Was am letzten echten Lauf (Build #18) belegt ist:** audio-brain, ears, song, vis bereit. **Nicht belegt:** brain, voice, studio, music (Korrekturen liegen im Image #19: gcc für Triton/Inductor, SonicMaster-Venv, Zweit-Host/Ersatz für music).

**Im Repo vorbereitet (ohne Guthaben getestet):**
- `scripts/fleet-up-measure.sh`: ein Befehl auf einem Rechner mit freiem Netz. Fragt Schlüssel unsichtbar ab, erneuert die Transfer-Inventur, plant mit klarer Fehlermeldung, prüft vorab, fragt „ja", mietet mit Zweit-Hosts (bis 11 €/h), Ersatz-Miete nach 6 min ohne gestarteten Container (`VAST_LATE_HEDGE_SECONDS`), schreibt den Kaltstart-Bericht und `docs/COLD_START_LOG.md`, entfernt die Flotte immer (`KEEP=1` hält sie an, nur nach erfolgreichem `up`).
- Host-Messwerte je Lauf: `host-observations.jsonl` im State-Verzeichnis (Maschine, GPU, Rolle, Zeit bis Container gestartet, Zeit bis bereit). Grundlage, um Hosts künftig nach Messung statt nach gemeldeter Bandbreite zu wählen.
- Für die Cloud-Sandbox (TLS zu Pod-IPs geblockt) bleiben `scripts/measure-from-hetzner.py` und `scripts/finalize-runtime-from-probe.py`; auf einem Rechner mit freiem Netz ist der Messserver nicht nötig.

**Checkliste vor dem nächsten Lauf:**
1. Vast aufladen (Richtwert: mindestens 10 €, Empfehlung 15 €; der Preflight prüft das).
2. Auf dem Linux-Rechner: `git pull`, dann `bash scripts/fleet-up-measure.sh` (für die laufende App danach `KEEP=1`).
3. Erwartung: alle 8 Rollen bereit; sonst zeigt der Bericht je Rolle den Grund (`/ready`-Text, Pod-Log). Ziel 15 min, eine Rolle bis 30 min, darüber Abbruch mit Hinweis.
4. App-Server aus dem Snapshot: `scripts/hetzner/app-from-snapshot.py` (Pod-Adressen aus `runtime.env`, CA aus `ca.pem`; DNS stellt der Betreiber auf die neue IP um).
5. Schlüsseltausch **erst, wenn das System zu 100 % steht** (Betreiberablauf; die neuen Schlüssel liegen bereit und bleiben bis dahin unbenutzt). Bis dahin laufen alle Tests mit den bestehenden Schlüsseln. Pod-Token verfällt mit den Pods.

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

## 7. Entscheidungen des Betreibers (2026-11-18)
1. Messort: **beides möglich**, Reihenfolge offen (Hetzner-Server aus Snapshot 457927664 und/oder GitHub Actions). Aus der Sandbox wird nicht gemessen.
2. Zweit-Host je Rolle: **erlaubt** (Grund: Pull-Zeit schwankt 45 s bis über 8 min unabhängig von der gemeldeten Bandbreite; der schnellere Host bestimmt die Wartezeit, die langsamere Instanz wird sofort zerstört; ca. 0,1–0,15 € je Rolle). **Noch nicht gebaut**: braucht Anpassung des Kaufpfads und der Kostenwächter (Stundenobergrenze gilt für die kurze Doppelmiete) samt Tests, vor jedem Lauf.
3. Payload der größten Rollen darf angefasst werden, falls 15 min nicht reichen (nur nach Messung, Modellidentität dokumentieren).
4. Hinweis zusätzlich **im Repo**: `docs/COLD_START_LOG.md` (nur anhängen), geschrieben mit `scripts/cold-start-report.py`. Gebaut und getestet.

## 8. Hetzner und Vast: Bestand (geprüft und bereinigt 2026-11-18 ca. 17:00, auf Anweisung des Betreibers)
- Vast: 0 Instanzen im gesamten Konto (16:15).
- Hetzner-Projekt audioMONASTRY (richtiges Token, Umgebung-Verwechslung mit Projekt Armageddon geklärt): Der Server `audiomonastry-prod` (ccx33, lief seit 16.11., IP 135.181.251.14) wurde
  **geordnet heruntergefahren, als Snapshot gesichert und gelöscht**. Snapshot **457927664** (status `available`, 2,95 GB belegt, aus dem Server erstellt, vor dem Löschen unabhängig geprüft).
  Danach: 0 Server, 0 Volumes, 0 Floating IPs, 0 Load Balancer, 0 Primary-IPs (mit dem Server gelöscht). Übrig: 1 Snapshot (ca. 0,03 €/Monat laut 0,0119 €/GB) und 4 Firewalls ohne Kosten.
- **Wiederherstellung:** neuen Server aus Snapshot 457927664 anlegen. Die alte IPv4 135.181.251.14 ist weg; DNS muss auf die neue Adresse zeigen. Der Snapshot wurde nicht an einem Wiederherstellungstest geprüft.
- Frühere Funde im Armageddon-Projekt (`projectarmageddon`, `pa-spiel-ipv4`) gehören nicht zu audioMONASTRY und wurden nicht angefasst.
- Die Umstellung auf die Ein-Instanz-App steht nicht im Repo (`docs/SERVER_FLEET.md`, `docs/HETZNER_DEPLOY.md` beschreiben noch vier Knoten): veraltet.

## 9. Aufräumen nach dem Test
Temporären GHCR-Token widerrufen; übrige Schlüssel nach erfolgreichem Preflight rotieren (Betreiber).
