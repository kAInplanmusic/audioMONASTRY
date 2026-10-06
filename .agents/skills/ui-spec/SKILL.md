---
name: ui-spec
description: Verbindliche Oberflächen-Regeln für audioMONASTRY (Aufbau, Modi OFF/STBY/ON, mixerMONK-Halter, SYNC gegen Main, Kopf-Icons, Farben, Bildschirm- vs. Signalreihenfolge). Use when changing any UI, plugin strip, header icon, mixer view, mode/lock behaviour, labels, or when wiring the v2 audio graph to the UI.
---

# UI-Spezifikation – Skill

Quelle der Wahrheit ist `docs/UI_SPEC.md`; die sichtbare Vorlage ist
`docs/design/audioMONASTRY-design.html`, der Verkabelungsvertrag für v2
`docs/design/V2_UI_VERKABELUNG.md`. Dieser Skill fasst die Regeln zusammen und
zeigt, wo sie im Code stehen. Bei Widerspruch gilt `docs/UI_SPEC.md`.

## Aufbau (oben → unten)

1. Kopf: Logo, 16 Modul-Icons (`src/components/HeaderPluginIcon.tsx`), Nutzer 4/4, Version aus `package.json`.
2. masterplayerMONK: **nur Ansicht**, keine Buttons (Zeit, Takt, BPM, Tonart, LUFS, Wellenform).
3. mixerMONK, dann die 15 anderen Plugins in **Kopfreihenfolge** (`src/plugins/registry.ts`), nummeriert 01–16.
4. Fuß: perforMONK, aiMONK.

**Bildschirm ≠ Signalweg.** Die Signalkette (`src/plugins/signalChain.ts`)
Quellen → Mixer → Nachbearbeitung → Recorder → Main Out gilt nur für die
Verkabelung; die App zeigt sie als Leiste (`src/components/SignalChainBar.tsx`).

## Formate: gleiche Kopie, nur in klein

Jedes Gerät zeigt dieselbe Oberfläche. Handy und Pad zeichnen 1440 px
(`DESIGN_WIDTH`, Viewport-Angabe) und werden verkleinert. Keine Klassen oder
Regeln, die je Gerät, Höhe oder Zeigerart anders aussehen (kein phone:, touch:,
short-landscape: o. ä.). Prüfung: `tests/e2e/formats.spec.ts`.

## Beständige Plugins

Plugin-Einstellungen gehören in die Session, nie nur in lokalen State oder
Browser-Speicher: `readPluginSettings(id, { section, legacyKey })` als
Einstiegsstand, `writePluginSettings(id, stand)` bei jeder Änderung
(`src/utils/pluginSettings.ts`). Beim Verlassen ruft die App
`flushPluginSettings`. Werte aus fremden Ständen immer mit `mergeKnown`
prüfen. Nicht gehaltene Plugins sind eingeklappt (nur „ob und wer").

## Session-Ausgänge

1–4 UI-Nutzer (jeder eigenes Format/eigene Auflösung) + genau ein Gerät Main Audio
(`/master-out`) + genau ein Gerät Main Visuals (`/visual-out`); weitere werden abgewiesen. Geräte melden sich per
`endpoint-report`, der Server verteilt `session-endpoints`
(`src/core/session/sessionEndpoints.ts`). Ausgänge zählen nie als Nutzer.

## Stream-Auflösung

Ausgabe-Streams haben ihre eigene Auflösung, nie die des Sendergeräts
(`src/core/visual/streamResolution.ts`): Auto = vom Empfänger gemeldet
(`endpoint-report` des Beamers), sonst feste Presets. Zeichenflächen für Streams in
Stream-Pixeln anlegen, nicht aus `clientWidth × devicePixelRatio`.

## Modi und Sperren

- Modus-Button rechts am Streifen: **OFF → STBY → ON → OFF** (`src/core/session/pluginMode.ts`).
  OFF = frei · STBY = gehalten, nicht aktiv · ON = aktiv, Bedienfläche nur beim Halter offen.
- Fremde Plugins sind gesperrt: kein Anfragen, kein Übernehmen. Nie lokal vorbei am zentralen Lock schalten.
- mixerMONK: immer ON, **immer genau ein Halter** (Server: `AuthoritativeSession.ensureHolder`, `server/realtime.ts`).
  Nur der Halter übergibt; Freigeben wird abgelehnt; verlässt er die Sitzung, bekommt ihn das am längsten anwesende Mitglied.
- Gehaltene Plugins werden per Heartbeat verlängert (`LOCK_HEARTBEAT_MS` in `src/context/PluginManagerContext.tsx`).
- Ton auf Main startet nur der Mixer-Halter.

## SYNC gegen Main

drop, song, syntisampler, drumsampler, instru, voice, sound, stem haben eine
SYNC-Taste (Standard an, nur der Halter schaltet). Zustand: `src/core/session/pluginSync.ts`.
Sample-genaue Quantisierung gehört in den Audio-Thread (v2-Verkabelung), nie in React.

## Kopf-Icons und Farben

- 16 verschiedene Symbole und Farben; Modulfarbe `hsl(i*22.5+11, 72%, 64%)`, i = Kopfposition (mixer = 0), Klassen `.monk-theme-*` in `src/index.css`.
- Status nur als Schein (frei grünlich, fremd dunkelrot, eigen mit Ring), nie als Farbwechsel des Symbols.

## Namen

Nur die README-Namen (16 Plugins + masterplayerMONK, aiMONK, perforMONK).
`tests/uiLabels.test.ts` prüft sichtbare Texte auf andere *MONK-Namen, Tippfehler und Platzhalter.

## Prüfen vor dem Abschluss

- `npx vitest run tests/uiPluginModes.test.ts tests/uiHeaderIcons.test.ts tests/uiLabels.test.ts tests/uiMasterplayer.test.ts`
- e2e (lokal, Dev-Server): `STUDIO_ACCESS_TOKEN=… AUDIOMONASTRY_TEST_RESET=1 npx playwright test` – Specs nutzen
  `modeButton`, `rackRow`, `switchPluginOn` aus `tests/e2e/helpers/studioNav.ts` und die Attribute
  `data-plugin-mode` / `data-plugin-owner` am Streifen.
- `npm run verify` (AGENTS.md).
