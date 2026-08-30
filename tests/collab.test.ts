// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { localUser } from '../src/utils/collab';

describe('collab (jsdom)', () => {
  it('localUser hat persistente id/name/color', () => {
    expect(localUser.id).toMatch(/^user_/);
    expect(localUser.name).toMatch(/^Operator /);
    expect(localUser.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('id wird in localStorage persistiert', () => {
    expect(window.localStorage.getItem('audiomonastry_user_id')).toBe(localUser.id);
    expect(window.localStorage.getItem('audiomonastry_user_name')).toBe(localUser.name);
  });
});
