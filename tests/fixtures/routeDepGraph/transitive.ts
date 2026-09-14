// Fixture für scripts/route-dependency-graph.py (Blindstelle 1: Transitivität).
// Die Route nutzt nur helperA - sharedTarget und counter liegen eine Ebene tiefer.
// Bewusst typ- und lint-sauber: tsconfig.json hat kein `include`, die Fixtures
// werden also von tsc und eslint mitgeprüft.
const app: any = {};
const sharedTarget = { url: 'http://127.0.0.1:11434' };
let counter = 0;

function helperA(): string {
  counter += 1;
  return sharedTarget.url;
}

app.get('/api/demo/one', (req: any, res: any) => {
  res.json({ v: helperA(), q: req.query });
});

app.get('/api/demo/two', (req: any, res: any) => {
  res.json({ n: counter, q: req.query });
});
