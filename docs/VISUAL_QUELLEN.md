# VISUAL_QUELLEN — öffentliche Medienquellen + lokale Pool-Reihenfolge

Stand 28.09.2026. Konsolidiert aus drei Recherche-Workern (read-only) + eigener
Messung. Keine Datei wurde bewegt/gelöscht; Lizenzaussagen unten sind je Quelle
geprüft, ungeprüfte stehen als UNVERIFIZIERT.

## 1. Öffentliche Quellen — kommerziell nutzbar (erste Welle)

| Quelle | Lizenz | Namensnennung | API/Download | Eignung |
|---|---|---|---|---|
| **Pexels** | Pexels License | nein (optional) | `api.pexels.com` (kostenloser Key), Web | universal, viel Neon/Techno |
| **Pixabay** | Pixabay License (CC0-ähnlich) | nein (optional) | `pixabay.com/api` | große Menge, Geometrie/Retro |
| **Coverr** | Coverr License (irrevocable, commercial) | nein (optional) | `coverr.co/developers` | VJ-Loops, industrial/düster |
| Mixkit | Mixkit Free License (pro Item!) | nein (optional) | Web-Download | VJ-Loops, retro/comic |
| Unsplash | Unsplash License | nein bei Download; **JA bei API** | Unsplash Source API | Fotos, Sternenhimmel |
| Wikimedia Commons | je Datei (CC0/CC BY/CC BY-SA/PD) | je Datei | `commons.wikimedia.org/w/api.php` | universal, historisch |
| NASA Image Library | US Gov Public Domain | nein | `images.nasa.gov` | Sternenhimmel, cool |
| Openclipart | CC0 1.0 | nein | Web (SVG/PNG) | lustig/comic/lego |
| Rijksmuseum Rijksstudio | PD/CC0 bzw. CC BY 4.0 | je Werk | `data.rijksmuseum.nl` | geometrische Kunst |
| Library of Congress | PD / rights-free | nein | Web | retro/industrial |

## 2. Warnliste — NICHT verwenden

* **Shadertoy** — Standard CC BY-**NC**-SA (nicht kommerziell).
* **Vecteezy Free** — Attribution-Pflicht + Budget-Limit ≤ 1 000 USD Produktion.
* **Videvo „Editorial Use Only"** — nur redaktionell, kein Produkt/Branding.
* **Videvo Attribution / CC BY 3.0** — Namensnennung Pflicht.
* **Mixkit „Restricted License"** — einzelne Clips nur personal/non-commercial.
* **Alle CC BY-NC / CC BY-NC-SA** (Openverse/IA/Wikimedia) — NonCommercial verboten.
* **Unsplash via API ohne Attribution** — API Terms verlangen Namensnennung.

**Regel:** Jede Fremddatei in `docs/LICENSE_EXTERNAL_RESOURCES.md` eintragen
(Text, Autor, URL, Lizenz). Niemals NC, niemals „Editorial Only", niemals
Namensnennung weglassen, wo sie Pflicht ist.

## 3. Lokale Pool-Reihenfolge (gemessen, read-only)

| # | Quelle | Umfang | Bewertung |
|---|---|---|---|
| 1 | `lora-themen-2026-09-27/visuals-live/` | 706 mp4 (35 Basis + 182 Varianten + 8 Vorlagen + 6 Serie + 12 ffmpeg) | **NUTZEN — sofort** |
| 2 | `lora-themen-2026-09-27/bilder-vorrat/` | 1 061 PNG (KI, 9 Kombinationen) | **NUTZEN — sofort** |
| 3 | `am-visuals-themen-neu/` | 834 Dateien, 33 Themen kuratiert | **NUTZEN nach Sichtung** (Tattoos_Frauen, Nackte Haut, Tänzer = Datenschutz) |
| 4 | `~/Bilder/` | **157 GB / 46 712 Dateien** (28 159 jpg, 9 140 heic, 5 773 png, 3 591 dng) | **PRÜFEN — zuletzt**, HEIC/DNG-Dekodierung + Personen |
| 5 | `~/Videos/` | **179 GB / 1 490 Dateien** (589 mp4, 542 mov, 74 avi, 107 html, 122 aac) | **PRÜFEN — zuletzt**, AVI/MOV/3GP, Codec-Mix |
| 6 | `~/Fotos/`, `~/iCloudDrive/Alben/` | leer / Platzhalter | **ÜBERSPRINGEN** |

## 4. Empfehlung (bindend für den Pool-Aufbau)

1. **Zuerst** KI-Generiertes + fertige Clips (Pool-Einträge 1–2): kein Datenschutz,
   einheitliches Format, stimmig düster/cool.
2. **Danach** kuratierte Themen (Eintrag 3), aber die Personen-Themen
   (Tattoos_Frauen, Nackte Haut, Tänzer, Porträts) erst nach Freigabe des Users.
3. **Private Archive (`Bilder`, `Videos`) gesondert markieren** und nicht automatisch
   in den Visualizer — Veröffentlichung entscheidet der User, und die Formate
   (HEIC/DNG/ARW/AVI/3GP) brauchen erst Normalisierung.
