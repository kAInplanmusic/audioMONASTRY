# Alternativen-Katalog (GAP-6)

> Für jede kritische Entscheidung: Optionen, Trade-offs, Empfehlung,
> verknüpfter Task. Stand: 2026-08-31.

| Entscheidung | Option A | Option B | Empfehlung | Task |
|---|---|---|---|---|
| Plugin-Routing | Zentrale `pluginAudioRouter`-Schicht | Direkte Engine-Aufrufe je Terminal | A (zentral) | P0-2 |
| Mixer-Sichtbarkeit | Festes Hardware-Pult + Plugin | Nur Plugin | Beides (D1) | P0-1 ✅ |
| Monitor-Modell | Parallele Cue-Busse (MAIN unangetastet) | Aktuelles Disconnect-Modell | A | P0-6 |
| 2.1-Ausgabe | Echter 3. Kanal + Phantom-Fallback | Nur Phantom | Beides (D10) | P2-3 ✅ |
| Synth-Backend | Worklet (V1) | V2-AudioGraph | V1 zuerst, V2 parallel (D4) | P0-5 ✅ |
| AI-Provider | A100-Endpoint bevorzugt | Kosten-Sort | A100 zuerst + DevSettings-Shutdown (D15) | FA-P1-6 ✅ |
| Transport | P2P Full-Mesh | SFU (Mediasoup) | Beide, SFU optional | P4-1 ✅ |
| Native Runtime | Browser-First | Rust/cpal-Desktop | Browser-First (D11) | P5-3 ✅ |
| Scratchpad-UI | Overlay-Sidebar | Bottom-Dock | Overlay-Sidebar (D9) | P1-4 ✅ |
| GPU-Konsolidierung | 1 Runtime, mehrere Modelle | 1 Endpoint je Modell | 1 Runtime (Kostenregel) | 9g ✅ |

Regel: kein P0/P1-Task ohne dokumentierte Alternative.
