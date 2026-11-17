# audioMONASTRY – Phase D: Full Integration Plan

**Basis:** Commit f5538c63 (gm-v1.0.0)  
**Ziel:** Alle 16 Plugins konsistent integriert, Signal-Kette funktioniert, Widersprüche aus Audits behoben.

---

## Integration-Liste (priorisiert nach Audit-Befunden)

### P0 – Kritisch (Signal-Kette funktioniert nicht)

#### 1. recordMONK nicht verkabelt (Audit: record_audit1/2)
- **Problem:** `createMediaStreamDestination()` nie mit Ausgang verbunden → Aufnahme zeichnet Stille
- **Fix:** MediaStream-Destination mit audioEngine-Ausgang verknüpfen
- **Dateien:** `src/plugins/adapters/recordAdapter.ts`, `src/components/recorder/RecorderTerminal.tsx`

#### 2. spatialMONK: 3 widersprüchliche Einbaupositionen (Audit: spatial_audit1/2)
- **Problem:** Vertrag sagt Channel-Insert (pre-Summe), signalChain.ts stuft als processing (post-Summe), Router sagt ui-only
- **Fix:** Eindeutige Position festlegen (Channel-Insert per Vertrag), signalChain.ts und Router anpassen
- **Dateien:** `src/plugins/signalChain.ts`, `src/plugins/pluginRouter.ts`, `src/plugins/adapters/spatialAdapter.ts`

#### 3. masterMONK: Lookahead-Limiter nicht implementiert (Audit: master_audit1/2)
- **Problem:** Vertrag verspricht 240-Frame-Lookahead-Limiter, Adapter tut nur linearen Gain (0–2)
- **Fix:** Limiter-Logik in Adapter implementieren, UI-Parameter (Ceiling, LUFS) verkabeln
- **Dateien:** `src/plugins/adapters/masterAdapter.ts`, `src/components/master/MasterRack.tsx`

### P1 – Hoch (Dateninkonsistenzen)

#### 4. Kanal-Nummerierung widersprüchlich (Audit: alle source-Plugins)
- **Problem:** Vertrag (drop=1, song=2, drumsampler=3, syntisampler=4, instru=5, voice=6, sound=7, stem=8) vs. Registry-Kommentar (anderes Schema)
- **Fix:** Ein Schema definieren, alle Referenzen (Vertrag, Registry, Adapter, Terminals) abgleichen
- **Dateien:** `src/plugins/pluginContract.ts`, `src/plugins/registry.ts`, alle Adapter

#### 5. eqMONK: Zwei unabhängige EQs ohne kanonische Wahrheit (Audit: eq_audit1/2)
- **Problem:** UI: 36-Band RBJ; Adapter: 3-Band Ein-Pol; `onParameter` hardcodiert Kanal 1 / Band Mid
- **Fix:** Ein EQ-Implementierung wählen, hardkodierte Kanal/Band-Referenzen entfernen
- **Dateien:** `src/plugins/adapters/eqAdapter.ts`, `src/components/eq/EQPluginTerminal.tsx`

### P2 – Mittel (Architektur)

#### 6. producesAudio: true ohne DSP-Node (mehrere Plugins)
- **Problem:** drop, syntisampler, drumsampler, instru, voice, sound, stem behaupten producesAudio: true ohne eigenen DSP-Node/Bypass-Crossfade
- **Fix:** Entweder producesAudio: false setzen oder DSP-Node + Bypass-Crossfade implementieren
- **Dateien:** `src/plugins/pluginContract.ts`, alle Adapter

#### 7. Bypass nicht als Dry/Wet-Crossfade (Vertrag vs. Implementierung)
- **Problem:** Vertrag fordert Bypass als Dry/Wet-Crossfade, nicht als Disconnect; nirgends implementiert
- **Fix:** Bypass-Crossfade in allen insert/fxReturn Plugins implementieren
- **Dateien:** `src/plugins/adapters/*.ts`, `src/plugins/signalChain.ts`

#### 8. Globale Singletons nicht injected (mehrere Plugins)
- **Problem:** `instrumentBackend`, `audioEngine`, `webMIDIAdapter` nicht injected → nicht testbar
- **Fix:** Dependency-Injection für Testbarkeit einführen (schrittweise)
- **Dateien:** Alle Terminal-Komponenten, Adapter

---

## Dokumentation (Phase D Ergebnis)

- `docs/integration/INTEGRATION_PLAN.md` (diese Datei)
- `docs/integration/SIGNAL_CHAIN_FINAL.md` – finale Signal-Kette nach Integration
- `docs/integration/CHANGES_APPLIED.md` – alle vorgenommenen Änderungen mit Datei:Zeile
- `docs/integration/TEST_RESULTS.md` – Integrationstest-Ergebnisse

---

## Status

| Aufgabe | Status |
|---------|--------|
| recordMONK Verkabelung | ✅ Fertig |
| spatialMONK Einbauposition | ✅ Fertig |
| masterMONK Limiter | ✅ Fertig |
| Kanal-Nummerierung abgleichen | ✅ Fertig |
| eqMONK kanonische Wahrheit | ✅ Fertig |
| producesAudio korrigieren | ✅ Fertig (6 Adapter mit onProcess ergänzt) |
| Bypass-Crossfade | ✅ Fertig (BasePluginAdapter.process() mit Dry/Wet-Crossfade) |
| DI für Testbarkeit | ⏳ Dokumentiert als Limitation (IAudioBackend unvollständig) |
| Dokumentation | ✅ docs/integration/ |

Nächster Schritt: Phase E (Deployment validiert ✅, E2E-Test ausstehend).