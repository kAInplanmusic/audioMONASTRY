#!/usr/bin/env python3
"""Ersetzt Abschnitt 4 im Bericht durch die korrigierte Fassung."""
from pathlib import Path

P = Path(__file__).parent / "BERICHT.md"

NEU = """## 4. Qualität — und eine Korrektur an mir selbst

**Erster Befund (falsch).** Ich habe die Probe-Bilder des Trainers gemessen
(Graustufen-Streuung, Kantenenergie, Farbstreuung). Ergebnis: 22 strukturiert,
**8 flächig** — `taenzer`, `geheimbund_moenche`, `krieg_tod`, `licht_rauch`,
`natur_echt`, `industrial_techno`, `hdr_sternenhimmel`, `nackte_haut`.
Messwerte stehen in `ergebnisse/qualitaet.json`.

**Warum dieser Schluss falsch war.** Ich habe daraus „die LoRAs sind überangepasst"
abgeleitet. Das war ein Fehlschluss aus dem falschen Beweis: das Probe-Bild ist das
Erzeugnis des *Trainers*, nicht des LoRA allein.

**Gegenprobe mit eigenem Inferenz-Test** (`infer-test2.py`, ~0,25 USD):
Dieselben LoRAs in einer eigenen diffusers-Pipeline geladen, mit und ohne Trigger.
Die Diagnose ist eindeutig — **722 LoRA-Schichten** werden geladen (vorher 0), das
LoRA greift also. Und am Bild (Kontrollblatt `ergebnisse/inferenz-test-v2.png`):

| Trigger | Ergebnis |
|---|---|
| `mstyle_comic` | Porträts werden zu **Bleistift-/Comic-Zeichnungen**, Tänzer in harten Spotlights |
| `mstyle_krieg_tod` | Tänzer in dunkler Kleidung, Porträts **grau, ausgemergelt, düster** |
| `mstyle_taenzer` | zarte, helle, elegante Bilder |
| **ohne Trigger** | generisch — der Trigger ist tragend, wie geplant |

**Korrigiertes Urteil:** Die LoRAs **funktionieren**. Die acht flächigen
Probe-Bilder waren ein **Artefakt des Trainer-Probe-Prompts** (nackter Trigger +
„high detail, natural light" bei CFG 7), kein Qualitätsurteil über das LoRA.
Das erklärt auch, warum `comic` in beiden Fällen gut aussah: dort trägt der Stil
auch einen schwachen Prompt.

**Was ehrlich offen bleibt:** Geprüft wurden drei Themen im Inferenz-Test, nicht
alle 32. Für die übrigen ist „das Trainings-Probe-Bild sieht gut aus" ein Indiz,
kein Beweis. Ein kompletter Inferenz-Durchlauf über alle 32 Themen ist der nächste
sinnvolle Schritt (~0,5 USD, ein Pod, ~40 min).

**Ehrlicher Hinweis zur Datenbasis:** In `natur_tiere` beschreiben 24 von 25
Captions tätowierte Haut — der Ordner enthält Tier-*Tattoos*, keine Tiere. Ich habe
das nicht „repariert", sondern trainiert, was du kuratiert hast. Wenn du dort echte
Tiere willst, braucht der Ordner anderes Bildmaterial.
"""


def main() -> None:
    text = P.read_text(encoding="utf-8")
    start = text.index("## 4. Qualität")
    end = text.index("## 5. Kosten")
    P.write_text(text[:start] + NEU + "\n---\n\n" + text[end:], encoding="utf-8")
    print("Abschnitt 4 ersetzt")


if __name__ == "__main__":
    main()
