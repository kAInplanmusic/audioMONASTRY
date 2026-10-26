#!/usr/bin/env node
/**
 * UI-Bedienelement-Audit (2026-10-26)
 * ===================================
 * Findet per TypeScript-AST JEDES Bedienelement in src/ und ordnet ihm zu:
 *   - Typ (button / input / select / textarea / slider / stepgrid / xypad / …)
 *   - sichtbarer Name (aria-label, label, title, Textinhalt)
 *   - Handler-Funktion und deren Rumpf
 *   - ob der Rumpf die Audio-Engine, den Session-Stand oder eine Sub-Komponente erreicht
 *
 * Status je Element:
 *   WIRED     Handler erreicht audioEngine.* / setX(Engine) / writePluginSettings / Plugin-API
 *   DOM_ONLY  Handler existiert, ändert nur lokalen React-State (kein Engine-Kontakt)
 *   NO_HANDLER  kein onClick/onChange/onInput (echter Blindgänger)
 *   READONLY  bewusst nur Anzeige (disabled, readOnly, tabIndex=-1 ohne Handler)
 *
 * Aufruf: node scripts/audit/ui-controls.mjs [--json reports/ui-controls.json]
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const OUT_JSON = (() => {
  const i = process.argv.indexOf('--json');
  return i > 0 ? process.argv[i + 1] : 'reports/ui-controls.json';
})();

/** Engine-/Persistenz-Aufrufe, die als „verkabelt" gelten. */
const ENGINE_RE = /\b(audioEngine\.[A-Za-z]+|writePluginSettings|readPluginSettings|setPluginSync|setPluginTransport|webRTCManager\.[A-Za-z]+|pluginLocks|requestLock|releaseLock|transferLock|setModuleState|setSamples?|addSample|save[A-Z]\w*|update[A-Z]\w*(Me|Tone|Master|Dsp|Eq)|setEffect\w*|setEq\w*|setDsp\w*|setSpatial\w*|setMaster\w*|setBpm|setChannel\w*|setMonitor\w*|automate\w*|captureNow|mergeCapturedBar|setOptionalReverb|setOptionalSynthVoice|resetOptionalSynthVoice)\b/;
/** Reine UI-/State-Aufrufe. */
const DOM_RE = /\b(set[A-Z]\w*|useState|onChange|onClose|onToggle|toggle\w*|setOpen|setTab|setActive\w*)\b/;

const INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea']);
/** Komponenten, die selbst Bedienelemente sind (Design-System). */
const INTERACTIVE_COMPONENTS = new Set([
  'AmKnob', 'AmFader', 'AmHFader', 'AmBar', 'AmToggle', 'AmSeg', 'AmXyPad', 'AmStepGrid',
  'AmTabs', 'AmCollapsible', 'AmPresetSelect', 'AmColorSwatch', 'AmParamRow', 'AmLed',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      walk(p, out);
    } else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

/** Sichtbaren Text eines Knotens grob einsammeln (für den Namen). */
function textOf(node, sf) {
  let s = '';
  const visit = (n) => {
    if (ts.isJsxText(n)) s += n.getText(sf).replace(/\s+/g, ' ').trim() + ' ';
    else if (ts.isStringLiteral(n) || ts.isTemplateExpression(n)) s += n.text + ' ';
    ts.forEachChild(n, visit);
  };
  visit(node);
  return s.replace(/\s+/g, ' ').trim().slice(0, 60);
}

function attr(node, name, sf) {
  for (const a of node.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText(sf) === name) {
      const init = a.initializer;
      if (!init) return 'true';
      if (ts.isStringLiteral(init)) return init.text;
      return init.getText(sf).replace(/\s+/g, ' ').slice(0, 80);
    }
  }
  return '';
}

function handlerBody(node, sf) {
  for (const a of node.attributes.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const n = a.name.getText(sf);
    if (!/^on(Click|Change|Input|PointerDown|PointerUp|KeyDown|Submit|DoubleClick|DragStart|Drop|Toggle)$/.test(n)) continue;
    const init = a.initializer;
    if (!init) continue;
    if (ts.isJsxExpression(init) && init.expression) return { name: n, body: init.expression.getText(sf) };
  }
  return null;
}

function componentName(node, sf) {
  const tag = node.tagName.getText(sf);
  return tag;
}

const results = [];
const files = walk(SRC);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  /** lokale Handler-Funktionen der Datei: Name -> Rumpftext */
  const fns = new Map();
  const collectFns = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) fns.set(n.name.getText(sf), n.getText(sf));
    if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) {
          if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
            fns.set(d.name.getText(sf), d.initializer.getText(sf));
          }
        }
      }
    }
    ts.forEachChild(n, collectFns);
  };
  collectFns(sf);

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = componentName(node, sf);
      const isTag = INTERACTIVE_TAGS.has(tag);
      const isComp = INTERACTIVE_COMPONENTS.has(tag);
      if (isTag || isComp) {
        const h = handlerBody(node, sf);
        const disabled = attr(node, 'disabled', sf);
        const readOnly = attr(node, 'readOnly', sf) || attr(node, 'readonly', sf);
        const aria = attr(node, 'aria-label', sf) || attr(node, 'title', sf) || attr(node, 'name', sf) || attr(node, 'label', sf);
        const value = attr(node, 'value', sf);
        // Handler-Rumpf + transitiv gerufene lokale Funktionen (bis Tiefe 4),
        // damit auch Ketten wie onChange → setParam → applyToEngine → audioEngine
        // als verkabelt erkannt werden.
        let body = h ? h.body : '';
        if (h) {
          const seen = new Set();
          let frontier = [body];
          for (let depth = 0; depth < 4; depth += 1) {
            const next = [];
            for (const chunk of frontier) {
              for (const [fname, fbody] of fns) {
                if (seen.has(fname) || fname === 'render') continue;
                if (new RegExp(`\\b${fname}\\b`).test(chunk)) {
                  seen.add(fname);
                  body += '\n' + fbody;
                  next.push(fbody);
                }
              }
            }
            if (!next.length) break;
            frontier = next;
          }
        }
        const wired = ENGINE_RE.test(body);
        const domOnly = DOM_RE.test(body);
        let status;
        if (disabled && !h) status = 'READONLY';
        else if (readOnly && !h) status = 'READONLY';
        else if (!h) status = isComp ? 'NO_HANDLER' : 'NO_HANDLER';
        else if (wired) status = 'WIRED';
        else if (domOnly) status = 'DOM_ONLY';
        else status = 'UNKNOWN';

        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        results.push({
          file: relative(ROOT, file),
          line: line + 1,
          tag,
          kind: isComp ? 'component' : 'element',
          name: aria || textOf(node.parent, sf) || '(ohne Namen)',
          handler: h ? h.name : '',
          status,
          disabled: disabled || undefined,
          value: value || undefined,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---- Aggregation ----
const byStatus = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
const byFile = results.reduce((a, r) => {
  const k = r.file;
  a[k] ||= { total: 0, WIRED: 0, DOM_ONLY: 0, NO_HANDLER: 0, READONLY: 0, UNKNOWN: 0 };
  a[k].total += 1;
  a[k][r.status] = (a[k][r.status] || 0) + 1;
  return a;
}, {});

mkdirSync(dirname(OUT_JSON), { recursive: true });
writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), total: results.length, byStatus, byFile, controls: results }, null, 2));

console.log(`Bedienelemente gefunden: ${results.length}`);
console.log('Status:', JSON.stringify(byStatus));
console.log('\nDateien mit den meisten NICHT verkabelten Elementen:');
const worst = Object.entries(byFile)
  .map(([f, v]) => ({ f, ...v, dead: (v.NO_HANDLER || 0) + (v.UNKNOWN || 0), dom: v.DOM_ONLY || 0 }))
  .sort((a, b) => (b.dead + b.dom) - (a.dead + a.dom))
  .slice(0, 15);
for (const w of worst) {
  if (!w.dead && !w.dom) continue;
  console.log(`  ${w.f.replace('src/', '')}: ${w.total} Elemente · NO_HANDLER ${w.dead} · DOM_ONLY ${w.dom} · WIRED ${w.WIRED}`);
}
console.log(`\nBericht: ${OUT_JSON}`);
