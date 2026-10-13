# Analyse: openDAW / ACE-Step DAW gegen audioMONASTRY (2026-10-12)

Status: ENTWURF zur Freigabe durch den Betreiber. Die umsetzbaren Punkte stehen seit 2026-10-13 als Tickets in `MASTERTODOENDE.json` (§4 als LEGO-P1-001 / DSP-P1-OVS-001, §5 als ZUK-001…ZUK-009); die früheren Listen FINALEAUFGABEN.json und UPDATESZUKUNFT.md sind entfernt (eine SSOT).

## 1. Der Text: Mängel und Korrekturen

| # | Befund | Korrektur |
|---|---|---|
| 1 | Quellen 2 und 6 (`glenwrhodes/OpenDaw`) sind ein **anderes Projekt** als `andremichelle/openDAW`. Der Text vermischt beide. | Nur andremichelle/openDAW als Quelle verwenden. |
| 2 | "128–256 Samples bei 48 kHz = unter 5 ms". 128 = 2,67 ms, 256 = 5,33 ms. Geräte- und OS-Latenz fehlt. | "Blocklatenz 2,7–5,3 ms, plus Ausgabegerät". Auf der openDAW-Repo-Seite steht keine Latenzzahl. |
| 3 | AudioWorklet und SharedArrayBuffer als openDAW-Eigenschaft: auf der Repo-Seite nicht belegt. | Als "unbelegt" markieren, bevor wir es als Maßstab nehmen. |
| 4 | Tabelle: "RTF 15,63–27,27x" und "unter 2 s pro Song auf A100" widersprechen sich (27x bei 4 min ≈ 9 s). | Zwei getrennte Messungen angeben (Modell 1.0 laut Paper vs. 1.5), jeweils mit Quelle. |
| 5 | Leere Platzhalter ("￼") bei RTF- und Parameterzahl ("4B"); Fragmente wie `[span_54]`; mehrere Aufzählungen sind leer (Oversampling, Plugins, Editor, Latent-Werkzeuge). | Zahlen nachtragen oder streichen, Aufzählungen aus Primärquellen füllen. |
| 6 | "WAM 2.0" bei ACE-Step DAW: auf der Repo-Seite **nicht** erwähnt. | Als unbelegt führen. |
| 7 | "Digital Clipping unmöglich" bei 32-Bit-Float: nur intern. Clipping entsteht am Ausgang oder beim Export. | Präzisieren. |
| 8 | Lizenz: openDAW AGPL-3.0-or-later mit Dual-Lizenz (belegt). ACE-Step DAW AGPL wegen gebündelter Strudel-Pakete (belegt). | Folge für uns: **kein Code übernehmen** (wir sind `UNLICENSED`/proprietär), nur Konzepte. |
| 9 | Belegt: LEGO-Pipeline, 5 Spurtypen, Repaint (konservativ/ausgewogen/aggressiv), IndexedDB-Autosave, Strudel, WebCLAP in openDAW, `.odb`-Bundle über JSZip, Headless-SDK. | Übernehmen. |

## 2. Wo wir besser sind

- **Kollaboration**: 4 Nutzer, gespiegelter Zustand, zentraler Lock (B2B). Beide Vergleichsprojekte sind Einzelnutzer-Anwendungen.
- **Persistenz ohne Gerätedaten**: Plugin-Einstellungen und Studio-Daten liegen serverseitig. Beide Vergleichsprojekte speichern lokal.
- **Echtzeit-Disziplin**: `audit:rt` als CI-Gate, allokationsfreier Audio-Thread, Voice-Pool, sample-genaue Event-Queue, PDC, True-Peak (4x), LUFS.
- **KI-Breite**: 8 GPU-Rollen, MCP-Werkzeuge, Orchestrator mit Kostenbremse; Stem-Trennung, Stimme, Visuals.
- **Betrieb und Sicherheit**: Token-Sperre, Not-Aus, RLS, Kostenbudget, Verify-Gate.

## 3. Wo wir schlechter sind

- **Kein Piano Roll / Noten-Editor.** Kein Treffer im Code. Sequenzer nur 16 Steps x 8 Spuren.
- **Kein kumulatives Kontext-Layering (LEGO).** `music.generate/remix/drop/repaint` existieren, aber ohne Vorspuren als Kontext. Es fehlen `lego`, `extract`, `complete`.
- **Kein Projekt-Bundle (.odb-Äquivalent)** mit Samples und Gerätezuständen als ein exportierbares Archiv.
- **Kein Oversampling in nichtlinearen Stufen.** `tanh` in `dspProcessor`, `synthProcessor`, `masteringProcessor` ohne Oversampling, daher Aliasing. Oversampling gibt es nur im True-Peak-Messer.
- **WASM-Kern ist Spielzeug.** `dspKernel_rs` macht nur Gain/Mix; der eigentliche DSP läuft in TypeScript-Worklets. Rust-Kern nur für HRTF-Faltung.
- **Kein Faltungshall** (nur algorithmischer `hqReverb`).
- **Kein Plugin-Standard nach außen** (WebCLAP/WAM). Interner Vertrag ist sauber, aber geschlossen.
- **Kein Live-Coding / Skripting.**
- **Latenzziel unrealistisch formuliert**: AGENTS.md fordert "sub-millisecond"; ein 128-Sample-Block ist 2,67 ms. Das Ziel muss als Budget pro Stufe neu definiert werden.
- **Doku-Widerspruch**: README nennt OPFS/IndexedDB lokal, AGENTS.md verbietet jede Gerätespeicherung.

## 4. Sofort umsetzen (Vorschlag, heute als Tickets in MASTERTODOENDE.json)

1. **LEGO-/Kontext-Pipeline** im MCP/Orchestrator: `music.lego`, `music.extract`, `music.complete`, Vorspuren als Kontext, Ergebnis automatisch in die Bibliothek. (Server-/Vertragsseite ohne Live-GPU machbar.)
2. **Repaint-Modi** (conservative/balanced/aggressive) als typisierter Parameter von `music.repaint`.
3. **Oversampling (2x/4x) für alle `tanh`-Sättiger** in Synth/DSP/Mastering, mit Aliasing-Test in `audit:rt`.
4. **Latenzmandat neu fassen** (Budget je Stufe statt "sub-millisecond") in AGENTS.md.
5. **README/AGENTS-Widerspruch** zur Gerätespeicherung bereinigen.

Bereits offen und weiter gültig: RT-AUDIT-P1-015 (Brain/Executor), IDEA-2026-10-07-A-F1 (Capture), AI-P2-006 (Drop-Cache).

## 5. Mittel-/langfristig (Vorschlag für UPDATESZUKUNFT)

- Piano Roll (Canvas, Velocity-Spur, Ghost Notes, Akkord-Stempel) als Erweiterung von Plugin #13.
- Projekt-Bundle-Export, serverseitig in die Bibliothek (Gerät bleibt frei).
- DSP-Kernel nach Rust/WASM verlagern (Filter, Sättigung, Kompressor), Messung gegen die TS-Worklets.
- Partitionierter Faltungshall.
- Plugin-Hosting WebCLAP, Bewertung WAM; Sicherheits- und Lock-Modell vorab klären.
- Headless-Rendering als Dienst (Basis: `master-player`, `OfflineRenderer`).
- Strudel-artiges Live-Coding (Lizenz AGPL: nur Konzept, kein Code).
- Automationsspuren auf einer Timeline.

## 6. Entscheidungen und Fragen an den Betreiber

1. Latenz: Budget je Stufe statt sub-millisecond: einverstanden?
2. Projekt-Export als Archiv: Download aufs Gerät widerspricht "nichts auf Geräten". Nur serverseitig oder Ausnahme für Export?
3. Lizenzstrategie: reine Konzeptübernahme, kein AGPL-Code. Bestätigen?
4. Plugin-Öffnung nach außen (WebCLAP) überhaupt gewollt, angesichts Lock und Latenz?
5. LEGO: Reihenfolge der Spuren fest (Drums, Bass, Harmonie, Melodie, Gesang) oder frei wählbar?
