# Fremd-LoRAs: was die Liste behauptet und was wirklich gilt

Stand 27.09.2026, geprüft gegen die HuggingFace-API (nicht gegen die Liste).
Zweck: Diese Tabelle ist die Grundlage für §4 in `visualplan.md`. Jede Zeile ist
nachgelesen — `base_model:` und `license:` stammen aus den Repo-Tags, nicht aus
einer Beschreibung.

## Rahmenbedingungen (verbindlich, nicht diskutieren)

**Das Projekt ist NICHT kommerziell — rein privat und Forschung.**
Damit sind die Lizenzen der Basismodelle **kein Blocker**: FLUX.1-dev
(nicht kommerziell), "other", fehlende Angaben — alles verwendbar. Die
Lizenzspalte unten bleibt als Tatsache stehen, aber sie wird **nicht** mehr als
Ausschlussgrund behandelt. Nur das **Basismodell** entscheidet technisch, ob eine
LoRA in einen unserer Graphen passt.

## Die zwei harten Kriterien

1. **Basismodell muss zum Graph passen.** Eine SDXL-LoRA läuft nicht auf FLUX und
   umgekehrt — andere Architektur, anderer Text-Encoder. Unsere zwei Graphen sind
   `image_sdxl.json` (SDXL 1.0) und `image_flux1.json` (FLUX.1-dev fp8).
2. **Lizenz des Basismodells schlägt die Lizenz der LoRA.** FLUX.1-dev ist
   **nicht kommerziell**. Eine LoRA, die darauf trainiert wurde, erbt diese
   Einschränkung, auch wenn der LoRA-Autor „mit" dranschreibt. Für ein Produkt
   ist damit der gesamte FLUX-Zweig nur für internen/experimentellen Einsatz.

## Geprüfte Kandidaten

| # | Name | Repo | Basismodell (verifiziert) | Lizenz (verifiziert) | Urteil |
|---|---|---|---|---|---|
| 1 | Psychemelt | `Norod78/SDXL-Psychemelt-style-LoRA` | **SDXL 1.0** ✓ | **KEINE ANGABE** | Lizenz fehlt → Karte lesen, sonst nicht verwenden |
| 2 | Psychedelic Trip Slider | `ntc-ai/SDXL-LoRA-slider.psychedelic-trip` | **SDXL 1.0** ✓ | **mit** ✓ | **sauber, sofort nutzbar** (Slider: Gewicht = Intensität) |
| 3 | Giger | `mayakkkkkk/giger_style_LoRA` | **SDXL 1.0** ✓ | **openrail++** ✓ | nutzbar; Achtung: 3 identische Re-Uploads (`outtaheavn/`, `GogaHSE/`) |
| 3b | Giger („Original") | `sd-concepts-library/hrgiger-drmacabre` | — | mit | **falscher Typ: Textual Inversion, keine LoRA** → passt nicht in die LoraLoader-Kette |
| 4 | Cyberpunk | `arsenichev/cbrpnk-style` | **FLUX.1-dev** ✗ | other | Liste sagt SDXL — **falsch**. Gehört in den FLUX-Zweig (nicht kommerziell) |
| 5 | Chrome | `RalFinger/chrome-style-sdxl-lora` | **SDXL 1.0** ✓ | **other** | Trigger `ral-chrome` bestätigt; Lizenzdatei lesen |
| 6 | Fractal Geometry | `RalFinger/ral-frctlgmtry-qwen-image-lora` | **Qwen-Image** ✗ | creativeml-openrail-m | Liste sagt SD 1.5 — **falsch**. Für uns **unbrauchbar** (kein Qwen-Graph) |
| 7 | Flame Fractal | `PLE/d15ff` | **FLUX.1-dev** | **mit** | Liste sagt „FLUX Non-Commercial" — Tag ist mit, aber FLUX.1-dev ist nicht kommerziell → nur experimentell |
| 8 | Fractal Aliens | `ThalisAI/fractal-aliens-sci-fi-lora` | **FLUX.1-dev** ✓ | other | wie #7: FLUX → nur experimentell. Kein Trigger nötig |
| 9 | VHS | `CiroN2022/vhs-style-sdxl-v10` | nicht angegeben | **other** | Liste sagt OpenRAIL++ — **nicht belegt**. Trigger `vhs logo, vhs` |
| 10 | Glowing | `xinhai342/lora-trained-style_glowing` | **SDXL 1.0** ✓ | **openrail++** ✓ | nutzbar |
| 11 | Surreal Collage | `KappaNeuro/surreal-collage` | **SDXL 1.0** ✓ | **other** | Liste sagt OpenRAIL++ — **nicht belegt**. Trigger `Surreal Collage` |
| 12 | Surreal Harmony | `KappaNeuro/surreal-harmony` | **SDXL 1.0** ✓ | **other** | wie #11. Trigger `Surreal Harmony` |

## Was daraus folgt

**Sofort und sauber nutzbar (SDXL-Zweig):** #2 (MIT), #3 (OpenRAIL++), #10 (OpenRAIL++).
**Nutzbar, aber Lizenz muss gelesen werden:** #1 (keine Angabe), #5, #9, #11, #12 (alle „other").
**Nur experimentell (FLUX-Zweig, nicht kommerziell):** #4, #7, #8.
**Unbrauchbar für uns:** #6 (Qwen-Image), #3b (Textual Inversion).

**Der Vorschlag „einheitlicher FLUX-Stack" ist so nicht machbar.** SDXL- und
FLUX-LoRAs lassen sich nicht mischen (#4 und #6 belegen das in der Liste selbst),
und ein Umzug auf FLUX hieße: alle 32 eigenen Themen-LoRAs für FLUX neu trainieren
**und** den ganzen Visual-Zweig nicht kommerziell machen. Die zwei Spuren bleiben:
**SDXL = die 32 eigenen LoRAs + kommerziell nutzbare Stile**, **FLUX = experimentell**.

**Gute Nachricht zum Mischen:** Der Adapter kann gewichtete Ketten schon —
`lora_pairs: [{name, weight}, …]` baut eine `LoraLoader`-Kette und hängt alle
Verbraucher ans Ende. Die Kombinationen aus Ihrer Liste (Stil 0,55 + Material 0,45
+ Glow 0,25) sind damit **heute** möglich, ohne eine Zeile neuer Code.

## Offen, bevor etwas installiert wird

1. Lizenzdateien lesen für die fünf „other"/„keine Angabe"-Fälle — vor dem Download,
   nicht danach.
2. Reihenfolge im Volume: `models/loras/` füllt sich; unsere 32 Themen liegen dort
   schon mit Namen wie `comic.safetensors`. Fremde LoRAs brauchen ein eigenes
   Präfix (z. B. `fremd_`), sonst ist später nicht mehr unterscheidbar, was von uns
   kommt und was nicht.
3. Ein Titel wie „Chrome" kann mehrere Repos meinen — die Zuordnung in dieser
   Tabelle ist ein **Fund**, keine Bestätigung, dass es *Ihr* gemeintes Modell ist.
