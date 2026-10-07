# visualMONK: Maker + Player, und Beatmatch (Entwurf 2026-10-07)

Auftrag Betreiber: ein **Visual-Maker** und ein **Visual-Player**, die Live-Visuals
aus **eigenen Bildern und Videos** machen. Keine KI-Generierung auf der GPU-Flotte
(siehe `AI_FLEET_6X48_PLAN.md`). Dazu **Beatmatch** im Audio.

Regeln (AGENTS.md): nichts auf dem Gerät speichern, Medien und Einstellungen liegen
serverseitig; ein Ausgabegerät pro Main-Ausgang (`/visual-out`); Sperrlogik der vier
Nutzer bleibt; kein Netzwerk im Audio-`process()`.

## 1. Audit des Bestands (Stand 2026-10-07, `npm run verify` grün: 2524 Tests)

Vorhanden und brauchbar:
- Audio-Feature-Bus (`featureBus.ts`), Audio→Parameter (`audioReactive.ts`), 12 Shader-Presets.
- Renderer Canvas2D, WebGL (mit Textur + Crossfade) und WebGPU (`src/core/visual/`).
- Show-Orchestrator (`showOrchestrator.ts`), Regisseur (`src/visuals/visualDirector.ts`,
  deterministisch, nach Energie und Stimmung), Schicht-Mischer (`layerCompositor.ts`, 7 Ebenen),
  Pool-Manifest „Topf" (`poolManifest.ts`, kennt `eigenes-foto` und `eigenes-video`).
- Ausgabe: `canvas.captureStream` → `/visual-out` (Ghostuser 6), MJPEG-Rückfall.

Lücken (im Code belegt):
1. **Kein Import eigener Bilder/Videos in die Visuals.** Im Overlay gibt es keinen
   Datei-Eingang; der Pool-Typ `eigenes-foto/-video` wird von nichts befüllt.
   Medien kommen nur aus der 8-Clip-Bank (R2) oder aus der KI-Erzeugung.
2. **Schnitt auf beliebigen Onset**, nicht auf Takt: `tickDirector` wechselt bei
   `onset ≥ 0,6` nach 3 s Mindestdauer. Es gibt kein Beat-Grid, keine Downbeats, keine Phrasen.
3. **Eine Szene = ein `<video>`/`<img>`**, nichts wird vorgeladen; kein Stapel aus
   mehreren gleichzeitig laufenden Videos (Ebenen sind Parameter, keine Medien).
4. **Kein Maker** (Tagging, Loop-Punkte, Look-Ketten, Sets) und **kein Player-UI**
   (Decks, Pads, Crossfader). Das Overlay (822 Zeilen) hängt als `lazy`-Overlay in
   `App.tsx`, nicht im Rack, ohne Plugin-Sperre und ohne Session-Einstellungen.
5. **Erzeugungsreste**: `makeClip`, `runpodVision.ts`, `runpodVideo.ts`, `visualBank` mit
   Nachschub über `imageHq`/`videoReal` entfallen mit der Flotten-Migration.
6. `tickDirector` ignoriert `_opts` in `pickNextScene` (bewusst, aber tote Signatur);
   `layerCompositor`/`poolManifest` haben keine eigenen Testdateien.

Sonstiges aus dem Audit: `npm audit` für Produktionsabhängigkeiten: 0 Funde (die
Warnung betrifft `smol-toml`, nur Dev); jscpd meldet 16 Duplikate (nur Warnung).
`origin/main` und `origin/visuals` enthalten nichts Neues gegenüber diesem Branch.

## 2. Zielbild

**Medien-Pipeline (serverseitig, kein Gerätespeicher)**
Upload (Chunk-Upload existiert, `QUAL_P3_002`) → Studio-Store/R2 → **ffmpeg auf dem
media-Knoten**: Proxy (H.264, 720p/1080p, kurze GOP, ohne Ton), Vorschaubild, Dauer/fps,
Helligkeit/Bewegungsstärke → **CLIP- und CLAP-Embedding** (`ears`) für Auto-Tags
(Stimmung, Energie, Farbe) in `visual_embeddings` (pgvector). Der Nutzer korrigiert Tags.

**Maker** (Vorbereitung, auch live bedienbar)
- Bibliothek: Raster mit Filtern (Tag, Stimmung, Energie, Farbe, Länge).
- Clip-Editor: In/Out, Loop **in Takten**, Tempo, Spiegeln, Farbe, Zoom.
- Looks: Effektketten als Shader (Kaleidoskop, Glitch, Feedback, Blur, Farbverschiebung,
  Strobe mit Blitzlimit ≤ 3/s).
- Szene = 1–3 Medien-Ebenen + Look + Audio-Mapping; Sets mit Slots Intro/Build/Drop/Breakdown.

**Player** (live)
- Zwei Visual-Decks A/B mit Crossfader, je 1–3 Ebenen.
- Übergänge (Cut, Fade, Wipe, Glitch, Zoom) **quantisiert auf Takt/Downbeat**.
- 8 Trigger-Pads (Szenen-Hot-Cues), Cue-Vorschau getrennt vom Main-Ausgang, Blackout.
- Modi: Manuell · Halbauto (Regisseur schlägt vor) · Auto (Regisseur schneidet).
- Audio-Mapping wie heute (bass→Zoom, treble→Farbe, onset→Schnitt, mid→Blende), zusätzlich Takt.

**Render und Zeit**
WebGL/WebGPU-Compositor; Videos vorab geladen (nächster Clip läuft stumm vor);
`requestVideoFrameCallback` bzw. WebCodecs für schleifengenaues Looping.
Frame-Budget 16,6 ms, Messung im perforMONK. Takt aus `MonastryMasterClock` plus Beat-Grid
des Tracks; SYNC gegen Main wie bei den Plugins.

**Einbindung**
Modul `visualMONK` im Rack (Vorschlag: fest, wie masterplayerMONK; Entscheidung §5).
Der Kopf-Schalter „Visuals" bleibt (nur Mixer-Halter). Einstellungen und Sets liegen in
der Server-Session (`writePluginSettings`), nie lokal. Der Halter steuert, alle anderen
sehen den gesperrten Streifen.

**KI**: `ears` taggt und findet Passendes zur Musik (CLIP ↔ CLAP), `brain` bekommt
MCP-Werkzeuge `visual.*` (Szene wählen, Set laden, Übergang auslösen). Keine Generierung.

## 3. Beatmatch (Audio)

Bestand: Uhr und Phasenregelung nur für das **Multi-User-Sync** (`MonastryMasterClock`,
`PhaseLockedLoop`). Es gibt **kein Beat-Grid je Track, keine Tempo-Anpassung ohne
Tonhöhenänderung und kein Phase-Lock zweier Decks** (Suche nach `beatGrid`, `beatmatch`,
`downbeat`: nur Treffer in der Drum-Machine; kein Time-Stretch-Modul, nur `dspKernel.wasm`).

Bausteine:
1. **Beat-/Downbeat-Grid** beim Import: essentia-Handler (`RhythmExtractor`) existiert in
   `handlers.py` und läuft in `ears`; ein spezialisiertes Beat-Tracking-Modell (z. B.
   „Beat This!") ist ungeprüft. Ergebnis: Beats, Downbeats, Konfidenz, im Studio-Store.
2. **Time-Stretch + Key-Lock** als WASM/AudioWorklet (Kandidat Rubber Band; Eignung und
   Latenz ungemessen). Kein Netzwerk im `process()`.
3. **Phase-Lock**: Deck-Phase gegen Master per vorhandenem PLL; SYNC-Button; Anzeige des
   Phasenfehlers in ms.
4. **Messung**: Phasenfehler nach Sync, Stretch-Latenz, Artefakte (Hörtest nötig).
5. **brain-Steuerung**: Übergangsbefehle über die Plugin-Kommandos (setzt die Brücke
   Gehirn → Session voraus, siehe KI-Plan).

## 4. Phasen

| Phase | Inhalt | Abnahme |
|---|---|---|
| V0 | Erzeugungspfade abtrennen, `layerCompositor`/`poolManifest` testen | `verify` grün |
| V1 | Upload + ffmpeg-Proxy + Tags + Bibliothek | Datei hochladen, Proxy + Vorschau erscheinen, Tags korrigierbar |
| V2 | Player: Decks, Crossfader, quantisierte Übergänge, Pads, `/visual-out` | Browser-Test, 60 fps-Messung |
| V3 | Maker: Clip-Editor, Looks, Sets | Set speichern, in neuer Session laden |
| V4 | KI-Auswahl + `visual.*`-Werkzeuge | Musik → passende Auswahl, ohne GPU-Erzeugung |
| B1 | Beat-/Downbeat-Grid je Track | Grid stimmt auf Testtracks (Hörtest + Messung) |
| B2 | Stretch + Phase-Lock + SYNC | Phasenfehler < Grenzwert, Hörtest |

B1 ist Voraussetzung für taktgenaue Visual-Übergänge (V2) und für Beatmatch.

## 5. Entscheidungen

1. **Wo im UI**: fester Streifen `visualMONK` im Rack (Vorschlag) oder Vollbild-Ansicht.
2. **Zielauflösung/-fps** der Ausgabe (1080p60?) und **maximale Ebenen** je Deck.
3. **Videoformate** für den Upload (mp4/H.264, mov, webm) und Obergrenze der Dateigröße.
4. **Reihenfolge**: Beatmatch (B1/B2) vor oder parallel zu den Visuals?
