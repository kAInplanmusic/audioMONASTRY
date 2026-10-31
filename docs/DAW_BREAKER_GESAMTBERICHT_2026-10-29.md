# audioMONASTRY — DAW-Breaker Gesamtaudit & Implementierungsnachweis

**Datum:** 29.10.2026 · **Repository:** [kAInplanmusic/audioMONASTRY](https://github.com/kAInplanmusic/audioMONASTRY)  
**Haupt-Basisstand:** `main@3e351f775e28edfe7192121fc3d88f59971fa300`  
**Integrationsbranch:** `audit/integrated-daw-breaker-20261029` · [PR #22](https://github.com/kAInplanmusic/audioMONASTRY/pull/22)  
**Abgrenzung:** Dieser Bericht ist eine **technische Beweismatrix**, **keine Produktionsfreigabe** und kein Ersatz für einen vollständigen Live-Penetrations-, Hör- oder Performance-Test.

## 1. Arbeitsauftrag, Freigabe und Sicherheitsgrenzen

Auftrag: Browser-DAW mit bis zu vier aktiven Musikern, zwei Ausgabe-Clients, AudioWorklet-V2, gemeinsamer Session, KI-/RunPod-/Hetzner-Infrastruktur forensisch prüfen, defensiv härten und mit echten Regressionen absichern. Erlaubt: GitHub-Code lesen, Sicherungsbranches/PRs anlegen, isolierte Tests. **Nicht erlaubt**: destruktive Produktionsdatenaktionen. Keine Produktionsdaten wurden bearbeitet; keine geheimen Zugangsdaten in diesen Bericht übernommen. Auf realen Hetzner-/RunPod-Systemen wurden **keine** neuen destruktiven Tests oder Deployment-Aktionen vorgenommen.

### Evidenz- und Zustandsbegriffe
- **Quellcode bestätigt:** betreffende Kontrollfluss-/Datenfluss-Eigenschaft im GitHub-Stand nachgewiesen; nicht zwingend online ausnutzbar.
- **Automatisiert getestet:** Vitest-/Socket.IO-Test im GitHub Actions Runner ausgeführt; Mediasoup kann dabei gemockt sein.
- **Modellreproduktion:** kleiner isolierter Harness ohne Originalserver; guter Hinweis, aber **kein Live-Exploit**.
- **Risiko / offene Hypothese:** Architekturannahme, noch kein belastbarer Laufzeitnachweis.
- **Implementiert (Branch):** Code ist committed, `main`/Produktion bleiben unverändert, bis Merge/Deployment verifiziert sind.
- **Freigegeben:** erst nach den unten genannten zusätzlichen Gates. Dieser Status **liegt nicht vor**.

## 2. Tatsächlich eingebrachte Changesets

| PR | Gegenstand | Geänderte Kernbereiche | Beweis / Einschränkung |
|---|---|---|---|
| [#19](https://github.com/kAInplanmusic/audioMONASTRY/pull/19) | Session-Membership, Listener-Rechte | `server/realtime.ts`, `tests/sessionSocketAccess*.ts` | 9 Handler mit zentraler Member-Guard; Unit-/Socket.IO-Integration geprüft |
| [#20](https://github.com/kAInplanmusic/audioMONASTRY/pull/20) | SFU-Eintritt, Daten-Relay, Videocodec | `server/sfuTicket.ts`, `server/routes/mediaRoutes.ts`, `server/realtime.ts`, `src/core/transport/MediasoupTransport.ts`, SFU-Tests | HMAC-Tickets, echte Socket.IO-Handshakes bei gemocktem mediasoup, keine echten RTP-Pakete |
| [#21](https://github.com/kAInplanmusic/audioMONASTRY/pull/21) | CI-Diagnose/-Reparatur | `.github/workflows/ci.yml`, `.github/workflows/sonarcloud.yml`, `tests/agentRuns.test.ts` | NumPy im Python-Smoke; Sparse-Checkout ergänzt; deterministische Abbruch-Barrieren |
| [#22](https://github.com/kAInplanmusic/audioMONASTRY/pull/22) | **Konsolidierte Integration** | beide Bereiche von `server/realtime.ts` zusammengeführt; CI-Abdeckung und diese Beweismatrix | maßgeblicher gemeinsamer Review-/Teststand; **Draft, nicht gemergt** |

### Funktionsumfang im Integrationsbranch

1. **Mitgliedschaft:** `canMutateSessionSocket` unterscheidet Mitglieder und Ausgabegeräte; `leave-session` löscht die editierbare Socket-Zuordnung; doppelter `join-session` wird zurückgewiesen. Das verhindert die bisher im Code möglichen Ghost-Writes und einige Listener-Mutationen.
2. **SFU-Authentifizierung:** `GET /api/sfu-ticket` hinter bestehender Studio-API-Authentifizierung stellt ein **90 Sekunden gültiges**, per HMAC-SHA256 signiertes Token für genau eine SFU-Session aus. `sfuIo.use` prüft Token, Ablauf und Zielsession **vor** Aufnahme der Verbindung. Browser holt bei jedem Connect/Reconnect ein Ticket. Getrennte SFU-Hosts teilen das serverseitige `SESSION_SECRET`. Fehlende Secrets führen zu Ablehnung.
3. **SFU-Nachrichten:** `data`-Ereignisse werden nur im authentifizierten selben SFU-Raum an andere Peers weitergeleitet, mit maximal 64 KiB serialisiertem JSON und 100 Ereignissen/s je verbundenem Socket. Dieser Handler ersetzt **keine** semantische Event-ACL.
4. **Video:** Mediasoup-Router deklariert zusätzlich zu stereo Opus den VP8-Codec für `sendVideoTrack` / Visual-Ausgabe.
5. **Tests:** SFU-Signatur-/Ablauf-/Replay-Grenzfälle, echte lokale Socket.IO-Handshake- und Relay-Testpfade, Listener- und Leave-Rechte, Rejoin-Grenzen; `agentRuns`-Abbruchtest verwendet gezielte Signal-/Planungsbarrieren statt unzuverlässiger absoluter Zeitfenster.
6. **KI-Integrität:** Das Modell kann die serverseitige \`task_id\`/\`source\`/\`provider\` nicht mehr ersetzen. Der Session-Disconnect gibt Locks nur noch für echte Edit-Verbindungen ohne weiteren aktiven Editor gleicher ID frei. Zwei neue AI-Tests und zwei Socket.IO-Tests sichern die Fälle ab.\n7. **CI:** Python-Smoke installiert `numpy` vor dem Testimport. Sonar-Sparse-Checkout lädt breite Quell-/Dokumentations-/Deployment-Dateien, schließt das riesige `public/`-Medienverzeichnis bis auf kleine erforderliche Assets aus.

**WICHTIG:** Die Implementierungen in den Einzel-PRs sind teilweise voneinander abhängig. Die erfolgreiche Ausführung eines einzelnen PRs beweist nicht automatisch die Integration; dafür zählt ausschließlich der CI-Lauf auf **dem genauen Head-SHA von PR #22**.

## 3. Befundmatrix (DB-001 bis DB-021)

| ID | Priorität | Art | Beobachtung und technisch begründeter Impact | Status / Belegqualität |
|---|---|---|---|---|
| **DB-001** | P0 | Secret Exposure | Ein `.env`-Pfad war im Git-Repository versioniert; mögliches Offenlegen von Studio-/Session-/KI-Tokens. Ob Schlüssel noch gültig sind, wurde nicht geprüft. | Git-Datei bestätigt; **Rotation + Historienprüfung offen** |
| **DB-002** | P0 | Supply Chain | `main` wurde ohne Branch Protection gemeldet; unkontrollierte Direct Pushes können Gates umgehen. | Repository-Metadaten bestätigt; **Schutzregeln offen** |
| **DB-003** | P0 | Authz / Identität | `join-session` akzeptiert `data.userId`; `verifyStudioSession` liefert Boolean statt authentifizierten Subject-Claim. Signierter Browserzugang ist nicht zwingend an die Socket-User-ID gebunden. | Quellcode bestätigt; **vollständige Identitätsbindung offen** |
| **DB-004** | P1 | Testabdeckung | Ältere 4-User-Tests verwenden gemeinsamen Master-Token bzw. vier Browser-Kontexte mit ggf. identischer Identität; sie beweisen nicht vier unterschiedliche berechtigte Accounts. | Testcode bestätigt; **vier echte unabhängige Accounts offen** |
| **DB-005** | P0 | SFU-Auth | Getrennte Mediasoup-Signalisierung (`sfuIo`) ohne eigene Handshake-Auth. Eine öffentlich erreichbare SFU würde ohne vorgelagerten Schutz Transport-Ressourcen anbieten. | **Fix auf PR #20/#22**: Ticket-Middleware; echter Remote-Pentest offen |
| **DB-006** | P0 | Listener-ACL | Listener-Modus vom Client wählbar und verschiedene schreibende Handler ohne explizite Member-/Edit-Prüfung. | **Teilfix PR #19/#22** (9 Handler); übrige mutierende Events weiter inventarisieren |
| **DB-007** | P1 | Lock-Lebenszyklus | Disconnect-Lockfreigabe basiert auf User-ID statt eindeutiger Verbindung; eine zweite Verbindung mit derselben Identität kann fremde Locks freigeben. | **Teilfix im Integrationsbranch:** Listener-Leave/Disconnect und das Abmelden einer von mehreren Editor-Verbindungen dürfen die Locks der verbleibenden Verbindung nicht freigeben; 2 zusätzliche Socket.IO-Integrationstests. **Identity Binding weiter offen** |
| **DB-008** | P1 | KI-Rate-Limit | `x-session-id` kann Rate-Limit-Identität mitbestimmen. Mehrere selbstgewählte IDs erzeugen unterschiedliche Budgets. | **Teilfix auf PR #22:** Teure KI- und Agent-Routen ignorieren das frei wählbare \`x-session-id\`-Feld, verwenden bei signiertem Subject eine Stable-ID, sonst das normalisierte IP-Budget. Vier Regressionstests. **Eigenständiges Account-Budget offen** |
| **DB-009** | P0 | Multinode-State | `sessionRuntime` persistiert Snapshots per Redis-`SET`, ohne Compare-and-Swap; konkurrierende App-Knoten können Writes überschreiben. | Architektur belegt; **echter Zwei-Knoten-Konflikttest/CAS offen** |
| **DB-010** | P1 | LLM-Output | Modell-JSON kann bei Objekt-Spread serverseitig definierte Metadaten wie `task_id` überschreiben. | **Teilfix im Integrationsbranch:** LLM-JSON kann \`task_id\`/\`source\`/\`provider\` nicht mehr überschreiben; 2 Manipulations-Regressionstests. **Vollständige Schema-Allowlist offen** |
| **DB-011** | P1 | Audio-Integrität | Bei im Buffer mutierenden Plugin-Adaptern kann ein Exception-Catch teilweise veränderte Samples weiterreichen. | Modellreproduktion; **Original-DSP-Referenzsignaltest offen** |
| **DB-012** | P0 | Ghost-Write | `leave-session` entfernt zuvor zwar Socket.IO-Raum, ließ aber `socket.data.sessionRoom/sessionUserId` stehen. | **Fix PR #19/#22** + Socket.IO-Integration |
| **DB-013** | P1 | Konfliktkontrolle | `baseRevision` und `sequence` sind optional; ohne sie greifen Prüfungen nicht. Legacy-Verhalten erlaubt veraltete Updates. | Quellcode bestätigt; **Version-Pflicht/Legacy-Migration offen** |
| **DB-014** | P1 | Rejoin/Lock | Wiederholtes `join-session` mit neuer User-ID kann bestehende Lock-Ownership verwaisen lassen. | **Teilfix PR #19/#22**: aktive Rejoins abgelehnt; TTL/Socket-Leases offen |
| **DB-015** | P2 | Informationsfluss | `master-out`/`visual-out` bekommen weitreichende Session-Snapshots statt minimaler Ausgabedaten. | Quellcode bestätigt; **least-privilege Snapshot offen** |
| **DB-016** | P0 | Datenlöschung | `store-remove` prüfte nur Raumzuordnung; Listener konnte gemeinsame Einträge löschen. | **Fix PR #19/#22**: Member-only Guard; Restinventar offen |
| **DB-017** | P1 | Audio-RT | Control-Ring kann bis zu 4095 Ereignisse puffern; keine harte CPU-Budgetgrenze bei Drain pro Audio-Quantum. | **ungetestetes Last-/Dropout-Risiko**; Benchmark offen |
| **DB-018** | P1 | Audio-RAM | Offline-Bounce allocates komplette Stereo-Float32-Arrays statt streaming/chunkweise zu rendern; 60 min @48 kHz können mehrere GiB beanspruchen. | Architektur/Größenabschätzung; **echter Peak-RAM-Messlauf offen** |
| **DB-019** | P0 | Globaler Capacity-Guard | Vier-User-Limit liest lokale Socket.IO-Registries; ohne globale atomare Reservierung können zwei Knoten unterschiedliche Zählungen sehen. | **Hypothese**, Mehrknoten-Integration fehlt |
| **DB-020** | P1 | SFU-Daten | SFU-Client sendet `data`, ursprünglicher SFU-Server registrierte kein entsprechendes Ereignis. | **Fix PR #20/#22**: Session-Relay + lokale Socket.IO-Integration |
| **DB-021** | P1 | SFU-Video | Ursprünglich nur Opus-Audio im Router, Client versucht `sendVideoTrack`. | **Fix PR #20/#22**: VP8-Routerkonfiguration; echter Browser-RTP-Test fehlt |

**Schweregrad bedeutet hier Impact × Plausibilität × Reproduzierbarkeit.** Insbesondere DB-019 und die Audio-Risiken sind **keine** nachgewiesenen Live-Exploits. Frühere lokale Harness-Ergebnisse werden bewusst nicht als echte Produktionstests umgedeutet.

## 4. Verifizierte Test-/CI-Erkenntnisse und fehlende Gates

- Auf PR #19: gezielte Session-Regressionen (9 Policy- + 3 echte lokale Socket.IO-Szenarien) im GitHub-Verifikationslauf bestanden. CI-Gesamtworkflow rot wegen unabhängiger Python-/Audit-/Sonar-Gates.
- Auf PR #20: SFU-Ticket-Unit-Tests (5) und lokaler gemockter Mediasoup-Socket.IO-Handshake (6) grün; 64-KiB-Abgrenzung, Session-Isolation und VP8-Router-Option in Integration geprüft. **Nicht** vergleichbar mit vier realen Audio-/Video-Produzenten über TURN/SFU.
- Ein früherer Verify-Job auf PR #20: **3443 erfolgreich, 1 fehlgeschlagen** (`tests/agentRuns.test.ts` Timing-Race). Nicht als „alles grün“ werten.
- Auf PR #21: eigener Verify-Job **3431/3431** Vitest und Python-Smokes passierten; die Pflicht-CI scheiterte danach am **Dependency-Audit** (`undici`-Advisory; genaue Dependency-Lösungsprüfung nötig). Sonar-Kontrolle blieb wegen weiterer Sparse-Checkout-Lücken rot; Browser-E2E Chromium/WebKit nicht voll grün, Firefox grün.
- Die Sonar-Coverage-Tests lesen mehr als die ursprüngliche Sparse-Auswahl (u.a. `deploy/runpod/pod-fleet.json`, `public/manifest.webmanifest`, `public/wasm/dspKernel.wasm`, `docs/AI_ARCHITECTURE.md`, root Compose/Vite/Deploy-Dateien). Die Integrationsvariante verwendet eine großzügigere Source-Auswahl mit gezielten Ausnahmen für schwere Medien. Nach einem weiteren Lauf (Sonar-Coverage: 3454 bestanden, 2 fehlgeschlagen) wurden zusätzlich die PWA-Iconfixtures \`public/assets/icon-192.png\`, \`icon-512.png\`, \`icon-maskable-512.png\` und \`apple-touch-icon.png\` gezielt eingeschlossen. Der erneute Gesamtlauf für den neuesten Commit muss separat bewertet werden.
- **Audio-Flow-Workflow:** mindestens ein Lauf konnte `npm run dev` nicht innerhalb des Liveness-Fensters auf Port 8080 erreichen, obwohl das Log nur einen frühen Agent-Init-Text ausgab. **Root Cause unbekannt**, nicht als durch SFU-Fix verursacht oder gelöst behaupten.
- **Deep Audit:** zuvor 33 Findings, 5 High-Gate-relevant; u.a. npm dependency audit. Keine pauschale Freigabe allein durch neue Unit-Tests.
- Bei erneutem CI auf PR #22 sind **genauer Commit, Job-ID, Testcount und Failures** maßgeblich. Dieser Bericht enthält bewusst keine erfundenen Teststatus.

### Reproduzierbare lokale Eingaben (nur für isolierte Umgebung)

```bash
npm ci
npm run typecheck
npm run lint
npx vitest run tests/sessionSocketAccess.test.ts tests/sessionSocketAccess.integration.test.ts
npx vitest run tests/sfuTicket.test.ts tests/sfuSignaling.test.ts tests/sfuTicketHandshake.integration.test.ts
npx vitest run tests/agentRuns.test.ts tests/da010ModelMetadata.test.ts
npm run test:ci
npm run security
npm run audio:gate
```

**Wichtig:** Die Test-Hubs binden an `127.0.0.1`/ephemere Ports. Bei `ENABLE_SFU=1` ist der Mediasoup-Worker in diesen Integrationstests gemockt. Kein `E2E_BASE_URL` auf Produktion setzen, keine Tests mit produktiven Zugangsdaten ausführen.

## 5. Offene Pflichtgates vor „100 % fertig“

1. **P0 – Identitätsmodell:** Portal stellt signierte `sub`-Claims aus; Studio-API & Haupt-Socket erzwingen denselben Subject-Claim auf `join-session`. Legacy-Masterzugänge als getrennte Service-Principal-Rollen, keine ungebundene `userId`. Eigene Tests mit 4 Konten + Spoof-Versuchen.
2. **P0 – Multi-Instance-Session:** Atomare Kapazität und Lock-Ownership über vier User, Redis CAS/Lua oder zentraler Autoritätsknoten; simulierte Konkurrenz auf zwei Servern, Partition/Reconnect/Restart, persistierte Revision und Konfliktauflösung.
3. **P0 – Secrets & Governance:** Keys sicher rotieren, Repo-/Git-Historie nach Exposition untersuchen, `main` mit Branch-Rules/required checks absichern. **Keine Secret-Werte in Issues/Reports/Logs.**
4. **P0 – echte SFU-Session:** App/API + dedizierte SFU im Sandbox-Netz, frisches geteiltes Secret, zwei bis vier Browser mit unterschiedlichen Identitäten, echte Opus-/VP8-Producer/Consumer, TURN über NAT, Abbrüche, Stummschaltung, Ablehnung unautorisierter Clients.
5. **P1 – Dependency/Security Gates:** `undici` und weitere npm-Advisories mit kompatiblem, getesteten Lockfile beheben; kein `npm audit --force` oder Gate-BYPASS ohne Analyse.
6. **P1 – Audio:** Frequenzgang, L/R-Polarität, PDC-Offsets, XRuns, Knackser, Gain-Peaks, Buffer-Ring-Stress, CPU/RAM-Profile sowie **echte Hörproben** (nicht bloß Spektrumsvergleich); Audio-Bounce >20 min.
7. **P1 – KI/RunPod:** Prompt-Injection aus untrusted Texten, begrenzte Ressourcen/Kosten, reproduzierbare Mock-und-Live-Vergleiche und Datenabflusskontrolle; separat mit Testdaten.
8. **P1 – End-to-End-Gates:** Alle vier Playwright/CI-Achsen grün auf einem *identischen* Integrations-SHA: unit, API/Socket.IO, Browser Chromium/Firefox/WebKit, DSP-Gates, Dependency-Audit, Sonar.
9. **P2 – Least Privilege:** Listener-Snapshots und alle zusätzlichen Socket.IO-Ereignisse methodisch inventarisieren; readonly wird nicht allein durch neun Guards garantiert.

## 6. Risiko-/Freigabeentscheidung

**Der Stand ist NICHT produktionsfertig.** Die drei Einzel-PRs und die konsolidierte PR #22 enthalten echte Verbesserungen, aber ein Merge auf den produktiv deploybaren `main` wäre ohne Integrationsgate, externen SFU-Test, Secret-Management und Rollback-Plan voreilig.

### Nicht vorgenommen
- Keine neuen Produktions-Deploys und keine destruktiven Produktionsdatenaktionen.
- Keine echten vier unabhängigen Studio-Konten angelegt.
- Keine direkte RunPod-/Hetzner-/TURN-/Redis-Zwei-Knoten-Lastmessung.
- Keine echten Hörproben oder physikalischen Audiomessungen.
- Keine behauptete vollständige 100-%-Abnahme.

## 7. Primärquellen

- [Main-Signalisierung, ACL, SFU](https://github.com/kAInplanmusic/audioMONASTRY/blob/main/server/realtime.ts)
- [Session-Locks & Revisionen](https://github.com/kAInplanmusic/audioMONASTRY/blob/main/src/core/session/authoritativeSession.ts)
- [Studio-Signaturverfahren](https://github.com/kAInplanmusic/audioMONASTRY/blob/main/src/core/session/studioSession.ts)
- [Session-Persistenz](https://github.com/kAInplanmusic/audioMONASTRY/blob/main/server/sessionRuntime.ts)
- [SFU-Client](https://github.com/kAInplanmusic/audioMONASTRY/blob/main/src/core/transport/MediasoupTransport.ts)
- [SFU-Ticket-Vertrag im Integrationsbranch](https://github.com/kAInplanmusic/audioMONASTRY/blob/audit/integrated-daw-breaker-20261029/docs/SFU_TICKET_AUTH.md)
- [PR #19](https://github.com/kAInplanmusic/audioMONASTRY/pull/19), [PR #20](https://github.com/kAInplanmusic/audioMONASTRY/pull/20), [PR #21](https://github.com/kAInplanmusic/audioMONASTRY/pull/21), [PR #22](https://github.com/kAInplanmusic/audioMONASTRY/pull/22)

---
*Audit-Methodik: unabhängige statische Codeprüfung, sichere GitHub-Fix-Branches, nachvollziehbare Vitest-/Socket.IO-Testläufe, explizite Trennung von bestätigten Defekten, Modellreproduktionen und offenen Live-Hypothesen. Keine automatischen Grünmeldungen durch Umklassifizierung.*

## 8. Nachtrag — neue Regressionen im Integrationsbranch

- **DB-007, Lock-Integrity:** Bei einem `visual-out` mit derselben gemeldeten ID wie einem Editor bleibt der Lock nach Listener-`leave-session` bestehen. Bei mehreren gleichnamigen Edit-Sockets bleibt er bis zum Verlassen des letzten Editors erhalten. Dieses Verhalten ist ein **Teilfix**; der Server muss User-IDs noch kryptographisch an Identitäten binden und Cluster-weit entscheiden.
- **DB-010, AI-Metadaten:** Die Helper-Funktion `attachServerMetadata()` und die Route `/api/ai/generate` erhalten serververgebene `task_id`, `source` und `provider` auch bei kollidierenden LLM-JSON-Schlüsseln. Zwei Tests prüfen die Angriffsszenarien.
- **Sonar-Sparse:** Frühere Tests scheiterten ausschließlich an fehlenden PWA-Icon-Testfixtures. Die betreffende Checkout-Whitelist wurde ergänzt. Keine Tests wurden deaktiviert oder umklassifiziert.
- **Aktueller Freigabestand:** Dieser Nachtrag dokumentiert **committete Implementierungen**, nicht bereits bestandene neueste CI-/E2E-Gesamtgates.

## 9. Nachtrag 29.10.2026 — CI-Beobachtungen und Kostenlimits

### Verifizierter CI-Stand auf Commit `cae1146e00f11a054bd5a035bfeda01889b2ef85`
- **SonarCloud:** erfolgreich (grün).
- **Build & Verify, Unit/Integration:** Verify-Job grün, vollständige Vitest-Suite **3460/3460** grün, Build und Compose grün, Firefox-E2E grün.
- **Pflicht-Gate und AI:** nach erfolgreich durchgeführten Unit/Python-Tests bei Dependency-Security-Audit rot. Gemeldet: 19 Advisories, darunter **6 high** (u.a. `zod < 4.6.6`, `body-parser < 1.20.9`, mehrere `undici >= 8.0.0 < 8.12.2`). Diese müssen mit kompatiblen Lockfile-Updates und neuen Prüfungen tatsächlich behoben werden; keine Unterdrückung des Gates.
- **Deep Audit 300:** 35 Findings, fünf Gate-relevant, insb. `npm-audit`. Semgrep und Interface Boundaries ohne neue Findings.
- **Audio Flow:** Testserver wird innerhalb des definierten Starts nicht erreichbar; `npm run dev` loggt lediglich Agent-Initialisierung. Grundursache noch unbestätigt.
- **Chromium-E2E:** 1 fehlschlagender Test `tests/e2e/pluginPersistence.spec.ts` (EQ-State nach User-Wechsel), Timeout 90s; vorher STUN-Namensauflösung nicht verfügbar. Ob echte State-Replikation oder testbedingtes Timing betroffen ist, muss separat isoliert werden.
- **WebKit-E2E:** 5 Fehlschläge (u.a. `mastergraphFixed.spec.ts`, `smoke.spec.ts`) wegen erwarteter bedienbarer Elemente, die im Test 0 statt 1 ergeben; außerdem Touch-Navigation-Timings. Nicht als reine Flakes oder gelöste Fehler ausgeben.

### Zusätzlicher Code-Fix DB-008 auf demselben Integrationsbranch
- `server/rateLimitKeys.ts`: `resolveTrustedCostIdentity()` für abrechnungsrelevante Requests. Keinen Kostentopf pro beliebigem Header und keinen pro beliebig häufig frisch ausgegebenem Subject-losen Portal-Token; bei verifiziertem signiertem `sub` ein Budget pro Subject, ansonsten pro normalisierter Netzwerkadresse.
- `server.ts`: `expensiveLimiter` und `agentLimiter` nutzen den neuen `costKeyGenerator`; normale UI-Limits bleiben aus Kompatibilitätsgründen separat und nutzen weiter den bisherigen Client-spezifischen Key.
- `tests/da008CostRateLimitIdentity.test.ts`: vier gezielte Tests für Header-Wechsel, Refresh anonymer Portal-Tokens, stabiles Subject und fehlende Auth.
- **Einschränkung:** Limiter weiterhin lokaler Prozessspeicher (ohne globalen Redis-Store) und Shared-NAT-Budget. Ein kompromittiertes Master-Token oder veränderbare Ursprungs-IP können weiterhin angreifen. Volles KI-Finanzbudget muss zentral und transaktional erzwungen werden.

**Freigabe weiterhin gesperrt.** Für Produktionsreife fehlen vor allem: signierte Benutzeridentität, transaktionale Cluster-Persistenz und Vier-User-Capacity, zentrale AI-Kostenkontrolle, vollständige CI/Browser-E2E/Audio-Messungen, echte STAGING-Accounts/Hetzner-SFU und Secret-Rotation.
