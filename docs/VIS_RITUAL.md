# vis · Ritual-Bausteine (Phasen, Taktbindung, Ebenen-Rollen)

Aus dem Konzept „Ritual" (mehrere Quellen, Videos + Fotos + Effekte zu einer Dramaturgie): übernommen wurde, was zu unserer
Architektur passt. Nicht übernommen: TouchDesigner/Resolume, OSC, Ableton Link, NDI/Spout (Desktop-Werkzeuge bzw. andere Topologie).

## Phasen-Makros
`POST /visual/phase {"phase": "build" | "trance" | "peak" | "release"}` (Aufbau, Trance, Höhepunkt, Auflösung) schaltet Preset,
Standzeit, Überblendzeit, Schwellen, Taktbindung und Effektzahl gemeinsam um. Quelle der Werte: `src/core/visual/visPhases.ts`,
`npm run build:vis-scene` schreibt `visual/phases.json` für den Pod. Status: `GET /visual/status` -> `phase`.

| Phase | Preset | Standzeit | Fade | Effekte | Takt |
| --- | --- | --- | --- | --- | --- |
| Aufbau | starfield | 10 s | 3 s | 1 | Takt |
| Trance | psy | 7 s | 2 s | 2 | Takt |
| Höhepunkt | inferno | 3 s | 0,4 s | 4 | Schlag |
| Auflösung | liquid | 12 s | 4 s | 1 | Takt |

## Beat- und Taktphase
Features dürfen `beatPhase` und `barPhase` enthalten (0 <= x < 1, Position im Schlag bzw. Takt). Fehlen sie, ändert sich nichts.
Mit Show-Option `quantize` = `beat` oder `bar` warten fällige Szenenwechsel (Dauer, Energiesprung, harter Schlag) auf die nächste
Schlag-/Taktgrenze (Rücksprung der Phase). Höchstens 4 s Überfälligkeit, danach wird sofort gewechselt. Das Backend liefert die
Phase noch nicht; das Feature-Feed aus dem Main-Mix ist weiterhin nicht gebaut.

## Ebenen-Rollen
Aktiv per Standard (`layerRoles: false` schaltet ab). Clips folgen Bass und Energie (Höhen und harte Schläge gedämpft), Bilder folgen
Mitten und Höhen als Näherung für die Melodie (Bass zurückgenommen). Szenenwechsel und Effekt-Regie sehen weiter die ungewichteten
Features, Effekte reagieren also unverändert auf Anschläge. Es gibt noch kein eigenes Melodie-/Stem-Signal im Renderer.

## Noch offen
- Das vis-Agent-Schema kennt die Phase nicht; der Agent steuert weiter über Preset/Fade/Standzeit/Effekte.
- Pro-Quelle-Features (Schlagzeug, Synth ...) aus den acht Plugin-Quellen: erst, wenn das Feature-Feed steht.
