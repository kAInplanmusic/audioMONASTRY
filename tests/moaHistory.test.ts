import { describe, expect, it } from 'vitest';
import { MoaHistoryStore } from '../src/core/ai/MoaHistory';
import { moaTaskForPlugin, PLUGIN_MOA_TASKS } from '../src/utils/prompts';

describe('MoaHistoryStore (zentrale Historie)', () => {
  it('add/list liefert neueste zuerst und filtert nach Plugin', () => {
    const store = new MoaHistoryStore();
    store.add({ pluginId: 'mixer', task: 't1', provider: 'deepseek-flash', results: ['ok'], at: 1 });
    store.add({ pluginId: 'drum', task: 't2', provider: 'hf', results: ['x'], at: 2 });

    expect(store.list()).toHaveLength(2);
    expect(store.list()[0].pluginId).toBe('drum');
    expect(store.list('mixer')).toHaveLength(1);
    expect(store.list('mixer')[0].task).toBe('t1');
  });

  it('kappt den Verlauf auf 20 Einträge', () => {
    const store = new MoaHistoryStore();
    for (let i = 0; i < 25; i++) {
      store.add({ pluginId: 'dsp', task: `t${i}`, provider: 'hf', results: [], at: i });
    }
    expect(store.list()).toHaveLength(20);
  });

  it('clear leert den Verlauf', () => {
    const store = new MoaHistoryStore();
    store.add({ pluginId: 'eq', task: 'x', provider: 'hf', results: [], at: 1 });
    store.clear();
    expect(store.list()).toHaveLength(0);
  });

  it('subscribe wird bei add benachrichtigt', () => {
    const store = new MoaHistoryStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => { notified++; });
    store.add({ pluginId: 'fx', task: 'y', provider: 'hf', results: [], at: 1 });
    expect(notified).toBe(1);
    unsubscribe();
  });
});

describe('PLUGIN_MOA_TASKS (AUTO_AI-Default-Aufgaben)', () => {
  it('hat für alle bekannten Plugins eine Aufgabe und einen Fallback', () => {
    for (const id of Object.keys(PLUGIN_MOA_TASKS)) {
      expect(moaTaskForPlugin(id)).toBeTruthy();
    }
    expect(moaTaskForPlugin('unbekannt')).toBe('Optimiere dieses Modul');
  });
});
