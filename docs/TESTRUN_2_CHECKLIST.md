# TESTRUN 2 – Workflow-Checkliste (audioMONASTRY)

> Stand: 2026-08-31 · Zweck: Nach jeder Optimierung reproduzierbar prüfen.
> Legende: ✅ bestanden · ⚠️ bekannt/limitiert · ❌ fehlgeschlagen · ⬜ offen
> Regeln: Erst messen, dann abhaken. Hardware-/Live-Checks nur mit echtem Gerät.

## 1. Start & Basis

- [x] `npm run verify` läuft durch (tsc + Vitest + Boundary-Scan) – **AUD-1 gefixt (D22)**
- [ ] Studio startet ohne geöffnetes Plugin-Terminal (außer aiMONK-Dock)
- [ ] Main-RMS < -60 dBFS bei inaktiven Plugins
- [ ] masterplayerMONK als Plugin 0 fest oben sichtbar (alle User)
- [ ] aiMONK-Bottom-Dock sichtbar, ausblendbar

## 2. Plugin-Lifecycle (je Plugin)

- [ ] Plugin OFF → keine Verbindung Plugin→GLOBAL_MASTER
- [ ] Plugin PRO → genau eine Verbindung auf Ziel-Kanal
- [ ] Close-Button (✕) im Terminal setzt OFF und gibt Lock frei
- [ ] OFF während Play stoppt Klang sofort (< 50 ms)
- [ ] Sanftes Ramp-Down bei MAIN-verbundenen Plugins / hart bei Monitor-only

## 3. Routing & Mixer

- [ ] mixerMONK ist einzige MAIN-Einspeiseinstanz
- [ ] Nur Halter von mixerMONK kann MAIN beeinflussen
- [ ] Halter OFF → Main-Ausgabe + MainClock/Tick stoppen
- [ ] Nicht-DJ-User können Plugins aktivieren und hören MAIN (Host-Stream oder lokal)
- [ ] CUE1–4 unabhängig von MAIN; PLUGIN-Solo trennt MAIN nicht

## 4. Latenz & Clock

- [ ] Lokale Roundtrip-Latenz < 15 ms (Ziel < 1 ms Audio-Thread p99.99)
- [ ] Netz-Latenz < 50 ms one-way
- [ ] 120 BPM, 10 min: Jitter < 1 ms
- [ ] 0 Xruns/Dropouts im Normallauf

## 5. AI & MOA/MCP

- [ ] aiMONK führt „Tempo 128, Sequencer an, Pattern laden“ aus
- [ ] Fehlerfall zeigt verständliche Meldung (kein roher Traceback)
- [ ] A100/HF-Endpoint bevorzugt; DevSettings „AI Server Shutdown“ aktiviert Fallbacks
- [ ] Jedes Plugin hat Systemprompt + Eval-Datensatz (GAP-5)

## 6. Kollaboration (4 User)

- [ ] 4 Browser sehen identischen State
- [ ] Locking deterministisch (User-ID, kein Seiteneffekt im Updater)
- [ ] Gäste hören Main via Host-Stream; Cue separat
- [ ] Rollenwechsel ohne Audio-Unterbrechung

## 7. Persistenz & Zwischenspeicher

- [ ] Session-Scratchpad (halbtransparente Overlay-Sidebar) speichert/lädt
- [ ] Drag & Drop funktioniert
- [ ] „In Zwischenablage senden“ liefert gültiges JSON

## 8. Cross-Platform & Geräte

- [ ] iOS/Android: Touch-Ziele ≥ 44 px, Safe-Areas, kein Hover-only
- [ ] USB-Default: Xonar bevorzugt, sonst erste USB-Karte
- [ ] 2.1-Layout: Sub < 80 Hz auf drittem Kanal oder Phantom-Fallback
- [ ] Output-Layouts 2.0/2.1/2.2/12.x/18.x/24.x konfigurierbar

## 9. Fehlerfälle & Robustheit

- [ ] stem-ai down → schneller 502 (D22, verifiziert)
- [ ] Upload: 1 Datei + Summenlimit; kein RAM-Exploit
- [ ] OSC/HID-Malformed-Chunks → kein Crash
- [ ] MCP ohne Permission → denied (serverseitig)
- [ ] RLS für AI-Tabellen aktiv

## 10. Ergebnis

- [ ] Alle kritischen (P0) und hohen (P1) Punkte grün
- [ ] Befunde in `MASTER_TODO.md` eingetragen, Checkboxen aktualisiert
