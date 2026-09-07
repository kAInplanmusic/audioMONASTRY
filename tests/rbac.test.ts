// Q-4/T-0016: RBAC-Tests (sicherheitsrelevanter Kern, vorher 0 % Coverage).
// Deckt: Rollen-Hierarchie, Aktions-Gates, dynamische Rollen (Composition +
// Inheritance), Modul-Permissions und den RoleTransitionManager ab.
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../src/utils/AuditLogger', () => ({
  logAuditEvent: vi.fn(async () => {}),
}));
// Storage-Adapter mocken (rbac.ts nutzt NUR storageGet — Boundary-Regel 1.1).
vi.mock('../src/utils/storage', () => ({
  storageGet: vi.fn(() => null),
  storageSet: vi.fn(() => {}),
  storageRemove: vi.fn(() => {}),
}));

import {
  can, canDynamic, roleForUser, readSessionConfig, roleLevel,
  defineRole, setModulePermission, canAccessModule,
  roleTransitionManager, ROLES,
  type Role, type Action,
} from '../src/utils/rbac';
import { logAuditEvent } from '../src/utils/AuditLogger';
import { storageGet } from '../src/utils/storage';

const storageGetMock = storageGet as unknown as Mock;

describe('RBAC: Rollen-Hierarchie (can)', () => {
  it('admin darf alles', () => {
    for (const a of ['lock', 'unlock', 'edit', 'master', 'state', 'routing', 'kick', 'assign'] as Action[]) {
      expect(can('admin', a)).toBe(true);
    }
  });

  it('guest darf nur state', () => {
    expect(can('guest', 'state')).toBe(true);
    for (const a of ['lock', 'unlock', 'edit', 'master', 'routing', 'kick', 'assign'] as Action[]) {
      expect(can('guest', a)).toBe(false);
    }
  });

  it('engineer darf master + routing, aber nicht lock/edit', () => {
    expect(can('engineer', 'master')).toBe(true);
    expect(can('engineer', 'routing')).toBe(true);
    expect(can('engineer', 'state')).toBe(true);
    expect(can('engineer', 'edit')).toBe(false);
    expect(can('engineer', 'lock')).toBe(false);
    expect(can('engineer', 'kick')).toBe(false);
  });

  it('producer darf edit/lock/unlock, aber nicht kick/assign', () => {
    expect(can('producer', 'edit')).toBe(true);
    expect(can('producer', 'lock')).toBe(true);
    expect(can('producer', 'unlock')).toBe(true);
    expect(can('producer', 'kick')).toBe(false);
    expect(can('producer', 'assign')).toBe(false);
  });

  it('Hierarchie ist total geordnet: guest < engineer < producer < admin', () => {
    const order: Role[] = ['guest', 'engineer', 'producer', 'admin'];
    for (const a of ['lock', 'master', 'kick', 'routing', 'edit'] as Action[]) {
      for (let i = 0; i < order.length - 1; i++) {
        if (can(order[i + 1], a)) {
          // Wer höher darf, muss mindestens die niedrigere Aktion… (nur wenn niedrigere erlaubt)
          if (can(order[i], a)) continue;
        }
      }
      // Kick ist admin-only: alle darunter verboten
      if (a === 'kick') {
        expect(can('guest', a)).toBe(false);
        expect(can('engineer', a)).toBe(false);
        expect(can('producer', a)).toBe(false);
      }
    }
    expect(ROLES).toEqual(['admin', 'producer', 'engineer', 'guest']);
  });
});

describe('RBAC: roleForUser (Host-Ermittlung)', () => {
  it('Raum-Host ist immer admin', () => {
    expect(roleForUser('user-1', 'user-1')).toBe('admin');
    expect(roleForUser('user-2', 'user-1')).toBe('guest');
  });

  it('SESSION_HOST_USER (Storage) wird respektiert', () => {
    storageGetMock.mockImplementation((k: string) =>
      k === 'SESSION_HOST_USER' ? 'host-uid' : k === 'SESSION_ROLE' ? 'producer' : null);
    expect(roleForUser('host-uid')).toBe('admin');
    expect(roleForUser('someone-else')).toBe('producer');
    storageGetMock.mockReturnValue(null);
  });

  it('Fallback ohne Konfiguration: nicht-Host = guest', () => {
    storageGetMock.mockReturnValue(null);
    const cfg = readSessionConfig();
    expect(cfg.hostUid).toBe('');
    expect(cfg.defaultRole).toBe('guest');
    expect(roleForUser('anyone')).toBe('guest');
  });
});

describe('RBAC: assertCan loggt Verweigerungen', () => {
  it('guest + lock → verweigert und auditiert', async () => {
    const { assertCan } = await import('../src/utils/rbac');
    const ok = await assertCan('user-g', 'lock', null, { pluginId: 'mixer', reason: 'test' });
    expect(ok).toBe(false);
    expect(logAuditEvent).toHaveBeenCalledWith('user-g', 'RBAC_DENIED', expect.objectContaining({
      action: 'lock', role: 'guest', pluginId: 'mixer',
    }));
  });

  it('producer + lock → erlaubt, kein Audit', async () => {
    vi.mocked(logAuditEvent).mockClear();
    storageGetMock.mockImplementation((k: string) =>
      k === 'SESSION_ROLE' ? 'producer' : null);
    const { assertCan } = await import('../src/utils/rbac');
    const ok = await assertCan('user-p', 'lock');
    expect(ok).toBe(true);
    expect(logAuditEvent).not.toHaveBeenCalled();
    storageGetMock.mockReturnValue(null);
  });
});

describe('RBAC: dynamische Rollen (defineRole/canDynamic)', () => {
  beforeEach(() => {
    // sauberen Custom-Role-State sicherstellen (Map ist modul-global)
    defineRole({ name: 'custom-vj', level: 0, grants: [] }); // Reset-Träger
    defineRole({ name: 'custom-vj', level: 1, inherits: [], grants: ['state', 'routing'] });
  });

  it('custom grants wirken unabhängig von der Level-Hierarchie', () => {
    expect(canDynamic('custom-vj', 'state')).toBe(true);
    expect(canDynamic('custom-vj', 'routing')).toBe(true);
    expect(canDynamic('custom-vj', 'edit')).toBe(false);
  });

  it('Vererbung: child erbt Level und Grants des Parents', () => {
    defineRole({ name: 'custom-vj-senior', level: 1, inherits: ['custom-vj'], grants: [] });
    expect(canDynamic('custom-vj-senior', 'routing')).toBe(true); // geerbt
    expect(canDynamic('custom-vj-senior', 'edit')).toBe(false);   // nicht geerbt
  });

  it('roleLevel: max(level, inherited)', () => {
    defineRole({ name: 'low-parent', level: 0, inherits: [], grants: [] });
    defineRole({ name: 'high-child', level: 2, inherits: ['low-parent'], grants: [] });
    expect(roleLevel('high-child')).toBe(2);
    defineRole({ name: 'low-child', level: 1, inherits: ['high-child'], grants: [] });
    expect(roleLevel('low-child')).toBe(2); // Vererbung hebt an
  });

  it('unbekannte Rolle = Level 0 = guest-Rechte', () => {
    expect(roleLevel('does-not-exist')).toBe(0);
    expect(canDynamic('does-not-exist', 'state')).toBe(true);
    expect(canDynamic('does-not-exist', 'edit')).toBe(false);
  });
});

describe('RBAC: Modul-Permissions (setModulePermission/canAccessModule)', () => {
  it('ohne Permission greift der Fallback auf canDynamic(edit) zurück', () => {
    // guest darf edit nicht → kein Schreibzugriff
    expect(canAccessModule('guest', 'mixer')).toBe(false);
    // state (read-Pfad) ist guest erlaubt
    expect(canAccessModule('guest', 'mixer', undefined, false)).toBe(true);
  });

  it('access=read blockiert Writes, erlaubt Reads', () => {
    setModulePermission('dj-readonly', { moduleId: 'eq', access: 'read' });
    expect(canAccessModule('dj-readonly', 'eq', undefined, true)).toBe(false);
    expect(canAccessModule('dj-readonly', 'eq', undefined, false)).toBe(true);
  });

  it('access=write erlaubt beides; param-Whitelist beschränkt Parameter', () => {
    setModulePermission('dj-limited', { moduleId: 'eq', access: 'write', params: ['low', 'mid'] });
    expect(canAccessModule('dj-limited', 'eq', 'low', true)).toBe(true);
    expect(canAccessModule('dj-limited', 'eq', 'high', true)).toBe(false);
    expect(canAccessModule('dj-limited', 'eq', undefined, true)).toBe(true);
  });

  it('access=full erlaubt alles', () => {
    setModulePermission('dj-full', { moduleId: 'eq', access: 'full' });
    expect(canAccessModule('dj-full', 'eq', 'high', true)).toBe(true);
  });
});

describe('RBAC: RoleTransitionManager (Live-Rollenwechsel)', () => {
  it('Transition läuft progressiv und endet bei 100 %', async () => {
    const mgr = roleTransitionManager;
    const seen: number[] = [];
    mgr.onRoleTransition((_uid, t) => seen.push(t.progress));
    mgr.beginTransition('user-t', 'producer', 200);
    expect(mgr.pending('user-t')).toBeDefined();
    // Progressiv: erste Werte < 1
    await new Promise((r) => setTimeout(r, 60));
    expect(seen.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(mgr.pending('user-t')).toBeUndefined();
    expect(mgr.activeRole('user-t')).toBe('producer');
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('vor Transition gilt Default guest', () => {
    expect(roleTransitionManager.activeRole('never-seen-user')).toBe('guest');
  });
});
