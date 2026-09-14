// Fixture für scripts/route-dependency-graph.py (Blindstelle 3: Gruppe != Block).
// Zwei Routen desselben Präfix, getrennt durch eine fremde Route. Eine Extraktion,
// die nur den größten zusammenhängenden Bereich nimmt, übersieht die zweite.
const app: any = {};
const shared = { v: 1 };

app.get('/api/demo/a', (req: any, res: any) => res.json({ q: req.query, shared }));
app.get('/api/other/b', (req: any, res: any) => res.json({ q: req.query }));

app.post('/api/demo/c', (req: any, res: any) => res.json({ q: req.query, shared }));
