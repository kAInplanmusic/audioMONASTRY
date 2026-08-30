import { useCallback, useEffect, useState } from 'react';
import { mappingStore } from '../core/mapping/MappingStore';
import type { MappingKind, MappingRule } from '../core/mapping/MappingEngine';
import type { ControlEvent } from '../core/interfaces';

/**
 * useMapping – persistente Control-Mappings (Learn-Modus)
 * -------------------------------------------------------
 * Verwaltet die zentrale Mapping-Engine über den MappingStore. Der Hook ist
 * bewusst transportagnostisch: Er bekommt ControlEvents von außen (MIDI/HID/
 * OSC) und weiß nichts über physische Geräte.
 */
export const useMapping = () => {
  const [rules, setRules] = useState<MappingRule[]>([]);
  const [learning, setLearning] = useState(false);
  const [target, setTarget] = useState('mixer.channel1.volume');
  const [kind, setKind] = useState<MappingKind>('absolute');
  const [lastLearned, setLastLearned] = useState<ControlEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void mappingStore.load()
      .then((loaded) => setRules(loaded))
      .catch(() => { /* In-Memory-Fallback bleibt aktiv */ });
  }, []);

  /** Lernt eine neue Regel aus einem ControlEvent (Learn-Modus). */
  const addFrom = useCallback(async (ev: ControlEvent) => {
    const rule: MappingRule = {
      id: `${ev.sourceProtocol}-${ev.parameter}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${ev.sourceProtocol}:${ev.parameter} → ${target}`,
      sourceProtocol: ev.sourceProtocol,
      sourceDevice: ev.sourceDevice || undefined,
      channel: ev.channel > 0 ? ev.channel : undefined,
      parameter: ev.parameter,
      target,
      kind,
    };
    try {
      await mappingStore.addRule(rule);
      setRules(mappingStore.engineRef.listRules());
      setLastLearned(ev);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [target, kind]);

  const remove = useCallback(async (ruleId: string) => {
    await mappingStore.removeRule(ruleId);
    setRules(mappingStore.engineRef.listRules());
  }, []);

  /** Mappt ein Event (ohne es zu lernen) — z. B. für Live-Monitoring. */
  const map = useCallback((ev: ControlEvent) => mappingStore.engineRef.map(ev), []);

  return {
    rules, learning, setLearning, target, setTarget, kind, setKind,
    addFrom, remove, map, lastLearned, error,
  };
};
