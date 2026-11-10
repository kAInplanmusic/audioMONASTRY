# R2-Live-Abgleich der 22 Flotteneintraege

Stand: 10. November 2026. Ergaenzt die Umsetzung in PR #27.

Die neuen S3-Zugangsdaten aus dem bereitgestellten Screenshot funktionieren:
signierte R2-Anfragen liefern HTTP 200. Der Bucket ist `audiomonastrysamples`.
Die Zugangsdaten wurden ausserhalb des Repositorys aktualisiert.
Supabase ist fuer diesen Zugriff nicht erforderlich.

## Umfang und Belegstaerke

Der komplette `weights/`-Namensraum wurde aufgelistet: anfangs **685 Objekte
mit 342.054.600.915 Bytes**, also rund 342 GB. Dieser Bestand umfasst auch
historische Modelle sowie teils doppelte TAR- und Einzeldatei-Spiegel.
Es wurde nichts daraus geloescht. Nach der gezielten Ergaenzung umfasst der
Bestand **703 Objekte mit 344.948.252.580 Bytes**. Die Differenz betraegt
18 Objekte und 2.893.651.665 Bytes (ca. 2,89 GB); enthalten sind die neuen
Zusatzdateien, der revisionsgebundene Beat-This-Checkpoint und kleine
Asset-Manifeste.

Fuer alle 22 aktiven IDs wurden die Rollen, Repositorys, Revisionen und
Gewichtsquellen abgeglichen. Bei zehn TAR-Archiven mit zusammen
92.792.524.800 Bytes wurden ueber signierte HTTP-Range-Anfragen die TAR-Header,
Snapshot-Pfade, symbolischen Linkketten und Groessen der erforderlichen
Gewichtsdateien geprueft. Alle 26 erforderlichen Gewichtsdateien dieser Archive
sind enthalten. Die Archive wurden dabei **nicht** vollstaendig heruntergeladen
und als Ganzes gehasht. Das uebernimmt weiterhin der Pod beim Download.

Alle fuenf Zusatzbestaende (BVE, DeReverb, Mega 53, Beat This! und YuE2-VAE)
wurden vollstaendig aus R2 zurueckgelesen und gegen ihre gepinnten SHA-256-Werte
geprueft: 16 Dateien mit zusammen 3.806.757.088 Bytes, alle Hashes korrekt. Der maschinenlesbare Abgleich
steht in [R2_MODEL_AVAILABILITY_2026-11-10.json](R2_MODEL_AVAILABILITY_2026-11-10.json).

## Tatsächlich gefundener Startfehler

Ein vorhandenes `_manifest.json` war kein Vollstaendigkeitsnachweis. Konkret:

| Modell | Einzeldatei-Spiegel | Alternative |
|---|---|---|
| Qwen3.5-4B (`qwen3-4b`) | Die aktuelle Revision liegt nur als TAR vor; der dateiweise Bestand gehoert zu einer aelteren Revision. | Aktuelles TAR mit beiden Shards vorhanden. |
| Qwen3 TTS CustomVoice | `model.safetensors` fehlt im dateiweisen Manifest. | TAR mit Hauptmodell und Speech-Tokenizer vorhanden. |
| ACE-Step XL Turbo | Alle vier Haupt-Shards fehlen im dateiweisen Manifest. | TAR mit allen vier Shards und Silence-Latent vorhanden. |
| MOSS SoundEffect v2 | `transformer/diffusion_pytorch_model.safetensors` fehlt im dateiweisen Manifest. | TAR mit DiT, Textencoder und VAE vorhanden. |

Der bisherige Starter bevorzugte ein solches unvollstaendiges Dateimanifest
gegenueber dem vorhandenen TAR. Dadurch konnte ein Start trotz vorhandener
Gewichte scheitern.

**Behoben:** `requiredWeightFiles` im Modellmanifest listet die notwendigen
Dateien mit ihren Originalgroessen auf. `manifest_entries()` prueft Repository,
Revision und diese Dateiliste. Unvollstaendige oder falsch zugeordnete Spiegel
werden verworfen; der Starter nimmt dann das TAR samt SHA-256-Sidecar.
Der lesende Live-Test aller acht Rollen liefert damit keine fehlenden
R2-Pflichtbestaende. Direkte Upstream-Modelle werden dabei ausdruecklich
separat ausgewiesen.

## Zuordnung aller 22 Eintraege

| Pod | Modell-ID | Bereitstellung |
|---|---|---|
| brain | `qwen38-27b-fp8` | Gepinntes Upstream-Repository; kein R2-Spiegel konfiguriert. |
| ears | `moss-music-8b-instruct` | Gepinntes Upstream-Repository; kein R2-Spiegel konfiguriert. |
| ears | `clap-music` | R2-Einzeldateien; zusaetzlich TAR vorhanden. |
| ears | `beat-this` | Gepinnter Checkpoint in R2; alter Root-Key bleibt ebenfalls erhalten. |
| ears | `songformer` | R2-Einzeldateien. |
| ears | `dsp-analysis` | CPU-DSP; kein neuronaler Gewichtsbestand erforderlich. |
| ears | `basic-pitch` | Hash-gepinnter Wheel 0.4.0 mit geprueftem ONNX-Modell; CPU. |
| voice | `qwen3-tts-17b` | R2-TAR; unvollstaendiger Einzeldatei-Spiegel wird verworfen. |
| voice | `qwen3-tts-voicedesign` | R2-Einzeldateien; zusaetzlich TAR vorhanden. |
| voice | `moss-soundeffect-v2.0` | R2-TAR; unvollstaendiger Einzeldatei-Spiegel wird verworfen. |
| voice | `acestep-v15-xl-base` | R2-Einzeldateien; zusaetzlich TAR vorhanden. |
| voice + music | `acestep-v15-shared` | R2-Einzeldateien fuer VAE/Textencoder; zusaetzlich TAR vorhanden. |
| music | `acestep-v15-xl-turbo` | R2-TAR; unvollstaendiger Einzeldatei-Spiegel wird verworfen. |
| music | `acestep-5hz-lm-4b` | R2-Einzeldateien; zusaetzlich TAR vorhanden. |
| studio | `sonicmaster` | Gepinntes Upstream-Repository; kein R2-Spiegel konfiguriert. |
| studio | `bs-roformer-sw-6stem` | R2-Einzeldateien; zusaetzlich TAR vorhanden. |
| studio | `mvsep-mega-53` | Gepinnte R2-Zusatzgewichte: Checkpoint und YAML. |
| studio | `mel-roformer-bve` | Gepinnte R2-Zusatzgewichte: Checkpoint und YAML. |
| audio-brain | `qwen3-4b` | R2-TAR der aktuellen Qwen3.5-4B-Revision. |
| song | `yue2-3b` | Hauptmodell direkt vom gepinnten Upstream; separater VAE als R2-Komponente. |
| vis | `universr` | Gepinntes Upstream-Repository; kein R2-Spiegel konfiguriert. |
| vis | `mel-roformer-dereverb` | Gepinnter Checkpoint und YAML bereits in R2 vorhanden. |

Im Ergebnis haben 15 der 22 Modell-IDs einen R2-Gewichtsbestand; fuenf
Hauptmodelle werden direkt geladen, Basic Pitch kommt aus dem gepinnten Wheel,
und DSP Analysis benoetigt keine neuronalen Gewichte. Der zusaetzliche YuE2-VAE
liegt als Abhaengigkeit in R2 und wird nicht als 23. Modell gezaehlt.

Damit sind fuenf Hauptmodelle bewusst direkt angebunden: Brain, MOSS Music,
SonicMaster, UniverSR und YuE2. Sie liegen nicht automatisch deshalb in R2,
weil ihr Upstream erreichbar ist. Die bisherige Konfiguration `directRepo`
bleibt fuer diese Hauptmodelle erhalten; es wurden keine ungefragten grossen
Duplikate dieser fuenf Bestaende angelegt.

## Gezielte Ergaenzung und Pod-Bereitstellung

Der Beat-This-Checkpoint wurde unter dem revisionsgebundenen Zusatzgewichts-
Pfad ergaenzt. Es fehlten ausserdem exakt 13 Dateien fuer BVE, Mega 53 und den
YuE2-VAE mit zusammen 2.812.589.523 Bytes. Deren Upload wurde erfolgreich abgeschlossen und war auf genau diese
Bestandteile begrenzt, mit maximal 2.813.000.000 Upload-Bytes einschliesslich
kleiner Asset-Manifeste. `--missing-only` ueberspringt vorhandene Objekte und
verweigert den Austausch abweichender Bestaende.

Ein urspruenglicher Sammellauf wurde von der automatischen Freigabepruefung
wegen moeglicher Ueberschreibungen/Kosten abgelehnt. Der Ersatzlauf ist durch
die expliziten drei IDs, die feste Byte-Obergrenze und den Verzicht auf
Ueberschreibungen begrenzt. Unterbrochene Multipart-Transfers wurden gezielt
abgebrochen (HTTP 204); es wurde kein fertiges Gewichtsobjekt geloescht.
Kleinere Multipart-Teile mit maximal vier parallelen Anfragen halten den
Transfer und den Speicherbedarf begrenzt. Part-ETags werden fuer den Abschluss
numerisch sortiert; fehlgeschlagene Transfers werden abgebrochen.

`weight_entries()` uebergibt vorhandene Zusatzdateien als kurzlebige
Presigned-URLs mit festem Zielpfad, Groesse und SHA-256 an `pod_start.py`.
Die Pods benoetigen dafuer keine R2-Schluessel. Fehlt ein optionaler
Zusatzspiegel, bleibt der bereits implementierte gepinnte Upstream-Download
als Startpfad verfuegbar. Der vorhandene Startschritt prueft die Datei vor
Bereitschaft.

## Pruefungen und weiterhin offene Grenzen

- 10 Tests der urspruenglichen Zusatzgewichts-/Loader-Korrekturen.
- 7 Tests fuer Vollstaendigkeit, TAR-Rueckfall, falsche Identitaeten und
  presignierte Zusatzdateien.
- 4 Tests fuer Upload-Groessenlimit, Nichtueberschreiben, sortierten
  Multipart-Abschluss und Abbruch bei fehlgeschlagenem Part.
- 8 bestehende S3-Signatur-/Konfigurationstests.
- 4 Flotten-Konfigurationstests, Typecheck und Lint bestehen.
- Ein unabhaengiger `weight-assets`-CI-Job fuehrt die 29 Python-Tests ohne
  Cloud-Zugriffe oder GPU aus. Er wird nicht von Fehlern anderer Teststufen
  am Start gehindert.

Die bekannte rote Gesamtsuite, fehlende Image-Builds und die noch ausstehenden
GPU-/Klangtests sind durch diesen R2-Abgleich nicht erledigt. Es wurden keine
Pods gestartet. Verfuegbare Gewichte sind kein Nachweis fuer gemessene
GPU-Speicherspitzen, Latenz oder Audioqualitaet.
