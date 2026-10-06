# audioMONASTRY – Oberflächen-Spezifikation

Stand: 2026-10-06 · Sichtbare Vorlage: `docs/design/audioMONASTRY-design.html` · Modulliste: die 16 aus der README · Kurzfassung für Agenten: `.agents/skills/ui-spec/SKILL.md`

## Aufbau (von oben nach unten)

1. **Kopf** – fest für alle. Logo, 16 Modul-Icons, Nutzerleiste (4/4), Einstellungen.
2. **Masterplayer** – fest für alle, kein Plugin. Nur Ansicht, keine Buttons: Wellenform des Ausgangs, Zeit, Takt, BPM, Tonart, Lautheit, L/R-Pegel.
3. **mixerMONK** – steht immer oben. Bei genau einem Nutzer immer offen, nicht schließbar. Nur der Halter kann ihn übergeben. Es gibt keine Anfrage.
4. **Die 15 anderen Plugins** – nacheinander in der Kopfreihenfolge (`plugins/registry.ts`):
   drop, song, effect, syntisampler, drumsampler, instru, biblio, voice, sound, stem, spatial, eq, dsp, master, record.
5. **Fuß** – fest für alle: perforMONK, aiMONK.

**Bildschirm ≠ Signalweg (Betreiber 2026-10-06).** Die lineare Reihenfolge
Quellen → Mixer → Nachbearbeitung → Recorder gilt **nur für die Verkabelung**
(Signalgraph, siehe „Signalkette“ unten). Auf dem Bildschirm steht der Mixer oben,
die übrigen Plugins folgen in der Kopfreihenfolge. Der Mixer zeigt den Signalweg
als eigene Leiste („Signalweg“), damit beides sichtbar bleibt.

## Formate (Betreiber 2026-10-06): gleiche Kopie, nur in klein

„Jedes Gerät gleiche Kopie, nur in klein." Es gibt **keine** eigenen Handy- oder Pad-Ansichten.

- Handy und Pad zeichnen die Oberfläche in der **Referenzbreite 1440 px**; der Browser verkleinert sie auf
  den Bildschirm (Viewport-Angabe `width=1440`). Zoomen mit zwei Fingern bleibt möglich.
- Der PC/Laptop zeigt dieselbe Oberfläche in seiner Fensterbreite.
- Keine Sonderregeln mehr nach Höhe (früher „short-landscape“) oder Zeigerart (früher größere Touch-Flächen) –
  sonst wäre die Kopie nicht dieselbe.
- Erkannt wird das Gerät weiter automatisch (`src/core/ui/deviceLayout.ts`): für die Ausgänge-Übersicht
  (echte Bildschirmauflösung) und fürs Vollbild.
- **Vollbild** (Handy quer, Pad quer): beim ersten Tippen angefordert. Ignoriert der Browser im Vollbild die
  Viewport-Angabe (Chromium tut das, gemessen), verlässt die App das Vollbild sofort wieder – die gleiche
  Kopie geht vor – und weist auf die **Home-Bildschirm-App** hin (Manifest `display: fullscreen`), die
  ohne Browserleisten läuft.
- Prüfung: `tests/deviceLayout.test.ts`, `tests/e2e/formats.spec.ts` (alle vier Formate zeichnen 1440 px,
  Mixer und Kopf gleich wie am PC, kein waagerechter Überlauf, Drehen).

## Session-Ausgänge (Betreiber 2026-10-06)

„1–4 Nutzer, die die UI gestreamt bekommen, ein Main-Ausgang Sound und ein Main-Ausgang Visuals."

| Platz | Gerät | Was es bekommt | Meldet |
|---|---|---|---|
| UI 1–4 | Session-Nutzer (Handy, Pad, PC) | die gespiegelte UI, jeder im **eigenen Format und eigener Auflösung** (siehe Formate) | Format + Auflösung |
| MAIN AUDIO | genau ein Gerät: `/master-out` (über Internet oder LAN) | Main-Ton | Zustand, Abtastrate, Kanäle |
| MAIN VISUALS | genau ein Gerät: `/visual-out` (über Internet oder LAN) | Visual-Stream in **eigener Auflösung** | Zustand, Bildschirm, ankommender Stream |

- Die Main-Ausgänge zählen nicht zu den 4 Nutzern.
- Jedes Gerät meldet sich selbst (`endpoint-report`); die Art bestimmt der Server aus dem Modus des
  Sockets – ein Nutzer kann sich nicht als Beamer ausgeben. Die Liste (`session-endpoints`) geht an alle.
- Genau ein Gerät je Main-Ausgang (Betreiber 2026-10-06): Das erste Gerät hält die Adresse, jedes weitere
  wird vom Server abgewiesen und zeigt „Der Main-Ausgang … ist schon auf einem anderen Gerät geöffnet“.
  Schließt das erste Gerät die Seite, ist die Adresse wieder frei.
- Knopf **AUSGÄNGE** im Kopf (in jedem Format): Zähler `n/4` und je ein Punkt für Ton und Bild;
  das Fenster zeigt die 6 Plätze mit Zustand und Auflösung sowie die Andock-URLs.
- Code: `src/core/session/sessionEndpoints.ts`, `src/hooks/useSessionEndpoints.ts`,
  `src/components/OutputsPanel.tsx`; Prüfung: `tests/sessionEndpoints.test.ts`, `tests/e2e/sessionOutputs.spec.ts`.

## Beständige Plugins (Betreiber 2026-10-06)

„Wenn User 3 aus dem EQ rausgeht und User 4 rein, muss die Einstellung bleiben – für alle Plugins. So kann
man switchen oder jemand anders kurz übernehmen lassen."

- **Nicht gehaltene Plugins** sind für alle eingeklappt und zeigen nur, ob und von wem sie gehalten werden.
- **Der Stand jedes Plugins liegt auf dem Server** (in der Session, mit ihr gesichert – übersteht Neuladen und
  Server-Neustart). Schreiben darf nur der Halter.
- Ändern: kurz entprellt (250 ms) an den Server. **Verlassen** (ON → OFF, Mixer übergeben, Seite schließen):
  sofort. Der Server verteilt jeden Stand; wer das Plugin als Nächstes holt, **startet genau damit** – in der
  Oberfläche und in der Audio-Engine.
- Mixer: Er ist bei allen geladen; der Stand greift im Moment der **Übernahme**.
- Gespeichert werden Einstellungen, keine Audiodaten: geladene Titel, aufgenommene Pad-Klänge und Takes
  bleiben auf dem Gerät und gehören in die Bibliothek.
- Umgestellt: mixer, eq, dsp, effect, master, spatial, drumsampler, syntisampler (Bereiche mpc/sampler/synth),
  instru, song, voice, stem, record. Ohne Einstellungen: drop, sound (nur Anzeige), biblio (Suche).
- Code: `src/core/session/pluginSettingsSync.ts`, `src/utils/pluginSettings.ts`,
  `AuthoritativeSession.setPluginSettings`; Prüfung: `tests/pluginSettings.test.ts`, `tests/e2e/pluginPersistence.spec.ts`.

## Stream-Auflösung (Betreiber 2026-10-06)

„Ein eigener Stream kann eine eigene Auflösung haben." Die Auflösung eines Ausgabe-Streams ist
**unabhängig vom Format des Senders** (Handy/Pad/PC). Umgesetzt für den Visual-Stream an den
Beamer (Ghostuser 6, `/visual-out`):

- Der Beamer meldet seinen Bildschirm als Session-Ausgang (`endpoint-report` → Server prüft → `session-endpoints`, siehe unten).
- Im Visual-Overlay wählt der Sender **Auflösung** und **FPS**:
  Auto (Beamer) · 720p · 1080p · 1440p · 4K · Hochkant 9:16 (1080×1920) · Quadrat 1:1 · 30/60 fps.
- **Auto** übernimmt Seitenverhältnis und Auflösung des Beamers, höchstens 1080p-Pixelmenge
  (ein Handy rendert nicht ungefragt 4K); ohne Beamer 1920×1080. 1440p/4K nur als ausdrückliche Wahl.
- Die Zeichenfläche hat genau die Stream-Größe; der Sender sieht sie eingepasst (Letterbox).
  Auflösung lässt sich live wechseln, die Bildrate vor dem Start.
- Der Beamer zeigt unten Bildschirm- und ankommende Stream-Auflösung.
- Code: `src/core/visual/streamResolution.ts`, `src/hooks/useStreamResolution.ts`;
  Prüfung: `tests/streamResolution.test.ts`, `tests/e2e/streamResolution.spec.ts`.

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

- AUTO_AI und PRO entfallen in der Oberfläche (README, AGENTS.md angeglichen). Intern bleibt `PRO` der aktive Modul-Zustand, `AUTO_AI` nur Altbestand. KI-Vorschläge kommen über aiMONK.
- Nummern 01–16 werden angezeigt, eindeutig nach Kopfreihenfolge (Betreiber-Vorlagen 2026-10-06). Kanalnummern 1–8 im Mixer bleiben.
- Verlässt der Mixer-Halter die Sitzung, geht der Mixer automatisch an die Person, die am längsten in der Sitzung ist (Entscheidung Betreiber).
