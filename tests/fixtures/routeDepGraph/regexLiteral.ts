// Fixture für scripts/route-dependency-graph.py (Blindstelle 2: Regex-Literale).
// Das Regex-Literal enthält ein Anfuehrungszeichen. Ein Scanner ohne Regex-Kenntnis
// hält es für einen String und verschluckt den Rest der Datei - dann wären weder
// die Route noch `hits` zu finden. Der Import ist zusätzlich der Testfall
// "Import-Zeile ist Deklaration, keine Nutzung" (sonst gilt jeder Import als geteilt).
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const app: any = {};
let hits = 0;
const strip = (s: string): string => s.replace(/['"]/g, '');

app.post('/api/demo/strip', (req: any, res: any) => {
  hits += 1;
  // `join` steht NUR in einer Template-Interpolation - der Scanner muss ${ ... }
  // als Code behandeln, sonst fehlt der Import im extrahierten Modul.
  res.json({ hits, v: strip('x'), q: req.query, id: randomUUID(), p: `out/${join('a', 'b')}.wav` });
});
