# DB2: Session DB Schema (Lokal – Google-frei)

> Frueher war dies eine Firestore-Schema-Beschreibung fuer Multiplayer-Sessions.
> Jetzt laufen Sessions rein LOKAL im Browser (kein Firestore, kein Google).

## Lokale Implementierung

- Kollaborations-Session: `src/utils/collab.ts` (in-memory + localStorage-Nutzeridentitaet)
- B2B-Raeume: `src/hooks/useRoom.ts` / `src/components/B2BModal.tsx` (in-memory, pro Tab)
- Audit-Log: `src/utils/AuditLogger.ts` (Konsolen- + localStorage-Log)

## Objektstruktur (referenz)

### Session (lokal)
- `locks`: Map<String, userId> – plugin/module -> Besitzer
- `playback`: { isPlaying: Boolean, bpm: Number }
- `sequencer`: { patterns: Object, synthNotes: Array<Number> }
- `mastering`: { cutoff, resonance, delayTime, decay }
- `activeUsers`: Map<userId, { name, color, lastSeen }>
