# VISUALVORLAGEN — Clip-Bank, audio-reaktiv, für den Visualizer

Stand 28.09.2026. Diese Vorlagen sind **keine Shader-Presets** (die liegen in
`src/core/visual/visualPresets.ts`), sondern **erzeugte Clips** aus unseren
eigenen Bildern, die der Visualizer live zur Musik auswählt und schneidet.

## 1. Warum eine Bank und nicht „live generieren"

Gemessen: ein 3-Sekunden-Clip braucht **101–162 s** Rechnen (Wan 2.2 TI2V-5B,
480×832, 49 Frames). Auf einen Takt kann niemand warten. Deshalb:

```
Bank (vorab erzeugt)  →  Auswahl nach Audio-Features  →  Schnitt/Übergang live
                       ↘  Nachschub im Vorlauf (1 Clip voraus), nie im Takt
```

Damit ist „live zur Musik" erfüllt, ohne die Latenz zu leugnen: die **Steuerung**
ist live, die **Erzeugung** läuft einen Schritt voraus.

## 2. Die drei Endpoints und was jeder tut

| # | Endpoint | Aufgabe | Kosten |
|---|---|---|---|
| 1 | `video-real` (`6ghy4fh00zb0j9`) | **Clips erzeugen** (Wan 2.2 TI2V): Foto → 3-s-Clip | 0,69 USD/h ≈ 0,63 €/h |
| 2 | `ai-image` (`wzh9hcbitjnn95`) | **Startbilder/Bilder** (SDXL 1.0 / FLUX.1-dev fp8) | 0,44 USD/h gemessen |
| 3 | `video-abstract` (`fogwdyxp1zj8zv`) | **Reserve**: zweiter Clip-Worker, nur wenn 1 und 2 stehen | 0,69 USD/h |

Regel: **immer nur ein Worker gleichzeitig** → unter 1 €/h. Im Leerlauf 0
(`workersMin 0`, `idleTimeout 120 s`). Ein Clip kostet ~0,02 USD.

## 3. Die Vorlagen

Acht Stück, jede aus einem geprüften Bild unseres Vorrats (Kombination × Motiv,
Seed 4711). Dateien und Kennzahlen je Vorlage: `index.json` in derselben Ablage.

| id | Quelle (Kombination) | Motiv | Bewegung (Prompt-Kern) |
|---|---|---|---|
| `neon_stage` | psy_techno | Neon-Bühne, Figur | Lichtröhren pulsieren, Dunst zieht, langsamer Push |
| `alien_temple` | flux_alien | biomechanischer Tempel | Nebel zwischen Strukturen, Lichter pulsieren, Kamera steigt |
| `alien_bluete` | alien_techno | riesige Alien-Blume | Blüte öffnet sich, Partikel driften, langsamer Orbit |
| `maschinen_flur` | traumraum | Maschinenflur mit Nebel | Nebel rollt vorwärts, Lichter flackern in Reihe, Dolly |
| `geometrie` | eskalation | schwebende Geometrie | Rotation, Kantenlicht, Staub, langsamer Orbit |
| `licht_kathedrale` | dark_techno | Lichtkathedrale | Lichtbalken fegen, Dunst, Push |
| `chrom_fluss` | metal_flow | fließende Metalllandschaft | Rippen wandern, Mondlicht, langsame Kamerafahrt |
| `chrom_gesicht` | feuer_organik | Gesicht aus flüssigem Chrom | Reflexe fließen, Augen öffnen sich, Drift |

## 4. Die Audio-Anbindung (passt auf die vorhandene Mechanik)

Die App hat bereits `AudioFeatures` (`bass, mid, treble, rms, onset, energy`) und
`mapAudioToParams(preset, features, t)`, das daraus `rotation, zoom, warp, hue,
flow` baut. Die Clip-Vorlagen benutzen **dieselben Features**, aber auf die
**Wiedergabe** statt auf einen Shader:

| Feature | Wirkung auf den Clip | Größe |
|---|---|---|
| `onset` | **Schnitt**: auf den Schlag die Vorlage wechseln (nächste in der Gruppe) | Schwellwert 0,6 |
| `energy` | **Gruppenwahl**: ruhig → `chrom_fluss`, `licht_kathedrale`; hart → `neon_stage`, `geometrie` | 0–1 |
| `bass` | **Zoom-Puls** beim Abspielen (0,98–1,06), zusätzlich zur Lautstärke | 0,6 wie im Bestand |
| `treble` | **feiner Farbdrift** (`hue`-Shift 0–12°) | 0–12° |
| `mid` | **Kreuzblende zwischen zwei Clips** statt harter Schnitt bei mittlerer Energie | 0,3 |
| `rms` | Grundtempo der Blenden | — |

Regeln für die Wiedergabe:
* Clips sind 3,03 s — **immer mit 0,3–0,5 s Kreuzblende** schleifen, sonst springt das Bild.
* **Hue-Shift statt neu erzeugen**: Farbvarianten kosten 0 GPU-Zeit.
* Bei `onset`-Schnitt: zwei gleichartige Vorlagen wechseln lassen (`neon_stage` ↔ `geometrie`), nicht zwei fremde.

## 5. Aufbau der Bank

```
R2: visuals/vorlagen/<id>.mp4          ← der Clip
    visuals/vorlagen/<id>_start.jpg    ← Startbild (auch für Nachschub)
    visuals/vorlagen/index.json        ← Kennzahlen je Vorlage
```

Die App liest die Dateien über die öffentliche R2-Basis
(`VITE_CFR2_PUBLIC_URL`), für den Nachschub über vorab signierte Links
(`r2.py presign GET`, 48 h).

## 6. Nachschub (wenn eine Vorlage „neu" wirken soll)

```bash
# 1. neues Startbild: entweder aus dem Vorrat oder per ai-image erzeugen
# 2. hochladen und signieren
python3 -c "import r2; print(r2.presign('PUT','visuals/vorlagen/neu.jpg',**r2._creds(),expires=3600))"
# 3. Clip erzeugen: POST video-real {prompt, image_url, width:480, height:832,
#                                   length:49, steps:20, cfg:5.0, seed:4711}
# 4. Ergebnis-MP4 nach R2 visuals/vorlagen/neu.mp4
```

## 7. Format und Nachbearbeitung

Erzeugt wird **480×832, 32 fps, 97 Frames, 3,03 s, h264**. Für die Bühne:

```bash
ffmpeg -i clip.mp4 -vf scale=1080:1920 -r 24 -c:v libx264 -crf 18 clip_buehne.mp4   # hochskalieren
ffmpeg -i clip.mp4 -vf "minterpolate=fps=48" clip_48.mp4                            # flüssiger
```

## 8. Nebenbei gemessen: was am Bildmaterial falsch ist

Der Datensatz `out-v3` — Grundlage der 32 **eigenen** LoRAs — ist inhaltlich
falsch zugeordnet. Beispiele aus den Beschriftungen:

* `dinosaurier`: „zwei Schlangen", „drei Jungen mit Teller Essen"
* `fantasy`: „Arm mit Tattoo", „Mann mit Tattoo"
* `drohnenflug`: „Sternhaufen", „**Tattomaschinen auf einem Tisch**"

Ein LoRA für „drohnenflug", trainiert auf Tattomaschinen, kann keinen
Drohnenflug liefern. **Vor jedem weiteren Training muss der Datensatz geprüft
werden** — sonst wird das Training ein zweites Mal für nichts bezahlt.
Bis dahin sind die Vorlagen bewusst **ohne** eigene LoRAs gebaut: sie nutzen die
Basisqualität von SDXL/FLUX, und das Ergebnis ist gemessen brauchbar.

## 9. Offen

* `TODO(verify)`: Ob `video-real` einen **Graph** fahren kann (nötig, um den Bild-Endpoint
  einzusparen) — offen seit 28.09., er spricht prompt-basiert.
* `TODO(verify)`: Clip-Tempo bei `length 97/193` (längere Vorlagen) — Zeit und Kosten linear.
* `TODO(verify)`: Ob der Video-Worker mit angehängtem Volume `lora_pairs` (Wan-LoRAs)
  akzeptiert. Unsere 32 LoRAs sind SDXL und passen dort nicht.
* Die drei Ausschuss-Clips aus dem ersten Versuch liegen in
  `visuals-live/serie-01/_verworfen/` (Beleg: falsche Quellauswahl, nicht Fehler der Kette).
