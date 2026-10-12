# KONZEPT_HERKUNFT: Herkunft von Konzepten und Code

Zweck: nachweisen, dass audioMONASTRY (proprietaer) **keinen AGPL-Code** von openDAW, ACE-Step DAW oder Strudel uebernimmt.
Regel: Konzepte (Ideen, Funktionsumfang) duerfen uebernommen werden, **Code, Texte und Assets nicht**. Eigene Umsetzung, eigene Namen.

| Konzept | Vorbild | Unsere Umsetzung | Code uebernommen? |
|---|---|---|---|
| Kontext-Layering (LEGO) | ACE-Step DAW | `music.lego/extract/complete` ueber eigene MCP-Schicht (LEGO-P1-001) | nein |
| Repaint-Modi | ACE-Step DAW | Parameter von `music.repaint` | nein |
| ACE-Step-1.5-Aufrufvertrag (`task_type`, `instruction`-Wortlaut, Spurnamen) | ACE-Step 1.5 Doku (docs/en/INFERENCE.md, gelesen 2026-10-12) | nur als Schnittstelle angesprochen: `musicContextTools.ts`, `comfyui_adapter.build_acestep_task_params`; Repaint-Modi sind eigene Abbildung auf `audio_cover_strength` | nein |
| Oversampling gegen Aliasing | allgemeine DSP-Praxis (Halbband-FIR) | eigene Implementierung (DSP-P1-OVS-001) | nein |
| Projekt-Bundle | openDAW `.odb` | eigenes Format, Export als Nutzerdatei (ZUK-002) | nein |
| Piano Roll, Timeline | ACE-Step DAW / openDAW | geplant, eigene Umsetzung (ZUK-001) | nein |
| Plugin-Hosting | WebCLAP / WAM | nur Bewertung (ZUK-008) | nein |

Pflicht bei jeder Uebernahme eines Konzepts: Zeile hier ergaenzen, Lizenz der Quelle nennen, bestaetigen dass kein fremder Code kopiert wurde.
