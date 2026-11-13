# audioMONASTRY – Orchestratorbericht A1–A5

Basis: main / `5193d9e33142c00edd67712fc2f605a722e66db7`. Datum: 13.11.2026 (Europe/Berlin).
Integration durch Cherry-Picks auf `fix/a1-a5-integration`, kein Merge nach main.

| Aufgabe | Status / DoD | Aufgabenbranch | Aufgabencommits |
|---|---|---|---|
| A1 | ⚠️ Schema-DoD erfüllt: 63 gültige Belege. Produktionsinventur und dig offen. | fix/a1-inventory | e81077112d7e8a831fb6fb18b9bd60b522a2bc1f |
| A2 | ⚠️ Domain-/Docänderungen fertig; numerische GPU-SSOT und integrierter Nulltreffer-Grep offen. | fix/a2-doc-reconciliation | f40d7ed01925d2333ac4c28ae8917fd5f26677cf, d7a081921a624285d774ca0279cf571800566c43 |
| A3 | ✅ Clock-Sync-Implementierung mit Datei:Zeile nachgewiesen. | fix/a3-clock-sync | d4706052c89c541e79d426a84cceba76616d85ea |
| A4 | ⚠️ Statische V2/P2P-Kette dokumentiert; benannte Lücken, keine Live-Zustellung bestätigt. | fix/a4-main-out-trace | unverändert auf Basis (read-only); Bericht in Integration durch Orchestrator: 0abec20 |
| A5 | ⚠️ Opt-in-Telemetrie, lokaler 600-s-V2-Test; echte Browser-Holder-CPU/WebRTC-Jitter offen. | fix/a5-rt-bench | a55a4a5d57ff680023bd7f1c3f38fb7dfa32a5e6, 29935263ac849b11616a2e528765fe3c34f2ec47 |

## DoD-Nachprüfung durch Orchestrator

A1: `python3 scripts/audit/check-evidence-registry.py` erneut ausgeführt:

```text
PASS: 63 entries; exact schema, nonempty command/output/date, timezone, unique IDs
```

Alte Einträge ohne vollständige Messbelege wurden entfernt. Hosttabelle/Zugangsgrenzen: `docs/audit/A1_INVENTORY.md:1`. Rohbelege: `EVIDENCE_REGISTRY.json:1`. Hetzner-/RunPod-/Vast-Credentials fehlen, kein SSH-Verzeichnis; PRAIN-DEV pwd scheitert mit `Mcp error: -32603: Internal error` (Original: `docs/audit/a1/prain-access.txt:1`). Lokales docker ps mit Exit 0/leerer stdout beweist keinen Produktionsbestand. dig und der vorgesehene Pakethelper fehlen; 55 Systemresolver-Proben sind im A1-Bericht als Ersatz und mit eingeschränktem Domain-Scope ausgewiesen. Aktuelle Produktions-GPU-Anzahl: unbekannt.

A2: Alle sechs Compose-Defaultänderungen in drei Dateien gelesen (einzeln in `docs/audit/a2/REPORT.md:26`). Die neun historischen Dokumentdiffs wurden programmatisch auf ausschließlich Domain-Ersetzung plus redaktionellen Historienhinweis geprüft: neunmal True. AGENTS, README und SERVER_FLEET als Diff gelesen. Keine Infrastrukturänderung oder Deploy ausgeführt.

```text
$ python3 tests/test_hetzner_scripts.py ServertypRollenDriftTest -v
Ran 4 tests in 0.003s
OK
```

Der exakte Nutzer-grep nach dem alten Domainstamm ergab im A2-Branch keine Ausgabe, Exit 1. Nach Integration ergibt derselbe Befehl 18 Trefferzeilen, ausschließlich EVIDENCE_REGISTRY.json; Exit 0. Die sechs ursprünglichen DNS-Belege bleiben unverändert: ihre Umbenennung würde Originalausgaben verfälschen. Deshalb ist die integrierte Nulltreffer-DoD nicht erfüllt. Numerische GPU-SSOT ist ohne aktuellen A1-Messwert nicht belegbar; historische Planzahlen verbleiben in anderen Dateien (Grep-Gegenbeleg im A2-Bericht). Keine Behauptung einer vollständig bereinigten Spec.

A3: Alle fünf Suchbefehle aus `docs/verification/A3_CLOCK_SYNC.md` erneut ausgeführt; Ausgaben stimmen überein, eine nach Sortierung der parallelen rg-Dateiausgabe. `src/utils/ClockSync.ts:34–42` und `src/core/clock/MonastryMasterClock.ts:132–148` zusätzlich gelesen. Basiscommit ist Vorfahr des Berichtcommits. Existenz-DoD erfüllt; kein Nachweis samplegenauer Live-Geräteausgabe.

A4: Kernstellen nachgelesen: `src/utils/WebRTCManager.ts:295–330,746–748,838–855`, `src/pages/MasterOutPage.tsx:40–51`, `src/core/audio/live/V2SinkEngine.ts:854–859`, `src/audio/masterStreamTap.ts:42–59`, `src/core/audio/backends/V2LiveSink.ts:217–225,255–261`. Bericht wegen des echten Legacy-Fallbacks und der zusätzlichen raw-Modus-Abfrage zur Ergänzung zurückgegeben und danach integriert. Vollständige Kette/Lücken: `docs/verification/A4_MAIN_OUT_TRACE.md:1`. A4 änderte keine Repo-Datei; nur der Orchestrator übernahm das separate Analyseergebnis.

A5: Helpertests unter Node v22.23.5 erneut ausgeführt: 3 Tests, 3 bestanden, 0 fehlgeschlagen. Gezieltes ESLint der vier neuen Telemetriedateien: Exit 0, keine Ausgabe. Unabhängiger 2-s-Orchestrator-Smoke: Exit 0, gemessen 2.002529829 s, 99/99 UDP-Pakete, 98 Jitterdifferenzen, error=null. Kein Ersatz für den 600-s-Lauf. `scripts/audit/rt-bench.ts` ist gegenüber Basis unverändert.

`npm exec --yes --package=node@22 -- npm run verify` auf integriertem Code: Exit 2 beim ersten Gate:

```text
src/core/ai/orchestrator/brainBench.ts(29,64): error TS1109: Expression expected.
```

Die Datei ist gegenüber main unverändert. Weitere verify-Gates wurden nicht erreicht. Der A5-Agent führte den bestehenden DSP-Gate separat aus: Exit 1, 19/20 Grenzen eingehalten, `RT-AUDIT-P0-002/over = 2` bei SOLL 0. Ursache nicht bestimmt; parallele Cloud-Last im Setup dokumentiert, kein Entlastungsbeweis. Vollständige Gatefreigabe fehlt.

`git diff main --check`: Exit 0 ohne Ausgabe. Bekannte Token-/Private-Key-Muster in hinzugefügten Zeilen: 0 Treffer; zusätzlich Diffs gelesen. Kein allgemeines Security-Audit.

## A5-Dauerlauf und Rohdaten

Rohdaten/Auswertung: `docs/audit/A5_RT_TELEMETRY.md:1`, `docs/audit/A5_RT_TELEMETRY_2026-11-13/{packets.csv,cpu.csv,summary.json}`. Gemessener Commit `a55a4a5d57ff680023bd7f1c3f38fb7dfa32a5e6`, dirty=false, Host `3e5f32b30d89`, Node v22.23.5. Zeitraum 13.11.2026, 08:21:11.371–08:31:11.589 Europe/Berlin (Original-UTC-Zeiten in summary.json). Monotone Dauer 600.002025103 s; 29788 Pakete gesendet/empfangen, 0 Verlust, 600 CPU-Samples.

| Größe | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|
| UDP-RTT-Differenz, ms | 0.032378 | 0.347214 | 2.167786 | 21.043035 |
| Renderer-Prozess-CPU, % eines Kerns | 6.001602 | 8.995100 | 10.002300 | 17.983310 |

Zeitgewichtete mittlere Prozess-CPU: 6.526645 %. Alle Verteilungen, RTT-Differenzen, Sequenznummern und gewichtete CPU aus den CSVs unabhängig nachgerechnet. Originalschlussausgabe:

```text
jitterMs: exact CSV percentiles verified
rttMs: exact CSV percentiles verified
cpuPercent: exact CSV percentiles verified
PASS: 600.002025103 seconds; 29788/29788 packets; 600 CPU samples; coverage >600 seconds, unsampled endpoint tail 0.149231 ms; clean measured commit; no error
```

Eine erste Orchestrator-Assertion verlangte maximal 0.1 ms Abstand zwischen letztem CPU-Sample und Endzeit und scheiterte. Nachgelesen: CPU-Intervallabdeckung 600001.875872 ms, Gesamtzeit 600002.025103 ms, Differenz 0.149231 ms durch abschließenden Read/Endzeitpunkt. Check danach mit explizitem Rest <1 ms und nachgewiesener CPU-Abdeckung >600 s bestanden. Messdaten unverändert.

Reproduktion (Linux, installierte Dependencies):

```sh
npm exec --yes --package=node@22 -- node scripts/audit/rt-telemetry.mjs --local-harness --duration 600 --out work/rt-reproduction
```

Dieser Aufbau misst UDP-Loopback-RTTvariation und CPU des lokalen V2-Testprozesses einschließlich Echo-Overhead. Keine Messung eines tatsächlichen Browser-Mixer-Holders, keines Produktionsnetzwerks, kein RTP-/Einweg-Jitter. Parallele Test-/Agentenlast dokumentiert. Daher nur Teilerfüllung der A5-Anforderung.


## Offene Punkte / Auffälligkeiten außerhalb der Änderungen

- Produktionscontainer, Providerlisten und aktuelle GPU-Anzahl bleiben wegen der belegten Zugangsgrenzen unbekannt. Keine Provider-/Container-Ressourcen geändert.
- Clock-Code vorhanden, Live-Offset/Drift ungemessen; Server setzt t1=t2 (`server/realtime.ts:133–135`).
- Studio setzt onMainStream ohne Aufrufstelle, Empfang läuft dagegen auf onRemoteStream. Listener-Initiation/raw masterOutMode und Erroranzeige sind bedingt unterbrochen. Monitor-Tap enthält konfigurierten Cue-Anteil. Separater konfigurierbarer HTTP-Masterreceiver kann Audio in Tone.Destination führen. Belege im A4-Bericht; nichts davon in read-only A4 repariert.
- TypeScript-Syntaxfehler und gescheiterter DSP-Gate bleiben offen.
- Domain-Defaults ändern beim späteren Deploy ohne ENV-Override Laufzeitziele. Neue Ziele sind nicht als erreichbare Produktionsdienste/Zertifikate bestätigt.
- Historische GPU-Pläne und Runtime-Manifeste enthalten weiterhin Zahlen; keine spekulative Flottenumstellung vorgenommen.

Frühe Werkzeugversuche scheiterten: Download vor Workspace-Bereitschaft, GitHub-Branchabfrage mit URL-encodiertem Slash (HTTP400), vermutete Dateipfade, Unicode-Gitpfadprüfung ohne -z und Erstellen des vorgegebenen lokalen Ausgabeverzeichnisses (Permission denied). Workspace abgewartet, echte Pfade genutzt, Git-Pfade danach mit -z gelesen; aus Fehlversuchen keine negativen Implementierungsbehauptungen abgeleitet. Ergebnisse werden im Repo bereitgestellt. PRAIN-Zugang bleibt ungelöst.

Keine Freigabe zum Merge vorweggenommen. main bleibt unangetastet. Alle Aufgabenbranches basieren auf main; Integration separat, ohne Force-Push.
