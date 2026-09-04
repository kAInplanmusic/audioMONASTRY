import { describe, expect, it, beforeEach } from 'vitest';
import { errorRegister } from '../src/utils/ErrorRegister';

describe('GAP-8: Zentrales Fehler-Register', () => {
  beforeEach(() => errorRegister.clear());

  it('sammelt Fehler mit Quelle und Kontext', () => {
    const e = errorRegister.add('audio-thread', 'dropout', { count: 3 });
    expect(e.source).toBe('audio-thread');
    expect(e.context).toEqual({ count: 3 });
    expect(errorRegister.count).toBe(1);
  });

  it('filtert nach Quelle und Zeitfenster', () => {
    errorRegister.add('a', 'x');
    errorRegister.add('b', 'y');
    errorRegister.add('a', 'z');
    expect(errorRegister.list({ source: 'a' })).toHaveLength(2);
    const since = Date.now() + 1000;
    expect(errorRegister.list({ since })).toHaveLength(0);
  });

  it('liefert die jüngsten Einträge zuerst (recent)', () => {
    errorRegister.add('a', 'alt');
    errorRegister.add('b', 'neu');
    expect(errorRegister.recent(1)[0].message).toBe('neu');
  });
});
