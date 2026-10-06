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
- Nummern 01–16 werden nicht angezeigt (Annahme).
- Verlässt der Mixer-Halter die Sitzung, geht der Mixer automatisch an die Person, die am längsten in der Sitzung ist (Entscheidung Betreiber).
