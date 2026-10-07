# Vis-Instanz: vollautomatische, selbstlernende Visuals, Maker/Player, und Beatmatch (Entwurf 2026-10-07)

Auftrag Betreiber: Live-Visuals aus **vorhandenen Bildern und Videos**, **vollautomatisch**:
das System sucht sich selbst Material heraus, erzählt eine **Geschichte zur Musik** und
**lernt selbst**. Ein **Visual-Maker** (Vorbereitung/Eingriff) und ein **Visual-Player**
(manuell steuerbar) bleiben als Handsteuerung. Keine KI-Generierung auf der GPU-Flotte
(siehe `AI_FLEET_6X48_PLAN.md`). Dazu **Beatmatch** im Audio.

Namensregel: „Player" ist ausschließlich mixerMONK. Die feste Anzeige oben heißt
mastergraphMONK. Hier heißt das Handpult deshalb **Visual-Deck**, nicht „Player".

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

### 2.1 Vis-Instanz und Zugriff per Browser (Betreiber 2026-10-07)

Wird **Visuals in den Einstellungen aktiviert** und hat die **Vis-Instanz geladen**
(Medienindex, Story-Engine, Ausgabe-Seite bereit), ist sie per Browser erreichbar, z. B.
`https://visuals.<domain>` oder `http://<IP>`. **Der Main-Sound wird mit gleichem Aufbau
per Browser ausgegeben** (`https://sound.<domain>`); heute sind das `/master-out` und
`/visual-out`. Es gibt **keinen Rack-Streifen** dafür; die Bedienung sitzt in den
Einstellungen (Schalter, Status „lädt/bereit", URL zum Kopieren, QR-Code).

- **Ein Gerät je Ausgang** (AGENTS.md): das erste Gerät hält die Adresse, weitere lehnt
  der Server ab. Die Ausgabe-Geräte sind Listener und zählen nicht zu den vier Nutzern.
- **Wer rendert?** Der **Ausgabe-Browser** (am Beamer) rendert selbst mit WebGL/WebGPU.
  Die Vis-Instanz liefert Szenenplan, Takt und Audio-Features (WebSocket/Datenkanal, mit
  Zeitstempeln der Master-Clock) sowie die Proxy-Videos. Ein Server-Rendering schließt sich
  aus: die Hetzner-Knoten haben keine GPU, 1080p60 per CPU wäre nicht zu halten.
- **Wo läuft sie?** Vorschlag: als Container `vis` auf dem **media-Knoten** (hat ffmpeg, NVMe,
  R2-Sync), Subdomain per Caddy, kein neuer Server. Alternative: eigener 5. Hetzner-Server
  (Konstitution erlaubt 5, genutzt sind 4).
- **Browser-Regel für IP-Zugriff:** Über `http://<IP>` ist die Seite kein „sicherer Kontext".
  Dort fehlen WebGPU, WebCodecs und AudioWorklet; WebGL bleibt. Für 1080p-Rendering reicht
  WebGL, für den Main-Sound reicht ein `<audio>`-Element mit WebRTC. Volle Funktionen gibt es
  über HTTPS (Domain oder lokales Zertifikat).
- **Auflösung:** Standard **1080p60**. **2K/4K** wird **hochskaliert** (Shader im Ausgabe-
  Browser) oder, wenn die GPU es hergibt, **nativ gerendert**; wählbar je Ausgabe
  (`streamResolution.ts` kann das schon je Ausgabe). 4K nativ nur nach Messung.

### 2.2 Vollautomatik: Story-Engine (Hauptmodus)

Ablauf, ohne dass jemand eingreift:
1. **Musik verstehen:** Struktur (Intro/Build/Drop/Break/Outro), Energiekurve, Beat-Grid,
   Stimmung. Bekannter Track: Analyse vorab (essentia + `ears`). Live-Mix: laufend, mit
   1–2 Phrasen Vorlauf.
2. **Geschichte planen:** `brain` macht daraus einen Bogen (Akte, Motive, Spannung/Entladung)
   und Stichworte je Abschnitt. Es erzeugt nur Text und Tags, keine Bilder.
3. **Material suchen:** Stichworte → CLIP-Texttower → ähnliche Bilder/Videos im Bestand
   (`visual_embeddings`, pgvector), gewichtet nach Tags, Stimmung, Energie und Lernwerten.
4. **Schneiden:** Der Regisseur legt die Folge fest, **quantisiert auf Takt/Downbeat**, mit
   Übergangsart je Abschnitt. Der Ausgabe-Browser spielt sie.
5. **Quellen:** eigener Bestand (Pflicht). Optional **öffentliche Quellen** (Pexels,
   Pixabay, Wikimedia; Lizenzfeld im Pool-Manifest), von der Vis-Instanz geholt, transkodiert
   und aufgenommen. API-Schlüssel nur serverseitig. Entscheidung §5.

Ohne `brain` gibt es **keinen neuen Plan**; die Vis-Instanz spielt den letzten Plan weiter
und meldet „Planung nicht verfügbar". Es gibt keinen Ersatz-KI-Pfad.

### 2.3 Selbstlernen (ohne GPU-Training)

- **Signale:** Daumen hoch/runter auf Szene und Übergang (Pad), Überspringen, manuelle
  Eingriffe (Override im Deck), Session-Ende-Bewertung (`visual_feedback` existiert),
  Verweildauer.
- **Lernen:** Gewichte je Clip, Tag, Übergang und Kontext (Struktur-Slot × Energie ×
  Stimmung) per Bandit/Thompson-Sampling, dazu Ähnlichkeitssuche über bestbewertete Szenen.
  Gespeichert serverseitig, je Nutzergruppe, pgvector für die Ähnlichkeit.
- **Leitplanken:** Wiederholungssperre im Set, Mindestvielfalt, feste Explorationsrate,
  Blitzlimit ≤ 3/s, Schalter „Lernen einfrieren", Seed für reproduzierbare Läufe (Tests,
  Replay). Das Lernen ändert nur Gewichte, nie Medien oder Modelle.

### 2.4 Handsteuerung: Maker und Visual-Deck

**Medien-Pipeline (serverseitig, nichts auf dem Gerät):** Upload (Chunk-Upload existiert,
`QUAL_P3_002`) → Studio-Store/R2 → **ffmpeg auf dem media-Knoten**: Proxy (H.264, 1080p, kurze
GOP, ohne Ton), Vorschaubild, Dauer/fps, Helligkeit/Bewegung → CLIP-/CLAP-Embedding (`ears`)
→ Auto-Tags (Stimmung, Energie, Farbe). Der Nutzer korrigiert Tags.

**Maker:** Bibliothek mit Filtern, Clip-Editor (In/Out, Loop in Takten, Tempo, Spiegeln,
Farbe, Zoom), Looks als Shader-Ketten (Kaleidoskop, Glitch, Feedback, Blur, Farbverschiebung),
Szenen (1–3 Ebenen + Look + Mapping), Sets mit Slots Intro/Build/Drop/Breakdown.

**Visual-Deck:** zwei Decks A/B mit Crossfader, 8 Trigger-Pads (Szenen), Übergänge auf
Downbeat, Cue-Vorschau getrennt vom Ausgang, Blackout. Modi: **Auto** (Story-Engine, Standard)
· **Halbauto** (Engine schlägt vor, Mensch bestätigt) · **Manuell**.

**Zuständigkeit:** Das Deck steuert der Mixer-Halter oder, per Sperre, ein Nutzer, der es
hält; alle anderen sehen den Stand. Einstellungen, Sets und Lernwerte liegen in der
Server-Session. Das Gehirn bekommt MCP-Werkzeuge `visual.*` (Szene wählen, Set laden,
Übergang auslösen, Modus wechseln).

**Render und Zeit:** WebGL/WebGPU-Compositor; der nächste Clip läuft stumm vor;
`requestVideoFrameCallback` bzw. WebCodecs für schleifengenaues Looping. Frame-Budget
16,6 ms, Messung im perforMONK. Takt aus `MonastryMasterClock` plus Beat-Grid des Tracks.

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
| V1 | Vis-Instanz: Container, Aktivierung in den Einstellungen, Status, URL, Ausgabe-Seite, Exklusivität | Seite per Browser erreichbar, zweites Gerät abgelehnt |
| V2 | Medien-Pipeline: Upload, ffmpeg-Proxy, Tags, CLIP-Index | Datei hochladen, Proxy + Tags erscheinen |
| V3 | Ausgabe-Browser rendert Plan + Takt, quantisierte Übergänge, 1080p60 | 60 fps im Browser-Test gemessen |
| V4 | Story-Engine: Struktur → Plan (`brain`) → Suche → Schnitt, Auto-Modus | Track läuft ohne Eingriff, nachvollziehbarer Plan im Log |
| V5 | Selbstlernen: Signale, Gewichte, Leitplanken, Einfrieren | Bewertung ändert nachweisbar die Auswahl, Seed-Replay identisch |
| V6 | Maker und Visual-Deck (Handsteuerung), `visual.*`-Werkzeuge | Set speichern, in neuer Session laden |
| V7 | 2K/4K-Hochskalierung bzw. nativ, Messung | Messprotokoll |
| B1 | Beat-/Downbeat-Grid je Track | Grid stimmt auf Testtracks (Hörtest + Messung) |
| B2 | Stretch + Phase-Lock + SYNC | Phasenfehler < Grenzwert, Hörtest |

B1 ist Voraussetzung für taktgenaue Übergänge (V3) und für Beatmatch.

## 5. Entscheidungen

Geklärt am 2026-10-07: Zugriff per Browser/URL statt Rack-Streifen (§2.1), 1080p Standard
mit 2K/4K hochskaliert oder gerendert, Vollautomatik als Hauptmodus, Namensregel.

Offen:
1. **Wo läuft die Vis-Instanz:** Container auf dem media-Knoten (Vorschlag) oder eigener Server.
2. **URL-Schema:** Subdomains (`visuals.`/`sound.`) oder Pfade (`/visual-out`/`/master-out`);
   Zugriffsschutz (Token in der URL?) und lokales Zertifikat für IP-Zugriff.
3. **Quellen:** nur eigener Bestand, oder zusätzlich öffentliche Quellen (Pexels/Pixabay/Wikimedia).
4. **Lern-Signale:** welche Eingaben zählen (Daumen/Pads, Session-Umfrage, Verweildauer).
5. **Videoformate und Größenobergrenze** beim Upload.
6. **Reihenfolge:** Beatmatch (B1/B2) vor oder parallel zu den Visuals?
