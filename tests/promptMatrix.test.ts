import { describe, expect, it } from 'vitest';
import {
  PLUGIN_COMMAND_CATALOG,
  PLUGIN_MOA_SYSTEM_PROMPTS,
  PLUGIN_MOA_TASKS,
} from '../src/utils/prompts';

const ALL_21 = [
  'masterplayer', 'instrument', 'synthesizer', 'drum', 'sampler', 'mcp',
  'voice', 'sound', 'mixer', 'controller', 'effect', 'drop', 'library', 'eq',
  'dsp', 'mastering', 'stem', 'spatial', 'recording', 'performance', 'ai',
];

describe('GAP-5: Prompt-/Trainings-Matrix je Plugin', () => {
  it('alle 21 Plugins haben Kommando-Katalog, System-Prompt und Default-Task', () => {
    for (const id of ALL_21) {
      expect(PLUGIN_COMMAND_CATALOG[id], `catalog:${id}`).toBeTruthy();
      expect(PLUGIN_MOA_SYSTEM_PROMPTS[id], `prompt:${id}`).toBeTruthy();
      expect(PLUGIN_MOA_TASKS[id], `task:${id}`).toBeTruthy();
    }
  });

  it('Katalog-Kommandos sind nicht leer und syntaktisch simpel', () => {
    for (const [id, cmds] of Object.entries(PLUGIN_COMMAND_CATALOG)) {
      expect(cmds.trim().length).toBeGreaterThan(0);
      expect(cmds).not.toContain('undefined');
      expect(cmds).not.toContain('null');
      void id;
    }
  });
});
