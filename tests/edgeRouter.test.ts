import { describe, expect, it } from 'vitest';
import { EdgeRouter } from '../src/core/edge/EdgeRouter';

describe('EdgeRouter', () => {
  it('wählt den schnellsten gesunden Knoten', () => {
    const router = new EdgeRouter();
    router.register({ id: 'a', url: 'https://a.example', region: 'eu', latencyMs: 10, healthy: true });
    router.register({ id: 'b', url: 'https://b.example', region: 'eu', latencyMs: 5, healthy: true });
    router.register({ id: 'c', url: 'https://c.example', region: 'us', latencyMs: 99, healthy: false });

    const active = router.selectActive();
    expect(active?.id).toBe('b');
    expect(router.selectStandby().map((n) => n.id)).toEqual(['a']);
  });

  it('liefert null ohne gesunde Knoten', () => {
    const router = new EdgeRouter();
    router.register({ id: 'a', url: 'https://a.example', region: 'eu', latencyMs: 1, healthy: false });
    expect(router.selectActive()).toBeNull();
    expect(router.list()).toHaveLength(1);
  });
});
