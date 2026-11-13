# VisualMONK – Live-Renderer für vorhandene Medien

Betreiberentscheidung 2026-11-13: genau ein aktueller Visuals-Live-Renderer nutzt vorhandene Medien. FLUX/Wan, generative Bild-/Video-Aufträge, LoRA-Training und Bildvorrats-Pipeline sind entfernt; es ist kein Ersatz geplant. Die frühere Spezifikation vom 2026-09-11 ist unverändert als historischer Quellbeleg `CLAUDE-RETIRED-HISTORY-VISUALMONK-SPEC` in EVIDENCE_REGISTRY.json erhalten und keine aktuelle Betriebsfreigabe.

- Die bestehende Visuals-Oberfläche und der bestehende Medien-/Rendererpfad bleiben erhalten (`src/components/visual/VisualMonkOverlay.tsx`).
- `/visual-out` ist der separate visuelle Ausgang. Die serverseitige Exklusivität und Trennung von Main-Audio gelten weiter; Quellen-/Empfangskette und Belege stehen in `docs/verification/A4_MAIN_OUT_TRACE.md`.
- Der Mixer-Halter steuert den bestehenden Visuals-Schalter. Es werden keine neuen Generatoren, Trainingsjobs, GPU-Rollen oder Vision-Tickets eingeführt.
- Die früheren Trainings-/Selbstlern-Pläne sind historisch; aktuelle Ausmusterung und erhaltene Medienkuration/Dataset-Werkzeuge: `docs/audit/P0_RETIRED_VISUAL_TRAINING.md`.

Dieser Abgleich ändert die aktive Renderer-Implementierung nicht und behauptet keinen neuen Live-/GPU-Nachweis.
