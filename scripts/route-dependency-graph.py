#!/usr/bin/env python3
"""ARCH-P2-002 · Dependency-Graph der server.ts-Routen.

Beantwortet je Routen-Gruppe: welche **server.ts-lokalen** Symbole fasst sie an?
Getrennt nach mutierbarem Zustand (blockiert die Extraktion) und Helfern.

Drei Blindstellen der ersten Fassung sind hier behoben - jede hatte beim Umsetzen
real zugeschlagen (siehe docs/ARCH_P2_002_DEPENDENCY_GRAPH.md):

  1. TRANSITIV statt nur direkt. Nutzt eine Route einen blockeigenen Helfer, der
     seinerseits ein Modul-Symbol anfasst, wird das jetzt verfolgt (Closure ueber
     die Referenzen der Top-Level-Deklarationen). Ohne das fehlte `fleetTargets`,
     das erst `tsc` gefunden hat.
  2. REGEX-LITERALE werden erkannt. Ein `/['"]/` brachte den String-Zustand
     durcheinander und liess den Rest der Datei als Literal verschwinden; dadurch
     galten Importe faelschlich als nur lokal genutzt.
  3. GRUPPE != BLOCK. Eine Gruppe umfasst ALLE Statements ihres Pfadpraefix, auch
     nicht zusammenhaengende. `--plan` gibt genau die zu verschiebenden Bereiche
     aus, damit eine Extraktion keine vorgezogenen Einzelrouten uebersieht.

Aufruf:
  python3 scripts/route-dependency-graph.py                  # Bericht (Markdown)
  python3 scripts/route-dependency-graph.py --json           # maschinenlesbar
  python3 scripts/route-dependency-graph.py --plan /api/ai   # Extraktionsplan
  python3 scripts/route-dependency-graph.py --file <pfad>    # anderes Ziel (Tests)
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict

ROUTE_RE = re.compile(r"^app\.(get|post|put|delete|patch|use)\(")
DECL_RE = re.compile(
    r"^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)"
    r"|^(?:export\s+)?async\s+function\s+([A-Za-z_$][\w$]*)"
    r"|^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)"
    r"|^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)"
)
IDENT_RE = re.compile(r"[A-Za-z_$][\w$]*")

IDENT_CHARS = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$')
# Nach diesen Zeichen beginnt ein Regex-Literal, kein Divisionsoperator.
REGEX_PRECEDERS = set('(,=:[!&|?{};+-*%~^<>')
# Nach diesen Schluesselwoertern ebenfalls.
REGEX_KEYWORDS = {
    'return', 'typeof', 'instanceof', 'case', 'in', 'of', 'new', 'delete', 'void',
    'do', 'else', 'yield', 'await', 'throw',
}


def regex_starts_here(text, i):
    """Heuristik: beginnt an text[i] ('/') ein Regex-Literal statt einer Division?"""
    j = i - 1
    while j >= 0 and text[j] in ' \t':
        j -= 1
    if j < 0:
        return True
    prev = text[j]
    if prev in REGEX_PRECEDERS:
        return True
    if prev in IDENT_CHARS:
        k = j
        while k >= 0 and text[k] in IDENT_CHARS:
            k -= 1
        return text[k + 1:j + 1] in REGEX_KEYWORDS
    # ')' ']' '}' -> Division. Bei '}' bewusst konservativ: Block vs. Objektliteral
    # ist ohne Parser nicht entscheidbar; ein verpasstes Regex ist der harmlose Fall.
    return False


def mask_literals(text):
    """Ersetzt String-/Template-/Regex-Literale und Kommentare durch Leerzeichen.

    Zeilenumbrueche bleiben erhalten, damit Zeilennummern stimmen.
    """
    out, i, n = [], 0, len(text)

    def blank(chunk):
        return ''.join(c if c == '\n' else ' ' for c in chunk)

    while i < n:
        ch = text[i]
        if text.startswith('//', i):
            j = text.find('\n', i)
            j = n if j == -1 else j
            out.append(blank(text[i:j]))
            i = j
            continue
        if text.startswith('/*', i):
            j = text.find('*/', i)
            j = n if j == -1 else j + 2
            out.append(blank(text[i:j]))
            i = j
            continue
        if ch in '\'"':
            quote, j = ch, i + 1
            while j < n:
                if text[j] == '\\':
                    j += 2
                    continue
                if text[j] == quote:
                    j += 1
                    break
                j += 1
            out.append(blank(text[i:j]))
            i = j
            continue
        if ch == '`':
            j = i + 1
            while j < n:
                if text[j] == '\\':
                    j += 2
                    continue
                if text[j] == '`':
                    j += 1
                    break
                j += 1
            out.append(blank(text[i:j]))
            i = j
            continue
        if ch == '/' and regex_starts_here(text, i):
            j, in_class = i + 1, False
            while j < n:
                c = text[j]
                if c == '\\':
                    j += 2
                    continue
                if c == '\n':
                    break
                if c == '[':
                    in_class = True
                elif c == ']':
                    in_class = False
                elif c == '/' and not in_class:
                    j += 1
                    break
                j += 1
            while j < n and text[j] in IDENT_CHARS:      # Flags
                j += 1
            out.append(blank(text[i:j]))
            i = j
            continue
        out.append(ch)
        i += 1
    return ''.join(out)


def statement_span(masked_lines, start):
    """Endzeile (0-basiert, inklusive) eines Statements ab start.

    Bilanz ueber (), {} und [] zusammen. Zwei Faelle, die eine naive Fassung
    verfehlt hat und die beide die Symbolzahl verfaelscht haben:
      * Deklarationen wie `const x = { ... }` enden ohne Klammerbilanz nie.
      * Eine Zeile OHNE jede Klammer (`let t: ReturnType<typeof setTimeout>|null =
        null;`) hat keine Bilanz - ein reiner Klammerzaehler laeuft dann in die
        folgenden Statements hinein und verschluckt echte Deklarationen.
        Deshalb gilt: ohne gesehenes Klammerpaar beendet ein Semikolon die Zeile.
    """
    depth, started = 0, False
    for j in range(start, min(start + 500, len(masked_lines))):
        line = masked_lines[j]
        for ch in line:
            if ch in '({[':
                depth += 1
                started = True
            elif ch in ')}]':
                depth -= 1
        if started:
            if depth <= 0:
                return j
        elif line.rstrip().endswith(';'):
            return j
    return start


def analyze(path):
    raw = open(path, encoding='utf-8').read()
    lines = raw.split('\n')
    masked = mask_literals(raw).split('\n')

    # --- Modul-Scope: Deklarationen (mit Spans) und Importe ---
    decls = {}        # name -> {'kind', 'start', 'end'}  (0-basierte Zeilen)
    imports = {}      # name -> Modul
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln and ln[0] not in ' \t}':
            m = DECL_RE.match(ln)
            if m:
                name = next(g for g in m.groups() if g)
                end = statement_span(masked, i)
                kind = ('state' if re.match(r"^(?:export\s+)?(?:let|var)\b", ln) else
                        'class' if re.match(r"^(?:export\s+)?class\b", ln) else
                        'function' if 'function' in ln.split('=')[0] else 'const')
                decls.setdefault(name, {'kind': kind, 'start': i, 'end': end})
                i = end + 1
                continue
            if ln.startswith('import'):
                text, j = ln, i
                while "from '" not in text and not text.rstrip().endswith("';") \
                        and j + 1 < len(lines):
                    j += 1
                    text = '\n'.join(lines[i:j + 1])
                mod = re.search(r"from\s*'([^']+)'", text)
                if mod:
                    head = text.split(' from ')[0]
                    brace = re.search(r'\{(.*)\}', head, re.S)
                    if brace:
                        for part in brace.group(1).split(','):
                            p = part.strip()
                            if not p:
                                continue
                            p = p[4:].strip() if p.startswith('type ') else p
                            p = p.split(' as ')[-1].strip()
                            imports[p] = mod.group(1)
                    else:
                        dm = re.match(r"import\s+([A-Za-z_$][\w$]*)", head)
                        if dm:
                            imports[dm.group(1)] = mod.group(1)
                i = j + 1
                continue
        i += 1

    def refs_in(start, end):
        return set(IDENT_RE.findall('\n'.join(masked[start:end + 1])))

    decl_refs = {name: refs_in(d['start'], d['end']) for name, d in decls.items()}

    def closure(names):
        """Transitive Huelle ueber die blockeigenen Deklarationen."""
        seen, queue = set(), list(names)
        while queue:
            n = queue.pop()
            if n in seen:
                continue
            seen.add(n)
            for r in decl_refs.get(n, ()):
                if r in decls and r not in seen:
                    queue.append(r)
        return seen

    # --- Routen ---
    routes = []
    for idx, ln in enumerate(lines):
        m = ROUTE_RE.match(ln)
        if not m:
            continue
        end = statement_span(masked, idx)
        # Pfad aus dem ROHEN Text lesen: im maskierten sind String-Literale leer.
        pm = re.search(r"\(\s*\[?'([^']+)'", '\n'.join(lines[idx:end + 1]))
        routes.append({
            'method': m.group(1),
            'path': pm.group(1) if pm else '(unbekannt)',
            'start': idx + 1,
            'end': end + 1,
        })

    # --- Gruppen = Praefix, NICHT ein Block ---
    groups = defaultdict(list)
    for r in routes:
        parts = r['path'].split('/')
        key = '/'.join(parts[:3]) if len(parts) > 2 else r['path']
        groups[key].append(r)

    def merged_areas(rs):
        areas = []
        for r in sorted(rs, key=lambda x: x['start']):
            if areas and r['start'] <= areas[-1][1] + 1:
                areas[-1][1] = max(areas[-1][1], r['end'])
            else:
                areas.append([r['start'], r['end']])
        return areas

    report = []
    for key in sorted(groups, key=lambda k: (-len(groups[k]), k)):
        rs = groups[key]
        names = set()
        for r in rs:
            names |= refs_in(r['start'] - 1, r['end'] - 1)
        reach = closure(names)
        state = sorted(n for n in reach if decls.get(n, {}).get('kind') == 'state')
        helper = sorted(n for n in reach if n in decls and n not in state)
        report.append({
            'prefix': key,
            'statements': rs,
            'areas': merged_areas(rs),
            'deps': {'state': state, 'helper': helper},
            'imported': sorted(n for n in reach if n in imports),
        })

    return {
        'file': path,
        'lines': len(lines),
        'routes': len(routes),
        'imports': len(imports),
        'moduleScope': {
            'declarations': len(decls),
            'state': sorted(n for n, d in decls.items() if d['kind'] == 'state'),
            'helpers': sorted(n for n, d in decls.items() if d['kind'] != 'state'),
        },
        'groups': report,
    }


def print_markdown(data):
    st = data['moduleScope']
    print('# Routen je Gruppe (transitiv, regex-fest)')
    print()
    print('Datei: %s - %d Zeilen, %d Statements, %d Modul-Scope-Symbole '
          '(%d Zustand), %d Importe'
          % (data['file'], data['lines'], data['routes'], st['declarations'],
             len(st['state']), data['imports']))
    print()
    for g in data['groups']:
        print('## %s  (%d Statements in %d Bereich(en))'
              % (g['prefix'], len(g['statements']), len(g['areas'])))
        print('   Bereiche: %s' % ', '.join('%d-%d' % tuple(a) for a in g['areas']))
        print('   Zustand (%d): %s' % (len(g['deps']['state']),
                                       ', '.join(g['deps']['state']) or '-'))
        print('   Helfer  (%d): %s' % (len(g['deps']['helper']),
                                       ', '.join(g['deps']['helper']) or '-'))
        if g['imported']:
            print('   Importe (%d): %s' % (len(g['imported']), ', '.join(g['imported'])))
        print()
    print('# Modul-Zustand (%d)' % len(st['state']))
    print()
    print(', '.join(st['state']) or '-')


def print_plan(data, prefix):
    hits = [g for g in data['groups'] if g['prefix'] == prefix]
    if not hits:
        print('Keine Gruppe mit Praefix %r. Vorhanden: %s'
              % (prefix, ', '.join(g['prefix'] for g in data['groups'])))
        return 1
    for g in hits:
        print('PLAN %s' % g['prefix'])
        print('  Statements: %d' % len(g['statements']))
        print('  Zu verschiebende Bereiche (ALLE, nicht nur der groesste): %s'
              % ', '.join('%d-%d' % tuple(a) for a in g['areas']))
        for r in g['statements']:
            print('    %-6s %-42s Zeilen %d-%d'
                  % (r['method'].upper(), r['path'], r['start'], r['end']))
        print('  Dependencies (transitiv):')
        print('    Zustand: %s' % (', '.join(g['deps']['state']) or '-'))
        print('    Helfer:  %s' % (', '.join(g['deps']['helper']) or '-'))
        print('    Importe: %s' % (', '.join(g['imported']) or '-'))
    return 0


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default = os.path.join(os.path.dirname(here), 'server.ts')
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--file', default=default, help='zu analysierende Datei')
    ap.add_argument('--json', action='store_true', help='maschinenlesbare Ausgabe')
    ap.add_argument('--plan', metavar='PREFIX', help='Extraktionsplan fuer ein Praefix')
    args = ap.parse_args()

    data = analyze(args.file)
    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0
    if args.plan:
        return print_plan(data, args.plan)
    print_markdown(data)
    return 0


if __name__ == '__main__':
    sys.exit(main())
