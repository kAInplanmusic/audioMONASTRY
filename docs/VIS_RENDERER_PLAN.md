# vis – Live-Visual-Renderer (Rollendefinition und Lücke, 2026-11-17)

**Zweck der Instanz `vis` (Betreiber):** aus vorhandenen Bildern, Videos und Effekten ein zur Musik passendes
Live-Video erzeugen. Eingänge: der Live-Main-Sound, die Medien der Library und alle brauchbaren Live-Visual-Werkzeuge.
Ausgang: ein Videostrom für `/visual-out`. **Nicht Zweck der Rolle:** Audio-Restaurierung.

## Was im Repo schon da ist (geprüft)
- Browser-Renderer mit Audio-Reaktion: `src/core/visual/` (`canvasRenderer.ts`, `webglRenderer.ts`,
  `webgpuRenderer.ts`, `audioReactive.ts`, `featureBus.ts`, `visualPresets.ts`) und
  `showOrchestrator.ts` (Szenen aus Bildern und Clips). UI: `src/components/visual/VisualMonkOverlay.tsx`.
- Ausgabe: `/visual-out` (genau ein Gerät, WebRTC/SFU), MJPEG-Fallback `server/visualStream.ts`
  (Frames per `POST /api/visual/frame`, JPEG/WebP, max. 512 KB, Standard 12 fps).
- Pod-Seite: Image mit Playwright/Chromium und ffmpeg (`AI_INSTALL_RENDER`, keine Modellgewichte);
  `render_probe.py` beweist nur Chromium → PNG → `h264_nvenc` (640×360, 24 Frames). `vast_app.py` bietet für
  `AI_ROLE=vis` nur `/diagnostics/render`.

## Lücke
Auf dem vis-Pod läuft kein Renderer: keine Audio-Eingabe, kein Medienzugriff, keine Szenensteuerung, kein
dauerhafter Videostrom. `podRouting` ordnet `imageHq`/`videoReal` keinem Pod zu. Die Modelle `universr` und
`mel-roformer-dereverb` in `deploy/gpu/pod-fleet.json` sind Audio-Restaurierung und passen nicht zur Rolle.

## Vorschlag (nicht umgesetzt, nicht auf GPU geprüft)
1. Die vorhandenen Renderer (WebGL/Show-Orchestrator) als Bundle in headless Chromium auf dem Pod laufen lassen,
   damit Browser- und Pod-Look identisch bleiben.
2. Audio-Features (Pegel, Spektrum, Beat) kommen als kleiner Datenstrom aus dem Main-Mix, nicht als Roh-Audio;
   das hält die Latenz niedrig und lässt Main-Out unberührt.
3. Medien aus der Library per kurzlebiger URL laden und vor Beginn auf den Pod vorladen.
4. Frames per `h264_nvenc` kodieren und als Strom an `/visual-out` liefern (MJPEG-Hub als Fallback).
5. Zusätzliche Effektwerkzeuge erst nach Messung wählen (Shader-Effekte, ffmpeg-Filter für Übergänge, ggf.
   kleine Modelle zur Medienauswahl nach Klangähnlichkeit, z. B. über `clap-music` aus ears).
6. `universr` und `mel-roformer-dereverb` aus vis entfernen. Ziel wäre studio (VRAM reicht rechnerisch:
   69 GB + ca. 7 GB < 80 GB der kleinsten Studio-Karte). Das ändert Inventar, Images und Attestierung und
   braucht eine eigene Freigabe.

Offen für den Betreiber: Videostrom-Format zum Beamer (WebRTC oder MJPEG), Ziel-Auflösung und -FPS, gewünschte
Effektliste. Die GPU-Wahl für vis (A40 usw.) ist bisher für die Audio-Modelle gewählt und muss für Rendern
und NVENC neu bewertet werden.
