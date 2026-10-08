# UI ↔ v2-Engine: Verkabelungsvertrag

Stand 2026-10-06 · Für den Agenten, der die v2-Verkabelung baut.
Sichtbare und klingende Vorlage: [`audioMONASTRY-design.html`](audioMONASTRY-design.html) (im Browser öffnen, „Audio starten“).
Regeln: [`../UI_SPEC.md`](../UI_SPEC.md). Dieses Dokument sagt, **was die Oberfläche von v2 erwartet**.

Der Entwurf ist so gebaut, als liefe v2 schon: Jedes Bedienelement steuert einen echten Knoten im Web-Audio-Graphen des Entwurfs. Die Namen unten sind die Parameter-Schlüssel des Entwurfs (`V[...]` im Skript); v2 soll dieselbe Bedeutung bekommen. Die Bezeichner dürfen in v2 anders heißen, die Semantik nicht.

## 1. Zwei Reihenfolgen

| | Reihenfolge | Quelle |
|---|---|---|
| **Bildschirm** | Kopf → Mastergraph → mixerMONK → drop, song, effect, syntisampler, drumsampler, instru, biblio, voice, sound, stem, spatial, eq, dsp, master, record → aiMONK → perforMONK | `plugins/registry.ts` (Kopfreihenfolge, Nummern 01–16, Farben) |
| **Signalweg** | Quellen → Mixer → effect → eq → dsp → spatial → master → record → Main Out | `src/plugins/signalChain.ts` (`SIGNAL_CHAIN`) |

Der Mixer zeigt den Signalweg als Leiste „Signalweg“. Ein Eintrag leuchtet, wenn die Stufe aktiv ist.

## 2. Kanäle

8 feste Mixer-Kanäle, sichtbar in Bank A (1–4) und Bank B (5–8). Die unsichtbare Bank läuft weiter.

| Kanal | Quelle | Kanal | Quelle |
|---|---|---|---|
| 1 | drop | 5 | instru |
| 2 | song | 6 | voice |
| 3 | drumsampler | 7 | sound |
| 4 | syntisampler | 8 | stem |

`biblio` erzeugt keinen Ton; es lädt in die anderen Plugins.

Kanalzug, in Signalreihenfolge (Entwurf: `buildAudio()`, Schleife „8 Kanalzüge“):

```
Quelle → trim → lo(shelf 120) → lm(peak 400) → hm(peak 2500) → hi(shelf 8k) → color-LP → color-HP
       → fader → GATE(▶/■) → mute/solo → crossfader(A|THRU|B) → pan → Distanz → Höhe → Mixer-Summe
                                 └→ FX-Send → FX-Bus
```

| Schlüssel | Bedeutung | Bereich |
|---|---|---|
| `chK.trim` | Eingangsverstärkung | −12…+12 dB |
| `chK.hi/hm/lm/lo` | 4-Band-EQ, unter −25,5 dB = Kill (−40) | −26…+6 dB |
| `chK.color` | Filter: <0 Tiefpass, >0 Hochpass | −1…1 |
| `chK.fx` | Send in den FX-Bus (post-fader) | 0…1 |
| `chK.pan` | Panorama, wenn spatial nicht ON | −1…1 |
| `chK.fader` | Fader, Kennlinie `n²` | 0…1 |
| `chK.mute/solo` | Solo schaltet alle anderen stumm | bool |
| `chK.xf` | Crossfader-Zuweisung | `A`/`T`/`B` |
| `chK.cue` | Vorhören (Kopfhörerweg, Monitor-Bus) | bool |

**Ton auf Main startet ausschließlich über ▶ im Kanal** (Gate des Kanals). Nur der Mixer-Halter darf ▶/■. Ist die Quelle OFF, ist ▶ gesperrt; ist sie STBY, schaltet ▶ sie auf ON.

Mixer-Summe: `mix.lvl` (Master-Fader, `n²`), `mix.gain` (dB), `mix.hi`/`mix.lo` (Master-Shelves), Makros `mac.flt` (Filter über die Summe), `mac.fx` (Returns lauter), `mac.build` (Hochpass + Hall), Crossfader `mix.xf` (0…1) mit Kurve `mix.xc` (`smooth` = konstante Leistung, `cut` = harter Schnitt).

## 3. SYNC gegen Main (neu, Pflicht für alle spielenden Plugins)

Jedes Plugin, das etwas abspielt oder erzeugt und abspielt (drop, song, syntisampler, drumsampler, instru, voice, sound, stem), hat eine SYNC-Taste (`sync.<id>`, Standard **an**). Sie sitzt in der Kopfzeile des Plugins; der Mixer-Kanal zeigt den Zustand („⟲ SYNC“/„FREI“), das Deck schaltet ihn für den gewählten Kanal.

| | SYNC an | SYNC aus |
|---|---|---|
| Start nach ▶ | auf dem **nächsten Main-Takt** (Zählzeit 1); ▶ leuchtet gelb, bis es losgeht | sofort |
| Pattern-Position | Schritt = Main-Schritt (taktgleich mit allen anderen) | zählt ab dem eigenen Start |
| Tempo | Main-BPM (inkl. Jog-Nudge); Stems werden gewarpt | Stems im Originaltempo |
| Pads/Drops | Quantisierung nach `drp.q` (Sofort, 1/4, 1 Takt) | immer sofort |
| Tonart, Akkorde | Main-Tonart, Akkord des Songs | unverändert Main-Tonart |

Main-Uhr: im Entwurf ein Lookahead-Scheduler (25 ms Takt, 120 ms Vorlauf, 16tel-Raster, Swing aus `drm.swing`). In v2 ist das die Master-Clock (`core/clock/MonastryMasterClock`), Quantisierung muss sample-genau im Audio-Thread passieren.

## 4. Modi, Halter, Sperren (serverseitig erzwingen)

| Plugin-Modus | Bedeutung | Audio |
|---|---|---|
| OFF | frei, jeder darf es holen | transparenter Bypass |
| STBY | einem Nutzer gemountet, nicht aktiv | Bypass, Quelle stumm |
| ON | aktiv, Bedienfläche offen | verarbeitet / spielt |

- Modus-Button rechts: OFF → STBY → ON → OFF. Fremde Plugins: Schloss, **kein Anfragen, kein Übernehmen**. Keine Ober- oder Untergrenze pro Nutzer.
- mixerMONK: genau ein Halter, immer ON, nicht schließbar, nur der Halter übergibt (MIX LOCK). Verlässt der Halter die Sitzung, bekommt ihn, wer am längsten dabei ist. Alle Plugins des Gehenden gehen auf OFF.
- Nicht-Halter sehen den Mixer eingeklappt mit 8 Pegeln.
- Wird eine Quelle OFF/STBY, stoppt ihr Kanal.

Das sind Sitzungsregeln: v2-Server und Collaboration-Lock müssen sie durchsetzen (UI2-P0-001/002), die Oberfläche spiegelt nur.

**Beständige Plugins (Betreiber 2026-10-06):** Der Stand jedes Plugins liegt in der Session
(`AuthoritativeSession.setPluginSettings`, Socket `plugin-settings`, nur der Halter schreibt). Wer ein Plugin
übernimmt, startet mit diesem Stand. Für v2 heißt das: Die Audio-Seite eines Plugins muss ihren Zustand aus
genau diesem Stand herstellen können (`restore`), und jede Reglerbewegung, die den Klang ändert, gehört in
den Stand – nicht in lokalen UI-Zustand. Main-Ausgänge: genau ein Gerät je Adresse (`/master-out`,
`/visual-out`), weitere werden abgewiesen (`output-busy`).

## 5. Nachbearbeitung (Stufen mit Bypass)

Jede Stufe hat einen trockenen und einen nassen Pfad; aktiv nur bei Modus ON (sonst transparent).

| Stufe | Knoten im Entwurf | Schlüssel |
|---|---|---|
| effect | FX-Bus → 5 parallele Effekte → Returns → zurück in die Summe (`retGate`) | `fx.master`, je Effekt `fx.<id>.on/amt/mix/p1/p2/p3` |
| eq | 6 Bänder: Low Cut, Low Shelf, 2× Peak, High Shelf, High Cut | `eq.N.f/g/q/on`, Presets `eq.pre`, A/B-Vergleich |
| dsp | Input → **Gate (AudioWorklet `am-gate`)** → Filter → Saturator → Kompressor → Tilt-EQ → Limiter → Output; LFO-Automation auf Cutoff/Resonanz/Gain | `dsp.in/out`, `dsp.g.*`, `dsp.f.*`, `dsp.s.drv`, `dsp.c.*`, `dsp.e.*`, `dsp.l.ceil`, `dsp.a.*`; Module an/aus `dsp.<m>.on` |
| spatial | Stereobreite + je Kanal Objekt x/y/z (Pan, Distanz, Höhe) | `sp.w`, `sp.K.x/y/z`, `sp.lay`, `sp.mode`, Pfade taktsynchron (`sp.spd`) |
| master | Eingang → Bass/Luft → Kompressor (Glue/Opto/VCA) → Limiter → Ausgang | `ma.drv/lo/air/gthr/ceil/rel`, `ma.comp`, `ma.lim`, Ziel `ma.tgt` (LUFS) |
| record | Abgriff nach Mastering oder nach Mixer, Float32 ohne Umwandlung | `rec.tap`, `rec.fmt` (16/24/32f), Bounce n Takte, `rec.arm` (Start mit erstem ▶) |

Effekte (`<id>`: `p1`/`p2`/`p3`):
`rev` Reverb (Abklingform/Größe), `dly` Delay (Taktwert 1/16…1/2 / Feedback, Ping-Pong, folgt BPM), `cho` Chorus (Rate / Feedback / Tiefe), `pha` Phaser (Rate / Feedback / Tiefe), `dst` Distortion (Ton / Drive). Die Effekt-Tabelle im Mixer bedient dieselben Werte (Amount = `amt`, Time = `p1`, Feedback = `p2`, Mix = `mix`). FX LOCK: Makros und Szenen dürfen Effekte nicht ändern.

## 6. Quellen: was die Oberfläche erwartet

| Plugin | Bedienung (Schlüssel) | v2 muss liefern |
|---|---|---|
| drop | Kategorien Drops/Loops/One-Shots/Zufall, 8 Pads, Drop-Text, `drp.<cat>.N.pit/lvl/len`, `drp.loop.N.lvl`, `drp.q` | Sample-Player, taktgenaue Loops, Erzeugung aus Text |
| song | Lyrics, Prompt, Stil-Chips, Länge, Takes, Arrangement mit Abschnitten, `song.bri` | Songerzeugung (Server), Arrangement-Wiedergabe, Abschnitt-Sprung |
| syntisampler | OSC1/2 (`syn.w*`, `o*`, `dt*`, `mix`), Filter (`ft`, `cut`, `res`, `env`), ADSR, LFO (`lr`, `ld`, `lt`), Glide, 16-Step-Rolle, „Folgt Akkord“ | Synth-Worklet (`synthProcessor`), Sequencer |
| drumsampler | 5 Kits, Raster 8×16 (Akzent, Choke CH→OH, Swing), Pads mit Drum-Bus `drm.drv/crush/lc/hc`, Smart Drums (x = Komplexität, y = Lautstärke, 6 Instrumente), Kit-Ansicht | Drum-Engine je Kit (Samples), Drum-Bus |
| instru | Gruppen → Spielfläche: Tastatur (49 Tasten, Velocity-Kurve, ADSR, Filter, MIDI, Arpeggiator), Streicher (gleitend), Gitarre (Griffbrett, Chorus-/Echo-Pedal `ins.pch/pec`), Bass; Akkordstreifen und Autoplay `ins.auto` 0–4 | 50 Instrumente (SFZ/Samples), Note-on/off mit Halten |
| voice | Text → Silben, Stimme, Modus Singen/Sprechen/Flüstern, Stil, `voc.pit/form/vib/air/drv` | TTS/Gesang (Server), Melodie folgt Akkorden |
| sound | Beschreibung, Kategorie, 4 Varianten, Länge, „alle n Takte“ | Klangerzeugung (Server) |
| stem | Import, BPM-Erkennung, 5 Stems (Gesang, Bass, Mitten, Höhen, Melodie) mit Pegel/M/S, Warp über SYNC, Trennen, Alle abspielen | Trennmodell (Server), Time-Stretch ohne Tonhöhenänderung |
| biblio | Suche, Typfilter, Preset-Schnellwahl, „Laden“ in das passende Plugin; neue Takes/Songs/Sounds landen automatisch hier | Library-Backend, Autosave |

## 7. Anzeigen, die Werte aus v2 brauchen

- Mastergraph (nur Ansicht): Ausgangspegel L/R, Song-Übersicht (Abschnitte, gespielte Pegel, Abspielkopf), Zeit/Gesamtzeit, Position Takt.Schlag.16tel, BPM, Tonart, LUFS kurzzeitig.
- Mixer: Kanalpegel post-fader, Summenpegel, Limiter-GR, Bankpegel I/II, Deck-Anzeige des gewählten Kanals.
- Streifen: L/R-Pegel je Plugin (Quellen: Kanal, Nachbearbeitung: Summe).
- dsp: Gate offen/zu, Kompressor- und Limiter-GR, Stimmenzahl (Budget 32).
- master: LUFS kurz/integriert (BS.1770 im Worklet), True Peak, GR, Verlauf gegen Ziel.
- perforMONK: Audio-Last, FPS, Speicher, Latenz (base + output), Dropouts, Worklets, SAB/crossOriginIsolated, Stimmen, Jitter, Netz ein/aus, Verbindungen 4/4, Laufzeit, Taktgeber-Verzug.

## 8. Was im Entwurf nur nachgebaut ist

Song, Stimme, Sound und Stem-Trennung laufen in der App über den Server; der Entwurf baut sie mit Oszillatoren und Filtern nach. LUFS ist im Entwurf eine RMS-Näherung. Monitor/CUE und Booth sind im Browser nur Anzeige (ein Ausgang). Alles andere (Kanalzug, Effekte, EQ, DSP, Mastering, Recorder, Sync, Sperrregeln) ist so gemeint, wie es im Entwurf klingt und reagiert.
