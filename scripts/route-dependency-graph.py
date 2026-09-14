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
    # Typ-Aliase und Interfaces: sie existieren nur zur Compile-Zeit, muessen aber
    # mitwandern, wenn sie nur in der Gruppe gebraucht werden - sonst findet tsc sie
    # nicht mehr (real passiert bei HfVoiceKind in der Voice-Familie).
    r"|^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)"
    r"|^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)"
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
            # Template-Literal: Text maskieren, aber ${ ... } ist CODE und bleibt
            # erhalten. Sonst uebersieht der Graph Bezeichner, die nur in einer
            # Interpolation vorkommen (real passiert: randomBytes in /api/library).
            out.append(' ')
            j = i + 1
            while j < n:
                c = text[j]
                if c == '\\':
                    out.append('  ')
                    j += 2
                    continue
                if c == '`':
                    out.append(' ')
                    j += 1
                    break
                if c == '$' and j + 1 < n and text[j + 1] == '{':
                    k, depth = j + 2, 1
                    while k < n and depth:
                        cc = text[k]
                        if cc == '\\':
                            k += 2
                            continue
                        if cc == '{':
                            depth += 1
                        elif cc == '}':
                            depth -= 1
                            if depth == 0:
                                # close zeigt auf die schliessende Klammer selbst;
                                # sie darf NICHT in den inneren Code geraten, sonst
                                # entsteht eine Klammer-Unwucht und Spans brechen ab.
                                close = k
                                break
                        elif cc == '`':
                            kk = k + 1
                            while kk < n:
                                if text[kk] == '\\':
                                    kk += 2
                                    continue
                                if text[kk] == '`':
                                    kk += 1
                                    break
                                kk += 1
                            k = kk
                            continue
                        elif cc in '\'"':
                            quote, kk = cc, k + 1
                            while kk < n:
                                if text[kk] == '\\':
                                    kk += 2
                                    continue
                                if text[kk] == quote:
                                    kk += 1
                                    break
                                kk += 1
                            k = kk
                            continue
                        k += 1
                    out.append('${')
                    out.append(mask_literals(text[j + 2:close]))
                    out.append('}')
                    j = close + 1
                    continue
                out.append(c if c == '\n' else ' ')
                j += 1
            i = j
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


def reindent(lines, spaces=2):
    """Rueckt Zeilen ein, ohne mehrzeilige Template-Literale zu veraendern.

    Eine Zeile, die INNERHALB eines Template-Literals beginnt, wird nicht angefasst -
    sonst wuerde der Inhalt des Templates (z. B. ein eingebettetes JSON oder Skript)
    verfaelscht. Fuer alle anderen Zeilen aendert sich garantiert nur fuehrender
    Whitespace; das prueft die Funktion selbst.
    """
    pad = ' ' * spaces
    out, in_template = [], False
    for line in lines:
        out.append(line if (in_template or not line.strip()) else pad + line)
        # Zustand fuer die FOLGEZEILE bestimmen (nur Backticks zaehlen,
        # String-/Kommentar-Literale koennen keine Zeile ueberspannen).
        i, n = 0, len(line)
        while i < n:
            ch = line[i]
            if in_template:
                if ch == '\\':
                    i += 2
                    continue
                if ch == '`':
                    in_template = False
                i += 1
                continue
            if ch == '/' and i + 1 < n and line[i + 1] == '/':
                break
            if ch in '\'"':
                quote, i = ch, i + 1
                while i < n:
                    if line[i] == '\\':
                        i += 2
                        continue
                    if line[i] == quote:
                        i += 1
                        break
                    i += 1
                continue
            if ch == '`':
                in_template = True
            i += 1
    for old, new in zip(lines, out):
        assert new.lstrip() == old.lstrip(), 'Inhalt veraendert: %r' % old[:60]
    return out


def attached_comment_start(lines, idx):
    """Erste Zeile des Kommentarblocks direkt ueber lines[idx].

    Beim Verschieben gehoeren vorangestellte Kommentare (JSDoc, Abschnittskoepfe)
    zum Code - sonst bleiben sie als verwaiste Bloecke in server.ts stehen. Es
    werden nur zusammenhaengende Kommentar-/Leerzeilen genommen und an der ersten
    Code-Zeile gestoppt; steht direkt ueber idx kein Kommentar, bleibt idx.
    """
    j = idx - 1
    if j < 0:
        return idx
    probe = lines[j].strip()
    if not probe or not (probe.startswith('//') or probe.startswith('/*') or probe.startswith('*')):
        return idx
    while j > 0:
        prev = lines[j - 1].strip()
        if prev.startswith('//') or prev.startswith('/*') or prev.startswith('*') or not prev:
            j -= 1
            continue
        break
    # Fuehrende Leerzeilen wieder abziehen: der Lauf darf Leerzeilen ueberspringen
    # (sonst gingen Abschnittskoepfe verloren, die durch eine Leerzeile getrennt sind),
    # der Span soll aber am ersten Kommentar beginnen.
    while j < idx and lines[j].strip() == '':
        j += 1
    return j


def analyze(path, unions=None):
    raw = open(path, encoding='utf-8').read()
    lines = raw.split('\n')
    masked = mask_literals(raw).split('\n')

    # --- Modul-Scope: Deklarationen (mit Spans) und Importe ---
    decls = {}        # name -> {'kind', 'start', 'end'}  (0-basierte Zeilen)
    imports = {}      # name -> Modul
    import_lines = set()   # Zeilen, die zu Import-Statements gehoeren
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
                        'type' if re.match(r"^(?:export\s+)?(?:type|interface)\b", ln) else
                        'function' if 'function' in ln.split('=')[0] else 'const')
                decls.setdefault(name, {
                    'kind': kind, 'start': i, 'end': end,
                    # Verschiebe-Span: mit dem direkt vorangestellten Kommentarblock.
                    'moveStart': attached_comment_start(lines, i),
                })
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
                import_lines.update(range(i, j + 1))
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
            # Verschiebe-Span: mit dem direkt vorangestellten Kommentarblock.
            'moveStart': attached_comment_start(lines, idx) + 1,
        })

    # --- Gruppen = Praefix, NICHT ein Block ---
    groups = defaultdict(list)
    for r in routes:
        parts = r['path'].split('/')
        key = '/'.join(parts[:3]) if len(parts) > 2 else r['path']
        groups[key].append(r)

    # Zusammengehoerige Gruppen (z. B. /api/voice + /api/sound + /api/song, die sich
    # die Voice-Helfer teilen) als EINE Gruppe betrachten: sonst gilt jeder Helfer
    # als "muss gereicht werden", nur weil eine Nachbargruppe ihn auch nutzt.
    for prefix_list in (unions or []):
        rs = [r for pfx in prefix_list for r in groups.get(pfx, [])]
        if rs:
            groups['+'.join(prefix_list)] = rs

    def merged_areas(rs):
        """Zu verschiebende Bereiche - inklusive der vorangestellten Kommentare."""
        areas = []
        for r in sorted(rs, key=lambda x: x['start']):
            start, end = r['moveStart'], r['end']
            if areas and start <= areas[-1][1] + 1:
                areas[-1][1] = max(areas[-1][1], end)
            else:
                areas.append([start, end])
        return areas

    def ref_lines(name):
        """0-basierte Zeilennummern, in denen name als Wort vorkommt."""
        pat = re.compile(r'\b%s\b' % re.escape(name))
        return {j for j, line in enumerate(masked) if pat.search(line)}

    def movability(names, areas):
        """Welche Namen koennen mitwandern, welche muessen gereicht werden?

        Ein Name darf mitwandern, wenn JEDE Referenz entweder innerhalb der
        Bereiche der Gruppe liegt oder innerhalb einer anderen Deklaration, die
        selbst mitwandert (Fixpunkt). Sonst wird er auch anderswo gebraucht und
        muss als Dependency uebergeben werden. Genau diese Frage hat beim
        AI-Block gefehlt - dort waeren Importe geloescht worden, die server.ts
        noch braucht.
        """
        area_lines = set()
        for a, b in areas:
            area_lines.update(range(a - 1, b))
        movable, changed = set(), True
        while changed:
            changed = False
            inner = set(area_lines)
            for n in movable:
                d = decls.get(n)
                if d:
                    inner.update(range(d['start'], d['end'] + 1))
            for n in names:
                if n in movable:
                    continue
                # Die eigene Deklarationszeile zaehlt nicht als externe Referenz -
                # sonst blockiert sich jede Deklaration selbst und nichts ist beweglich.
                # Fuer Importe gilt dasselbe: die Import-Zeile IST die Deklaration,
                # keine Nutzung (sonst meldet der Graph jeden Import als geteilt).
                own = decls.get(n)
                lines = ref_lines(n)
                if own:
                    lines -= set(range(own['start'], own['end'] + 1))
                lines -= import_lines
                if lines <= inner:      # leere Menge ist ebenfalls beweglich
                    movable.add(n)
                    changed = True
        return sorted(movable), sorted(n for n in names if n not in movable)

    report = []
    for key in sorted(groups, key=lambda k: (-len(groups[k]), k)):
        rs = groups[key]
        names = set()
        for r in rs:
            names |= refs_in(r['start'] - 1, r['end'] - 1)
        reach = closure(names)
        state = sorted(n for n in reach if decls.get(n, {}).get('kind') == 'state')
        helper = sorted(n for n in reach if n in decls and n not in state)
        imported = sorted(n for n in reach if n in imports)
        areas = merged_areas(rs)
        # EIN Durchgang ueber alle Namen: getrennte Durchlaeufe pro Kategorie
        # verfehlen den Fall "Zustand wird nur ueber einen mitwandernden Helfer
        # erreicht" - der Helfer-Span fehlt dann in der inner-Menge.
        all_names = set(state) | set(helper) | set(imported)
        movable_all, shared_all = movability(all_names, areas)
        mov_state = [n for n in state if n in movable_all]
        shared_state = [n for n in state if n not in movable_all]
        mov_helper = [n for n in helper if n in movable_all]
        shared_helper = [n for n in helper if n not in movable_all]
        mov_imports = [n for n in imported if n in movable_all]
        shared_imports = [n for n in imported if n not in movable_all]
        report.append({
            'prefix': key,
            'statements': rs,
            'areas': areas,
            'deps': {'state': state, 'helper': helper},
            'imported': imported,
            'movable': {'state': mov_state, 'helper': mov_helper, 'imports': mov_imports},
            'shared': {'state': shared_state, 'helper': shared_helper,
                       'imports': shared_imports},
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
            # 1-basierte Spans je Symbol. moveStart schliesst den Kommentarblock
            # darueber ein - das ist der Bereich, den eine Extraktion verschieben muss.
            'spans': {n: {'start': d['start'] + 1, 'end': d['end'] + 1,
                          'moveStart': d['moveStart'] + 1}
                      for n, d in sorted(decls.items())},
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
        print('  Kann mitwandern (nur in dieser Gruppe referenziert):')
        for kind in ('state', 'helper', 'imports'):
            print('    %-8s %s' % (kind, ', '.join(g['movable'][kind]) or '-'))
        print('  MUSS gereicht werden (auch anderswo referenziert):')
        for kind in ('state', 'helper', 'imports'):
            print('    %-8s %s' % (kind, ', '.join(g['shared'][kind]) or '-'))
    return 0


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default = os.path.join(os.path.dirname(here), 'server.ts')
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--file', default=default, help='zu analysierende Datei')
    ap.add_argument('--json', action='store_true', help='maschinenlesbare Ausgabe')
    ap.add_argument('--plan', metavar='PREFIX[,PREFIX...]',
                    help='Extraktionsplan; mehrere Präfixe mit Komma werden als EINE '
                         'Gruppe gerechnet (Hilfe fuer zusammengehoerige Familien)')
    ap.add_argument('--reindent', metavar='DATEI',
                    help='DATEI einruecken und ausgeben (template-sicher, fuer Extraktionen)')
    args = ap.parse_args()

    if args.reindent:
        src = open(args.reindent, encoding='utf-8').read().split('\n')
        print('\n'.join(reindent(src)))
        return 0

    prefixes = [p.strip() for p in (args.plan or '').split(',') if p.strip()]
    data = analyze(args.file, unions=[prefixes] if len(prefixes) > 1 else None)
    if args.plan:
        return print_plan(data, '+'.join(prefixes) if prefixes else args.plan)
    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0
    if args.plan:
        return print_plan(data, args.plan)
    print_markdown(data)
    return 0


if __name__ == '__main__':
    sys.exit(main())
