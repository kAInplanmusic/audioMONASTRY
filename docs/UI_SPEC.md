# audioMONASTRY – Oberflächen-Spezifikation

Stand: 2026-10-06 · Sichtbare Vorlage: `docs/design/audioMONASTRY-design.html` · Modulliste: die 16 aus der README

## Aufbau (von oben nach unten)

1. **Kopf** – fest für alle. Logo, 16 Modul-Icons, Nutzerleiste (4/4), Einstellungen.
2. **Masterplayer** – fest für alle, kein Plugin. Nur Ansicht, keine Buttons: Wellenform des Ausgangs, Zeit, Takt, BPM, Tonart, Lautheit, L/R-Pegel.
3. **mixerMONK** – steht immer oben. Bei genau einem Nutzer immer offen, nicht schließbar. Nur der Halter kann ihn übergeben. Es gibt keine Anfrage.
4. **Die 15 anderen Plugins** – nacheinander in der Kopfreihenfolge (`plugins/registry.ts`):
   drop, song, effect, syntisampler, drumsampler, instru, biblio, voice, sound, stem, spatial, eq, dsp, master, record.
5. **Fuß** – fest für alle: perfMONK, aiMONK.

**Bildschirm ≠ Signalweg (Betreiber 2026-10-06).** Die lineare Reihenfolge
Quellen → Mixer → Nachbearbeitung → Recorder gilt **nur für die Verkabelung**
(Signalgraph, siehe „Signalkette“ unten). Auf dem Bildschirm steht der Mixer oben,
die übrigen Plugins folgen in der Kopfreihenfolge. Der Mixer zeigt den Signalweg
als eigene Leiste („Signalweg“), damit beides sichtbar bleibt.

## Mixer (Entwurf 2026-10-06)

- 8 Kanäle, sichtbar in **zwei Bänken à 4** (farbiger Umschalter A = Kanal 1–4, B = Kanal 5–8). Die unsichtbare Bank läuft weiter.
- Kanal k ist fest mit einer Quelle verdrahtet: 1 drop · 2 song · 3 drumsampler · 4 syntisampler · 5 instru · 6 voice · 7 sound · 8 stem.
- Pro Kanal von oben: Trim, Hi/Mid/Low (Kill bei −26 dB), Color-Filter (links Tiefpass, rechts Hochpass), Sends A–D, CUE/M/S, Pegel + **ein senkrechter Fader**, Crossfader-Zuweisung **A / THRU / B**, **▶ / ■**.
- **▶ im Kanal ist die einzige Möglichkeit, Ton auf Main zu starten.** Nur der Mixer-Halter kann sie drücken. Ist die Quelle OFF, ist ▶ gesperrt; ist sie STBY, schaltet ▶ sie auf ON.
- Rechts daneben: 4 Effekt-Returns (A Hall, B Delay, C Chorus, D Drive) mit eigenem Fader, dann der Master-Bereich (Master, Booth, Kopfhörer Cue/Mix und Pegel, Limiter-Anzeige).
- Darunter: **ein waagerechter Crossfader A ↔ B** mit Kurve Weich/Hart, 16 Pads (8 Drops, 8 Drum-Sounds), 3 Makros (Filter, FX-Anteil, Build-up), 8 Szenen.
- Wer den Mixer nicht hält, sieht ihn eingeklappt mit Name des Halters und 8 kleinen Pegeln.
- Pult nach Betreiber-Vorlage (2026-10-06): links Tastenleiste (EQ/DYN/FX/PAN/REC springen zum Plugin, FX LOCK, MIX LOCK = Übergabe), Deck mit Anzeige des gewählten Kanals, CUE/LOOP/SYNC und Jogwheel (Nudge), A/B-Taste = Bank; Master-Zug (High, Low, Gain, Fader); 4 Kanäle; rechts Effekt-Tabelle (An, Amount, Time, Feedback, Mix), 16 Trigger-Pads mit 4 Seiten (Drops, Drums, Akkord, Vox), Makro 1–3, Reihe „Mixer“ (Kanal aufs Deck, EDIT) und „Szene“ 1–8 mit SAVE; unten Crossfader A–B und Bankpegel I/II.

## SYNC gegen Main (Betreiber 2026-10-06)

Jedes Plugin, das etwas abspielt oder erzeugt und abspielt (drop, song, syntisampler, drumsampler, instru, voice, sound, stem), hat eine SYNC-Taste in der Kopfzeile (Standard an). SYNC an: Start auf dem nächsten Main-Takt, Pattern taktgleich mit Main, Tempo/Tonart von Main, Stems gewarpt, Pads quantisiert. SYNC aus: sofortiger Start, eigene Zählung. Der Mixer-Kanal zeigt den Zustand, das Deck schaltet ihn für den gewählten Kanal. Details für die v2-Verkabelung: `docs/design/V2_UI_VERKABELUNG.md`.

## Plugin-Streifen (Entwurf 2026-10-06)

- Kopfzeile: Nummer (Kopfreihenfolge 01–16), Name in Modulfarbe, Modus-Anzeige OFF/STBY/ON, Schloss, Halter, Vorbild-Gerät, L/R-Pegel, rechts der Modus-Button.
- drumsamplerMONK hat vier Ansichten: Raster (8 × 16), Pads (Drive, Crush, Low Cut, High Cut), Smart Drums (Laut/Leise × Einfach/Komplex) und Kit (gezeichnetes Studio- bzw. chinesisches Set). Fünf Kits.
- instruMONK wählt die Spielfläche nach Instrumentengruppe: Tastatur (Tasten, Blech, Holz, Perkussion, Weitere), Streicher (Violine/Viola/Cello/Kontrabass, gleitende Töne), Gitarre (Griffbrett, Chorus- und Echo-Pedal), Bass. Akkordstreifen und Autoplay 1–4 wie Smart Instruments.
- Die Spielflächen sind selbst gezeichnet; die Bilder in `public/instruMONK` stammen aus GarageBand und gehören nicht ins Produkt.

## Modi der 15 Plugins (ohne Mixer)

| Modus | Bedeutung | Kopf-Icon |
|---|---|---|
| OFF | frei, jeder darf es sich holen | grünlicher Schein |
| STBY | einem Nutzer gemountet, nicht aktiv | für andere dunkelroter Schein |
| ON | einem Nutzer gemountet, aktiv, Bedienfläche offen | für andere dunkelroter Schein |

- Der Button rechts am Plugin schaltet durch: OFF → STBY → ON → OFF.
- Fremde Plugins (STBY/ON eines anderen) sind gesperrt: Schloss, kein Anfragen, kein Übergeben.
- Keine Mindest- oder Höchstzahl pro Nutzer. Eine Person kann alle 16 belegen.
- ON und Ton läuft: Button leuchtet leicht pulsierend in der Modulfarbe.

## Kopf-Icons

- 16 Icons, jedes mit einzigartigem Symbol und einzigartiger Farbe. Die Farbe ist die Modulfarbe im Rack.
- Status nur als Schein hinter dem Icon, nie als Farbwechsel des Icons.
- Eigenes Modul: Ring in der eigenen Nutzerfarbe. Der Mixer ist für alle außer dem Halter rot.
- Tippen springt zum Modul.

## Farben

- Hintergrund `#080c14` · Fläche `#101826` · Linie `#1e2a40` · Text `#d9e2f2` · gedämpft `#6f7f9d`
- Modulfarbe: `hsl(i * 22.5 + 11, 72%, 64%)`, i = Position in der Kopfreihenfolge (mixer = 0).
- Nutzerfarben: `#4cc9f0`, `#ffb703`, `#e879f9`, `#f1f5f9`
- Schein frei `rgba(61,220,132,.30)` · Schein gesperrt `rgba(170,22,34,.55)`

## Transport und Autoload (mixerMONK) — umgesetzt 2026-10-05

**Transport.** PLAY und STOP sitzen in der Kopfzeile des Mixers, nicht in einem
Plugin-Terminal. Der Mixer *ist* der Master; wer ihn hält, steuert den
Transport. Ist man nicht der Halter, ist der Knopf deaktiviert und sagt im
Tooltip warum — ein stiller Klick ohne Wirkung ist ausdrücklich nicht gewollt.
Der Status (`LÄUFT` / `HALT`) wird aus der Audio-Engine gelesen, nicht lokal
geraten, damit auch engine-seitige Änderungen (Idle-Suspend) sichtbar sind.

**Autoload Kanal 1.** Ein Lied kann in der Kopfzeile als Autoload gepinnt
werden (`AUTOLOAD`, ✕ entfernt es wieder). Beim Start des Studios liegt es auf
Kanal 1 und läuft an, sobald der Browser nach der ersten Nutzergeste Audio
erlaubt — die Autoplay-Sperre lässt vorher keinen Ton zu. Gepinnt wird bewusst
nur, was auch in der Bibliothek liegt: Ein Eintrag ohne Datei wird verworfen,
damit kein Autoload ins Leere greift.

## Signalkette — die verbindliche Insert-Reihenfolge

Die Reihenfolge im Signalweg ist **fest** und unabhängig davon, wer welches
Plugin hält. Wer den Mixer hat, ändert nur, wer bedient — nicht den Pfad.

| Stufe | Plugins |
|---|---|
| Quellen | biblio · drop · song · drumsampler · syntisampler · instru · voice · sound · stem |
| **Mixer** | **mixer** |
| Nachbearbeitung | effect · eq · dsp · spatial · master |
| Recorder | record |
| Ausgang | Main Out |

Eine Quelle im Code: `src/plugins/signalChain.ts` (`SIGNAL_CHAIN`). Sie wird
vom Mixer als Leiste angezeigt („SIGNALKETTE“) und von
`tests/signalChain.test.ts` gegen die 16 kanonischen Plugins gehalten.

**Nicht zu verwechseln mit der Kopfreihenfolge.** Die Reihenfolge der Icons im
Kopf (`plugins/registry.ts`, DJ → PRODUCING → AI → MASTERING) ist die
*Darstellung*; an ihr hängen die Modulfarben `hsl(i*22.5+11, …)`. Die
Signalkette ist eine zweite, unabhängige Achse.

## Annahmen und offene Punkte

- AUTO_AI und PRO entfallen (Annahme). KI-Vorschläge kommen über aiMONK.
- Nummern 01–16 werden angezeigt, eindeutig nach Kopfreihenfolge (Betreiber-Vorlagen 2026-10-06). Kanalnummern 1–8 im Mixer bleiben.
- Verlässt der Mixer-Halter die Sitzung, geht der Mixer automatisch an die Person, die am längsten in der Sitzung ist (Entscheidung Betreiber).
