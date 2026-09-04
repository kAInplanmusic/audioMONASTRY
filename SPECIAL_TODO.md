# SPECIAL_TODO – Hardware-Spezialfälle (mit aktueller Ausstattung nicht testbar)

> Stand: 2026-09-03
> Quelle: aus `MASTER_TODO.md` umgezogen (Umpflegung nach Hardware-Abgleich).

## Verfügbare Hardware (Test-Setup)

- **3 PCs:** 2 Laptops + 1 Desktop
- **4 Mobilgeräte:** 2× iPhone 12 Pro · 1× iPad Pro 2021 · 1× Xiaomi 11 Max
- **1× ASUS Xonar U7** (8 Kanäle)
- **2.2-Lautsprecher mit Verstärker** (Verstärker max. 6 Kanäle)

## Damit testbare Audio-Layouts (mit Ton)

`2.0 · 2.1 · 2.2 · 3.0 · 3.1 · 3.2 · 4.0 · 4.1 · 4.2`

## Umzugs-Kriterien

Hierher verschoben werden TODOs, die mindestens eines davon brauchen:

- **mehr als 5 User-Geräte**
- **Audio-Layouts > 4.2** (5.1, 7.1, 8.1, 10.1, 12.x, 18.x, 24.x …)
- **externe MIDI-Controller, Audio-Interfaces, USB-Mischpulte o. ä.**
  (z. B. TR-8S, Beatstep Pro)

---

## Offene Spezial-TODOs

### MIDI-Controller / Hardware-Instrumente

- [ ] **NEW-MONK-4:** Pads-Synth-UI im Minilogue-Stil, **Beatstep-Pro-MIDI-Profil** (braucht Beatstep Pro zum Testen).
- [ ] **NEW-MONK-6 Prüfpunkt (Live):** Hörprobe mit echter Hardware (TR-8S/Beatstep Pro) – Clock-Lock und Notenzuordnung am Gerät prüfen (siehe `docs/HARDWARE_AUDIT_2026.md`).
- [ ] **Zusammenfassung (Live):** MIDI-Out/Clock mit echter Hardware (TR-8S/Beatstep Pro).

### Audio-Layouts > 4.2 (Xonar U7 = 8 Kanäle, Verstärker max. 6)

- [ ] **P2-3/D10:** Ausgabe-Layouts **12.0 / 12.1 / 12.2 / 18.0 / 18.1 / 18.2 / 24.0 / 24.1 / 24.2** unterstützen und mit Ton testen (benötigt > 4.2 Lautsprecher-Setup).
- [ ] **P2-3 Prüfpunkt (Live):** Output-Layouts **12.x / 18.x / 24.x** konfigurierbar und hörbar (benötigt > 4.2 Setup).

---

## Hinweis

Sobald zusätzliche Hardware verfügbar ist (MIDI-Controller, Audio-Interfaces,
USB-Mischpulte oder ein > 4.2-Lautsprecher-Setup), diese Punkte zurück nach
`MASTER_TODO.md` ziehen und dort abarbeiten.
