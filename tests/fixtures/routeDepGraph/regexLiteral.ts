// Fixture für scripts/route-dependency-graph.py (Blindstelle 2: Regex-Literale).
// Das Regex-Literal enthält ein Anfuehrungszeichen. Ein Scanner ohne Regex-Kenntnis
// hält es für einen String und verschluckt den Rest der Datei - dann wären weder
// die Route noch `hits` zu finden. Der Import ist zusätzlich der Testfall
// "Import-Zeile ist Deklaration, keine Nutzung" (sonst gilt jeder Import als geteilt).
import { randomUUID } from 'node:crypto';

const app: any = {};
let hits = 0;
const strip = (s: string): string => s.replace(/['"]/g, '');

app.post('/api/demo/strip', (req: any, res: any) => {
  hits += 1;
  res.json({ hits, v: strip('x'), q: req.query, id: randomUUID() });
});
