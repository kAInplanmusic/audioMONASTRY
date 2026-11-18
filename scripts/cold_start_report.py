"""Cold-start target logic and report (operator target 2026-11-18: app up in < 15 minutes).

Rules:
* Target `coldStartTargetMinutes` (15): all roles ready by then.
* One single role may still run for up to `coldStartGraceMinutes` (15) more minutes before it is shut down.
* Two or more roles late at the target is a workflow problem: abort at the target.
* Every role over the target produces a notice with measured numbers and optimization options (`hints`), written to
  `cold-start-report.json` and printed, so the workflow gets reviewed instead of silently tolerated.
Pure functions only (no network), tested in tests/test_cold_start_report.py.
"""
import json
import math

TARGET_DEFAULT_MIN = 15.0
GRACE_DEFAULT_MIN = 15.0


def limits_seconds(policy):
    """(target, hard) in seconds. hard = target + grace, never beyond `maxTestMinutes - 2` (two minutes cleanup reserve)."""
    window = policy['maxTestMinutes'] - 2
    target = min(float(policy.get('coldStartTargetMinutes', TARGET_DEFAULT_MIN)), window)
    hard = min(target + float(policy.get('coldStartGraceMinutes', 0.0)), window)
    return target * 60.0, max(hard, target) * 60.0


def decision(pending_roles, now, soft_deadline, hard_deadline):
    """What to do after one readiness pass.

    ready          nothing pending
    wait           before the target (or no target given): keep polling
    grace          target passed, exactly one role still pending: it may run until the hard deadline
    abort_multiple target passed, two or more roles pending
    abort_hard     hard deadline passed
    """
    if not pending_roles:
        return 'ready'
    if now >= hard_deadline:
        return 'abort_hard'
    if soft_deadline is not None and now >= soft_deadline:
        return 'abort_multiple' if len(pending_roles) >= 2 else 'grace'
    return 'wait'


def _minutes(seconds):
    return round(seconds / 60.0, 1)


def hints_for(role, info, target_min):
    """Optimization options for one slow (or missing) role, from measured and planned numbers only."""
    gb = info.get('payloadGb')
    mbps = info.get('downloadReported')
    seconds = info.get('readySeconds')
    ideal = None
    if isinstance(gb, (int, float)) and isinstance(mbps, (int, float)) and mbps > 0:
        ideal = round(gb * 8000.0 / mbps / 60.0, 1)             # GB -> Mbit / (Mbit/s) -> Minuten bei gemeldeter Bandbreite
    lines = []
    head = '%s: %s' % (role, 'bereit nach %.1f min' % _minutes(seconds) if seconds is not None else 'nicht bereit')
    head += ' (Ziel %d min)' % target_min
    if gb is not None:
        head += '; Payload %.1f GB' % gb
    if ideal is not None:
        head += ', ideal %.1f min bei gemeldeten %.0f Mbit/s' % (ideal, mbps)
    lines.append(head)
    if seconds is not None and ideal is not None and seconds > 0 and ideal * 60.0 < seconds * 0.5:
        lines.append('gemessen deutlich langsamer als die gemeldete Bandbreite: gemeldete Werte nicht zur Planung benutzen, Host nach gemessener Zeit waehlen')
    lines.append('Optionen: (1) Image in mehrere kleinere Schichten teilen (paralleler Pull), (2) Hosts nach gemessener Pull-Zeit bevorzugen '
                 '(deploy/vast/host-health.json), (3) Rolle warm halten: stoppen und fortsetzen statt neu laden, (4) Payload verkleinern '
                 '(Quantisierung, weniger Modelle je Rolle), (5) Gewichte naeher am Host ablegen')
    return lines


def build_report(state, now, policy, outcome, hints_enabled=True):
    """Report dict from the deployment state: per role ready time, over-target flag, hints. `state['readyAtSeconds']` holds the times."""
    target_s, hard_s = limits_seconds(policy)
    started = float(state.get('startedAt', now))
    elapsed_s = max(0.0, now - started)
    ready = state.get('readyAtSeconds', {})
    roles = {}
    for role, item in state.get('instances', {}).items():
        seconds = ready.get(role)
        info = {'readySeconds': round(seconds, 1) if seconds is not None else None,
                'readyMinutes': _minutes(seconds) if seconds is not None else None,
                'overTarget': (elapsed_s >= target_s) if seconds is None else seconds > target_s,      # nicht bereit zaehlt erst nach dem Ziel
                'gpu': item.get('gpu'), 'machineId': item.get('machineId'), 'downloadReported': item.get('downloadReported'),
                'payloadGb': (state.get('payloadGbByRole') or {}).get(role)}
        roles[role] = info
    late = {role: info for role, info in roles.items() if info['overTarget']}
    all_ready = bool(roles) and all(info['readySeconds'] is not None for info in roles.values())
    report = {'outcome': outcome, 'targetMinutes': _minutes(target_s), 'hardMinutes': _minutes(hard_s),
              'elapsedMinutes': _minutes(elapsed_s), 'roles': roles,
              'rolesOverTarget': sorted(late), 'targetMet': all_ready and not late}
    if late and hints_enabled:
        report['hints'] = [line for role in sorted(late) for line in hints_for(role, late[role], _minutes(target_s))]
        report['notice'] = ('Kaltstart-Ziel von %d Minuten nicht erreicht (%s). Workflow pruefen und optimieren, siehe hints.'
                            % (round(target_s / 60.0), ', '.join(sorted(late))))
    return report


def to_markdown(report, when):
    """Block for docs/COLD_START_LOG.md (append-only log of real runs)."""
    lines = ['## %s: %s' % (when, 'Ziel erreicht' if report['targetMet'] else 'Ziel NICHT erreicht'),
             '', 'Ergebnis: %s; Ziel %s min, Hoechstgrenze %s min, verstrichen %s min.' % (
                 report['outcome'], report['targetMinutes'], report['hardMinutes'], report['elapsedMinutes']), '',
             '| Rolle | bereit nach (min) | GPU | Payload GB | gemeldet Mbit/s | ueber Ziel |', '| --- | --- | --- | --- | --- | --- |']
    for role, info in sorted(report['roles'].items()):
        lines.append('| %s | %s | %s | %s | %s | %s |' % (role, info['readyMinutes'] if info['readyMinutes'] is not None else 'nicht bereit',
                                                         info.get('gpu') or '', info.get('payloadGb') if info.get('payloadGb') is not None else '',
                                                         info.get('downloadReported') or '', 'ja' if info['overTarget'] else 'nein'))
    if report.get('notice'):
        lines += ['', '**Hinweis:** ' + report['notice'], ''] + ['- ' + h for h in report.get('hints', [])]
    return '\n'.join(lines) + '\n'


def dump(report):
    return json.dumps(report, indent=2, ensure_ascii=False) + '\n'


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)
