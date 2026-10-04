# audioMONASTRY – Oberflächen-Spezifikation

Stand: 2026-10-04 · Sichtbare Vorlage: `docs/design/audioMONASTRY-design.html` · Modulliste: die 16 aus der README

## Aufbau (von oben nach unten)

1. **Kopf** – fest für alle. Logo, 16 Modul-Icons, Nutzerleiste (4/4), Einstellungen.
2. **Masterplayer** – fest für alle, kein Plugin. Nur Ansicht, keine Buttons: Wellenform des Ausgangs, Zeit, BPM, Takt, Tonart, L/R-Pegel.
3. **mixerMONK** – bei genau einem Nutzer immer offen, nicht schließbar. Nur der Halter kann ihn übergeben. Es gibt keine Anfrage.
4. **Quellen** (liegen im Signalweg vor dem Mixer): biblio, drop, song, drumsampler, syntisampler, instru, voice, sound, stem.
5. **Nachbearbeitung** (liegen im Signalweg nach dem Mixer): effect, eq, dsp, spatial, master, record.
6. **Fuß** – fest für alle: perfMONK, aiMONK.

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

## Annahmen und offene Punkte

- AUTO_AI und PRO entfallen (Annahme). KI-Vorschläge kommen über aiMONK.
- Nummern 01–16 werden nicht angezeigt (Annahme).
- Verlässt der Mixer-Halter die Sitzung, geht der Mixer automatisch an die Person, die am längsten in der Sitzung ist (Entscheidung Betreiber).
