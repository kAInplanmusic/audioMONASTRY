import re, pathlib, collections, json
root = (pathlib.Path(__file__).resolve().parents[2] / 'src')
ENGINE = re.compile(r"audioEngine\.|engine\.|Engine\(\)|host\.setParameter|\.port\.postMessage|postMessage\(|\.setValueAtTime|\.gain\.|\.frequency\.|\.Q\.|setTargetAtTime|setParam|applyParam|apply[A-Z]\w*\(|controller\.|worklet|node\.|\.set[A-Z]\w*\(")
audio_files = [p for p in root.rglob('*.ts') if any(s in str(p) for s in ('/audio/', '/core/audio', '/plugins/', '/utils/audioEngine', '/core/dsp', '/core/fx', '/core/master', '/core/spatial', '/core/sequencer', '/core/drop', '/core/eq'))]
audio_text = '\n'.join(p.read_text(errors='replace') for p in audio_files if '.test.' not in p.name)
res = []
for p in sorted(root.rglob('*.tsx')):
    if '.test.' in p.name: continue
    t = p.read_text(errors='replace'); lines = t.splitlines()
    for m in re.finditer(r"<(AmKnob|AmFader|AmSlider|Knob|Fader|Slider|AmToggle|input)\b([^>]{0,400}?)value=\{([\w.\[\]]+)\}", t):
        expr = m.group(3); field = re.split(r"[.\[\]]", expr.strip('.'))[-1] or expr
        if field in ('value', 'v', 'x', 'on', 'checked') or len(field) < 3: continue
        label = re.search(r'label="([^"]+)"', m.group(0)); line = t.count('\n', 0, m.start()) + 1
        in_file = any(re.search(r"\b%s\b" % re.escape(field), l) and ENGINE.search(l) for l in lines)
        in_audio = re.search(r"\b%s\b" % re.escape(field), audio_text) is not None
        if not in_file and not in_audio:
            res.append(f"{p.relative_to(root.parent)}:{line} {m.group(1)} '{label.group(1) if label else ''}' value={expr}")
print(len(res)); print('\n'.join(res))
