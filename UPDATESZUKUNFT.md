# UPDATESZUKUNFT

Mittel- und langfristige Punkte (Stand 2026-10-12, Quelle: `docs/ANALYSE_openDAW_ACE-Step_2026-10-12.md`).
Nicht Teil von FINALEAUFGABEN. Aufnahme dorthin erst nach Betreiber-Entscheid.

| ID | Punkt | Anmerkung |
|---|---|---|
| ZUK-001 | Piano Roll / Noten-Editor (Canvas, Velocity-Spur, Ghost Notes, Akkord-Stempel) | Erweiterung ueber Slot #13; Server-State, Lock-konform |
| ZUK-002 | Projekt-Bundle (Samples + Geraetezustaende als ein Archiv) | Export als Nutzerdatei (AGENTS.md 2.2), Server bleibt Quelle |
| ZUK-003 | DSP-Kern nach Rust/WASM (Filter, Saettigung, Kompressor) | heute nur Gain/Mix in `dspKernel_rs`; erst messen gegen TS-Worklets |
| ZUK-004 | Partitionierter Faltungshall (zero-latency) | Latenz-Mandat: erste Partition im Audio-Thread |
| ZUK-005 | Automationsspuren auf einer Timeline | baut auf Piano Roll und songMONK auf |
| ZUK-006 | Headless-Rendering als Dienst | Basis `master-player` + `OfflineRenderer` |
| ZUK-007 | Live-Coding / Skripting (Strudel-aehnlich) | nur Konzept, kein AGPL-Code |
| ZUK-008 | Plugins von Dritten im Studio laden (WebCLAP/WAM) | "nach aussen oeffnen"; Lock-, Sicherheits- und Latenzmodell vorab klaeren |
| ZUK-009 | Spur-Kontext-Editor fuer LEGO (Reihenfolge/Mix der Vorspuren in der UI) | nach LEGO-P1-001 |
