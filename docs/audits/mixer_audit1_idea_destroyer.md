# mixerMONK · Idea-Destroyer-Audit

**Stand:** 21. November 2026 · **Audit-Revision:** `c7b69990670f3276616030b885f05e3c691532d8`

mixerMONK ist der gemeinsame Stereo-Mixer mit einem autorisierten Main-Out-Halter. Die Oberfläche erlaubt echte Kanalbearbeitung, zeigt aber auch Regler an, deren Werte im Desk-Zustand gespeichert werden und deren Audioverbraucher fehlen. Das fällt erst im Set auf: Eine Bewegung ist sichtbar und nach dem Handover wieder da, während der Klang unverändert bleibt.

## Bestätigte Befunde

| ID | Befund | Evidenz | Abnahme |
|---|---|---|---|
| MIX-IDEA-01 | Kanalfilter und Effekt-Send werden im Desk-State gespeichert. | `MixerDesk.tsx:138` schreibt Gain, EQ und Panorama. `:172–174` schreibt Filter und Send lediglich in den Kanalzustand. | AM-15 mit Einzeltönen und definiertem Signal. Filter muss pro Kanal den Frequenzgang ändern. Send muss dosiert am vorgesehenen Effekt-Return ankommen. |
| MIX-IDEA-02 | Drei Makros und FX LOCK versprechen hörbare Bearbeitung. | `MixerDesk.tsx:456,526–528` ändert Zustand. Der dort aufgerufene Update-Pfad `:235–241` nutzt standardmäßig keinen Engine-Push. | AM-15. Summe-Filter, FX-Return und Build-up erhalten messbare Wirkung oder die Bedienelemente werden aus dem Release-Umfang genommen. FX LOCK entscheidet ausdrücklich über Makro-Auswirkungen. |
| MIX-IDEA-03 | Sechs Pad-Regler je Deck haben einen gespeicherten Wert. | `DeckControllers.tsx:278–281` bindet jeden Regler an `s.knobs[i]`. In der Komponente gibt es keinen Signal- oder Parameterverbraucher für die Werte. | AM-15. Pro sichtbarem Regler ein belegter Verbraucher, eine verständliche Beschriftung und ein wiederherstellbarer Zustand. |
| MIX-IDEA-04 | Main-Out wird als anklickbares Element angezeigt. | `MixerDesk.tsx:443` enthält einen Button ohne Aktion. | AM-15. Der Signalweg bezeichnet Main-Out als Status. Eine Aktion braucht ein Ziel, einen Berechtigungsvertrag und einen Test. |
| MIX-IDEA-05 | Ein Halterwechsel spielt den gespeicherten Desk erneut in die Engine. Audiosummen und beide Cue-Wege müssen nach dem Wechsel aufeinander abgestimmt bleiben. | `MixerDesk.tsx:252–262` lädt den Desk beim Übergang zu Main-Out-Ownership, schreibt die Kanalparameter und setzt Main-Gain. `:358–361` enthält den separaten Main-Out-Update-Pfad. Das ist ein Szenario für die Abnahme. | AM-13/15/30. Zwei getrennte Halter übernehmen nacheinander während eines laufenden Signals. Pegelfolge, autorisierter Writer, private Cue-Auswahl und Click-/Dropout-Verhalten protokollieren. |

## Testsequenz für AM-15

1. Bei −18 dBFS je einen Tief- und Hochton einspeisen. Den Kanalfilter aus seiner neutralen Position bewegen. Verhältnisse im betroffenen Kanal und im Nachbarkanal im selben Lauf vergleichen.
2. Einen kurzen Impuls auf den zugeordneten Effekt-Send geben. Dry und Return einzeln erfassen. Send 0, einen Mittelwert und den Maximalwert prüfen. Der Return muss seine eigene Pegel- und Bypass-Semantik behalten.
3. Makros aus neutraler Position fahren. Pro Makro die Zielparameter und den hörbaren Effekt registrieren. FX LOCK ein- und ausschalten und die verbundene Sperrwirkung testen.
4. A/B-Überblendung, Mute/Solo, Track-Stop und Main-Out abrufen. Auf Einzelspuren und der Summe RMS/Peak beobachten. Main-/Monitor-Signale getrennt erfassen.
5. Handover und Reload mit dokumentiertem Desk-Zustand. Eine zweite Identität betrachtet den Desk und bedient ihren privaten Monitor. Nur der aktuelle Main-Out-Halter setzt gemeinsam wirksame Parameter.

Das bestehende Struktur-Audit nennt Undo/Redo, Linking und Multiroom. Deren Aufnahme in den ersten Release bleibt AM-32 zugeordnet. Der neue Bericht bestätigt die oben gelisteten Codepfade. Klang, Zeitverhalten und die Mehrnutzerabnahme sind damit noch zu messen.

[Struktur-Audit](mixer_audit2_structure.md) · [Wiring-Backlog](../../VerkabelungsToDo.md) · [Agenten-Release-TODO](../../RELEASE_TODO.md)
