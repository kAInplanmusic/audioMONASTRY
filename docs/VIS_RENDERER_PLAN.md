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
- `services/audiomonastry-ai-runtime/visual-src/podScene.ts` → `services/audiomonastry-ai-runtime/visual/scene.js` (`npm run build:vis-scene`,
  eingecheckt, weil der Docker-Kontext kein `src/` enthält; `tests/visPodScene.test.ts` schlägt bei veraltetem Bundle an).
  Show-Uhr ist `Frame-Index / fps`; Szenenwechsel nach Dauer, Beat oder Energie wie im Overlay.
- `visual_renderer.py`: Sitzung = headless Chromium + ffmpeg. Auflösung `1080p` oder `1440p`, fps 24/25/30,
  JPEG-Frames → H.264 (`h264_nvenc`, Rückfall `libx264`), MPEG-TS, 1-s-GOP, keine B-Frames, kein Eingangs-Probing
  (erstes Byte nach ca. 0,14 s gemessen). Medien lädt der Pod selbst (nur https, keine privaten Adressen,
  max. 1 GiB) und liefert sie unter demselben Ursprung aus: keine CORS-Header am Speicher nötig.
- `vast_app.py` (nur `AI_ROLE=vis`, Bearer-Auth erbt die App): `POST /visual/session`, `POST /visual/features`,
  `POST /visual/effects`, `GET /visual/status`, `GET /visual/stream` (video/mp2t), `DELETE /visual/session`.
- `deploy/gpu/pod-fleet.json`: vis bekommt `NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics`;
  `Dockerfile.vast` installiert für das Render-Image `libvulkan1` und `libegl1`.

**Getestet (lokal, echtes Chromium + ffmpeg):** Konfigurationsregeln, ffmpeg-Argumente, Medienfilter, Wirkung von
Stille gegen Beat auf das Bild, Szenenwechsel auf Beat, gültiger H.264-Strom in der geforderten Größe und
Bildrate, HTTP-Ablauf über eine schlanke FastAPI-Stand-in-App. Diese Tests werden ohne Playwright übersprungen.

## 25 Effekte (2026-11-17, Abend)
Alle 25 Effekte der Betreiberliste sind als Shader-Module umgesetzt (`src/core/visual/effects/`), mit Regisseur
(`auto`: je Szene höchstens 3, nie zwei aus Mosaik/Stilisierung), fester Liste oder `off`; live umschaltbar über
`POST /visual/effects`. Details, Gruppen und Einschränkungen: `docs/VIS_APPS_REVIEW.md`.
Test: jeder Effekt ändert das Bild messbar gegenüber dem Lauf ohne Effekte (Python, echtes Chromium); der Kontaktbogen
wurde angesehen. Nicht auf GPU gemessen; Pixel Sorting ist der teuerste Effekt.

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
4. ~~`universr` und `mel-roformer-dereverb` aus vis entfernen~~ ERLEDIGT 2026-11-17: nach studio umgezogen (Manifest,
   Flottenliste, Routing, Build-Plan, Bestandsliste); vis ist eine Renderer-Rolle ohne Modelle.
5. Image-Neubau und Neu-Attestierung (neue Dateien im Image-Kontext); der letzte Lauf scheiterte am ghcr-Login.
6. GPU für vis: RTX 4090 erste Wahl (Betreiber 2026-11-17), A40/L40 Standard-Alternativen; auf echter GPU noch ungemessen; Effektliste mit dem Betreiber abstimmen.

## GPU-Test (Versuch 2026-11-17, Abend): nicht durchgeführt
Ziel: eine RTX 5090/4090 mieten, den fertigen vis laden und messen (Chromium-WebGL auf der GPU, NVENC, ms je
Effekt in 1080p, 24/25/30 fps in 1080p/1440p). Das Testskript ist fertig und lokal erprobt: `scripts/vis-gpu-selftest.py`
(läuft auf der Maschine; Medien entstehen dort per ffmpeg; Bericht als `results.json`).

Was verhindert hat, dass es Messwerte gibt:
1. **R2:** Die R2-Schlüssel dieser Umgebung (`CLOUDFLARE_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`) werden von allen R2-Endpunkten mit
   401 abgelehnt; der Cloudflare-API-Token ebenfalls. Die Medien in R2 sind von hier nicht lesbar.
2. **Vast-Suchquote:** Das Konto hat sein Tagesbudget von 20.000 Suchzeilen verbraucht (Rücksetzung in ca. 5 h, gemessen
   2026-11-17 Abend); ohne Suche gibt es keine aktuellen Angebote. Die IDs aus `gpu-alternatives-under-1eur.json` (12.11.) waren
   bis auf eine nicht mehr verfügbar.
3. **Defekter Host:** Die eine noch verfügbare Maschine (RTX 5090, Instanz 61111210, Host 36567) scheiterte am Containerstart
   (`failed to inject CDI devices ... gpu=3: unknown`), auch nach einem Neustart. Sofort zerstört; Kosten ca. 0,001 USD.

Technische Funde für den nächsten Versuch:
- `PUT /api/v0/asks/<id>/` lehnt Startparameter über 16 KB ab (`len(args) > 16384`): das Bündel (31 KB) passt nicht in `onstart`.
  Lieferweg: SSH (Schlüssel pro Instanz über `POST /api/v0/instances/<id>/ssh/`, im Container ohne `ssh`-Client z. B. mit
  `paramiko`) oder eine Download-URL.
- Vast setzt in jeder Instanz `CONTAINER_ID` und `CONTAINER_API_KEY`; damit kann sich die Maschine selbst zerstören (Sicherheitsnetz).
- Unverifizierte Hosts können am Container-Start scheitern. Für den Test verifizierte Hosts nehmen.
- Für Grafik (WebGL) taugen Consumer- und RTX/Quadro-Karten; A100/H100 haben keine Grafikfähigkeit.
