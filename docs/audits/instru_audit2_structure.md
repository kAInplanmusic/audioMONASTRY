# audit2_structure — instruMONK (Plugin `instru`, Kanal 5)

**Status:** abgeschlossen (Struktur-Audit)  
**Basis:** `src/components/InstrumentsTerminal.tsx`, `src/plugins/adapters/InstruPluginAdapter.ts`, `src/plugins/pluginContract.ts`, `src/plugins/adapters/BasePluginAdapter.ts`, `src/plugins/registry.ts`, `src/plugins/plugin_interface.ts`  
**Artefakte geprüft:** Hauptrepo + Worktree `audioMONASTRY-instru` (byte-identisch)

---

## 1. Grundkonzept

instruMONK ist ein source-Plugin (Kanal 5, stereo) zur Instrumentenwahl und Notenwiedergabe. UI-Terminal (`InstrumentsTerminal`) plus Adapter (`InstruPluginAdapter`) plus globales `instrumentBackend`. Steuert über Commands (`program`, `note`, `optional-voice`) den Klang, persistentiert Einstellungen über `pluginSettings`.

---

## 2. Architektur-Analyse

### Komponenten-Zusammenhang
```
Registry (registry.ts)
  └─ COMPONENT_MAP.instru -> InstrumentsTerminal (lazy import)
  └─ Adapter: InstruPluginAdapter (MANIFEST id 'instru', kind 'audio-source')
        └─ BasePluginAdapter (onCommand, scheduleSyncStart, context)
        └─ instrumentBackend (core/instrument/InstrumentBackend)  [globaler Singleton]
        └─ audioEngine (utils/audioEngine)                        [globaler Singleton]
        └─ webMIDIAdapter (core/adapters)                         [globaler Singleton]
UI: InstrumentsTerminal (React.memo, 5 Views, pluginSettings, webRTCManager lock)
```

### Datenfluss
1. UI: Nutzer wählt Instrument → `loadInstrument` → `instrumentBackend.load(id)`; Einstellung wird via `writePluginSettings('instru', …)` persistiert.
2. UI: MIDI Program Change → `webMIDIAdapter.onControl` → `instrumentBackend.handleProgramChange` → `setActiveInstrument` + `setMidiProgram`.
3. UI: Note spielen → `instrumentBackend.noteOn/off` oder `audioEngine.instrumentNote`.
4. Adapter: Commands `program`/`note`/`optional-voice` delegieren an die gleichen globalen Backends.

### Abhängigkeiten (InstrumentsTerminal)
React, lucide-react, `./am/amUi`, `./DropTarget`, `../data/samples`, `../hooks/usePluginState`, `../utils/audioEngine`, `../core/instrument/catalog`, `../core/instrument/InstrumentBackend`, `../core/adapters`, `./instrument/*` (4 Komponenten), `../utils/WebRTCManager`, `../utils/pluginSettings` — **14+ direkte Imports**, hohe Kopplung.

---

## 3. Technische Fehlannahmen (Strukturell)

- **Annahme: Adapter ist die Command-Schicht des Plugins.** Wirklichkeit: Das Terminal ruft `instrumentBackend`/`audioEngine` direkt auf; der Adapter (`InstruPluginAdapter`) wird von der Registry kaum für instru-Spezifisches genutzt — er doppelstückelt Commands, die das Terminal ohnehin direkt ausführt. Unklare Verantwortung: Wer darf was? Terminal oder Adapter?
- **Annahme: `singleInstance: true` schützt vor Doppel-Instanziierung.** Wirklichkeit: Es gibt keine Instanz überhaupt — nur globale Singletons. Der Vertrags-Begriff ist hier bedeutungslos.
- **Annahme: `React.memo` verhindert unnötige Re-Renders.** Wirklichkeit: Die Komponente erstellt bei jedem Render neue Arrays (`[...PRESET_INSTRUMENTS, ...SYNTH_PRESET_INSTRUMENTS]`, Zeile 117, 119) und neue Objekt-Referenzen, wodurch `memo` ohne tiefen Vergleich wenig bringt; die `useEffect`-Dependencies (`[saved]`, `[activeInstrument, activeCategory, playView]`) sind inkonsistent.

---

## 4. Designschwächen

- **SRP-Verletzung:** `InstrumentsTerminal` mischt UI-Rendering, MIDI-Verbindung, Sample-Drop, Preset-Loading, Settings-Persistenz und View-Management auf 239 Zeilen.
- **Globale Singletons als versteckte Abhängigkeiten:** `instrumentBackend`, `audioEngine`, `webMIDIAdapter` werden nicht über Props/Context injected, sondern hardcodiert importiert. Testbarkeit und Ersetzbarkeit (z. B. für Offline- oder Mock-Modus) nicht gegeben.
- **Lazy-Imports im Command-Pfad:** `import('../../core/instrument/InstrumentBackend')` innerhalb `onCommand` — erste Command-Ausführung löst Code-Loading aus, nicht deterministisch für Echtzeit-MIDI.
- **Kein Interface zwischen Adapter und Terminal:** Beide rufen dieselben globalen Backends auf; kein Vertrag, wer state besitzt (`activeInstrument` lebt nur im Terminal, `instrumentBackend.current()` separat).
- **Settings als globaler Key-Store:** `pluginSettings('instru')` ist ein flacher Key/Value-Speicher ohne Schema-Versionierung; ein Strukturwechsel der Einstellungen bricht gespeicherte Werte stillschweigend.

---

## 5. Performance-/DSP-Risiken

- **Kein eigener Audio-Graph-Knoten:** Es gibt nichts, was man für PDC verzögern oder als Bypass legen könnte. `intrinsicLatencyFrames: 0` ist nicht durch den Code abgedeckt (kein Node, keine Latenzmessung).
- **Synchroner Blocking-Risiko beim Preset-Wechsel:** `instrumentBackend.load(inst.id)` wird `await`ed im UI-Thread; bei großen Soundfonts friert die UI kurz ein (kein Suspense/Loading-Skeleton beyond `isLoading`-Flag).
- **WebMIDI Polling/Connect bei jedem Mount:** `webMIDIAdapter.connect()` ohne Backoff oder Cache; wiederholte Mounts/Unmounts rufen Connect mehrfach auf.
- **Kein Sample-Cache:** Jeder Preset-Wechsel lädt das Sample neu über das globale Backend, keine Wiederverwendung bereits geladener Instrumente.

---

## 6. Schnittstellen-Probleme

| Schnittstelle | Problem |
|---------------|---------|
| `InstruPluginAdapter.MANIFEST` vs Vertrag | `latencySamples: 0`, `tailSamples: 0` — widersprechen nicht explizit, aber es wird keine Latenz gemessen oder gemeldet. |
| Adapter `onCommand(payload?: Record<string, unknown>)` | Keine Typisierung; `Number(command.payload?.program ?? 0)` kann `NaN` erzeugen, das stillschweigend an `handleProgramChange` weitergereicht wird. |
| `audioEngine.instrumentNote(note)` | `note as string | number` — keine Absprache mit der Engine über Format/Range; unbekannte Noten führen undefiniert. |
| Registry `COMPONENT_MAP.instru` → lazy import | Lazy-Chunk wird erst beim ersten Aktivieren geladen; keine Preload-Strategie für den Start-Kanal. |
| `usePluginState('instru', 'PRO')` | Liefert `lockStatus`, aber der Lock wird für WebMIDI-Program-Change nur teilweise geprüft (Zeile 141 prüft `lockedBy`, der Command-Pfad im Adapter nicht). |

---

## 7. Empfohlene Korrekturen

1. **Verantwortung trennen:** Entweder das Terminal ruft die Backends direkt auf (Adapter entfernt) ODER der Adapter ist die einzige Command-Schicht und das Terminal kommuniziert nur über Commands. Aktuelle Doppelspurigkeit auflösen.
2. **Abhängigkeiten injizieren:** `instrumentBackend`, `audioEngine`, `webMIDIAdapter` über Props oder ein Plugin-Context injecten, statt hardcoder Imports; ermöglicht Unit-Tests mit Mocks.
3. **Kanal-Parameter durchziehen:** Alle Audio-Aufrufe erhalten den vertraglichen Kanal (5) bzw. einen `TrackType`; `channel1` hardcodiert entfernen.
4. **Interfaces einführen:** `InstrumentBackend` und `audioEngine` über TS-Interfaces typisieren, damit das Plugin nicht an konkrete Implementierungen gekoppelt ist.
5. **Memo stabilisieren:** `instruments`-Array außerhalb der Komponente oder mit `useMemo` stabilisieren; neue Objekt-Referenzen bei jedem Render vermeiden.
6. **Effekt-Dependencies korrigieren:** Die `useEffect` für WebMIDI hat ein deaktiviertes eslint-disable für exhaustive-deps — entweder Dependencies korrekt angeben oder Verbindung stabilisieren (einmal connect, nicht bei jedem Mount).
7. **Validierung im Adapter:** `program` und `note` vor Weitergabe validieren (Range-Check MIDI 0–127), `NaN` abfangen.
8. **Latenz ehrlich abbilden:** Entweder eigenen DSP-Node mit Bypass-Crossfade bauen oder Vertrag auf `producesAudio: false` / Rolle `utility` ändern und `intrinsicLatencyFrames` entfernen.
