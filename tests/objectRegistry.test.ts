import { describe, expect, it } from 'vitest';
import { ObjectRegistry, uuidV4 } from '../src/core/session/ObjectRegistry';

describe('ObjectRegistry', () => {
  it('uuidV4 liefert eine UUID', () => {
    const id = uuidV4();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('create/get/update/list funktionieren', () => {
    const reg = new ObjectRegistry<{ name: string }>();
    const obj = reg.create('plugin', { name: 'EQ' });
    expect(obj.version).toBe(1);
    expect(reg.get(obj.id)?.data.name).toBe('EQ');

    reg.update(obj.id, { name: 'Compressor' });
    expect(reg.get(obj.id)?.version).toBe(2);
    expect(reg.get(obj.id)?.data.name).toBe('Compressor');
    expect(reg.snapshot()).toHaveLength(1);
  });

  it('delete entfernt Objekte', () => {
    const reg = new ObjectRegistry<{ name: string }>();
    const obj = reg.create('plugin', { name: 'X' });
    expect(reg.delete(obj.id)).toBe(true);
    expect(reg.get(obj.id)).toBeUndefined();
  });
});
