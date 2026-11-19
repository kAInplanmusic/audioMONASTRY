import re, pathlib, collections, json
root = pathlib.Path(__file__).resolve().parents[2]
def scan(globs):
    emit, on = collections.defaultdict(set), collections.defaultdict(set)
    for g in globs:
        for p in root.glob(g):
            if 'node_modules' in p.parts or '.test.' in p.name: continue
            t = p.read_text(errors='replace'); rel = str(p.relative_to(root))
            for m in re.finditer(r"\.(emit|volatile\.emit|timeout\(\d+\)\.emit|emitWithAck)\(\s*['\"`]([A-Za-z0-9_:.\-/]+)['\"`]", t): emit[m.group(2)].add(rel)
            for m in re.finditer(r"\.(on|once)\(\s*['\"`]([A-Za-z0-9_:.\-/]+)['\"`]", t): on[m.group(2)].add(rel)
    return emit, on
ce, con = scan(['src/**/*.ts', 'src/**/*.tsx'])
se, son = scan(['server/**/*.ts', 'server/*.ts'])
builtin = {'connect','disconnect','connect_error','error','message','close','open','end','data','upgrade','request','listening','finish','exit','drain','response','timeout','abort','load','change','ended','statechange','track','icecandidate','connectionstatechange','reconnect','ready','SIGTERM','SIGINT','uncaughtException','unhandledRejection'}
c2s_unhandled = {e: sorted(w)[:2] for e, w in ce.items() if e not in son and e not in builtin}
s2c_unhandled = {e: sorted(w)[:2] for e, w in se.items() if e not in con and e not in builtin}
print(json.dumps({'clientEmits': len(ce), 'serverEmits': len(se), 'clientEmitNoServerHandler': c2s_unhandled,
                  'serverEmitNoClientHandler': s2c_unhandled}, indent=1, ensure_ascii=False))
