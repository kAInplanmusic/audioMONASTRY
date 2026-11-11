"""Render the theoretical GPU catalog and per-role alternatives without changing dispatch."""
import importlib.util
import json
from pathlib import Path
from zoneinfo import ZoneInfo
from datetime import datetime

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('planner', ROOT / 'scripts/vast-fleet-plan.py')
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)
SOURCE = ROOT / 'deploy/vast/gpu-alternatives-under-1eur.json'
OUTPUT = ROOT / 'docs/VAST_GPU_ALTERNATIVEN_UNTER_1EUR_2026-11-12.md'
ACCEPT = {'listed-in-current-profile', 'theoretical-vram-cuda-fit-unverified', 'experimental-cmp-requires-real-model-benchmark', 'insufficient-host-resources'}


def render():
    data = json.loads(SOURCE.read_text())
    fleet, models = planner.fleet_module.load_fleet(), planner.fleet_module.load_models()
    pods = fleet['pods'] + [fleet['visPod']]
    by_role = {}
    for pod in pods:
        alternatives = []
        for group in data['variants']:
            statuses = group.get('roles', {}).get(pod['role'], {})
            for status, price in statuses.items():
                if status in ACCEPT:
                    alternatives.append({'gpu': group['gpu'], 'vramGiB': group['vramGiB'],
                        'grossQuoteEurPerHour': price, 'assessment': status,
                        'priceBasis': group.get('priceBasis', 'gpu-quote-without-role-disk')})
        by_role[pod['role']] = {'requiredVramGiB': planner.memory_required(pod, models),
            'models': pod['models'], 'currentProfileGpuPriority': pod['gpuPriority'], 'alternatives': sorted(alternatives, key=lambda a: a['grossQuoteEurPerHour'])}
    data['byRole'] = by_role
    priced = {group['gpu'] for group in data['variants']}
    missing = sorted(set(data.get('gpuCatalogNames', [])) - priced)
    data['gpuTypesWithUnderOneEuroEvidence'] = len(priced)
    data['gpuTypesWithoutUnderOneEuroEvidence'] = missing
    SOURCE.write_text(json.dumps(data, indent=2) + '\n')
    coverage = ('Alle GPU-Bezeichnungen wurden erfolgreich gegen die Angebots-API geprüft; Preise und Verfügbarkeit bleiben Momentaufnahmen.' if data.get('allGpuTypesQuoted') else 'Die tägliche Suchzeilenquote wurde erreicht; vollständige aktuelle Preisabdeckung aller 107 Bezeichnungen ist noch nicht bestätigt. Die Fortsetzung ist für 01:10 Uhr deutscher Zeit eingerichtet, ohne Vermietung oder Produktionsänderung.')
    lines = ['# Vast: theoretische GPU-Alternativen unter 1 EUR/h', '',
        'Stand: 12. November 2026, Europe/Berlin. Diese Liste erweitert die Alternativen für die acht bestehenden Rollen. Sie ändert keine aktive GPU-Priorität, kein Modell, keine Gewichte und keine Image-Digests.', '',
        '**Die Betriebsgrenze beträgt 8 EUR/h für die gesamte aktive Flotte ohne Hetzner und Supabase. Einzelne Instanzen dürfen mehr als 1 EUR/h kosten.** Die 1-EUR-Schwelle ist nur der Filter dieses ergänzenden Katalogs.', '',
        f"Die native Vast-Typenliste enthält {data.get('gpuCatalogTypeCount', 107)} GPU-Bezeichnungen. Dokumentiert sind {len(data['variants'])} Speicher-/Kartenvarianten mit Unter-1-EUR-Preisbeleg über {len(priced)} Bezeichnungen. {coverage}", '',
        '## Preis- und Prüfstatus', '',
        '- Umrechnung wie im Flottenbudget: 0,92 EUR/USD und 19 Prozent Steuerannahme. Die Quote ist keine Reservierung.',
        '- Normale GPU-Preisbelege enthalten keine rollenbezogene Arbeitsdisk und keinen Traffic. Mit `≤` markierte Werte sind konservative Obergrenzen aus früheren vollständigen Rollenangeboten einschließlich deren Disk; die reine GPU war damit ebenfalls unter 1 EUR/h.',
        '- „Profil“ bedeutet: Hardwaretyp steht bereits in der bestehenden Kompatibilitätsliste. Es ist kein neuer erfolgreicher Vast-Inferenznachweis.',
        '- „Theorie“ bedeutet: VRAM/CUDA passen grundsätzlich, die unveränderten Images und Modelle sind auf diesem Typ noch zu prüfen.',
        '- CMP-/VRAM-Umbauten bleiben experimentell. Gemeldeter Speicher ist kein Beleg für stabile Rechenleistung, passende Tensor-Kernels oder NVENC/Chromium.',
        '- Angebote mit unzureichendem Host-RAM, CPU-Anteil oder CUDA-Treiber werden nicht als passende Rollenangebote geführt. Neue Angebote brauchen immer eine frische vollständige Prüfung.', '',
        '## Zuordnung zu den acht Rollen', '']
    for role, info in by_role.items():
        lines += [f"### {role}: mindestens {info['requiredVramGiB']:g} GiB nach aktuellem Modellbudget", '',
            'Modelle: ' + ', '.join('`' + model + '`' for model in info['models']) + '.', '',
            '| Karte / gemeldeter VRAM | Belegte Quote EUR/h | Einordnung |', '|---|---:|---|']
        if not info['alternatives']:
            lines.append('| Keine unter dieser Schwelle belegt | – | Teurere passende Karten bleiben im Gesamtbudget zulässig |')
        for item in info['alternatives']:
            tag = {'listed-in-current-profile': 'Profil', 'theoretical-vram-cuda-fit-unverified': 'Theorie',
                   'experimental-cmp-requires-real-model-benchmark': 'CMP: Benchmark und Hostprüfung erforderlich', 'insufficient-host-resources': 'GPU-RAM passt; größere CPU/RAM-Hostzuweisung erforderlich'}[item['assessment']]
            prefix = '≤ ' if item['priceBasis'] == 'upper-bound-including-quoted-role-disk' else ''
            lines.append(f"| {item['gpu']} / {item['vramGiB']:g} GiB | {prefix}{item['grossQuoteEurPerHour']:.3f} | {tag} |")
        lines += ['', 'Das bestehende Hardwareprofil bleibt einschließlich teurerer Karten erhalten: ' + ', '.join('`' + gpu + '`' for gpu in info['currentProfileGpuPriority']) + '.', '']
    lines += ['## Sämtliche belegten Unter-1-EUR-Varianten', '',
        '| GPU | Gemeldeter VRAM GiB | Quote EUR/h | Preisgrundlage |', '|---|---:|---:|---|']
    for group in data['variants']:
        disk = group.get('priceBasis') == 'upper-bound-including-quoted-role-disk'
        lines.append(f"| {group['gpu']} | {group['vramGiB']:g} | {'≤ ' if disk else ''}{group['minGpuGrossEurPerHour']:.3f} | {'inkl. beobachteter Rollen-Disk' if disk else 'GPU-Angebot; Disk/Traffic zusätzlich'} |")
    if data.get('queryLimitReachedGpuTypes'):
        lines += ['', 'Die Angebotsstichprobe erreichte ihr Limit für: ' + ', '.join(sorted(set(data['queryLimitReachedGpuTypes']))) + '. Weitere Host-/Speichervarianten sind damit nicht ausgeschlossen.', '']
    lines += ['', '## Ohne bestätigten Unter-1-EUR-Beleg', '',
        'Diese Typen sind nicht pauschal ungeeignet. Hier fehlt ein aktueller passender Preisbeleg unter der Schwelle oder es gibt in den abgerufenen Angeboten keinen solchen Preis. Sie werden nicht als bestätigt günstig eingesetzt.', '',
        ', '.join('`' + name + '`' for name in missing) or 'Keine.', '',
        '## Besonders wichtig für die Auswahl', '',
        '- CMP 170HX mit 40/64 GB: theoretisch für speicherpassende Audio-/Generierungsrollen interessant; unverändertes FP8-Brain und komplette Vis-Grafikrolle sind damit nicht freigegeben. 64 GB reichen außerdem nicht für das aktuelle 69-GiB-Studio-Budget.',
        '- Modifizierte RTX 4090 mit 48 GB: als eigene gemeldete Variante dokumentieren; Stabilität und das konkrete Modell müssen separat bestätigt werden.',
        '- Für Studio dürfen 80-/96-GB-Karten über 1 EUR/h verwendet werden, solange die gesamte Acht-Rollen-Zuordnung unter 8 EUR/h bleibt.',
        '- Speicher verschiedener GPUs wird in der aktuellen Konfiguration nicht einfach addiert. Zwei 24-GB-Karten ersetzen keine einzelne erforderliche 48-/80-/96-GB-Zuweisung.', '',
        'Maschinenlesbare Zuordnung: `deploy/vast/gpu-alternatives-under-1eur.json`, insbesondere `byRole`. Neu erzeugen: `python scripts/vast-gpu-report.py`.',
        'Nach Quotenreset vollständige Preise aktualisieren: `python scripts/vast-gpu-alternatives.py --refresh --output deploy/vast/gpu-alternatives-under-1eur.json`. Der Scanner ist ausschließlich lesend und berücksichtigt das Providerlimit.', '']
    OUTPUT.write_text('\n'.join(lines))
    print(json.dumps({'variants': len(data['variants']), 'pricedNames': len(priced), 'unconfirmedNames': len(missing),
        'roleCounts': {role: len(value['alternatives']) for role, value in by_role.items()}}))


if __name__ == '__main__':
    render()
