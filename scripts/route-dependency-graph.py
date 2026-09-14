#!/usr/bin/env python3
"""ARCH-P2-002 Subitem 1: Dependency-Graph der server.ts-Routen erheben.

Liefert je Routen-Gruppe die Abhaengigkeiten auf server.ts-lokale Symbole
(Zustand vs. Helfer), damit die Extraktionsreihenfolge begruendet ist und nicht
geraten wird.
"""
import os
import re
import sys
from collections import defaultdict

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.ts")

ROUTE_RE = re.compile(r"^app\.(get|post|put|delete|patch|use)\(")
DECL_RE = re.compile(
    r"^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)"
    r"|^(?:export\s+)?async\s+function\s+([A-Za-z_$][\w$]*)"
    r"|^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)"
    r"|^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)"
    r"|^(?:export\s+)?(?:const|let|var)\s*[\{\[]"
)
IMPORT_FROM_RE = re.compile(r"\}\s*from\s*'([^']+)'|^import\s+\w+\s+from\s*'([^']+)'")
IDENT_RE = re.compile(r"[A-Za-z_$][\w$]*")

# Bezeichner, die keine Modulabhaengigkeit sind.
BUILTINS = {
    'app', 'req', 'res', 'next', 'err', 'e', 'i', 'id', 'state', 'data', 'body',
    'if', 'else', 'return', 'const', 'let', 'var', 'function', 'await', 'async',
    'new', 'typeof', 'instanceof', 'try', 'catch', 'finally', 'throw', 'for',
    'while', 'of', 'in', 'this', 'true', 'false', 'null', 'undefined', 'switch',
    'case', 'break', 'continue', 'default', 'import', 'export', 'from', 'as',
    'class', 'extends', 'super', 'void', 'delete', 'yield', 'static', 'get', 'set',
}


def strip_strings(text: str) -> str:
    """Entfernt String-/Template-Literale, damit deren Inhalt nicht zaehlt."""
    out, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if ch in '\'"`':
            quote = ch
            i += 1
            while i < n:
                if text[i] == '\\':
                    i += 2
                    continue
                if text[i] == quote:
                    i += 1
                    break
                i += 1
            out.append(' ')
            continue
        if text.startswith('//', i):
            j = text.find('\n', i)
            i = n if j == -1 else j
            out.append(' ')
            continue
        if text.startswith('/*', i):
            j = text.find('*/', i)
            i = n if j == -1 else j + 2
            out.append(' ')
            continue
        out.append(ch)
        i += 1
    return ''.join(out)


def main():
    src = open(SERVER, encoding='utf-8').read()
    lines = src.split('\n')

    # --- Modul-Scope: Deklarationen + Imports ---
    module_syms: dict[str, str] = {}       # name -> 'state' | 'const' | 'function' | 'class'
    imports: dict[str, str] = {}           # name -> Modul
    for ln in lines:
        if not ln or ln[0] in ' \t':       # nur Top-Level (Spalte 0)
            continue
        m = DECL_RE.match(ln)
        if m:
            name = next(g for g in m.groups() if g)
            kind = 'state' if re.match(r"^(?:export\s+)?(?:let|var)\b", ln) else (
                'function' if 'function' in ln else
                'class' if ln.startswith('class') or ' class ' in ln else 'const')
            module_syms.setdefault(name, kind)
        mi = IMPORT_FROM_RE.search(ln)
        if ln.startswith('import') and mi:
            mod = mi.group(1) or mi.group(2) or '?'
            head = strip_strings(ln)
            brace = re.search(r'\{(.*?)\}', head)
            if brace:
                for part in brace.group(1).split(','):
                    nm = part.strip().split(' as ')[-1].strip()
                    if nm:
                        imports[nm] = mod
            else:
                dm = re.match(r"import\s+([A-Za-z_$][\w$]*)", head)
                if dm:
                    imports[dm.group(1)] = mod

    # --- Routen einlesen (Statement-Ende per Klammerbilanz) ---
    routes = []
    for idx, ln in enumerate(lines):
        m = ROUTE_RE.match(ln)
        if not m:
            continue
        method = m.group(1)
        buf, depth, started, end = [], 0, False, idx
        for j in range(idx, min(idx + 400, len(lines))):
            stripped = strip_strings(lines[j])
            for ch in stripped:
                if ch == '(':
                    depth += 1
                    started = True
                elif ch == ')':
                    depth -= 1
            buf.append(lines[j])
            if started and depth == 0:
                end = j
                break
        stmt = '\n'.join(buf)
        pm = re.search(r"\(\s*\[?'([^']+)'", stmt)
        path = pm.group(1) if pm else '(unbekannt)'
        routes.append({'method': method, 'path': path, 'start': idx + 1,
                       'end': end + 1, 'text': stmt})

    # --- Abhaengigkeiten je Route ---
    def deps_of(route):
        code = strip_strings(route['text'])
        # der Handler-Kopf app.get('/pfad', ...) selbst zaehlt nicht
        idents = set(IDENT_RE.findall(code))
        local_state = sorted(i for i in idents if module_syms.get(i) == 'state')
        local_helpers = sorted(i for i in idents
                              if module_syms.get(i) in ('const', 'function', 'class'))
        imported = sorted(i for i in idents if i in imports)
        return local_state, local_helpers, imported

    groups = defaultdict(list)
    for r in routes:
        parts = r['path'].split('/')
        key = '/'.join(parts[:3]) if len(parts) > 2 else r['path']
        groups[key].append(r)

    print('# Routen je Gruppe (mit server.ts-lokalen Abhaengigkeiten)')
    print()
    summary = []
    for key in sorted(groups, key=lambda k: -len(groups[k])):
        rs = groups[key]
        states, helpers = set(), set()
        for r in rs:
            s, h, _ = deps_of(r)
            states |= set(s)
            helpers |= set(h)
        summary.append((key, len(rs), states, helpers))
        print('## %s  (%d Routen)' % (key, len(rs)))
        print('   Zeilen: %s' % ', '.join('%d-%d' % (r['start'], r['end']) for r in rs))
        print('   lokaler Zustand (%d): %s' % (len(states), ', '.join(sorted(states)) or '-'))
        print('   lokale Helfer (%d): %s' % (len(helpers), ', '.join(sorted(helpers)) or '-'))
        print()

    print('# Zusammenfassung')
    print()
    print('%-28s %6s %8s %8s' % ('Gruppe', 'Routen', 'Zustand', 'Helfer'))
    for key, cnt, states, helpers in summary:
        print('%-28s %6d %8d %8d' % (key, cnt, len(states), len(helpers)))
    print()
    print('Modul-Scope insgesamt: %d Symbole (%d Zustand, %d Helfer/Konstanten), %d Importe'
          % (len(module_syms),
             sum(1 for v in module_syms.values() if v == 'state'),
             sum(1 for v in module_syms.values() if v != 'state'),
             len(imports)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
