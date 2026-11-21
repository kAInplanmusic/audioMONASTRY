# Lokale Direktbefehle und Testantworten

Direktbefehle werden im bestehenden aiMONK-Feld mit Enter abgesendet. Erkannte Befehle werden im Browser in ein geprüftes DAW-Kommando übersetzt. Sie benötigen keinen Modellaufruf, GPU-Pod oder zusätzlichen Dienst. Der optionale Präfix `lokal` begrenzt die Eingabe ausdrücklich auf die hinterlegten Regeln. Andere Eingaben laufen über den regulären Executor. Plugins und Main-Out behalten ihre vorhandenen Besitzregeln.

| Eingabe | Aktion |
|---|---|
| `Equalizer Blitz Pass zwei höher` oder `EQ Bass zwei höher` | Gespeicherte Gains der drei tiefsten EQ-Bänder um 2 dB anheben. |
| `EQ Band 5 bis 8 um 1,5 dB tiefer` | Die vier bezeichneten Gains um 1,5 dB senken. |
| `Master EQ Bass zwei höher` | Die drei tiefsten der zwölf echten Main-Master-Bänder anheben. |
| `Tempo 128 BPM` | Transporttempo bei eigenem Mixer-Lock ändern. |
| `Transport Start` / `Transport Stopp` | Wiedergabe über die vorhandene Transportsteuerung. |
| `Mixer Pegel -6 dB` | Mixer-Ausgangspegel setzen. |

Der EQ-Faderzustand umfasst 36 Bänder und begrenzt Gains auf ±12 dB. `Bass` und die Schreibweise `Blitz Pass` wählen die drei tiefsten Fader. Die Regel verstellt Gain, keine Grenzfrequenz. Bei Bypass bleibt der Zustand erhalten. Die aktuelle Monitor-Engine erhält die vorhandene Low/Mid/High-Projektion von `updateToneShiftEQ`. Für die 36 gespeicherten Werte gibt es damit noch keine 36 unabhängig wirksamen Audiofilter. Mit `Master EQ` wählt man ausdrücklich den gemeinsamen Backend-Master mit zwölf unabhängig wirksamen Bändern. `Bass` steht dort für 40, 80 und 150 Hz. Der Master-Lock ist erforderlich.

## 22 Modellidentitäten und ihre kleinsten Testfälle

Die Modelle werden gegen `deploy/gpu/pod-fleet.json` und den Dispatch der App eingeordnet. Das gemeinsam genutzte ACE-Step-Modell zählt einmal. Die vis-Rolle ist ein Renderer. Die Modelle werden nicht im lokalen Fallback geladen. Die letzte Spalte beschreibt entweder ausführbare App-Regeln, einen bereits vorhandenen Testdatentyp oder einen konkreten Offline-Ersatz für spätere Arbeit.

| Modell | Pod | Kernfunktion und kleinster Testfall | Lokales Verhalten |
|---|---|---|---|
| qwen38-27b-fp8 | brain | Freitext planen und erklären. Eine Anfrage, eine Textantwort. | Markierter Testtext. Direkte DAW-Bedienung per Regel. |
| qwen3-4b | audio-brain | Anweisung in prüfbare DAW-Kommandos übersetzen. Ein Tempo-Vorschlag. | Transport, Mixerpegel und EQ per Regel. Simulierter Tempo-Vorschlag separat. |
| moss-music-8b-instruct | ears | Musik beschreiben. Text mit Rate und Laufzeit. | Feste Testbeschreibung. |
| clap-music | ears | Audio-Tags und Ähnlichkeit. Testclip mit zwei Tags. | Feste Tags für den Klassifizierungspfad. |
| beat-this | ears | Beat- und Taktpositionen ermitteln. 120 BPM mit zwei Takten. | Festes Beat-/Downbeat-Raster. |
| songformer | ears | Songabschnitte erkennen. Zwei Abschnitte mit festen Grenzen. | Feste Abschnittsliste. |
| dsp-analysis | ears | Physikalische Merkmale messen. RMS, Peak, Schwerpunkt und Onsets. | Fester Messdatensatz im Simulator. Echte CPU-Messung wäre ein eigener Produktionspfad. |
| basic-pitch | ears | Noten aus Audio ableiten. Eine Note als MIDI-Datei. | Gültige Ein-Noten-MIDI als Testdatei. |
| qwen3-tts-17b | voice | Sprache mit gewählter Stimme erzeugen. Ein kurzer Testauftrag. | Markiertes Mono-WAV. |
| qwen3-tts-voicedesign | voice | Stimme nach Beschreibung gestalten. Testauftrag mit Stimmhinweis. | Markiertes Mono-WAV für dieselbe Ausgabeschnittstelle. |
| moss-soundeffect-v2.0 | voice | Soundeffekt erzeugen. Ein kurzer Effektauftrag. | Markiertes Stereo-WAV. |
| acestep-v15-xl-base | voice | ACE-Step-Kontextarbeit. LEGO-Auftrag mit Referenzspur. | Stereo-WAV zum Prüfen von Routing und Ergebnisübergabe. |
| acestep-v15-shared | voice / music | Gemeinsam genutzter ACE-Step-Eintrag. Aufrufe über beide Rollen prüfen. | Simulierte Rollenwahl und Stereo-WAV. |
| acestep-v15-xl-turbo | music | Musikabschnitt erzeugen. Ein kurzer Loop-Auftrag. | Markiertes Stereo-WAV. |
| acestep-5hz-lm-4b | music | ACE-Step-Planung und interne Musiksteuerung. Ein Aufruf über music. | Simulierter Auftrag zur Routingprüfung. |
| yue2-3b | song | Song aus Lyrics und Stil erzeugen. Ein Auftrag über song. | Markiertes Stereo-WAV. |
| sonicmaster | studio | Audio mastern. Eingang und WAV-Ausgabe prüfen. | Markiertes Stereo-WAV. Für lokale Wiedergabe stehen die regulären DSP-Regler bereit. |
| bs-roformer-sw-6stem | studio | Sechs Modellspuren trennen und fünf App-Ausgaben liefern. | Fünf App-WAVs, optional sechs getrennte Modell-WAVs. |
| mvsep-mega-53 | studio | Mehrziel-Stem-Trennung. App-Ausgabe für den Studio-Pod prüfen. | Fünf App-WAVs. Vollständige 53 Modellspuren sind ein Live-Nachweis. |
| mel-roformer-bve | studio | Lead und Backing aus Vocals trennen. Zwei Ausgaben. | Zwei getrennte WAVs. |
| universr | studio | Audio hochskalieren. Rate und WAV-Ausgabe prüfen. | Fester 48-kHz-WAV-Payload. |
| mel-roformer-dereverb | studio | Direktanteil und Hallrest trennen. Zwei Ausgaben. | Zwei getrennte WAVs. |

Alle Simulatorantworten tragen `simulated: true`. Audiodateien bestehen aus reproduzierbaren Signalen. Sie können Transport, Library, Mixer-Import und Fehlerpfade prüfen. Ein Nutzermodus darf sie nur ausdrücklich als Testdaten verwenden. Automatische Aktionen bleiben an die bestehenden Berechtigungen und explizite Eingaben gebunden.
