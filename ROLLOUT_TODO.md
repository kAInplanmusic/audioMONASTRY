# audioMONASTRY ROLLOUT-TASKLIST (Phase A Abschluss)

## Zusammenfassung (Stand 2026-11-01)
- **R2 Bucket**: 2812 Objekte (Upload läuft)
- **Musik-Import**: 179 Einträge in biblioMONK
- **Gewicht-Mirror**: Neu gestartet (RP1-5 aktiv)
- **Git**: clean, main gepusht
- **Tests**: 3464/3464 Vitest bestanden, Playwright teilweise rot
- **DSP**: 100% real-time, 90% getestet
- **dropMONK**: Preset-Bibliothek vorhanden, Elemente/Block-Bibliothek unvollständig

## P0 RELEASE-BLOCKER
> [2026-11-01] DB-001 (Branch-Protection) und DB-002 (Secrets-Rotation) werden nach Fertigstellung gemacht – hier gelöscht. DB-011/017 (Audio-Integrität, physische Tests) folgt.
- `.env.deploy` contains real production secrets (23+ credentials). Must be excluded from VCS and rotated if exposed.
- 23 moderate npm vulnerabilities (all eslint-related) — fixable with package updates.
- No path traversal, prompt injection, or code execution vulnerabilities found.
- Input validation robust (file sanitization, command catalog, prompt limits).
- Data flows encrypted in transit; R2 storage encrypted at rest.

## PERFORMANCE FINDINGS (Phase A)
- RT bench: p99.9 latency 4.41ms (exceeds 1.33ms budget) — bottleneck in `v2SinkProcessorWorklet.ts:renderBlock`
- GC pauses 12.297ms (exceeds 1ms real-time limit) — likely in AudioWorklet global scope
- Memory stable (3.96-3.99MB heap), no leaks
- Visual Engine isolated in Web Worker — no audio thread impact
- Concurrent plugins: 10% CPU overhead (within 15% budget)

## IMMEDIATE ACTIONS
1. Update `.gitignore` to exclude all `.env*` files globally.
2. `npm install eslint@latest @typescript-eslint/parser@latest @typescript-eslint/eslint-plugin@latest`
3. Fix render block latency (investigate `v2SinkProcessorWorklet.ts:renderBlock` line ~1200)
4. Reduce GC pressure (avoid heavy allocations in AudioWorklet global scope)
 (Sofort vor Release)
1. **Identitätsmodell**: Portal `sub`-Claims + Studio-Token müssen zwingend an `join-session` gebunden werden (DB-003).
2. **Multi-Instance-Session**: Atomare 4-User-Kapazität + Lock-Ownership über Redis CAS oder zentraler Autoritätsknoten (DB-009).
3. **Secrets**: `.env`-Historie prüfen, Schlüssel rotieren, `main` mit Branch-Protection (DB-001, DB-002).
4. **SFU-Sicherheit**: Echte Sandbox-SFU mit frischem Shared Secret, nicht nur Token-Middleware (DB-005).
5. **Audio-Integrität**: Frequenzgang, L/R-Polarität, PDC-Offsets, XRuns, Knackser, Gain-Peaks, Buffer-Ring unter Last (DB-011, DB-017).
6. **KI-Rate-Limit**: Session-ID darf nicht frei wählbar sein für Budget-Bypass (DB-008).

## P1 VOR RELEASE ERFORDERLICH
1. **Testabdeckung**: 4 echte unabhängige Accounts für User-Flow-Tests (DB-004).
2. **Dependency-Security**: `undici` Advisory fixen, kompatibles Lockfile (DB-21).
3. **KI**: Prompt-Injection-Schutz, Ressourcen-Limits, reproduzierbare Mock/Live-Vergleiche (DB-008, DB-10).
4. **Audio**: Echte Hörproben, Referenzsignale, Nulltest, Impulsanalyse (DB-12).
5. **DSP**: Unit-Tests für modMatrix & phaseDistortion (DSP-Gap).
6. **dropMONK**: Element-/Block-Bibliothek implementieren (10/16 Plugins UI-Komponenten fehlen).
7. **Frontend**: 6 dropMONK UI-Komponenten existieren, aber 4 Plugins ohne UI — UI-Lücken füllen.

## P2 WICHTIG, RELEASE-ABHÄNGIG
- **mastergraph/ai/perfor**: System-Module finden, UI-Integration vervollständigen.
- **Spatial**: HRTF-WASM laden, Hardware-Tests, 11-30 Lautsprecher-Konfiguration.
- **Visual Engine**: Datenfluss von Audio zu Visuals, GPU/CPU-Benchmarks, Browser-Kompatibilität.
- **Deployment**: Docker/RunPod Fleet-Scripts finalisieren, Build reproduzierbar.

## P3 SPÄTERE VERBESSERUNG
- **dropMONK**: Keyword-Suche, AI-Vorschläge, multilingual UI.
- **Performance**: Echtzeit-Latenz-Budgets, CPU/RAM-Profiling, Langzeittests.
- **User Experience**: Blind-/ABX-Hörtests, Screenreader-Support, responsive UI.

## Offene Hör-/Sicht-/Hardware-Tests
1. **Hörtest**: Referenz-0dBFS, -6dBFS, -12dBFS Signale, pegelgleicher Vergleich.
2. **Sichttest**: Visual-Engine mit echtem Audio-Input, 1080p60, GPU-Nutzung.
3. **Hardware**: MIDI-Controller-Profile (3 gängige), Spatial-Lautsprecher (11-Kanal), Audio-Interface-Latenz.

## Abnahmekriterien pro Bereich
- **Audio-Signalkette**: 100% real-time, <5ms Latenz, 0 Dropouts, korrekte Summierung.
- **MONK-Funktionen**: Alle 16 Plugins implementiert, UI für alle sichtbar, Kollaboration funktioniert.
- **KI**: Modelle laden, Inferenz <500ms, Fehlerbehandlung robust.
- **Security**: Keine Secrets im Repo, Branch-Protection aktiv, SFU authentifiziert.
- **Tests**: Alle kritischen User-Flows abgedeckt, 4 echte Accounts.

## Verifikation
- [ ] `npm run verify` grün auf `main@<commit>`
- [ ] `npm run audit:rt` Budgets eingehalten
- [ ] `npm run test:e2e` alle 4 Playwright-Achsen grün
- [ ] `npm run test:python` alle KI-Tests grün
- [ ] `npm run test:coverage` ≥90% abgedeckt
- [ ] `npm run security` keine kritischen Findings
- [ ] `npm run check:deadcode` grün
- [ ] `npm run build` reproduzierbar, kein Audit-Archive leakt

---
*Erstellt aus Phase A Bestandsaufnahme und Subagent-Audits. Nächste Phase: Ausführliche Abarbeitung der P0/P1-Punkte.*