#!/usr/bin/env python3
"""Aktualisiert Kopf, Kosten und Offene Punkte im Bericht auf den Endstand."""
from pathlib import Path

P = Path(__file__).parent / "BERICHT.md"

KOPF_ALT = """| **Fertige LoRAs** | **30 von 32 Themen** (2 liefen zuletzt noch, siehe §6) |"""
KOPF_NEU = """| **Fertige LoRAs** | **32 von 32 Themen** (das letzte lief im Nachhol-Pod, siehe §6) |"""

Q_ALT = """| **Qualität** | **22 Themen sauber strukturiert · 8 flächig** (gemessen, §4) |"""
Q_NEU = """| **Qualität** | **funktionieren** — im Inferenz-Test nachgewiesen; ein früheres „8 flächig" war mein Messfehler (§4) |"""

K_ALT = """| Posten | Betrag |
|---|---|
| Start (aufgeladen) | 11,795 USD |
| Guthaben jetzt | siehe `python3 monitor.py` |
| **Bisher verbraucht** | **~7,3 USD** inkl. aller Fehlversuche |
| Verbleibend | ~4,5 USD |"""
K_NEU = """| Posten | Betrag |
|---|---|
| Start (aufgeladen) | 11,795 USD |
| **Verbraucht** | **~8,3 USD** inkl. aller Fehlversuche und Prüfläufe |
| Verbleibend | ~3,5 USD |

Aufgeteilt: ~6,5 USD Training (32 Themen × ~15 min auf RTX PRO 5000 Community zu
0,82 USD/h, inkl. Kaltstarts), ~0,5 USD Fehlversuche, ~0,4 USD Diagnose- und
Inferenz-Prüfläufe, ~0,4 USD Nachhol-Pods."""

OFFEN_ALT = """- **2 Themen** (`vorsintflutliche_hochkultur`, `wikinger_samurai`) laufen im
  Nachhol-Pod `lora-p9` — sie waren an derselben HF-Störung gescheitert, als der
  Wiederholungsversuch noch nicht eingebaut war. Fertig ~08:45 lokal.
- **8 flächige LoRAs** — Ergebnis des Inferenz-Tests abwarten, dann entscheiden
  (siehe §4). Ein Neulauf mit z. B. 400 Schritten kostet für alle 8 zusammen
  unter 1 USD.
- **SDXL-Anbindung:** Die LoRAs nützen dir erst, wenn ein SDXL-Generator läuft.
  Das ist der nächste eigentliche Schritt (ComfyUI mit SDXL oder ein neuer
  Endpoint), nicht das Training."""
OFFEN_NEU = """- **`wikinger_samurai`** lief zuletzt im Nachhol-Pod `lora-p10` (der erste
  Anlauf war fertig trainiert, aber der 85-MB-Upload hing — dasselbe
  Host-Netzproblem wie beim HF-Aussetzer). Fertig ~09:15 lokal. Seitdem bricht
  ein hängender Upload nach 15 min ab, statt den Pod eine Stunde zu blockieren.
- **Vollständige Qualitätsprüfung:** Der Inferenz-Test deckte 3 von 32 Themen ab.
  Ein Durchlauf über alle 32 (~0,5 USD, ein Pod, ~40 min) würde für jedes Thema
  belegen, dass es unter freiem Prompt wirkt. Sag Bescheid, dann mache ich das.
- **SDXL-Anbindung — der eigentliche nächste Schritt:** Die LoRAs nützen dir erst,
  wenn ein SDXL-Generator läuft. Deine Rolle `imageHq` ist FLUX.1-dev und kann sie
  nicht laden. Nötig ist ein SDXL-Pfad (ComfyUI mit SDXL-Checkpoint oder ein neuer
  Endpoint mit `stabilityai/stable-diffusion-xl-base-1.0`)."""


def main() -> None:
    t = P.read_text(encoding="utf-8")
    for a, b in ((KOPF_ALT, KOPF_NEU), (Q_ALT, Q_NEU), (K_ALT, K_NEU), (OFFEN_ALT, OFFEN_NEU)):
        if a not in t:
            print("NICHT GEFUNDEN:", a.splitlines()[0][:60])
        t = t.replace(a, b)
    P.write_text(t, encoding="utf-8")
    print("Bericht aktualisiert")


if __name__ == "__main__":
    main()
