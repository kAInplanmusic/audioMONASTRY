# Vast: theoretische GPU-Alternativen unter 1 EUR/h

Stand: 12.11.2026, 01:19:19 CET. Native Quelle: [Vast GPU-Typenliste](https://console.vast.ai/api/v0/gpu_names/unique/); Preisquelle: authentifizierte, ausschließlich lesende Angebotssuchen unter `https://console.vast.ai/api/v0/bundles/`.

**Die aktive Gesamtflotte darf 8 EUR/h ohne Hetzner und Supabase kosten. Einzelne Instanzen dürfen teurer als 1 EUR/h sein. Die Grenze von strikt unter 1 EUR/h gilt ausschließlich für diese ergänzende Kartenliste.**

Katalog: **107 GPU-Bezeichnungen**. Aktuell erfolgreich abgefragt: **107**. Aktuelle Unter-1-EUR-Belege: **95 Karten-/Speichervarianten aus 83 GPU-Bezeichnungen**. Historisch erhalten, derzeit nicht bestätigt: **0 Varianten**.

**Alle Katalogtypen wurden abgefragt.** Dies ist keine vollständige Erfassung aller Anbieter, Angebote oder VRAM-Umbauten: je Typ wurden höchstens fünf mietbare Single-GPU-On-Demand-Angebote nach Gesamtstundenpreis abgefragt. Ein leeres Suchergebnis bedeutet keine Angebote unter diesen Suchbedingungen; es beweist nicht, dass der Kartentyp generell nicht angeboten wird.

## Preisabgrenzung und Nachweise

- Umrechnung unverändert aus dem Budget: USD × 0,92 × 1,19. Das ist eine Budgetannahme, kein aktueller Wechselkurs.
- GPU-Preis: `search.gpuCostPerHour`, ersatzweise `dph_base`. Unbekannte, nichtpositive oder nichtendliche Preise zählen nicht als Unter-1-EUR-Nachweis.
- `dph_total`/`search.totalHour` enthalten gegebenenfalls bereits Standard-Disk. Falls nur dieser Beleg erhalten ist, wird er ausdrücklich als konservative Obergrenze einschließlich Standard-Disk markiert.
- Rollendisk: nicht in dieser Abfrage allokiert. Die zusätzliche Disk für Modelle und Arbeitsdaten muss anhand der jeweiligen Rollenanforderung separat vollständig kalkuliert werden. Bereits enthaltene Disk nicht doppelt addieren.
- Traffic: nutzungsabhängige Download-/Uploadkosten gemäß `inet_down_cost`/`inet_up_cost` (USD/GB); separat von GPU und Disk. Persistenter Speicher ist ebenfalls nicht enthalten.
- JSON enthält Angebots-IDs, gemeldete Hardware, Preisfelder und Zeitstempel als Beleg, soweit im fortsetzbaren Cache vorhanden. Historische Preise sind keine aktuelle Preisbestätigung. Keine Buchung, Reservierung, Inferenz oder Leistungsprüfung.

## Rollenanforderungen aus unverändertem Profil

| Rolle | VRAM mindestens GiB | Host-RAM GiB | effektive vCPUs | CUDA mindestens | Rollendisk GB | Modelle |
|---|---:|---:|---:|---|---:|---|
| brain | 47 | 64 | 4 | 13.0 | 140 | qwen38-27b-fp8 |
| ears | 42 | 80 | 4 | 12.8 | 180 | moss-music-8b-instruct, clap-music, beat-this, songformer, dsp-analysis, basic-pitch |
| voice | 45 | 64 | 4 | 12.8 | 150 | qwen3-tts-17b, qwen3-tts-voicedesign, moss-soundeffect-v2.0, acestep-v15-xl-base, acestep-v15-shared |
| music | 33 | 64 | 4 | 12.8 | 150 | acestep-v15-xl-turbo, acestep-5hz-lm-4b, acestep-v15-shared |
| studio | 69 | 88 | 4 | 12.8 | 250 | sonicmaster, bs-roformer-sw-6stem, mvsep-mega-53, mel-roformer-bve |
| audio-brain | 19 | 32 | 4 | 12.8 | 80 | qwen3-4b |
| song | 23 | 40 | 4 | 12.8 | 150 | yue2-3b |
| vis | 27 | 32 | 4 | 12.8 | 180 | universr, mel-roformer-dereverb |

## Einstufungen

**P – Profil:** Typ bereits im unveränderten Hardwareprofil; kein neuer Inferenznachweis. **T – theoretisch passend:** VRAM, Treiber und gemeldete Hostressourcen passen, unveränderte Images/Modelle noch ungeprüft. **C – CMP ungeprüft**, **M – VRAM-Modifikation ungeprüft**: ausdrücklich keine Freigabe durch den normalen Kartennamen.

Ausschlüsse oder zusätzliche Prüfbedarfe: **V** VRAM zu klein; **H** Host-RAM/vCPU zu klein; **D** CUDA-Treiber ungeeignet/fehlend; **A** ARM statt benötigtem amd64; **F** nicht für aktuelles FP8-Brain freigegeben; **G** kompletter Vis-Grafik-/NVENC-Pfad nicht freigegeben; **S** unverändertes Vis-Image ohne sm_120; **U** ältere/unbekannte Compute-Architektur separat zu validieren; **N** aktueller CUDA-Pfad erfordert NVIDIA. Ein Ausschluss ist der erste ausschlaggebende Grund und keine vollständige Hardwarediagnose.

Die Rollenprüfung bewertet VRAM, gemeldete CPU-/RAM-Zuweisung, Treiber und bekannte Architektur-/Image-Ausschlüsse. Provider-Verifizierung, Zuverlässigkeit, freie Rollendisk, Ports, Host-Gesundheit, tatsächliche Kernel-Unterstützung und Echtzeitlatenz sind damit nicht vollständig validiert. P und T sind keine Produktionsfreigabe.

Mehrere Codes bedeuten unterschiedliche geprüfte Angebote derselben Karten-/Speichervariante. Der Tabellenpreis ist das GPU-Minimum der Variante und gilt nicht automatisch für jeden Rollen-Code; die exakten Preise je Einstufung stehen im JSON unter `roles`/`byRole`. Preis und Rollenpassung müssen vom selben Angebot stammen.

## Aktuelle Varianten und Zuordnung zu allen acht Rollen

| GPU / gemeldeter VRAM | GPU EUR/h | brain | ears | voice | music | studio | audio-brain | song | vis |
|---|---:|---|---|---|---|---|---|---|---|
| A10 / 22.5 GiB | 0.2482 | V | V | V | V | V | H/T | V | V |
| A100 PCIE / 40 GiB | 0.4379 | V | V | V | H/T | V | H/T | H/T | G |
| A100 PCIE / 80 GiB | 0.9488 | F | P | P | P | P | P | P | G |
| A100 SXM4 / 40 GiB | 0.4087 | V | V | V | H/P | V | P | H/P | G |
| A16 / 15 GiB | 0.1460 | V | V | V | V | V | V | V | V |
| A40 / 45 GiB | 0.2919 | V | P | V | P | V | P | P | P |
| A40 / 48 GiB | 0.7737 | F | P | P | P | V | P | P | P |
| A800 PCIE / 80 GiB | 0.5109 | F | T | T | T | T | T | T | T |
| CMP 170HX / 40 GiB (CMP ungeprüft) | 0.2628 | V | V | V | H | V | H | H | G |
| CMP 170HX / 64 GiB (CMP ungeprüft) | 0.2628 | F | C/H | C/H | C/H | V | C | C | G |
| GB10 / 119 GiB | 0.2919 | A | A | A | A | A | A | A | A |
| GTX 1060 / 6 GiB | 0.0730 | V | V | V | V | V | V | V | V |
| GTX 1070 / 8 GiB | 0.0365 | V | V | V | V | V | V | V | V |
| GTX 1070 Ti / 8 GiB | 0.0555 | V | V | V | V | V | V | V | V |
| GTX 1080 / 8 GiB | 0.0584 | V | V | V | V | V | V | V | V |
| GTX 1080 Ti / 11 GiB | 0.0657 | V | V | V | V | V | V | V | V |
| GTX 1650 / 4 GiB | 0.0526 | V | V | V | V | V | V | V | V |
| GTX 1660 / 6 GiB | 0.0511 | V | V | V | V | V | V | V | V |
| GTX 1660 S / 6 GiB | 0.0555 | V | V | V | V | V | V | V | V |
| GTX 1660 Ti / 6 GiB | 0.0438 | V | V | V | V | V | V | V | V |
| GTX TITAN X / 12 GiB | 0.0438 | V | V | V | V | V | V | V | V |
| L4 / 22.5 GiB | 0.1022 | V | V | V | V | V | H | V | V |
| L40 / 45 GiB | 0.3941 | V | P | V | P | V | P | P | P |
| L40 / 48 GiB | 0.3941 | P | P | P | P | V | P | P | P |
| L40S / 45 GiB | 0.5839 | V | H/P | V | H/P | V | H/P | H/P | H/P |
| Q RTX 4000 / 8 GiB | 0.1168 | V | V | V | V | V | V | V | V |
| Q RTX 5000 / 16 GiB | 0.1022 | V | V | V | V | V | V | V | V |
| Q RTX 6000 / 24 GiB | 0.1241 | V | V | V | V | V | U | U | V |
| Q RTX 8000 / 45 GiB | 0.2773 | V | U | U | U | V | U | U | U |
| Q RTX 8000 / 48 GiB | 0.2773 | F | U | U | U | V | U | U | U |
| Quadro P4000 / 8 GiB | 0.0584 | V | V | V | V | V | V | V | V |
| RTX 2000Ada / 16 GiB | 0.1314 | V | V | V | V | V | V | V | V |
| RTX 2060 / 12 GiB | 0.0730 | V | V | V | V | V | V | V | V |
| RTX 2060S / 8 GiB | 0.0701 | V | V | V | V | V | V | V | V |
| RTX 2070 / 8 GiB | 0.0657 | V | V | V | V | V | V | V | V |
| RTX 2070S / 8 GiB | 0.0730 | V | V | V | V | V | V | V | V |
| RTX 2080 / 8 GiB | 0.1022 | V | V | V | V | V | V | V | V |
| RTX 2080 Ti / 11 GiB | 0.0730 | V | V | V | V | V | V | V | V |
| RTX 2080 Ti / 22 GiB (Umbau ungeprüft) | 0.0730 | V | V | V | V | V | U | V | V |
| RTX 3050 / 6 GiB | 0.0730 | V | V | V | V | V | V | V | V |
| RTX 3060 / 12 GiB | 0.0365 | V | V | V | V | V | V | V | V |
| RTX 3060 Ti / 8 GiB | 0.0399 | V | V | V | V | V | V | V | V |
| RTX 3060 laptop / 12 GiB | 0.0774 | V | V | V | V | V | V | V | V |
| RTX 3070 / 8 GiB | 0.0730 | V | V | V | V | V | V | V | V |
| RTX 3070 Ti / 8 GiB | 0.1022 | V | V | V | V | V | V | V | V |
| RTX 3080 / 10 GiB | 0.1158 | V | V | V | V | V | V | V | V |
| RTX 3080 / 20 GiB (Umbau ungeprüft) | 0.0949 | V | V | V | V | V | H | V | V |
| RTX 3080 Ti / 12 GiB | 0.0876 | V | V | V | V | V | V | V | V |
| RTX 3090 / 24 GiB | 0.0949 | V | V | V | V | V | D/H/P | D/H/P | V |
| RTX 3090 Ti / 24 GiB | 0.2263 | V | V | V | V | V | H/P | H/P | V |
| RTX 4000Ada / 20 GiB | 0.1898 | V | V | V | V | V | H/T | V | V |
| RTX 4060 / 8 GiB | 0.0584 | V | V | V | V | V | V | V | V |
| RTX 4060 Ti / 8 GiB | 0.1168 | V | V | V | V | V | V | V | V |
| RTX 4060 Ti / 16 GiB | 0.0876 | V | V | V | V | V | V | V | V |
| RTX 4060 laptop / 8 GiB | 0.1095 | V | V | V | V | V | V | V | V |
| RTX 4070 / 12 GiB | 0.0949 | V | V | V | V | V | V | V | V |
| RTX 4070 Ti / 12 GiB | 0.1460 | V | V | V | V | V | V | V | V |
| RTX 4070 laptop / 8 GiB | 0.1591 | V | V | V | V | V | V | V | V |
| RTX 4070S / 12 GiB | 0.1022 | V | V | V | V | V | V | V | V |
| RTX 4070S Ti / 16 GiB | 0.0730 | V | V | V | V | V | V | V | V |
| RTX 4080 / 16 GiB | 0.1898 | V | V | V | V | V | V | V | V |
| RTX 4080S / 16 GiB | 0.2134 | V | V | V | V | V | V | V | V |
| RTX 4080S / 32 GiB | 0.2379 | V | V | V | V | V | H | H | H |
| RTX 4090 / 24 GiB | 0.1460 | V | V | V | V | V | H/P | H/P | V |
| RTX 4500Ada / 24 GiB | 0.3576 | V | V | V | V | V | H/T | H/T | V |
| RTX 5000Ada / 32 GiB | 0.4525 | V | V | V | V | V | P | P | P |
| RTX 5060 / 8 GiB | 0.0876 | V | V | V | V | V | V | V | V |
| RTX 5060 Ti / 15.9 GiB | 0.0876 | V | V | V | V | V | V | V | V |
| RTX 5070 / 11.9 GiB | 0.1460 | V | V | V | V | V | V | V | V |
| RTX 5070 Ti / 15.9 GiB | 0.1722 | V | V | V | V | V | V | V | V |
| RTX 5080 / 15.9 GiB | 0.2044 | V | V | V | V | V | V | V | V |
| RTX 5090 / 31.8 GiB | 0.3357 | V | V | V | V | V | H/P | H/P | S |
| RTX 5090D / 31.8 GiB | 0.7153 | V | V | V | V | V | T | T | S |
| RTX 5880Ada / 48 GiB | 0.8758 | T | T | T | T | V | T | T | T |
| RTX 6000Ada / 48 GiB | 0.5839 | D/H/P | D/H/P | D/H/P | D/H/P | V | D/P | D/P | D/P |
| RTX A2000 / 6 GiB | 0.0350 | V | V | V | V | V | V | V | V |
| RTX A2000 / 12 GiB | 0.1460 | V | V | V | V | V | V | V | V |
| RTX A3000 laptop / 12 GiB | 0.0730 | V | V | V | V | V | V | V | V |
| RTX A4000 / 15 GiB | 0.0949 | V | V | V | V | V | V | V | V |
| RTX A4000 / 16 GiB | 0.0774 | V | V | V | V | V | V | V | V |
| RTX A4500 / 20 GiB | 0.1460 | V | V | V | V | V | H | V | V |
| RTX A5000 / 24 GiB | 0.1752 | V | V | V | V | V | H/P | H/P | V |
| RTX A6000 / 48 GiB | 0.3357 | F | H/P | H/P | H/P | V | P | P | P |
| RTX PRO 4000 / 23.9 GiB | 0.2409 | V | V | V | V | V | H/P | H/P | V |
| RTX PRO 4500 / 31.9 GiB | 0.3795 | V | V | V | V | V | H/P | H/P | S |
| RTX PRO 5000 / 47.8 GiB | 0.4087 | H/P | H/P | H/P | H/P | V | H/P | H/P | S |
| RTX PRO 6000 Max-Q / 95.6 GiB | 0.6934 | H | H | H | H | H | H | H | S |
| RTX PRO 6000 WS / 95.6 GiB | 0.9488 | H | H | H | H | H | P | P | S |
| Tesla P100 / 16 GiB | 0.0467 | V | V | V | V | V | V | V | V |
| Tesla P40 / 22.5 GiB | 0.1022 | V | V | V | V | V | D | V | V |
| Tesla T4 / 15 GiB | 0.1314 | V | V | V | V | V | V | V | V |
| Tesla T4 / 16 GiB | 0.2919 | V | V | V | V | V | V | V | V |
| Tesla V100 / 32 GiB | 0.0730 | V | V | V | V | V | D/U | D/U | D/U |
| Titan RTX / 24 GiB | 0.1460 | V | V | V | V | V | U | U | V |
| Titan Xp / 12 GiB | ≤ 0.0462 | V | V | V | V | V | V | V | V |

## Vollständige Katalogabdeckung

| GPU-Typ | Abfragestatus | Angebote im Limit 5 | aktuelle Varianten <1 EUR | niedrigster bestätigter GPU-Preis EUR/h |
|---|---|---:|---:|---:|
| A10 | quoted | 2 | 1 | 0.2482 |
| A100 PCIE | quoted | 5 | 2 | 0.4379 |
| A100 SXM4 | quoted | 5 | 1 | 0.4087 |
| A100X | quoted | 0 | 0 | – |
| A16 | quoted | 1 | 1 | 0.1460 |
| A40 | quoted | 5 | 2 | 0.2919 |
| A800 PCIE | quoted | 1 | 1 | 0.5109 |
| B200 | quoted | 3 | 0 | – |
| B300 | quoted | 1 | 0 | – |
| CMP 170HX | quoted | 5 | 2 | 0.2628 |
| GB10 | quoted | 5 | 1 | 0.2919 |
| GB200 | quoted | 1 | 0 | – |
| GB300 | quoted | 0 | 0 | – |
| GTX 1050 Ti | quoted | 0 | 0 | – |
| GTX 1060 | quoted | 2 | 1 | 0.0730 |
| GTX 1070 | quoted | 4 | 1 | 0.0365 |
| GTX 1070 Ti | quoted | 1 | 1 | 0.0555 |
| GTX 1080 | quoted | 4 | 1 | 0.0584 |
| GTX 1080 Ti | quoted | 5 | 1 | 0.0657 |
| GTX 1650 | quoted | 3 | 1 | 0.0526 |
| GTX 1650 S | quoted | 0 | 0 | – |
| GTX 1660 | quoted | 4 | 1 | 0.0511 |
| GTX 1660 S | quoted | 5 | 1 | 0.0555 |
| GTX 1660 Ti | quoted | 3 | 1 | 0.0438 |
| GTX TITAN X | quoted | 3 | 1 | 0.0438 |
| H100 NVL | quoted | 2 | 0 | – |
| H100 PCIE | quoted | 5 | 0 | – |
| H100 SXM | quoted | 4 | 0 | – |
| H200 | quoted | 3 | 0 | – |
| H200 NVL | quoted | 5 | 0 | – |
| L4 | quoted | 5 | 1 | 0.1022 |
| L40 | quoted | 2 | 2 | 0.3941 |
| L40S | quoted | 5 | 1 | 0.5839 |
| Q RTX 4000 | quoted | 2 | 1 | 0.1168 |
| Q RTX 5000 | quoted | 1 | 1 | 0.1022 |
| Q RTX 6000 | quoted | 1 | 1 | 0.1241 |
| Q RTX 8000 | quoted | 4 | 2 | 0.2773 |
| Quadro GV100 | quoted | 0 | 0 | – |
| Quadro K2200 | quoted | 0 | 0 | – |
| Quadro P4000 | quoted | 5 | 1 | 0.0584 |
| RTX 2000Ada | quoted | 1 | 1 | 0.1314 |
| RTX 2060 | quoted | 5 | 1 | 0.0730 |
| RTX 2060S | quoted | 3 | 1 | 0.0701 |
| RTX 2070 | quoted | 3 | 1 | 0.0657 |
| RTX 2070S | quoted | 2 | 1 | 0.0730 |
| RTX 2080 | quoted | 1 | 1 | 0.1022 |
| RTX 2080 Ti | quoted | 5 | 2 | 0.0730 |
| RTX 3050 | quoted | 2 | 1 | 0.0730 |
| RTX 3060 | quoted | 5 | 1 | 0.0365 |
| RTX 3060 Ti | quoted | 5 | 1 | 0.0399 |
| RTX 3060 laptop | quoted | 5 | 1 | 0.0774 |
| RTX 3070 | quoted | 5 | 1 | 0.0730 |
| RTX 3070 Ti | quoted | 3 | 1 | 0.1022 |
| RTX 3070 laptop | quoted | 0 | 0 | – |
| RTX 3080 | quoted | 5 | 2 | 0.0949 |
| RTX 3080 Ti | quoted | 5 | 1 | 0.0876 |
| RTX 3090 | quoted | 5 | 1 | 0.0949 |
| RTX 3090 Ti | quoted | 4 | 1 | 0.2263 |
| RTX 4000Ada | quoted | 4 | 1 | 0.1898 |
| RTX 4060 | quoted | 5 | 1 | 0.0584 |
| RTX 4060 Ti | quoted | 5 | 2 | 0.0876 |
| RTX 4060 laptop | quoted | 2 | 1 | 0.1095 |
| RTX 4070 | quoted | 5 | 1 | 0.0949 |
| RTX 4070 Ti | quoted | 5 | 1 | 0.1460 |
| RTX 4070 laptop | quoted | 1 | 1 | 0.1591 |
| RTX 4070S | quoted | 5 | 1 | 0.1022 |
| RTX 4070S Ti | quoted | 5 | 1 | 0.0730 |
| RTX 4080 | quoted | 5 | 1 | 0.1898 |
| RTX 4080 laptop | quoted | 0 | 0 | – |
| RTX 4080S | quoted | 5 | 2 | 0.2134 |
| RTX 4090 | quoted | 5 | 1 | 0.1460 |
| RTX 4090D | quoted | 0 | 0 | – |
| RTX 4500Ada | quoted | 3 | 1 | 0.3576 |
| RTX 5000Ada | quoted | 4 | 1 | 0.4525 |
| RTX 5060 | quoted | 5 | 1 | 0.0876 |
| RTX 5060 Ti | quoted | 5 | 1 | 0.0876 |
| RTX 5070 | quoted | 5 | 1 | 0.1460 |
| RTX 5070 Ti | quoted | 5 | 1 | 0.1722 |
| RTX 5080 | quoted | 5 | 1 | 0.2044 |
| RTX 5090 | quoted | 5 | 1 | 0.3357 |
| RTX 5090D | quoted | 3 | 1 | 0.7153 |
| RTX 5880Ada | quoted | 2 | 1 | 0.8758 |
| RTX 6000Ada | quoted | 5 | 1 | 0.5839 |
| RTX 6000D | quoted | 1 | 0 | – |
| RTX A2000 | quoted | 5 | 2 | 0.0350 |
| RTX A3000 laptop | quoted | 1 | 1 | 0.0730 |
| RTX A4000 | quoted | 5 | 2 | 0.0774 |
| RTX A4500 | quoted | 1 | 1 | 0.1460 |
| RTX A5000 | quoted | 5 | 1 | 0.1752 |
| RTX A6000 | quoted | 5 | 1 | 0.3357 |
| RTX PRO 4000 | quoted | 5 | 1 | 0.2409 |
| RTX PRO 4000 SFF | quoted | 0 | 0 | – |
| RTX PRO 4500 | quoted | 5 | 1 | 0.3795 |
| RTX PRO 5000 | quoted | 5 | 1 | 0.4087 |
| RTX PRO 6000 Max-Q | quoted | 5 | 1 | 0.6934 |
| RTX PRO 6000 S | quoted | 5 | 0 | – |
| RTX PRO 6000 WS | quoted | 5 | 1 | 0.9488 |
| T4G | quoted | 1 | 0 | – |
| Tesla P100 | quoted | 3 | 1 | 0.0467 |
| Tesla P4 | quoted | 0 | 0 | – |
| Tesla P40 | quoted | 1 | 1 | 0.1022 |
| Tesla T4 | quoted | 3 | 2 | 0.1314 |
| Tesla V100 | quoted | 5 | 1 | 0.0730 |
| Tesla V100S | quoted | 0 | 0 | – |
| Titan RTX | quoted | 5 | 1 | 0.1460 |
| Titan V | quoted | 0 | 0 | – |
| Titan Xp | quoted | 5 | 1 | 0.0462 |

Bei fünf zurückgegebenen Angeboten können weitere Anbieter und Speichergrößen existieren. Ohne bestätigten Preis wird kein Typ als unter 1 EUR/h geführt. Ein Preisbeleg ohne passende Rollenressourcen bleibt ein Preisbeleg und wird nicht zu einer geeigneten Rollenalternative.

## Bestehende Profile bleiben erhalten

- **brain:** NVIDIA RTX 6000 Ada Generation; NVIDIA L40; NVIDIA L40S; NVIDIA RTX PRO 5000 Blackwell; NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb; NVIDIA RTX PRO 6000 Blackwell Workstation Edition.
- **ears:** NVIDIA RTX 6000 Ada Generation; NVIDIA A100 80GB PCIe; NVIDIA A100-SXM4-80GB; NVIDIA A40; NVIDIA L40; NVIDIA L40S; NVIDIA RTX A6000; NVIDIA RTX PRO 5000 Blackwell; NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb; NVIDIA RTX PRO 6000 Blackwell Workstation Edition.
- **voice:** NVIDIA A40; NVIDIA A100 80GB PCIe; NVIDIA A100-SXM4-80GB; NVIDIA L40; NVIDIA L40S; NVIDIA RTX 6000 Ada Generation; NVIDIA RTX A6000; NVIDIA RTX PRO 5000 Blackwell; NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb; NVIDIA RTX PRO 6000 Blackwell Workstation Edition.
- **music:** NVIDIA RTX 6000 Ada Generation; NVIDIA A100 80GB PCIe; NVIDIA A100-SXM4-40GB; NVIDIA A100-SXM4-80GB; NVIDIA A40; NVIDIA L40; NVIDIA L40S; NVIDIA RTX A6000; NVIDIA RTX PRO 5000 Blackwell; NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb; NVIDIA RTX PRO 6000 Blackwell Workstation Edition.
- **studio:** NVIDIA RTX PRO 6000 Blackwell Server Edition; NVIDIA A100 80GB PCIe; NVIDIA A100-SXM4-80GB; NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition; NVIDIA RTX PRO 6000 Blackwell Workstation Edition.
- **audio-brain:** NVIDIA GeForce RTX 5090; NVIDIA A100 80GB PCIe; NVIDIA A100-SXM4-40GB; NVIDIA A100-SXM4-80GB; NVIDIA A40; NVIDIA GeForce RTX 3090; NVIDIA GeForce RTX 3090 Ti; NVIDIA GeForce RTX 4090; NVIDIA L4; NVIDIA L40; NVIDIA L40S; NVIDIA RTX 5000 Ada Generation; NVIDIA RTX 6000 Ada Generation; NVIDIA RTX A5000; NVIDIA RTX A6000; NVIDIA RTX PRO 4000 Blackwell; NVIDIA RTX PRO 4500 Blackwell; NVIDIA RTX PRO 4500 Blackwell Server Edition; NVIDIA RTX PRO 5000 Blackwell; NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb; NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb; NVIDIA RTX PRO 6000 Blackwell Workstation Edition.
- **song:** NVIDIA GeForce RTX 5090; NVIDIA A100 80GB PCIe; NVIDIA A100-SXM4-40GB; NVIDIA A100-SXM4-80GB; NVIDIA A40; NVIDIA GeForce RTX 3090; NVIDIA GeForce RTX 3090 Ti; NVIDIA GeForce RTX 4090; NVIDIA L4; NVIDIA L40; NVIDIA L40S; NVIDIA RTX 5000 Ada Generation; NVIDIA RTX 6000 Ada Generation; NVIDIA RTX A5000; NVIDIA RTX A6000; NVIDIA RTX PRO 4000 Blackwell; NVIDIA RTX PRO 4500 Blackwell; NVIDIA RTX PRO 4500 Blackwell Server Edition; NVIDIA RTX PRO 5000 Blackwell; NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb; NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb; NVIDIA RTX PRO 6000 Blackwell Workstation Edition.
- **vis:** NVIDIA A40; NVIDIA GeForce RTX 5090; NVIDIA L40; NVIDIA L40S; NVIDIA RTX 5000 Ada Generation; NVIDIA RTX 6000 Ada Generation; NVIDIA RTX A6000; NVIDIA RTX PRO 4500 Blackwell; NVIDIA RTX PRO 4500 Blackwell Server Edition; NVIDIA RTX PRO 5000 Blackwell; NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition; NVIDIA RTX PRO 6000 Blackwell Server Edition; NVIDIA RTX PRO 6000 Blackwell Workstation Edition.

Keine Produktionskonfiguration, Modelle, Gewichte, Revisionen oder Qualitätsparameter geändert. Keine GPU-/CPU-Instanzen gemietet, gestartet, recycelt oder behalten. Keine Containerlogs angefordert oder exportiert. Der Katalog ist eine zusätzliche theoretische Übersicht; eine künftige Flottenauswahl braucht frische vollständige Angebote einschließlich Disk, Trafficreserve und 8-EUR-Gesamtprüfung.

## Validierung dieses Berichts

- Integritätsprüfung: 107 eindeutige Katalogtypen erfolgreich abgefragt; 95 aktuelle Varianten; alle acht Rollen je Variante; alle bestätigten Preise strikt zwischen 0 und 1 EUR/h.
- 16 gezielte lokale Tests erfolgreich: sechs zum Scanner und zehn zum bestehenden Flottenplaner. Tests decken unter anderem sofortigen Quotenstopp, persistiertes Retry-After, unbekannte Preise, GPU-/Disk-Trennung und VRAM-Modifikationen ab.
- Private Zugangsdaten gegen die vier geänderten Dateien geprüft; keine Treffer. Fortsetzungs-Cache bleibt außerhalb des Commits.
- Vollständiges `npm run verify` nicht erfolgreich abgeschlossen: zwei AI-Routentests meldeten Fehler; die automatische Sicherheitsprüfung wies die Fortsetzung wegen eines unerwarteten Kontakts zu `hallerbans.de` mit ungeklärter Datenübermittlung ab. Kein erneuter Versuch dieses Laufs.
