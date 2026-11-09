# spatialMONK — Architekturplan & Single Source of Truth

**Projekt:** audioMONASTRY  
**Stand:** 2026-11-09  
**Branch:** `spatial`  
**Status:** Architektur- und Implementierungsplan, **keine bereits implementierten Codeänderungen**  
**Codebasis:** `main` @ `b7baff2b7d65a85b20f668bcda252203a6df426f`

> **Ziel:** Vorhandene 16-Plugin-Architektur bewahren, Parallelwege konsolidieren und spatialMONK zu einem zuverlässigen objektbasierten 2D-Spatial-Renderer mit binauralem Cue, echtem Mehrkanal-Output, Bassmanagement, Lautsprecherkalibrierung und deterministischer Vier-Nutzer-Synchronisation ausbauen.

## 0. Evidenzstandard

- **CODE:** Befund aus eingesehener Repository-Datei.
- **RESEARCH:** Abgeleitet aus `Deep Research Spatial Hifi Audio.txt` (2026-11-09) und `24_2_Spatial_Audio_Whitepaper_v2.docx`.
- **DESIGN:** Beabsichtigte Änderung, nicht gegen die Audiohardware verifiziert.
- **VERIFY:** Tests, Messungen und Hörproben sind vor Release erforderlich.

Eingesehen wurden `src/audio/spatialBus.ts`, `src/audio/spatial/node.ts`, `src/core/spatial/spatialRenderers.ts`, `src/plugins/adapters/SpatialPluginAdapter.ts`, `src/plugins/pluginContract.ts`, Auszüge aus `src/components/am/SpatialRack.tsx` und `src/audio/worklets/spatialProcessor.ts`. Zusätzlich identifiziert: `src/core/audio/V2OutputGraph.ts`, `src/utils/audioEngine.ts`, `src/core/spatial/SpatialScene.ts`, `src/utils/spatialMath.ts`, `src/core/spatial/layouts.ts`, `scripts/spatial-regression.ts`. Der gesamte Live-Signalweg muss vor Codeänderungen weiter durchlaufen werden.

## BINDENDER ARCHITEKTUR-OVERRIDE – 2026-11-09: Stereo-first, XY-only

**Diese Präzisierung hat Vorrang vor älteren Alternativen in diesem Dokument.**

- mixerMONK bleibt die kanonische Stereo-Summe. DJ, Recording, Stream, andere Nutzer, normale Kopfhörer und sämtliche anderen Ausgänge bleiben auf originalem Stereo – unabhängig von spatialMONK.
- spatialMONK bekommt nicht-destruktive, post-fader Signal-KOPIEN aus einem oder mehreren Mixerkanälen. Kein `disconnect(GLOBAL_MASTER)`, kein Eingriff in Mixer-Pan, Fader oder FX.
- Spatial-only-Dateien, Töne und Samples bekommen eigene Inject-Inputs, niemals heimlich einen Mixer/DJ-Kanal ersetzen.
- Der bearbeitete Spatial-Return kommt NUR in den **dedizierten Spatial-Main-Summing-Node** – nicht in den allgemeinen DJ-/Stereo-Master.
- Selektierte Dry-Kanäle werden im Spatial-Main durch ihre räumlich gerenderten Kopien ersetzt. Nicht selektierte Mixerkanäle plus FX-Returns bilden den Stereo-Bed. Vollständigen Mixer-Stereo-Master nicht parallel mit kopierten selektierten Dry-Quellen summieren.
- **ZWEI Raumachsen:** XY-Draufsicht mit X=links/rechts und Y=vorne/hinten, beide auf konstanter Ohrhöhe. Keine Z-/Elevation-Eingabe, kein 3D-UI und keine separate 360°-Kontrolle. Eine horizontale Lautsprecherumgebung darf intern Azimutwinkel aus XY ableiten, die UI zeigt nur den Raum.
- Nur der ausdrücklich gewählte räumliche MAIN-Ausgang erhält N-Kanal-Audio, nur bei nachgewiesener Hardwarefähigkeit. Alle anderen Outputs bleiben Stereo.
- Legacy `SpatialScene.applyRouting→cluster.connect(GLOBAL_MASTER)`, `routeChannelToSpatialInput→disconnect`, `SpatialBus.setPosition→setChannelPan` und `SpatialBus.setMode→globalStereoMute` widersprachen dem Auftrag und werden im Sidebranch abgesichert.

```text
mixerMONK ch1..8 ────────────────► STEREO MASTER ──► DJ / other users / stream / record
   │
   ├─selected channel copy────────────┐
   ├─unselected dry + FX stereo bed────┼──► Spatial Proxy/Renderer ─► Spatial Main (N channels)
   └─spatial-only injections───────────┘       ↑
                                  UI: simple top-down X/Y only
```

Neues passives Routing-Modul: `src/core/spatial/v2/routingPlan.ts`. Neues nicht-destruktives WebAudio-Tap-Grundgerüst: `src/core/spatial/v2/nonDestructiveTap.ts`. Beide sind **noch nicht** in den hörbaren V2LiveSink integriert.

## 1. Verbindliche Architekturentscheidungen

1. **Kanonische Plugin-ID `spatial` bleibt unverändert.** Eine Plugin-Instanz bleibt verantwortlich; beliebig viele räumliche Audioobjekte dürfen darin existieren.
2. **Kein Big-Bang-Refactor.** `audioEngine`, V2-Graph, Mixer, Plugin-Contract, bestehende Worklets, PDC, Settings und Session-Sync werden schrittweise erweitert.
3. **Eine `SpatialScene`, ein graphweiter Routing-Owner und genau ein aktiver Renderer je Output-Bus.** Andere Render-Implementierungen können Offline- oder Fallback-Backends sein.
4. **Audio und Steuerung sind getrennt.** Im Audio-Callback keine JSON-Deserialisierung, Netzwerkaufrufe, React-Zugriffe, KI, Dateizugriffe oder unkontrollierte Speicherallokationen.
5. **2D ist Release-Ziel.** Binaural, Stereo und 4–24 horizontale Satelliten plus optional ein bis zwei Subwoofer. 3D-Elevation, WFS und 36-Lautsprecher-Raster bleiben Forschung.
6. **Rendering, Monitoring und Hardware unterscheiden.** Ein 24.2-Layout im UI ist kein Nachweis für 26 tatsächlich getrennt adressierbare physische Ausgänge.
7. **Der LFE-Kanal ist kein Positionslautsprecher.** Bassmanagement bekommt eigenen DSP mit Crossover, Phase, Pegel und Verzögerung.
8. **Stereo-Master bleibt funktional.** Neue Spatial-Routen dürfen die bestehenden 16 Plugins, die Standardwiedergabe und Aufnahme nicht brechen.

## 2. Bestandsaufnahme und konkrete Risiken

| Priorität | Datei | Nachweis / Risiko |
|---|---|---|
| P0 | `SpatialPluginAdapter.ts` | In `onProcess` setzt Mono-Pan bei `pan !== 0` `channels[0].fill(0)`: **Mono-Audio wird stumm**. |
| P0 | `spatialBus.ts` | `ChannelSplitter(2)` aus Stereo-Master → L+R-Summe → N Kanal-Gains: **keine unabhängigen Audioobjekte pro Quelle**; Master-Upmix ist nicht Objekt-Rendering. |
| P0 | `spatial/node.ts` | `SpatialCluster.splitNow()` migriert Quell-Metadaten, aber nicht sichtbar alle bereits an Quell-Slots angeschlossenen AudioNodes: mögliche stille Quellen. |
| P0 | `spatial/node.ts` | Globales `modulePromise` statt AudioContext-gebundener Module-Loads; Fehlerzustände werden nicht zurückgesetzt. |
| P0 | `spatialBus.ts` | Erzeugte `splitter`, `sourceL`, `sourceR`, `monoSource` werden bei Rebuild/Reset nicht vollständig als zusammengehöriger Graph verwaltet: Lifecycle-/Doppelrouting-Risiko. |
| P1 | `spatialRenderers.ts` | `BinauralSpatialRenderer` nutzt primär ILD-Gains statt echter HRIR-Convolution/ITD-Renderqualität. |
| P1 | `spatialRenderers.ts` | Offline-`render()` erzeugt `Float32Array`-Allokationen trotz Header-Behauptung „keine Allokationen“. Nicht im Realtime-Callback verwenden. |
| P1 | `pluginContract.ts` | `spatial` derzeit Stereo-Channel-Insert, Latenz 0, `singleInstance: true`. N-Kanal-Main und reale Convolution-Latenz benötigen getrennte Capability-/Bus-Policy statt stillschweigender Vertragserweiterung. |
| P1 | `SpatialRack.tsx` | ON_TOP und SEPARATION unterscheiden parallele Stereo-/Spatial-Ausgänge; bei überlappenden Device-Kanälen drohen Summierungs-/Phasenprobleme. |
| P1 | Gesamtprojekt | `SpatialBus`, `SpatialNode/SpatialCluster`, `SpatialScene`, `spatialRenderers`, `SpatialPluginAdapter` und `public/wam/spatial/spatial-processor.js` sind mehrere teilweise überlappende Wege. Pro Betriebsmodus den tatsächlich hörbaren Signalweg nachweisen. |

**Besonders wichtig:** Der `SpatialNode` ist derzeit mit `outputChannelCount: [2]` aufgebaut; das ist ein Stereo/binauraler Worklet-Ausgang, kein physischer N-Kanal-Renderer.

## 3. Architektur: verbindlicher Soll-Signalfluss

```text
Audio Sources: drop/song/drums/synth/instru/voice/sound/stem
    │
    ▼
Mixer Channels 1–8
    ├── Trim / Insert / Channel PDC / Fader / Solo / Mute
    ├── Post-fader FX send ──> effectMONK ──> FX Return
    ├── Stereo-Bed / Stereo Main ──> eqMONK ──> dspMONK ──> masterMONK
    │                                               └──> Stereo Output / Recorder
    └── post-fader Source Taps
         └──> spatialMONK Source Router (one audio owner)
              └──> Canonical SpatialScene + transport automation
                   ├── Binaural HRTF (personal headphone cue, 2ch)
                   ├── VBAP 2D (primary position panning, Nch)
                   ├── DBAP 2D (optional distributed-listener mode)
                   └── HOA 2D (optional diffuse/ambience beds)
                        └── N satellite bus
                             └── Calibrated speaker output matrix
                                  ├── satellite HPF / delay / EQ / trims
                                  ├── subwoofer LPF / summing / delay / phase
                                  ├── aligned N-channel output safety limiter
                                  ├── device channel capability + mapping
                                  └── monitor downmix (separate output)
```

**Doppelsummierung verboten:** Jeder physische Device-Channel besitzt genau einen autoritativen finalen Ausgabepfad. Stereo-Cue und Spatial-Main dürfen nur bewusst und nach nachvollziehbarer Output-Policy auf Hardware geroutet werden. Der Stereo-`masterMONK`-Limiter darf nicht als vermeintlicher N-Kanal-Limiter verwendet werden.

**Betriebsmodi:**
- `stereo-main`: bestehende Stereo-Kette ohne Änderung.
- `binaural-cue`: personalisierter Kopfhörer-Monitoring-Pfad, ohne zusätzliche physische Spatial-Kanäle.
- `spatial-main-exclusive`: objektbasierte N-Kanal-Hauptausgabe mit eigenem finalen Output-Gain.
- `stereo-monitor-plus-spatial-main`: nur bei explizit getrennten Geräte-/Output-Endpunkten.
- `offline-spatial-render`: deterministischer Export unabhängig von Gerätelimits.

## 4. Kanonisches Datenmodell / SceneV2

```ts
export type SpatialObjectKind = 'mono' | 'stereo-pair' | 'bed';
export type SpatialAlgorithm = 'vbap2d' | 'dbap2d' | 'hoa2d' | 'binaural';
export type OutputPurpose = 'speaker-main' | 'headphone-cue' | 'offline-export';

export interface Vec2 { x: number; y: number } // metres: +X right, +Y front
export interface SpatialObjectV2 {
  id: string;
  sourcePluginId: string;
  channelId: string;
  kind: SpatialObjectKind;
  positionM: Vec2;
  gainDb: number;
  spread: number;                  // [0, 1]
  width: number;                   // [0, 2], stereo pair/bed only
  orientationDeg: number;
  distanceMode: 'normalized' | 'physical';
  enabled: boolean;
  mute: boolean;
  sends: { earlyReflections: number; lateReverb: number };
  automationLaneIds: string[];
}

export interface SpeakerV2 {
  id: string;
  positionM: Vec2;
  role: 'satellite' | 'subwoofer';
  physicalOutputChannel: number | null;
  trimDb: number;
  delayMs: number;
  polarity: 1 | -1;
}

export interface SpatialSceneV2 {
  schemaVersion: 2;
  revision: number;
  listenerM: Vec2;
  roomM: { width: number; depth: number };
  objects: SpatialObjectV2[];
  speakers: SpeakerV2[];
  renderAlgorithm: SpatialAlgorithm;
}
```

**Migration:** Vorhandene `SpatialScene`-/Plugin-Settings inklusive `spatialMONK-v1` automatisch und verlustfrei in v2 migrieren. Alte Presets weiterhin lesbar halten; neue Presets explizit versionieren; idempotente Migration testen. Physische Lautsprechergeometrie von normierten UI-Positionen trennen.

## 5. DSP: VBAP-2D als primärer Renderer

1. Nur `satellite`-Lautsprecher in VBAP-Paare einbeziehen.
2. Azimut aus realen Lautsprecherpositionen zum Hörer berechnen; nach 360° sortieren und Wrap-Around-Paar bilden.
3. Für ein Audioobjekt das einschließende Lautsprecherpaar bestimmen.
4. Zweidimensionale Basis invertieren; negative Werte gegen Null clampen; bei degenerierter Geometrie deterministisch nearest-speaker wählen.
5. Amplituden `sqrt(g0*g0 + g1*g1)` normalisieren; Pegel-/Energieverhalten separat messtechnisch überprüfen.
6. Pro Source die Gains sample-/blockgenau interpolieren. Keine Sprünge bei 359°→0°, schnellen Richtungswechseln oder Layoutänderungen.

```ts
interface SpeakerDirection { id: string; azimuthRad: number; x: number; y: number }

function vbapPair(sourceAzimuthRad: number, pair: [SpeakerDirection, SpeakerDirection]) {
  const [a, b] = pair;
  const dX = Math.sin(sourceAzimuthRad);
  const dY = Math.cos(sourceAzimuthRad);
  const determinant = a.x * b.y - b.x * a.y;
  if (Math.abs(determinant) < 1e-7) return null;

  let ga = (dX * b.y - b.x * dY) / determinant;
  let gb = (a.x * dY - dX * a.y) / determinant;
  ga = Math.max(0, ga);
  gb = Math.max(0, gb);
  const norm = Math.hypot(ga, gb);
  if (norm < 1e-9) return null;
  return [ga / norm, gb / norm] as const;
}
```

Die Funktion ist ein algorithmischer **Baustein** und setzt korrekt vorab ausgewählte, normierte Lautsprecherrichtungen voraus. Keine komplette Layout-/Renderer-Implementierung und keine akustische Validierung.

**DBAP:** Physische Entfernungen statt Sweet-Spot-Richtungsgewichte, mit definiertem Mindestabstand, Rolloff, Normierung und Spektral-/Pegeltest. **HOA:** 2D horizontale Harmonische mit `2N+1` Komponenten für Ordnung N; objekt- und bed-basierte Nutzung, eindeutiges Decoder-Layout. **WFS:** Nicht im ersten Release.

## 6. Binaural-HRTF und SpatialNode

`SpatialNode` bleibt binauraler Kopfhörerpfad. Ziel: SOFA/AES69-kompatible HRIR-Datensätze, HRTF-Interpolation, echte ITD/ILD, Convolution, definierte Tail-Länge und gemeldete Latenz. Qualität `low/medium/high` bekommt hör- und messbare Unterschiede; kein „high“ allein aufgrund eines Qualitätslabels.

**Fix: Worklet-Modul-Laden pro AudioContext:**

```ts
const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();

export function ensureSpatialModule(ctx: BaseAudioContext): Promise<void> {
  const existing = moduleLoads.get(ctx);
  if (existing) return existing;
  const p = (ctx as AudioContext).audioWorklet.addModule('/worklets/spatialProcessor.js');
  moduleLoads.set(ctx, p);
  p.catch(() => { if (moduleLoads.get(ctx) === p) moduleLoads.delete(ctx); });
  return p;
}
```

**Cluster:** Bis zur vollständig implementierten Rewire-/Crossfade-Migration automatische Splits deaktivieren. Beim Split müssen Quellverbindungen, Slot-Belegung, Source-State und Zeitachse gemeinsam und atomar auf den neuen Worklet-Eingang umziehen. Validierungsziel: kein verlorenes Audio und keine doppelten Signale.

## 7. P0: Mono-Pan-Bug

In `src/plugins/adapters/SpatialPluginAdapter.ts` muss die `channels[0].fill(0)`-Verzweigung im Mono-Pan-Pfad entfernt werden. Ein Mono-Block kann innerhalb eines Mono-Containers keine Stereo-Seitenrichtung repräsentieren; entweder unverändert durchreichen und Stereo-Panning nach dem expliziten Mono→Stereo-Router ausführen oder einen erwarteten Stereo-Output des Renderers erzeugen. **Niemals den Mono-Buffer stummschalten.**

Testen: Pan = -1, -0.5, 0, 0.5, 1; Mono-Signal muss in jedem Fall erhalten bleiben. Zusätzlich Tests für Stereo-Balance vs echtes Mono-Position-Panning mit definierter Pan-Law.

## 8. Output-Routing, PDC, Bassmanagement, Calibration

**Speaker-Mapping:** `physicalOutputChannel` wird erst aktiviert, wenn ein tatsächlicher Hardware- oder Bridge-Output nachweislich alle benötigten unabhängigen Kanäle unterstützt. Browser `ChannelMerger` garantiert keine 24.2-Hardwareausgabe. Stereo-Fallback sichtbar machen; verfügbare Kanäle und das ausgewählte Gerät über eine Capability-Abfrage validieren.

**Bassmanagement:** Erst Satelliten-VBAP berechnen, danach Frequenzbandrouting auf Satelliten-Hochpass und Subwoofer-Tiefpass. Startpunkt: Linkwitz-Riley 4. Ordnung, konfigurierbarer Crossover z. B. 80 Hz, getrennte Sub-Gains/Delays/Polarity, Headroom und limitergeschützte Testsignale. Filterphase, summierte Übertragungsfunktion und Raumakustik mit Impuls-/Sweepmessungen validieren. LFE-Inhalte und umgeleitete Satellitenbässe getrennt definieren.

**PDC:** Jeder Worklet-/FIR-/Limiter-/Frequenzweichen-Pfad liefert `latencyFrames(sampleRate)`. Bereits bekannter Stereo-Master-Lookahead in `pluginContract.ts`: 240 Frames bei 48 kHz. Keine implizite Latenz 0 bei aktivem Lookahead/FIR. Alignments vor Mehrweg-Summierung und Recorder-/Cue-Tap durchführen; Delay bei Sample-Rate-Wechsel neu bestimmen.

**Speaker Calibration:** Lautsprecher-ID, physische Position, Kanalbelegung, Gain, Delay, Polarität, EQ und Messprofil versioniert speichern. Direkte elektronische „0 dB“-Kalibrierung ersetzt keine reale Raummessung. Eine sichere Testsignalfunktion mit Pegelbegrenzung ist Pflicht.

## 9. Kollaboration bis vier Nutzer

Die Scene-Commands sind der gemeinsame Zustand, das Audio bleibt beim graphverantwortlichen Client/Host. Jedes Kommando trägt `opId`, `actorId`, `sceneRevision`, `objectRevision`, `transportEpoch` und einen geplanten Audiotimestamp. Server validiert Besitz, Rechte, Revision und Update-Rate. Gleicher Parameter desselben Objekts: deterministische Konfliktregel oder kurzer Parameter-Lease; verschiedene Objekte unabhängig. Layout-/Device-Mapping nur Host/Owner.

Bewegungsupdates über Netzwerk koaleszieren (z. B. 20–60 Hz); samplegenaue Interpolation im Renderer. Rejoin: Snapshot + Revision + Delta-Replay. Doppelte/alte Nachrichten ignorieren. KI-Text→Trajectory nur über validierte, rücknehmbare Commands; kein KI-Code im Audio-Thread.

## 10. UI und Betriebsmodi

`SpatialRack` und `SpatialScene` behalten ihre UI-Rollen, verwenden aber dieselbe kanonische Szene. Anzeigen: Objektpositionen/IDs, reale Raummaße, Lautsprecher- und Sub-Positionen, aktive Algorithmen, physische Kanäle, „simuliert“ vs „hardware-active“, Clip-/Peak-/RMS-Anzeigen, Monitoring-Modus, PDC und Device-Fallback.

`ON_TOP` wird nur als **Stereo monitor + spatial main** angeboten, wenn die Ausgangspfade getrennt und technisch unterstützt sind. `SEPARATION` wird eindeutig **Spatial main exclusive**. UI-Behauptungen „hörbar/24.2“ an echte Engine- und Device-Telemetrie koppeln.

## 11. Architektur-Backlog / agentenfertige Aufgaben

| ID | Prio | Zuständige Dateien | Änderung | Abnahme |
|---|---|---|---|---|
| SP-P0-01 | P0 | `SpatialPluginAdapter.ts` | Mono-Pan-Mute reparieren | Fünf Pan-Positionen ohne Stille |
| SP-P0-02 | P0 | `spatialBus.ts`, `audioEngine.ts`, `V2OutputGraph.ts` | Graph-Routing pro Modus inventarisieren und Doppelausgabe ausschließen | Ein physischer Producer je Ausgang |
| SP-P0-03 | P0 | `spatialBus.ts` | Splitter/Gain/Merger-Lifecycle idempotent verwalten | 100 Rebuilds ohne Nodes/CPU-Leak |
| SP-P0-04 | P0 | `spatial/node.ts` | Context-bound Worklet-Load + Retry | Zwei Contexts + Fehlerfall grün |
| SP-P0-05 | P0 | `spatial/node.ts` | Auto-Split deaktivieren bis vollständiges Audio-Rewire | Kein Source-Drop bei Split |
| SP-P0-06 | P0 | `pluginContract.ts`, `audioEngine.ts` | Channel-Insert und Spatial-Main-Output als getrennte Fähigkeiten modellieren | Contract-/PDC-/Routing-Tests |
| SP-P1-01 | P1 | `SpatialScene.ts`, `types.ts` | SceneV2 + Migration + Revision | Alte Presets verlustfrei |
| SP-P1-02 | P1 | `spatialMath.ts`, `spatialRenderers.ts` | Exakter 2D-VBAP-Renderer für echte Positionen | 360° Sweep, Wrap, Energienorm |
| SP-P1-03 | P1 | `src/audio/worklets/` | N-Kanal-Worklet/Matrix mit explizitem Output-Layout | 16+2 isolierte Buffer |
| SP-P1-04 | P1 | `V2OutputGraph.ts`, Outputs | Physical Device Capability und Mapping | Stereo/8/16/24-Kanal-Loopback |
| SP-P1-05 | P1 | `master21`, Biquad/DSP | LR4-Crossover, getrennte 2 Subs, Mess-IR | Frequenzgang/Phase/Headroom |
| SP-P1-06 | P1 | `v2Pdc.ts`, metrics | Sample-Rate-abhängige Render-/Convolution-PDC | Kein Drift/Fehlalignment |
| SP-P1-07 | P1 | `SpatialRack.tsx`, `SpatialScene.tsx` | Gerätekanäle und Simulationsstatus korrekt anzeigen | Keine falsche Hardware-Aussage |
| SP-P1-08 | P1 | `scripts/spatial-regression.ts`, CI | WAV/FFT/Impulse/Channel-ID/Automation | Deterministische Goldens |
| SP-P2-01 | P2 | `src/audio/spatial/` | SOFA-HRTF + Interpolation + FIR/FFT | Binaurale Hör-/Impulstests |
| SP-P2-02 | P2 | `src/core/spatial/` | DBAP + 2D HOA für Beds | Lokalisation/Energie gemessen |
| SP-P2-03 | P2 | Session/Socket/Control | Vier-User-Revisions- und Konfliktlogik | 10.000 konkurrierende Edits |
| SP-P2-04 | P2 | Calibration/Output | 4×4-m-Raumprofil und LS-Messwizard | Reproduzierbares 16-LS-Profil |
| SP-P3-01 | P3 | Bridge/Export | ADM-BWF/ADM-OSC, Audio-over-IP-Bridge | Standards-/Realgeräte-Validierung |
| SP-P3-02 | P3 | AI Control | Text→Trajectory als validierte Commands | Preview/Undo/Rechteprüfung |

## 12. Test- und Release-Gates

1. **DSP:** Impuls, Sinus, Rosa Rauschen, Sprache, Percussion, Stereo-Beds, 0°/90°/180°/270°, Sweep und 359°→0°, NaN/Inf/Clipping, gain-normalisation.
2. **Objekte:** zwei Quellen gleichzeitig mit verschiedenen Positionen; post-fader Send/Return, mute/solo/PDC, Stereo-Bed-Erhalt.
3. **Audioqualität:** Stereo-Monokompatibilität, Azimutfehler, Front/Back-Fehler, Timbre-/Kammfilter-Effekte, Sub-Crossover-Phase, korrekte Lautheit.
4. **Routing:** 2, 8, 16, 24+2; Ausgabegerätwechsel/Unplug/Replug; kein doppelter Stereo-/Spatial-Pfad; 44.1/48/96 kHz.
5. **Langlebigkeit:** 100 Layoutwechsel, 30 Minuten Live-Rendering, 32 aktive Quellen, keine Zombie-Nodes oder CPU-/Speicherzunahme.
6. **Echtzeit:** AudioWorklet-Underruns, CPU-p95/p99, HRTF-Convolution, IR/FFT und Fallbacks auf schwacher CPU.
7. **Kollaboration:** vier Nutzer gleichzeitig, gleiche/verschiedene Objekte, Out-of-order, Reconnect, Rechteverletzung, Undo und Transport-Drift.
8. **Hardware-Hörprobe:** echten Mehrkanal-Ausgang und Lautsprechermapping mit Messtechnik nachweisen. **Grüne Unit-Tests allein erlauben kein „produktionsreif“.**

**CI-Gates:** `tsc`, Lint, Unit, deterministischer Offline-WAV-Render, Graph-Topologie, Channel-Mapping, Lifecycle-Soak, Browser-Integration. **Release-Gate:** echte N-Kanal-Hardwaretests und akustische Messungen.

## 13. Implementierungsreihenfolge / Rollout

**Phase A — Stabilisieren (P0):** Mono-Pan, Graph-Lifecycle, Worklet-Modulcache, Cluster-Rewire, PDC und Capability-Nachweis.  
**Phase B — Schema und Adapter:** SceneV2, Preset-Migration, Control-/Automation-Protokoll; öffentliche API beibehalten.  
**Phase C — Spatial Render:** 2D VBAP N-Channel, Stereo-/Binaural- und Speaker-Main sauber trennen.  
**Phase D — Akustik:** Bassmanagement, Speaker-Correction, Limiter, Kanal- und Messprofile.  
**Phase E — Optionale Erweiterungen:** DBAP, 2D HOA, SOFA-HRTF, vier Nutzer, ADM/OSC, KI-Steuerung.

**Hard stop:** Kein Feature-Merge, solange Mono-Pan stummschaltet, Cluster-Split Audio verliert, physische Kanäle doppelt versorgt werden oder 24.2 trotz fehlender Hardwarefähigkeit als echt ausgegeben wird.

## 14. Fachliche Quellen

- `Deep Research Spatial Hifi Audio.txt` (2026-11-09): VBAP/PEP, DBAP, HOA, WFS, objektbasierte DAW-Integration, ADM-OSC, Audio-over-IP, HRTF, psychoakustische Messanforderungen.
- `24_2_Spatial_Audio_Whitepaper_v2.docx`: 24+2-Raum- und Lautsprechermodell, VBAP/DBAP/HOA, Bassmanagement, Kalibrierung und Integration.
- audioMONASTRY-Repository (`main` @ `b7baff2b7d65a85b20f668bcda252203a6df426f`), Dateien unter Abschnitt 0.
- Normative Referenzen bei der Implementation gegen Primärtexte prüfen: ITU-R BS.2076/ADM, AES69/SOFA, W3C Web Audio / AudioWorklet, AES67 und bei externer Broadcast-Infrastruktur SMPTE ST 2110 / ST 2022-7.

**SSOT-Endzustand:** spatialMONK ist die kanonische räumliche Szene innerhalb der bestehenden DAW. Ein klarer Audio-Graph erzeugt definierte, getrennte Stereo-, Binaural- und N-Kanal-Ausgänge. Automationen, Kollaboration, Kalibrierung, PDC und reale Hardwarefähigkeiten werden explizit und testbar verwaltet.
