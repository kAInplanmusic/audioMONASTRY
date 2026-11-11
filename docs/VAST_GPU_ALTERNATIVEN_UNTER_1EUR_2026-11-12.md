# Vast: theoretische GPU-Alternativen unter 1 EUR/h

Stand: 12. November 2026, Europe/Berlin. Diese Liste erweitert die Alternativen für die acht bestehenden Rollen. Sie ändert keine aktive GPU-Priorität, kein Modell, keine Gewichte und keine Image-Digests.

**Die Betriebsgrenze beträgt 8 EUR/h für die gesamte aktive Flotte ohne Hetzner und Supabase. Einzelne Instanzen dürfen mehr als 1 EUR/h kosten.** Die 1-EUR-Schwelle ist nur der Filter dieses ergänzenden Katalogs.

Die native Vast-Typenliste enthält 107 GPU-Bezeichnungen. Dokumentiert sind 88 Speicher-/Kartenvarianten mit Unter-1-EUR-Preisbeleg über 71 Bezeichnungen. Die tägliche Suchzeilenquote wurde erreicht; vollständige aktuelle Preisabdeckung aller 107 Bezeichnungen ist noch nicht bestätigt. Die Fortsetzung ist für 01:10 Uhr deutscher Zeit eingerichtet, ohne Vermietung oder Produktionsänderung.

## Preis- und Prüfstatus

- Umrechnung wie im Flottenbudget: 0,92 EUR/USD und 19 Prozent Steuerannahme. Die Quote ist keine Reservierung.
- Normale GPU-Preisbelege enthalten keine rollenbezogene Arbeitsdisk und keinen Traffic. Mit `≤` markierte Werte sind konservative Obergrenzen aus früheren vollständigen Rollenangeboten einschließlich deren Disk; die reine GPU war damit ebenfalls unter 1 EUR/h.
- „Profil“ bedeutet: Hardwaretyp steht bereits in der bestehenden Kompatibilitätsliste. Es ist kein neuer erfolgreicher Vast-Inferenznachweis.
- „Theorie“ bedeutet: VRAM/CUDA passen grundsätzlich, die unveränderten Images und Modelle sind auf diesem Typ noch zu prüfen.
- CMP-/VRAM-Umbauten bleiben experimentell. Gemeldeter Speicher ist kein Beleg für stabile Rechenleistung, passende Tensor-Kernels oder NVENC/Chromium.
- Angebote mit unzureichendem Host-RAM, CPU-Anteil oder CUDA-Treiber werden nicht als passende Rollenangebote geführt. Neue Angebote brauchen immer eine frische vollständige Prüfung.

## Zuordnung zu den acht Rollen

### brain: mindestens 47 GiB nach aktuellem Modellbudget

Modelle: `qwen38-27b-fp8`.

| Karte / gemeldeter VRAM | Belegte Quote EUR/h | Einordnung |
|---|---:|---|
| RTX 4090 / 48 GiB | 0.440 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX 4090 / 48 GiB | 0.586 | Theorie |
| RTX PRO 5000 / 47.8 GiB | ≤ 0.772 | Profil |
| RTX 6000Ada / 48 GiB | ≤ 0.828 | Profil |

Das bestehende Hardwareprofil bleibt einschließlich teurerer Karten erhalten: `NVIDIA RTX 6000 Ada Generation`, `NVIDIA L40`, `NVIDIA L40S`, `NVIDIA RTX PRO 5000 Blackwell`, `NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb`, `NVIDIA RTX PRO 6000 Blackwell Workstation Edition`.

### ears: mindestens 42 GiB nach aktuellem Modellbudget

Modelle: `moss-music-8b-instruct`, `clap-music`, `beat-this`, `songformer`, `dsp-analysis`, `basic-pitch`.

| Karte / gemeldeter VRAM | Belegte Quote EUR/h | Einordnung |
|---|---:|---|
| CMP 170HX / 64 GiB | 0.294 | CMP: Benchmark und Hostprüfung erforderlich |
| RTX 4090 / 48 GiB | 0.440 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX A6000 / 48 GiB | ≤ 0.511 | Profil |
| L40 / 45 GiB | ≤ 0.585 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX 4090 / 48 GiB | 0.586 | Theorie |
| L40S / 45 GiB | ≤ 0.712 | Profil |
| RTX PRO 5000 / 47.8 GiB | ≤ 0.772 | Profil |
| RTX 6000Ada / 48 GiB | ≤ 0.828 | Profil |
| A40 / 45 GiB | ≤ 0.828 | Profil |
| A40 / 48 GiB | ≤ 0.865 | Profil |

Das bestehende Hardwareprofil bleibt einschließlich teurerer Karten erhalten: `NVIDIA RTX 6000 Ada Generation`, `NVIDIA A100 80GB PCIe`, `NVIDIA A100-SXM4-80GB`, `NVIDIA A40`, `NVIDIA L40`, `NVIDIA L40S`, `NVIDIA RTX A6000`, `NVIDIA RTX PRO 5000 Blackwell`, `NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb`, `NVIDIA RTX PRO 6000 Blackwell Workstation Edition`.

### voice: mindestens 45 GiB nach aktuellem Modellbudget

Modelle: `qwen3-tts-17b`, `qwen3-tts-voicedesign`, `moss-soundeffect-v2.0`, `acestep-v15-xl-base`, `acestep-v15-shared`.

| Karte / gemeldeter VRAM | Belegte Quote EUR/h | Einordnung |
|---|---:|---|
| CMP 170HX / 64 GiB | 0.294 | CMP: Benchmark und Hostprüfung erforderlich |
| RTX 4090 / 48 GiB | 0.440 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX A6000 / 48 GiB | ≤ 0.511 | Profil |
| RTX 4090 / 48 GiB | 0.586 | Theorie |
| RTX PRO 5000 / 47.8 GiB | ≤ 0.772 | Profil |
| RTX 6000Ada / 48 GiB | ≤ 0.828 | Profil |
| A40 / 48 GiB | ≤ 0.865 | Profil |

Das bestehende Hardwareprofil bleibt einschließlich teurerer Karten erhalten: `NVIDIA A40`, `NVIDIA A100 80GB PCIe`, `NVIDIA A100-SXM4-80GB`, `NVIDIA L40`, `NVIDIA L40S`, `NVIDIA RTX 6000 Ada Generation`, `NVIDIA RTX A6000`, `NVIDIA RTX PRO 5000 Blackwell`, `NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb`, `NVIDIA RTX PRO 6000 Blackwell Workstation Edition`.

### music: mindestens 33 GiB nach aktuellem Modellbudget

Modelle: `acestep-v15-xl-turbo`, `acestep-5hz-lm-4b`, `acestep-v15-shared`.

| Karte / gemeldeter VRAM | Belegte Quote EUR/h | Einordnung |
|---|---:|---|
| CMP 170HX / 40 GiB | 0.265 | CMP: Benchmark und Hostprüfung erforderlich |
| CMP 170HX / 64 GiB | 0.294 | CMP: Benchmark und Hostprüfung erforderlich |
| RTX 4090 / 48 GiB | 0.440 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX A6000 / 48 GiB | ≤ 0.511 | Profil |
| L40 / 45 GiB | ≤ 0.585 | Profil |
| RTX 4090 / 48 GiB | 0.586 | Theorie |
| L40S / 45 GiB | ≤ 0.712 | Profil |
| A100 SXM4 / 39 GiB | ≤ 0.719 | Profil |
| A100 SXM4 / 40 GiB | ≤ 0.745 | Profil |
| RTX PRO 5000 / 47.8 GiB | ≤ 0.772 | Profil |
| RTX 6000Ada / 48 GiB | ≤ 0.828 | Profil |
| A40 / 45 GiB | ≤ 0.828 | Profil |
| A40 / 48 GiB | ≤ 0.865 | Profil |
| A100 PCIE / 40 GiB | ≤ 0.899 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |

Das bestehende Hardwareprofil bleibt einschließlich teurerer Karten erhalten: `NVIDIA RTX 6000 Ada Generation`, `NVIDIA A100 80GB PCIe`, `NVIDIA A100-SXM4-40GB`, `NVIDIA A100-SXM4-80GB`, `NVIDIA A40`, `NVIDIA L40`, `NVIDIA L40S`, `NVIDIA RTX A6000`, `NVIDIA RTX PRO 5000 Blackwell`, `NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb`, `NVIDIA RTX PRO 6000 Blackwell Workstation Edition`.

### studio: mindestens 69 GiB nach aktuellem Modellbudget

Modelle: `sonicmaster`, `bs-roformer-sw-6stem`, `mvsep-mega-53`, `mel-roformer-bve`.

| Karte / gemeldeter VRAM | Belegte Quote EUR/h | Einordnung |
|---|---:|---|
| Keine unter dieser Schwelle belegt | – | Teurere passende Karten bleiben im Gesamtbudget zulässig |

Das bestehende Hardwareprofil bleibt einschließlich teurerer Karten erhalten: `NVIDIA RTX PRO 6000 Blackwell Server Edition`, `NVIDIA A100 80GB PCIe`, `NVIDIA A100-SXM4-80GB`, `NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition`, `NVIDIA RTX PRO 6000 Blackwell Workstation Edition`.

### audio-brain: mindestens 19 GiB nach aktuellem Modellbudget

Modelle: `qwen3-4b`.

| Karte / gemeldeter VRAM | Belegte Quote EUR/h | Einordnung |
|---|---:|---|
| Tesla V100 / 32 GiB | 0.075 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX 2080 Ti / 22 GiB | 0.078 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX 3080 / 20 GiB | 0.097 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX 3090 / 24 GiB | 0.104 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| L4 / 22.5 GiB | 0.114 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX 3080 / 20 GiB | 0.134 | Theorie |
| RTX 3090 / 24 GiB | 0.134 | Profil |
| RTX 4090 / 24 GiB | 0.148 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX A4500 / 20 GiB | 0.148 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX A5000 / 24 GiB | 0.178 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX A5000 / 24 GiB | 0.178 | Profil |
| RTX 4000Ada / 20 GiB | 0.192 | Theorie |
| Titan RTX / 24 GiB | 0.221 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX A5000 / 22.5 GiB | ≤ 0.229 | Profil |
| CMP 170HX / 40 GiB | 0.265 | CMP: Benchmark und Hostprüfung erforderlich |
| RTX 3090 Ti / 24 GiB | ≤ 0.280 | Profil |
| CMP 170HX / 64 GiB | 0.294 | CMP: Benchmark und Hostprüfung erforderlich |
| RTX 4090 / 24 GiB | 0.329 | Profil |
| RTX 4090 / 48 GiB | 0.440 | Profil |
| RTX A6000 / 48 GiB | ≤ 0.511 | Profil |
| L40 / 45 GiB | ≤ 0.585 | Profil |
| L40S / 45 GiB | ≤ 0.712 | Profil |
| A100 SXM4 / 39 GiB | ≤ 0.719 | Profil |
| L4 / 22.5 GiB | 0.732 | Profil |
| A100 SXM4 / 40 GiB | ≤ 0.745 | Profil |
| RTX PRO 5000 / 47.8 GiB | ≤ 0.772 | Profil |
| RTX 5090 / 31.8 GiB | ≤ 0.811 | Profil |
| RTX 6000Ada / 48 GiB | ≤ 0.828 | Profil |
| A40 / 45 GiB | ≤ 0.828 | Profil |
| A40 / 48 GiB | ≤ 0.865 | Profil |
| A100 PCIE / 40 GiB | ≤ 0.899 | Profil |

Das bestehende Hardwareprofil bleibt einschließlich teurerer Karten erhalten: `NVIDIA GeForce RTX 5090`, `NVIDIA A100 80GB PCIe`, `NVIDIA A100-SXM4-40GB`, `NVIDIA A100-SXM4-80GB`, `NVIDIA A40`, `NVIDIA GeForce RTX 3090`, `NVIDIA GeForce RTX 3090 Ti`, `NVIDIA GeForce RTX 4090`, `NVIDIA L4`, `NVIDIA L40`, `NVIDIA L40S`, `NVIDIA RTX 5000 Ada Generation`, `NVIDIA RTX 6000 Ada Generation`, `NVIDIA RTX A5000`, `NVIDIA RTX A6000`, `NVIDIA RTX PRO 4000 Blackwell`, `NVIDIA RTX PRO 4500 Blackwell`, `NVIDIA RTX PRO 4500 Blackwell Server Edition`, `NVIDIA RTX PRO 5000 Blackwell`, `NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb`, `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb`, `NVIDIA RTX PRO 6000 Blackwell Workstation Edition`.

### song: mindestens 23 GiB nach aktuellem Modellbudget

Modelle: `yue2-3b`.

| Karte / gemeldeter VRAM | Belegte Quote EUR/h | Einordnung |
|---|---:|---|
| Tesla V100 / 32 GiB | 0.075 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX 3090 / 24 GiB | 0.104 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX 3090 / 24 GiB | 0.134 | Profil |
| RTX 4090 / 24 GiB | 0.148 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX A5000 / 24 GiB | 0.178 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX A5000 / 24 GiB | 0.178 | Profil |
| Titan RTX / 24 GiB | 0.221 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| CMP 170HX / 40 GiB | 0.265 | CMP: Benchmark und Hostprüfung erforderlich |
| RTX 3090 Ti / 24 GiB | ≤ 0.280 | Profil |
| CMP 170HX / 64 GiB | 0.294 | CMP: Benchmark und Hostprüfung erforderlich |
| RTX 4090 / 24 GiB | 0.329 | Profil |
| RTX 4090 / 48 GiB | 0.440 | Profil |
| RTX A6000 / 48 GiB | ≤ 0.511 | Profil |
| L40 / 45 GiB | ≤ 0.585 | Profil |
| L40S / 45 GiB | ≤ 0.712 | Profil |
| A100 SXM4 / 39 GiB | ≤ 0.719 | Profil |
| A100 SXM4 / 40 GiB | ≤ 0.745 | Profil |
| RTX PRO 5000 / 47.8 GiB | ≤ 0.772 | Profil |
| RTX 5090 / 31.8 GiB | ≤ 0.811 | Profil |
| RTX 6000Ada / 48 GiB | ≤ 0.828 | Profil |
| A40 / 45 GiB | ≤ 0.828 | Profil |
| A40 / 48 GiB | ≤ 0.865 | Profil |
| A100 PCIE / 40 GiB | ≤ 0.899 | Profil |

Das bestehende Hardwareprofil bleibt einschließlich teurerer Karten erhalten: `NVIDIA GeForce RTX 5090`, `NVIDIA A100 80GB PCIe`, `NVIDIA A100-SXM4-40GB`, `NVIDIA A100-SXM4-80GB`, `NVIDIA A40`, `NVIDIA GeForce RTX 3090`, `NVIDIA GeForce RTX 3090 Ti`, `NVIDIA GeForce RTX 4090`, `NVIDIA L4`, `NVIDIA L40`, `NVIDIA L40S`, `NVIDIA RTX 5000 Ada Generation`, `NVIDIA RTX 6000 Ada Generation`, `NVIDIA RTX A5000`, `NVIDIA RTX A6000`, `NVIDIA RTX PRO 4000 Blackwell`, `NVIDIA RTX PRO 4500 Blackwell`, `NVIDIA RTX PRO 4500 Blackwell Server Edition`, `NVIDIA RTX PRO 5000 Blackwell`, `NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb`, `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb`, `NVIDIA RTX PRO 6000 Blackwell Workstation Edition`.

### vis: mindestens 27 GiB nach aktuellem Modellbudget

Modelle: `universr`, `mel-roformer-dereverb`.

| Karte / gemeldeter VRAM | Belegte Quote EUR/h | Einordnung |
|---|---:|---|
| Tesla V100 / 32 GiB | 0.075 | GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich |
| RTX 4090 / 48 GiB | 0.440 | Theorie |
| RTX A6000 / 48 GiB | ≤ 0.511 | Profil |
| L40 / 45 GiB | ≤ 0.585 | Profil |
| L40S / 45 GiB | ≤ 0.712 | Profil |
| RTX 6000Ada / 48 GiB | ≤ 0.828 | Profil |
| A40 / 45 GiB | ≤ 0.828 | Profil |
| A40 / 48 GiB | ≤ 0.865 | Profil |

Das bestehende Hardwareprofil bleibt einschließlich teurerer Karten erhalten: `NVIDIA A40`, `NVIDIA GeForce RTX 5090`, `NVIDIA L40`, `NVIDIA L40S`, `NVIDIA RTX 5000 Ada Generation`, `NVIDIA RTX 6000 Ada Generation`, `NVIDIA RTX A6000`, `NVIDIA RTX PRO 4500 Blackwell`, `NVIDIA RTX PRO 4500 Blackwell Server Edition`, `NVIDIA RTX PRO 5000 Blackwell`, `NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition`, `NVIDIA RTX PRO 6000 Blackwell Workstation Edition`.

## Sämtliche belegten Unter-1-EUR-Varianten

| GPU | Gemeldeter VRAM GiB | Quote EUR/h | Preisgrundlage |
|---|---:|---:|---|
| A100 PCIE | 40 | ≤ 0.899 | inkl. beobachteter Rollen-Disk |
| A100 SXM4 | 39 | ≤ 0.719 | inkl. beobachteter Rollen-Disk |
| A100 SXM4 | 40 | ≤ 0.745 | inkl. beobachteter Rollen-Disk |
| A16 | 15 | 0.147 | GPU-Angebot; Disk/Traffic zusätzlich |
| A40 | 45 | ≤ 0.828 | inkl. beobachteter Rollen-Disk |
| A40 | 48 | ≤ 0.865 | inkl. beobachteter Rollen-Disk |
| CMP 170HX | 40 | 0.265 | GPU-Angebot; Disk/Traffic zusätzlich |
| CMP 170HX | 64 | 0.294 | GPU-Angebot; Disk/Traffic zusätzlich |
| GTX 1060 | 6 | 0.074 | GPU-Angebot; Disk/Traffic zusätzlich |
| GTX 1070 | 8 | 0.039 | GPU-Angebot; Disk/Traffic zusätzlich |
| GTX 1070 Ti | 8 | 0.058 | GPU-Angebot; Disk/Traffic zusätzlich |
| GTX 1080 | 8 | 0.061 | GPU-Angebot; Disk/Traffic zusätzlich |
| GTX 1080 Ti | 11 | 0.061 | GPU-Angebot; Disk/Traffic zusätzlich |
| GTX 1650 | 4 | 0.054 | GPU-Angebot; Disk/Traffic zusätzlich |
| GTX 1660 | 6 | 0.054 | GPU-Angebot; Disk/Traffic zusätzlich |
| GTX 1660 S | 6 | 0.058 | GPU-Angebot; Disk/Traffic zusätzlich |
| GTX 1660 Ti | 6 | 0.047 | GPU-Angebot; Disk/Traffic zusätzlich |
| GTX TITAN X | 12 | 0.046 | GPU-Angebot; Disk/Traffic zusätzlich |
| L4 | 22.5 | 0.114 | GPU-Angebot; Disk/Traffic zusätzlich |
| L40 | 45 | ≤ 0.585 | inkl. beobachteter Rollen-Disk |
| L40S | 45 | ≤ 0.712 | inkl. beobachteter Rollen-Disk |
| Q RTX 4000 | 8 | 0.148 | GPU-Angebot; Disk/Traffic zusätzlich |
| Q RTX 5000 | 16 | 0.089 | GPU-Angebot; Disk/Traffic zusätzlich |
| Quadro P4000 | 8 | 0.062 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 2000Ada | 16 | 0.134 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 2060 | 12 | 0.075 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 2060S | 8 | 0.073 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 2070 | 8 | 0.068 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 2070S | 8 | 0.075 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 2080 | 8 | 0.105 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 2080 Ti | 11 | 0.075 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 2080 Ti | 22 | 0.075 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3050 | 6 | 0.075 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3050 | 8 | 0.194 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3060 | 12 | 0.054 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3060 Ti | 8 | 0.031 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3060 laptop | 6 | 0.090 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3060 laptop | 12 | 0.081 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3070 | 8 | 0.089 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3070 Ti | 8 | 0.090 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3070 laptop | 8 | 0.098 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3080 | 10 | 0.118 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3080 | 20 | 0.097 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3080 Ti | 12 | 0.090 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3090 | 24 | 0.104 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 3090 Ti | 24 | ≤ 0.280 | inkl. beobachteter Rollen-Disk |
| RTX 4000Ada | 20 | 0.192 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4060 | 8 | 0.061 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4060 Ti | 8 | 0.135 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4060 Ti | 16 | 0.090 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4060 laptop | 8 | 0.112 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4070 | 12 | 0.119 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4070 Ti | 12 | 0.155 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4070 laptop | 8 | 0.164 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4070S | 12 | 0.105 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4070S Ti | 16 | 0.075 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4080 | 16 | 0.192 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4090 | 24 | 0.148 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 4090 | 48 | 0.440 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 5060 | 8 | 0.100 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 5060 Ti | 8 | 0.121 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 5060 Ti | 15.9 | 0.106 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 5070 | 11.9 | 0.133 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 5070 Ti | 15.9 | 0.170 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 5080 | 15.9 | 0.207 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX 5090 | 31.8 | ≤ 0.811 | inkl. beobachteter Rollen-Disk |
| RTX 6000Ada | 48 | ≤ 0.828 | inkl. beobachteter Rollen-Disk |
| RTX A2000 | 6 | 0.040 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX A2000 | 11.2 | 0.266 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX A2000 | 12 | 0.057 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX A3000 laptop | 12 | 0.075 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX A4000 | 15 | 0.101 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX A4000 | 16 | 0.080 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX A4500 | 20 | 0.148 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX A5000 | 22.5 | ≤ 0.229 | inkl. beobachteter Rollen-Disk |
| RTX A5000 | 24 | 0.178 | GPU-Angebot; Disk/Traffic zusätzlich |
| RTX A6000 | 48 | ≤ 0.511 | inkl. beobachteter Rollen-Disk |
| RTX PRO 5000 | 47.8 | ≤ 0.772 | inkl. beobachteter Rollen-Disk |
| Tesla P100 | 16 | 0.049 | GPU-Angebot; Disk/Traffic zusätzlich |
| Tesla P40 | 22.5 | 0.105 | GPU-Angebot; Disk/Traffic zusätzlich |
| Tesla P40 | 24 | 0.118 | GPU-Angebot; Disk/Traffic zusätzlich |
| Tesla T4 | 15 | 0.130 | GPU-Angebot; Disk/Traffic zusätzlich |
| Tesla T4 | 16 | 0.294 | GPU-Angebot; Disk/Traffic zusätzlich |
| Tesla V100 | 16 | 0.089 | GPU-Angebot; Disk/Traffic zusätzlich |
| Tesla V100 | 32 | 0.075 | GPU-Angebot; Disk/Traffic zusätzlich |
| Titan RTX | 24 | 0.148 | GPU-Angebot; Disk/Traffic zusätzlich |
| Titan V | 12 | 0.148 | GPU-Angebot; Disk/Traffic zusätzlich |
| Titan Xp | 12 | 0.046 | GPU-Angebot; Disk/Traffic zusätzlich |

## Ohne bestätigten Unter-1-EUR-Beleg

Diese Typen sind nicht pauschal ungeeignet. Hier fehlt ein aktueller passender Preisbeleg unter der Schwelle oder es gibt in den abgerufenen Angeboten keinen solchen Preis. Sie werden nicht als bestätigt günstig eingesetzt.

`A10`, `A100X`, `A800 PCIE`, `B200`, `B300`, `GB10`, `GB200`, `GB300`, `GTX 1050 Ti`, `GTX 1650 S`, `H100 NVL`, `H100 PCIE`, `H100 SXM`, `H200`, `H200 NVL`, `Q RTX 6000`, `Q RTX 8000`, `Quadro GV100`, `Quadro K2200`, `RTX 4080 laptop`, `RTX 4080S`, `RTX 4090D`, `RTX 4500Ada`, `RTX 5000Ada`, `RTX 5090D`, `RTX 5880Ada`, `RTX 6000D`, `RTX PRO 4000`, `RTX PRO 4000 SFF`, `RTX PRO 4500`, `RTX PRO 6000 Max-Q`, `RTX PRO 6000 S`, `RTX PRO 6000 WS`, `T4G`, `Tesla P4`, `Tesla V100S`

## Besonders wichtig für die Auswahl

- CMP 170HX mit 40/64 GB: theoretisch für speicherpassende Audio-/Generierungsrollen interessant; unverändertes FP8-Brain und komplette Vis-Grafikrolle sind damit nicht freigegeben. 64 GB reichen außerdem nicht für das aktuelle 69-GiB-Studio-Budget.
- Modifizierte RTX 4090 mit 48 GB: als eigene gemeldete Variante dokumentieren; Stabilität und das konkrete Modell müssen separat bestätigt werden.
- Für Studio dürfen 80-/96-GB-Karten über 1 EUR/h verwendet werden, solange die gesamte Acht-Rollen-Zuordnung unter 8 EUR/h bleibt.
- Speicher verschiedener GPUs wird in der aktuellen Konfiguration nicht einfach addiert. Zwei 24-GB-Karten ersetzen keine einzelne erforderliche 48-/80-/96-GB-Zuweisung.

Maschinenlesbare Zuordnung: `deploy/vast/gpu-alternatives-under-1eur.json`, insbesondere `byRole`. Neu erzeugen: `python scripts/vast-gpu-report.py`.
Nach Quotenreset vollständige Preise aktualisieren: `python scripts/vast-gpu-alternatives.py --refresh --output deploy/vast/gpu-alternatives-under-1eur.json`. Der Scanner ist ausschließlich lesend und berücksichtigt das Providerlimit.
