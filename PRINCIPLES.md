# PRINCIPLES.md — audioMONASTRY

> **Status:** verbindlich ab 2026-09-23 · Owner: Betreiber (`kAInplanmusic`)
> **Verhältnis zu `AGENTS.md`:** `AGENTS.md` regelt die *Technik* (Architektur,
> Plugin-Vertrag, Latency-Mandat). Diese Datei regelt die *Haltung* — sie
> entscheidet im Zweifel, ob eine technisch saubere Lösung auch gebaut wird.

---

## 1. Die Grundsätze

Vom Betreiber vorgegeben. Bei Konflikt schlägt der höhere Grundsatz den
niedrigeren; bei Konflikt zwischen einem Grundsatz und einem Feature gewinnt
der Grundsatz.

1. **Audio bleibt lokal.** AudioMONASTRY wird vollständig im Browser und auf
   eigener Infrastruktur ausgeführt. AudioMONASTRY wird nicht wegen einer
   fehlenden Sonderfunktion für externe Datenquellen geöffnet.
2. **Keine Funktion ungenutzt.** Was gebaut ist, muss erreichbar sein und
   benutzt werden. Toter, nie gerenderter Code ist ein Regelverstoß, kein
   Schönheitsfehler (siehe `ARCH-P3-001` in `MASTERTODOENDE.json`).
3. **Hörbar exzellent schlägt brauchbar.** Eine Funktion, die den Klang
   verschlechtert, wird nicht ausgeliefert — auch wenn sie technisch korrekt ist.
4. **Keine neuen Erweiterungen, bevor alle vorherigen zu 100 % laufen** und die
   Nutzer-Zufriedenheit über 90 % liegt. Das ist die härteste Regel und der
   Grund, warum diese Datei vor jedem neuen Plugin gelesen wird.
5. **Absolute Kostenkontrolle auf Guthaben-Basis.** Es wird nur ausgegeben, was
   vorher gedeckt ist. Kein Auto-Scaling ohne Deckel, kein Dauerbetrieb, keine
   Kosten ohne Alarm bei 50 % Budget.
6. **Modelle und Prompts immer aktuell — und geloggt.** Jede Modell-/Prompt-
   Änderung ist versioniert und nachvollziehbar. Kein stiller Modellwechsel.
7. **Spezialisten einbeziehen.** Bei Unsicherheit wird nicht geraten, sondern
   geprüft (Werkzeug, Messung, Fachquelle). `ANNAHME:` und `TODO(verify):` sind
   erlaubte, markierte Zwischenstände — stille Vermutungen nicht.
8. **Niemals aufgeben.**

> `ANNAHME:` Der Startbefehl spricht von „PRINCIPLES.md mit 5 Sätzen", listet
> aber acht. Ich habe alle acht übernommen statt fünf auszuwählen — Auswahl wäre
> eine inhaltliche Entscheidung des Betreibers. `TODO(operator):` Falls es
> genau fünf sein sollen, streichen.

## 2. Klausur — die drei Nicht-Ziele

Diese drei Dinge bauen wir **nicht**. Sie sind die Grenze, an der ein Wunsch
zu einem anderen Projekt wird:

1. **Kein eigenes Audio-Interface.** Wir sind Software. Hardware-Treiber,
   FPGA/DSP-Boards und Geräte-Firmware gehören nicht hierher.
2. **Kein Kino-Audio.** Dolby Atmos, THX-Zertifizierung und Film-Mastering-
   Formate sind nicht das Ziel. Stereo und Surround-Abmischung ja, Kino-Spec nein.
3. **Keine eigene Lichtanlage.** Lichtsteuerung wird nicht nachgebaut;
   Visuals sind Bildschirm-/Beamer-Ausgabe, nicht DMX-Bühnensteuerung.

Wer eines dieser Ziele will, braucht dafür ein eigenes Projekt mit eigenen
Grundsätzen.

## 3. Zelle — jedes Bedienelement muss Nutzen haben

**Regel:** Der Profi-User-Flow hat Vorrang vor Reduktion. Ein Element wird erst
entfernt, wenn belegt ist, dass es keinen Nutzen hat — „aufgeräumt wirkt
besser" ist kein Beleg.

**Befund 2026-09-23 (`ARCH-P3-001`, aus dem Audit):** Die Regel ist im Repo
**verletzt**. 24 Dateien haben null Import-/Require-/Pfad-Statements und werden
nie erreicht — darunter `src/components/ModuleContainer.tsx`, dessen
`✕ OFF`-Button damit unerreichbar ist (der Rack-Power-Button ist heute der
einzige Schließweg; belegt in `tests/e2e/pluginCloseSync.spec.ts:20-22`).
Das ist genau der Fall, den dieser Grundsatz verbietet: gebaut, aber nicht
benutzbar.

## 4. Stille als Feature

**Audit 2026-09-23, gemessen:**

| Prüfung | Ergebnis |
|---|---|
| `new Notification(...)` / `Notification.requestPermission` | **0 Treffer** in `src/` ✅ |
| `window.alert(...)` / `alert(...)` | **0 Treffer** in `src/` ✅ |
| Unaufgeforderte Audio-Signale (Beeps, Alarmtöne) | **keine** ✅ |
| `new Audio(...)` | 7 Stellen — **ausschließlich** nutzerausgelöste Hörproben (Library, Deck, Recorder, Sound/Song/MCP/Drum-Terminal, SingingEngine) |
| Operator-Alarme | `SLACK_WEBHOOK` + `ALERT_WEBHOOK_TOKEN` (min. 16 Zeichen, fail-closed) — gehen **an den Betreiber**, nicht an den Nutzer ✅ |

**Ergebnis: PASS.** Die App unterbricht den Nutzer nicht ungefragt. Wird ein
neues Benachrichtigungs-Feature gebaut, muss es hier zuerst eingetragen und
begründet werden.

## 5. Ora et labora — Rhythmus

**Festgelegt:** Offene Diskussion ist erlaubt; die Antwortzeit ist unbestimmt.
Es gibt keinen Anspruch auf sofortige Reaktion.

**Ruhe-Modus (Betreiber-Entscheidung 2026-09-23, umgesetzt):** Alarme sind
**22–07 Uhr ruhig**. In diesem Fenster werden Meldungen **zurückgehalten und beim
ersten Kontakt danach gebündelt zugestellt**. **Kritische Alarme durchbrechen die
Ruhe sofort** (`severity`/`priority` = `critical`, `fatal`, `page`).

| Aspekt | Festlegung |
|---|---|
| Fenster | 22–07 Uhr, konfigurierbar über `ALERT_QUIET_HOURS="22-7"` |
| Abschaltbar | `ALERT_QUIET_HOURS_OFF=1` |
| Kritisch (kommt durch) | `severity` ∈ {`critical`, `fatal`, `page`} oder `priority` ebenso |
| Zurückgehalten | alles andere, **nicht verworfen** — begrenzter Puffer (100), Verluste werden gezählt und laut gemeldet |
| Nachlieferung | beim ersten Alarmkontakt nach dem Fenster, als **eine** Sammelmeldung |
| Nicht enthalten | eigener Scheduler. Ohne Alarmkontakt nach dem Fenster gibt es nichts zu liefern; nach einem Prozess-Neustart ist der Puffer leer — dafür ist `repeat_interval`/`group_wait` im Alertmanager zuständig. |

Beleg: `server/quietHours.ts`, 21 Tests in `tests/quietHours.test.ts`
(Grenzstunden 21:59/22:00/07:00, Mitternachtsübergang, kritische Ausnahme,
Puffer-Überlauf, Bündelung mit Deckelung).

## 6. Nachhaltigkeit statt Wachstum

**Regel:** Lieber kuratiert klein als unkontrolliert groß. Kein Wachstumsziel.

**Die Zugangsregel, konkret (Betreiberentscheidung 2026-09-24):**

1. **Es gibt keine Anmeldung.** Kein Signup, keine Registrierung, keine
   Selbstbedienung — es gibt technisch nichts, wobei man sich anmelden könnte.
2. **Zugang entsteht nur persönlich.** Wer dabei sein soll, bekommt den
   Studio-Zugang (`STUDIO_ACCESS_TOKEN`, fail-closed: ohne Token kein Zugang)
   von Hand ausgegeben. Das ist der Deckel.
3. **Es gibt keine öffentliche Instanz.** Die Flotte ist aus, wenn nicht
   gearbeitet wird — oder für einen geplanten Lauf an.
4. **Obergrenze einer Sitzung: 4 Personen** — das ist eine *dokumentierte
   Auslegungsgrenze*, **keine erzwungene**. Es gibt keine Konstante im Code, die
   eine fünfte Verbindung abweist (gemessen am 2026-09-24: kein
   `MAX_PARTICIPANTS`/`MAX_USERS` vorhanden). Wer sie überschreitet, merkt es an
   der Qualität, nicht an einer Fehlermeldung. Das steht hier, damit sich niemand
   auf eine Sperre verlässt, die es nicht gibt.
5. **Kein Wachstumsziel.** Wenn jemals mehr Zugänge entstehen sollen, als
   begleitet werden können, wird **vorher** ein Deckel oder eine Warteliste
   gebaut — nicht nachträglich.

**Warum kein Signup-Limit gebaut wurde:** Ein Limit für eine Anmeldung, die es
nicht gibt, wäre Code ohne Wirkung. Das Nachhaltigkeits-Instrument ist hier die
**geschlossene Ausgabe**: kein öffentlicher Weg hinein, keine Selbstregistrierung,
Zugang nur persönlich. Damit ist „klein bleiben" keine Absichtserklärung, sondern
der Zustand.

`TODO(verify):` Bekommt dieses Projekt je einen öffentlichen Zugang, ist der Punkt
neu zu bewerten: dann gehören Deckel und Warteliste wirklich gebaut und die
4-Personen-Grenze im Code erzwungen. Solange es privat ist, wäre beides Theater.

## 7. Skriptorium — Ausgabe in Standardformaten

**Regel:** Was das Haus verlässt, muss ohne uns lesbar sein.

| Anforderung | Stand 2026-09-23 |
|---|---|
| Audio-Export in Standardformaten | ✅ WAV (bit-genau, `recordMONK`) + MP3/FLAC/AAC(M4A)/OGG über `POST /api/audio/encode` (`FEAT-P3-004`, DONE) |
| Zustands-/Projekt-Export | ✅ `exportGraphState()` → JSON, validiert beim Import (`audioGraphSerialization`) |
| Lizenz | ✅ `LICENSE` vorhanden (proprietär, alle Rechte vorbehalten) + `license: UNLICENSED` in `package.json` (`PROD-P1-005`, DONE 2026-09-23) |
| Doku | ✅ `README.md` (deutsch, einzige Fassung) + 61 Dateien in `docs/` |
| Impressum / Datenschutz | ✅ unter `/impressum` und `/datenschutz`, **ohne** Zugangstoken erreichbar (`PROD-P0-005`). Betreiber-Angaben fehlen noch und werden auf der Seite sichtbar angemahnt. |

## 8. Warum

**Diese Frage beantwortet der Betreiber privat.** Sie ist nicht Teil des Repos,
bestimmt aber die Härte, mit der die Grundsätze oben durchgesetzt werden —
insbesondere Grundsatz 4 („keine neuen Erweiterungen, bevor alles läuft").

`TODO(operator):` Wenn der Betreiber das „Warum" schriftlich festhält, gehört
hier ein Verweis darauf — nicht der Inhalt.
