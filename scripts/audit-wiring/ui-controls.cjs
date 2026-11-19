// Statische Pruefung aller Bedienelemente (JSX) in src/: Handler fehlt, Handler leer/no-op, dauerhaft deaktiviert.
const ts = require(require('path').resolve(__dirname, '../../node_modules/typescript'));
const fs = require('fs'), path = require('path');
const REPO = require('path').resolve(__dirname, '../..'); const ROOT = require('path').join(REPO, 'src');
const files = [];
(function walk(d){ for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p);
  if (s.isDirectory()) walk(p); else if (p.endsWith('.tsx') && !p.includes('.test.')) files.push(p); } })(ROOT);
const CONTROL_TAGS = new Set(['button','input','select','textarea']);
const CUSTOM = /^(Knob|Fader|Slider|Toggle|Switch|Pad|Button|RotaryKnob|VerticalFader|ParamKnob|ParamSlider|IconButton|MonkKnob|MonkFader|XYPad)$/;
const HANDLER_PROPS = /^on(Click|Change|Input|PointerDown|PointerUp|MouseDown|TouchStart|KeyDown|Submit|ValueChange|Change[A-Z]\w*|Commit|Toggle|Press)$/;
const out = { files: 0, controls: 0, noHandler: [], noopHandler: [], alwaysDisabled: [], todoHandler: [] };
function attrs(el) { const m = {}; for (const a of el.attributes.properties) { if (a.name) m[a.name.getText()] = a; } return m; }
function isNoop(expr, sf) {
  if (!expr) return false; const t = expr.getText(sf).replace(/\s+/g, '');
  return /^\(\)=>\{\}$|^\(\)=>undefined$|^\(\)=>null$|^\(\w*\)=>\{\}$|^noop$|^undefined$|^\(\)=>void0$/.test(t);
}
function bodyText(expr, sf) { return expr ? expr.getText(sf) : ''; }
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8'); const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  out.files++; const rel = path.relative(REPO, file);
  (function visit(n) {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf); const isCtl = CONTROL_TAGS.has(tag) || CUSTOM.test(tag);
      if (isCtl) {
        out.controls++; const a = attrs(n); const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        const typeAttr = a.type && a.type.initializer ? a.type.initializer.getText(sf) : '';
        const handlers = Object.keys(a).filter(k => HANDLER_PROPS.test(k));
        const hasSpread = n.attributes.properties.some(p => ts.isJsxSpreadAttribute(p));
        const readOnly = 'readOnly' in a || 'disabled' in a && !a.disabled.initializer;
        const isSubmit = /submit/.test(typeAttr); const hidden = /hidden/.test(typeAttr);
        const passive = tag === 'input' && ('defaultValue' in a || 'defaultChecked' in a);
        if (!handlers.length && !hasSpread && !readOnly && !isSubmit && !hidden && !passive && !(tag === 'button' && 'form' in a))
          out.noHandler.push(`${rel}:${line} <${tag}>`);
        for (const h of handlers) { const init = a[h].initializer; const expr = init && init.expression;
          if (isNoop(expr, sf)) out.noopHandler.push(`${rel}:${line} <${tag} ${h}>`);
          else if (/TODO|FIXME|not implemented|nicht implementiert|console\.log\(/i.test(bodyText(expr, sf)) && bodyText(expr, sf).length < 200) out.todoHandler.push(`${rel}:${line} <${tag} ${h}>`); }
        if (a.disabled && a.disabled.initializer && /^\{?\s*true\s*\}?$/.test(a.disabled.initializer.getText(sf))) out.alwaysDisabled.push(`${rel}:${line} <${tag}>`);
      }
    }
    ts.forEachChild(n, visit);
  })(sf);
}
console.log(JSON.stringify(out, null, 1));
