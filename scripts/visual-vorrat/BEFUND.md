# BEFUND — Vorratslauf 28.09.2026

Ergebnis der Prüfung des Laufs (2080 Aufträge geplant, 1061 erzeugt, dann
gestoppt). Alle Zahlen hier sind gemessen, nicht geschätzt; die Befehle stehen
dabei.

## 1. Abgebrochen bei 1061 von 2080 — warum

| | |
|---|---|
| Erzeugt | **1061 Bilder** (acht SDXL-Kombinationen vollständig = 1040, FLUX 5, Proben 7) |
| Laufzeit | 08:44 – 14:40, ≈ 5 h 56 min warmes Fenster |
| Kosten | ≈ 2,6 USD Lauf + ≈ 0,3 USD Proben/Gegentests → **≈ 3 USD** |
| Rest wäre gewesen | 1035 FLUX-Bilder × 58 s ≈ **16,7 h ≈ 7,4 USD** |

Gestoppt wurde nicht aus Zeitnot, sondern weil die **Prämisse des Laufs
messbar nicht trägt** (Abschnitt 3).

## 2. Gemessen: die LoRA-Kette wirkt

```
                             A_ohne_lora  B_ohne_lora  C_feuer_1.0  D_chrome_0.6
A_ohne_lora                        0.00         0.00        25.70        14.15
B_ohne_lora_wiederholt             0.00         0.00        25.70        14.15
C_feuer_flammen_1.0               25.70        25.70         0.00        24.71
D_fremd_chrome_0.6                14.15        14.15        24.71         0.00
```

Mittlere absolute Helligkeitsdifferenz (0–255), gleicher Prompt, gleicher Seed
4711, gleicher Graph bis auf `lora_pairs`.

* **A gegen B = 0,00**, und beide Dateien sind byte-identisch (1 186 068 B).
  Der Worker rechnet also **deterministisch** — es gibt kein Rauschen, das
  Unterschiede erklären könnte.
* Eine LoRA verschiebt das Bild um **14–26 Stufen**. Das ist viel, nicht wenig.
* Der Graph ist korrekt verdrahtet: `KSampler.model <- lora2 <- lora1 <-
  CheckpointLoaderSimple`, ebenso `CLIPTextEncode.clip` (Graph ausgepackt mit
  `/tmp/graph-pruefen.py`).

**Eigener Fehler, dokumentiert statt weggeschrieben:** Ich hatte aus dem
Augenschein geschlossen, die LoRA-Kette wirke nicht, weil ein LoRA namens
`feuer_flammen` mit Gewicht 1.0 kein Feuer zeigt. Die Messung widerlegt das.
Richtig ist: die LoRA wirkt **stark auf die Pixel**, aber sie prägt dem Bild
nicht ihren *Themenstil* auf. Der Prompt gewinnt.

## 3. Der eigentliche Befund: das Motiv bestimmt das Bild, nicht die LoRA

Acht SDXL-Kombinationen × drei Motive, je Seed 4711 (`/tmp/kombis.py`):

* **Innerhalb einer Spalte** (gleiches Motiv) sehen alle acht Kombinationen
  gleich aus — magenta Neonraum, Kapuzenfigur; Glasapparat mit Organik; weisser
  Raum mit Polyeder. Die Unterschiede liegen in der Neon-Geometrie und in der
  Form des Objekts, **nicht im Stil**.
* Dasselbe für FLUX: sieben Kombinationen, ein Motiv → siebenmal derselbe
  Korridor (`/tmp/fluxprobe-sheet.png`).
* Direktvergleich ohne LoRA / `feuer_flammen` 1.0 / zwei Vorratsstapel:
  dieselbe Bildfamilie (`/tmp/gegentest.png`).

Die Motive sind stark beschreibend („a lone figure on a neon-lit stage,
cinematic light"). Der Prompt diktiert Szene und Licht; die LoRA moduliert nur.
Der Skriptkopf nennt das Ziel selbst — „Neutrale Motive: die LoRA soll den Stil
liefern, nicht das Motiv" — und genau das erreicht der Lauf mit diesen Motiven
nicht.

## 4. Zwei Infrastruktur-Befunde

**a) Die zwölf Fehler 1041–1052 sind erklärt.** Systemprotokoll des Workers:

```
WARN: container is unhealthy: triggered memory limits (OOM)   12:25:22, 12:25:25, 12:25:41
```

Der 16-GB-Worker (RTX 2000 Ada) lief beim Umschalten SDXL → FLUX (16,06 GB
Checkpoint) in den OOM. Danach lief es weiter, aber mit **58 s je Bild statt
20 s** — FLUX auf dieser Karte ist der Engpass. Wer den Lauf fortsetzt, sollte
die GPU-Klasse wechseln, nicht die Geduld.

**b) Der Endpoint trägt das falsche Image.** `GET /v1/endpoints/wzh9hcbitjnn95`:

```
name  audiomonastry-ai-image
image registry.runpod.net/prunaai-runpod-worker-flux-1-dev-main-dockerfile:287a29201
env   AI_ROLE=imageHq
```

Erwartet ist laut `visualplan.md` Template `35rilgx8er` =
`runpod/worker-comfyui:5.10.0-flux1-dev-fp8`. Beobachtet: **drei Worker, zwei
davon mit dem alten PrunaAI-Image** (14:22, 14:25, dann nochmals 14:37 auf RTX
4090). Aufträge, die dort landen, scheitern nach 1,3 s. Nicht angefasst — das
ist eine Änderung an RunPod und gehört angesagt, nicht nebenbei gemacht.

## 5. Was der Lauf nicht geprüft hat

Die **32 eigenen Themen-LoRAs** — der Grund, warum als Basismodell SDXL
gewählt wurde (`docs/VISUAL_LORA_STACK.md` §2) — kommen in den 16 Kombinationen
so gut wie nicht vor: nur `feuer_flammen` und `dark_ornament` sind eigene,
alle übrigen sind `fremd_*`. Wer den Bestand auswerten will, sollte ihn um die
eigenen LoRAs herum bauen.

## 6. Nächster Schritt (Vorschlag, nicht ausgeführt)

Zehn Bilder, ≈ 15 min, ≈ 0,25 USD: dieselben LoRA-Stapel, aber **abstrakte,
stilfreie Motive** („empty void", „close-up texture", „abstract composition"),
und die Wirkung mit derselben Differenzmessung belegt statt mit dem Auge. Erst
wenn dort Stil sichtbar wird, lohnt ein neuer Lauf — dann um die eigenen LoRAs
herum.

## 7. Wiederaufsetzen

Nichts ist verloren, die Zuordnung ist stabil:

```bash
cd ~/lora-themen-2026-09-27
python3 batch-bilder.py --gruppe --limit 0 --out bilder-vorrat   # läuft weiter, wo er war
setsid nohup ./vorrat-wache.sh >> vorrat-wache.log 2>&1 < /dev/null &
```

Die zwölf verlorenen `flux_alien`-Aufträge werden dabei zuerst nachgeholt, weil
sie in keinem Manifest stehen.
