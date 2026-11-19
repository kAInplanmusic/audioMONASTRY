# VJ-Apps und Ideen: Prüfung und Übernahme für vis (2026-11-17)

Eingang: die Listen des Betreibers (10 Apps, 25 Effekte, 40 "Ideen"). Geprüft per Websuche am 2026-11-17.
"Belegt" heißt: eine Quelle in den Suchergebnissen. Alles andere ist ausdrücklich als ungeprüft markiert.

## Antwort auf "Vast.ai oder was?"
Die Rechenarbeit bleibt auf der vis-Instanz bei Vast. Die genannten Apps laufen dort nicht: Resolume Arena und
TouchDesigner werden für Mac und Windows geführt, NestDrop für Windows (Quelle: Vergleich projectileobjects.com
2025-11, resolume.com). Sie sind kommerzielle Desktop-Programme mit Bedienoberfläche; ein Linux-Container ohne
Bildschirm kann sie nicht fahren, und eine Lizenz für automatisierten Serverbetrieb ist nicht belegt. Wir
übernehmen deshalb ihre **Konzepte und offenen Formate** in unseren eigenen Renderer.

## Die 10 Apps
| App | Funktion (belegt / aus deiner Liste) | Übernommen | Nicht übernommen |
|---|---|---|---|
| Resolume Arena/Avenue | Clip-Mixer; Mac+PC; Arena 799 EUR dauerhaft, 12 Monate Updates (belegt); ISF-Shader (belegt); Wire = Knoten-Editor für Effekte | Effektkette mit Stärke je Effekt, Überblendung zweier Medien (vorhanden), ISF als Erweiterungsformat (offen, s. u.) | die App selbst, Mapping |
| TouchDesigner | Knoten-Umgebung; Mac+PC; ca. 565 EUR (belegt) | Audio-Features als Eingang jedes Shaders, Rückkopplungs-Puffer (Verlauf der letzten 2 Frames) | die App selbst |
| VDMX | modulare Mac-App (Liste); ISF (belegt) | ISF-Kompatibilität als Ziel | die App selbst |
| Synesthesia Live | Shader-App, Audio-Reaktion; Spout/Syphon (belegt); ISF (belegt) | Audio-Reaktion als Grundprinzip; Audio-Textur (Spektrum/Welle) als offener Punkt | Spout/Syphon (Desktop-Austausch) |
| NestDrop | MilkDrop-Presets, Windows (belegt) | MilkDrop-Ebene über **butterchurn** (MIT, WebGL2, läuft im Browser; belegt), als Generator neben den Medien | NestDrop selbst |
| MadMapper | Projektions-/LED-Mapping (Liste) | nichts: wir haben einen Beamer-Ausgang | Mapping |
| Notch | Echtzeit-3D, Großproduktionen (belegt) | nichts: proprietär, GPU-Engine | App und 3D |
| Visibox | Visuals für Bands/DJs mit ISF/MilkDrop (Liste) | Automatik-Modus (Regisseur) | App |
| GoVJ | iPad-VJ, 2 Kanäle, 16 Filter (Liste) | Zwei-Kanal-Überblendung (vorhanden) | App |
| Magic Music Visuals | Audioanalyse + Generatoren (Liste) | Generator-Ebene als offener Punkt | App |

## Die 25 Effekte: umgesetzt
Alle 25 sind Shader-Module (`src/core/visual/effects/`), getestet und angesehen (Kontaktbogen). Der Regisseur wählt
je Szene höchstens 3 gleichzeitig, nie zwei aus Mosaik/Stilisierung, und passt die Stärke jedem Frame dem Klang an.

| Gruppe | Effekte |
|---|---|
| Geometrie | Twitch, Distortion, Kaleidoscope, Mirror Quad, Linear Cloner |
| Mosaik | Hexagon Pixelation, Voronoi Glitch, Triangulate |
| Stilisierung | Edge Detection, ASCII (geometrisch), Geometric ASCII, Text-ASCII (Glyph Atlas), Dithering, Halftone, Pixel Sorting |
| Spuren | Feedback-Schleife, Echo Trace |
| Nachbearbeitung | Bloom, RGB Split, Delay RGB, Hue Rotate, Corner Color Tint, Bright/Contrast, Procedural Noise, Glitch |

Steuerung: `effects` = `"auto"` (Regisseur, Standard), `"off"` oder feste Liste `[{id, amount}]`; `maxEffects` 1 bis 4.
Live ändern über `POST /visual/effects`.

Ehrliche Einschränkungen: Pixel Sorting ist eine GPU-Näherung (Fenster von 12 Pixeln, nicht die Zeilensortierung
der Bildbearbeitung) und mit Abstand der teuerste Effekt (in Software 175 ms/Frame bei 640x360 gegen ca. 30 ms
bei den anderen). Delay RGB und Echo brauchen Bewegung im Bild; bei Standbildern kommt sie aus dem Kick-Zoom und
dem Versatz. Auf der GPU sind die Effekte nicht gemessen.

## Die "Ideen"-Liste
Von den 40 genannten Projekten habe ich geprüft, ob sie existieren:
- **Belegt:** SenSei (EboSuite, Unreal Engine in Ableton Live), DJESTHESIA (Forschungsprojekt, ACM, Motion-Capture-
  Handschuhe plus Projektor), Vibing Art (ACM-Veröffentlichung, iPhone-App), Phosphene/Augurs' Wand (NIME 2026,
  VCV Rack, Laser).
- **Nur dünn belegt:** Agentic VJ (nur ein Instagram-Beitrag von vrch.io gefunden).
- **Nicht gefunden:** Coachella x DeepMind World Models, Inspiring Formosa, DJ Agent, All-at-Once/RealityFX.
  Behandle diese Angaben als unbestätigt.

Was davon für uns Sinn ergibt:
| Idee | Entscheidung |
|---|---|
| Feedback-Schleifen, Audio-reaktive Shader, Kaleidoskop, Glitch | umgesetzt (in den 25) |
| Agentic VJ: Full-Auto / Semi-Auto / Manuell | umgesetzt als `auto` / feste Liste / `off`; aiMONK kann das später auf ausdrückliche Anforderung steuern |
| Partikelsysteme, Fraktal-Shader als Generator | offen, sinnvoll als zusätzliche Generator-Ebene neben den Medien |
| MilkDrop über butterchurn | offen, sinnvoll; Lizenz der Preset-Pakete vor dem Einbinden prüfen (ungeprüft) |
| ISF-Shader importieren | offen, sinnvoll als Erweiterungs-Slot; Lizenz je Shader prüfen (ungeprüft) |
| Audio als Textur (Spektrum/Welle) in Shadern | offen, sinnvoll, genauere Reaktion als vier Bänder |
| KI Bild-zu-Bild, Gaussian Splatting, Hologramme, Weltmodelle | nicht: widerspricht der Betreiberentscheidung 2026-11-13 (nur Renderer aus vorhandenen Medien) und braucht eigene Modelle/Hardware |
| Laser, Motion-Capture-Handschuhe, Orgelpfeifen-Projektion | nicht: Spezialhardware |
| Live-Coding (Hydra), Code als Performance | nicht jetzt: eigene Bedienoberfläche nötig |
| Sprachsteuerung | nicht jetzt: aiMONK ist ein Textfeld mit ausdrücklich abgesendeten Anforderungen (AGENTS.md) |
