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

## Lücke (Stand vor 2026-11-17, Abend)
Auf dem vis-Pod lief kein Renderer: keine Audio-Eingabe, kein Medienzugriff, keine Szenensteuerung, kein
dauerhafter Videostrom. `podRouting` ordnet `imageHq`/`videoReal` keinem Pod zu. Die Modelle `universr` und
`mel-roformer-dereverb` in `deploy/gpu/pod-fleet.json` sind Audio-Restaurierung und passen nicht zur Rolle.

## Umgesetzt (2026-11-17, nicht auf GPU gemessen)
Vorgabe des Betreibers: 1080p bis 1440p ("1-2K"), 24/25/30 fps, Effekte nach Sinn und Funktion.

**Befund:** Der vorhandene Szenen-Shader (`webglRenderer.ts`) legt Bild/Clip mit `sceneAmount = 1` unverändert
über das Feld; die Audio-Parameter wirken nur auf das verdeckte Feld. Bilder und Clips liefen also ohne Effekte
(Browser-Overlay wie Pod). Der Shader bleibt unverändert.

**Neu:**
- `src/core/visual/mediaFx.ts`: Effektstufe auf dem Medium selbst, gesteuert über die bestehende
  `mapAudioToParams`: Kick-Zoom und Ken-Burns, Drehung, Wellen-Verzerrung, Farbton-Drift, Helligkeit/Kontrast,
  Glow, Chroma-Split und Glitch-Streifen auf Onsets, Kaleidoskop bei Presets mit Symmetrie, Überblendung
  zweier Medien mit denselben Effekten.
- `src/core/visual/podScene.ts` → `services/audiomonastry-ai-runtime/visual/scene.js` (`npm run build:vis-scene`,
  eingecheckt, weil der Docker-Kontext kein `src/` enthält; `tests/visPodScene.test.ts` schlägt bei veraltetem Bundle an).
  Show-Uhr ist `Frame-Index / fps`; Szenenwechsel nach Dauer, Beat oder Energie wie im Overlay.
- `visual_renderer.py`: Sitzung = headless Chromium + ffmpeg. Auflösung `1080p` oder `1440p`, fps 24/25/30,
  JPEG-Frames → H.264 (`h264_nvenc`, Rückfall `libx264`), MPEG-TS, 1-s-GOP, keine B-Frames, kein Eingangs-Probing
  (erstes Byte nach ca. 0,14 s gemessen). Medien lädt der Pod selbst (nur https, keine privaten Adressen,
  max. 1 GiB) und liefert sie unter demselben Ursprung aus: keine CORS-Header am Speicher nötig.
- `vast_app.py` (nur `AI_ROLE=vis`, Bearer-Auth erbt die App): `POST /visual/session`, `POST /visual/features`,
  `GET /visual/status`, `GET /visual/stream` (video/mp2t), `DELETE /visual/session`.
- `deploy/gpu/pod-fleet.json`: vis bekommt `NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics`;
  `Dockerfile.vast` installiert für das Render-Image `libvulkan1` und `libegl1`.

**Getestet (lokal, echtes Chromium + ffmpeg):** Konfigurationsregeln, ffmpeg-Argumente, Medienfilter, Wirkung von
Stille gegen Beat auf das Bild, Szenenwechsel auf Beat, gültiger H.264-Strom in der geforderten Größe und
Bildrate, HTTP-Ablauf über eine schlanke FastAPI-Stand-in-App. Diese Tests werden ohne Playwright übersprungen.

## Hauptrisiko: GPU-WebGL im Container
Gemessen hier mit Software-WebGL (SwiftShader, 4 CPU-Kerne): **1080p 5,7 fps, 1440p 3,2 fps**. Das ist eine untere
Grenze, aber 24–30 fps gibt es nur, wenn Chromium auf dem Pod die Grafikkarte nutzt. Das Image ist ein
PyTorch-CUDA-Image ohne Grafikfähigkeit; ob die Vast-Laufzeit `graphics` einbindet, ist ungeprüft. Prüfung im
ersten echten Lauf: `GET /visual/status` → `renderer` (nicht "SwiftShader") und `softwareRenderer: false`,
`achievedFps`, `lateFrames`. Hilft die Umgebungsvariable nicht, kann man Chromium-Flags über
`AI_VIS_CHROMIUM_ARGS` testen (z. B. `--use-angle=gl-egl`, `--use-angle=vulkan`). Bleibt es bei Software:
Auflösung senken oder die Effekte auf einen anderen Weg (CUDA/ffmpeg) verlegen.

## Noch offen
1. Der Strom ist H.264/MPEG-TS am Pod. Die Übernahme in `/visual-out` (SFU-Eingang oder MJPEG-Fallback) und
   die Steuerung aus der App (Session starten, Features senden, Medien aus der Library wählen) sind nicht gebaut.
2. Audio-Features kommen als JSON-Updates; der Sender im Main-Mix und seine Rate (30–60 Hz) sind nicht gebaut.
   Browser und Pod nutzen dieselbe Merkmals-Abbildung (`featureBus.ts`).
3. Frames gehen als JPEG von Chromium zu ffmpeg (Qualität 0,88). Bei GPU-Betrieb ist ein In-Page-Encoder
   (WebCodecs) eine mögliche Optimierung, aber ungemessen.
4. `universr` und `mel-roformer-dereverb` aus vis entfernen (Ziel studio, rechnerisch passend). Ändert Inventar,
   Images und Attestierung und braucht eine eigene Freigabe.
5. Image-Neubau und Neu-Attestierung (neue Dateien im Image-Kontext); der letzte Lauf scheiterte am ghcr-Login.
6. GPU-Wahl für vis (A40 usw.) für Rendern und NVENC neu bewerten; Effektliste mit dem Betreiber abstimmen.
