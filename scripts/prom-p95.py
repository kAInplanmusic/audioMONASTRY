import re
import sys

path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/live.prom'
lines = open(path, encoding='utf-8').read().splitlines()
buckets = {}
sum_s = 0.0
count = 0.0
for line in lines:
    m = re.match(r'audiomonastry_http_request_duration_seconds_bucket\{le="([^"]+)"\} ([\d.e+]+)', line)
    if m:
        buckets[float(m.group(1))] = float(m.group(2))
        continue
    m2 = re.match(r'audiomonastry_http_request_duration_seconds_sum ([\d.e+]+)', line)
    if m2:
        sum_s = float(m2.group(1))
        continue
    m3 = re.match(r'audiomonastry_http_request_duration_seconds_count ([\d.e+]+)', line)
    if m3:
        count = float(m3.group(1))

if buckets:
    ks = sorted(buckets)
    target = 0.95 * buckets[ks[-1]]
    p95 = next((k for k in ks if buckets[k] >= target), ks[-1])
    avg = (sum_s / count * 1000) if count else 0
    print(f'Requests: {int(buckets[ks[-1]])} · Mittel {avg:.1f} ms · p95 <= {p95 * 1000:.0f} ms')
else:
    print('keine Histogramm-Buckets gefunden')
print('audiomonastry_*-Zeilen:', sum(1 for l in lines if l.startswith('audiomonastry_')))
