/**
 * audioMONASTRY · Eval-Set des DAW-Executors (RT-AUDIT-P1-015)
 * =============================================================
 * 50 Nutzeranweisungen (DE/EN gemischt, wie im Studio gesprochen) mit den
 * erwarteten Katalog-Kommandos. Abdeckung: alle 20 Einträge aus
 * `PLUGIN_COMMAND_CATALOG`, Zahlenparameter, Textparameter, Mehrfach-Kommandos.
 *
 * Genutzt von:
 *   - `tests/dawExecutorEval.test.ts` (deterministisches Mock-Modell, Gate:
 *     100 % gültiges JSON, 100 % erwartete Kommandos),
 *   - `scripts/eval-ai.ts --executor` (echtes Modell über den LlmRouter; ohne
 *     erreichbaren Provider ehrlich UNCHECKED).
 *
 * Außerdem das deterministische Mock-Modell: es liefert die erwarteten
 * Kommandos in den typischen Fehlformen kleiner Modelle (Markdown-Zaun, Prosa,
 * Großschreibung, `play()`, Einheiten, Anführungszeichen, Argumente
 * im Nebenfeld, halluziniertes Kommando, Nicht-JSON). Damit prüft das Gate die
 * Reparatur- UND die Reject-/Retry-Strecke, nicht nur den Glücksfall.
 */
import type { LlmCompletion, LlmRequest } from '../LlmRouter';
import type { ExecutorCommand } from '../dawExecutor';

export interface ExecutorEvalCase {
  id: string;
  task: string;
  expected: ExecutorCommand[];
}

const c = (pluginId: string, command: string): ExecutorCommand => ({ pluginId, command });

export const EXECUTOR_EVAL_SET: readonly ExecutorEvalCase[] = [
  { id: 'transport-tempo-128', task: 'Setz das Tempo auf 128 BPM', expected: [c('transport', 'set_tempo(128)')] },
  { id: 'transport-tempo-174', task: 'Drum and bass tempo please, 174', expected: [c('transport', 'set_tempo(174)')] },
  { id: 'transport-play', task: 'Starte die Wiedergabe', expected: [c('transport', 'play')] },
  { id: 'transport-stop', task: 'Stop playback', expected: [c('transport', 'stop')] },
  { id: 'transport-tempo-play', task: 'Tempo 140 und dann abspielen', expected: [c('transport', 'set_tempo(140)'), c('transport', 'play')] },
  { id: 'mixer-gain-minus6', task: 'Mixer-Gain auf -6 dB', expected: [c('mixer', 'gain(-6)')] },
  { id: 'mixer-gain-0', task: 'Set mixer gain to 0 dB', expected: [c('mixer', 'gain(0)')] },
  { id: 'mixer-fade-8', task: 'Main in 8 Sekunden einblenden', expected: [c('mixer', 'fade_in_main(8)')] },
  { id: 'mixer-channel-3', task: 'Wähle Kanal 3 im Mixer', expected: [c('mixer', 'channel(3)')] },
  { id: 'mixer-channel-fade', task: 'Kanal 2 wählen und Main über 4 Sekunden einfaden', expected: [c('mixer', 'channel(2)'), c('mixer', 'fade_in_main(4)')] },
  { id: 'drop-pattern-build', task: 'Lade das Drop-Pattern build', expected: [c('drop', 'pattern(build)')] },
  { id: 'drop-auto', task: 'Auto-Drop auslösen', expected: [c('drop', 'auto_drop')] },
  { id: 'drop-status', task: 'What is the drop status?', expected: [c('drop', 'status')] },
  { id: 'song-generate', task: 'Generiere einen Song: dunkler Warehouse Techno mit 130 BPM', expected: [c('song', 'generate(dunkler Warehouse Techno mit 130 BPM)')] },
  { id: 'song-status', task: 'Wie weit ist die Song-Generierung?', expected: [c('song', 'status')] },
  { id: 'effect-automate', task: 'Automatisiere einen Filter-Sweep im FX', expected: [c('effect', 'automate')] },
  { id: 'effect-status', task: 'FX status', expected: [c('effect', 'status')] },
  { id: 'synth-note-440', task: 'Spiel eine Note mit 440 Hz', expected: [c('syntisampler', 'note(440)')] },
  { id: 'synth-note-55', task: 'Play a sub note at 55 Hz', expected: [c('syntisampler', 'note(55)')] },
  { id: 'synth-trigger', task: 'Sample triggern', expected: [c('syntisampler', 'trigger')] },
  { id: 'synth-four', task: 'Four-on-the-floor Pattern im Synth', expected: [c('syntisampler', 'pattern_four')] },
  { id: 'synth-random', task: 'Random synth pattern', expected: [c('syntisampler', 'pattern_random')] },
  { id: 'synth-break', task: 'Breakbeat-Pattern im SyntiSampler', expected: [c('syntisampler', 'pattern_break')] },
  { id: 'drum-kit-808', task: 'Lade das 808 Drumkit', expected: [c('drumsampler', 'kit(808)')] },
  { id: 'drum-random', task: 'Würfel ein Drum-Pattern', expected: [c('drumsampler', 'pattern_random')] },
  { id: 'drum-trigger', task: 'Trigger the drum pad', expected: [c('drumsampler', 'trigger')] },
  { id: 'instru-program-0', task: 'Instrument Programm 0 (Piano)', expected: [c('instru', 'program(0)')] },
  { id: 'instru-program-40', task: 'Switch the instrument to program 40, violin', expected: [c('instru', 'program(40)')] },
  { id: 'biblio-search', task: 'Such in der Bibliothek nach Kick', expected: [c('biblio', 'search(kick)')] },
  { id: 'biblio-sync', task: 'Bibliothek synchronisieren', expected: [c('biblio', 'sync')] },
  { id: 'biblio-load', task: 'Load the selected sample', expected: [c('biblio', 'load')] },
  { id: 'voice-speak', task: 'Sag: Willkommen im Kloster', expected: [c('voice', 'speak(Willkommen im Kloster)')] },
  { id: 'voice-sing', task: 'Sing the line: rise up', expected: [c('voice', 'sing(rise up)')] },
  { id: 'voice-song', task: 'Erzeuge einen Vocal-Song mit dem Text: nachts im Club', expected: [c('voice', 'song(nachts im Club)')] },
  { id: 'sound-trigger', task: 'Sound abfeuern', expected: [c('sound', 'trigger')] },
  { id: 'sound-status', task: 'Sound engine status', expected: [c('sound', 'status')] },
  { id: 'stem-separate', task: 'Trenne den Track in Stems', expected: [c('stem', 'separate')] },
  { id: 'stem-status', task: 'Stem queue status?', expected: [c('stem', 'status')] },
  { id: 'spatial-setup', task: 'Spatial-Setup 7.1 laden', expected: [c('spatial', 'setup(7.1)')] },
  { id: 'spatial-mode', task: 'Spatial mode separation', expected: [c('spatial', 'mode(SEPARATION)')] },
  { id: 'eq-automate', task: 'EQ-Sweep automatisieren', expected: [c('eq', 'automate')] },
  { id: 'dsp-automate', task: 'Automate the DSP cutoff', expected: [c('dsp', 'automate')] },
  { id: 'master-preset', task: 'Mastering-Preset club laden', expected: [c('master', 'preset(club)')] },
  { id: 'master-status', task: 'Master chain status', expected: [c('master', 'status')] },
  { id: 'record-start', task: 'Aufnahme starten', expected: [c('record', 'start')] },
  { id: 'record-stop-status', task: 'Stop the recording and show the recorder status', expected: [c('record', 'stop'), c('record', 'status')] },
  { id: 'ai-plan', task: 'Plane den nächsten Schritt', expected: [c('ai', 'plan')] },
  { id: 'perfor-mode', task: 'Performance-Monitor in den Modus live', expected: [c('perfor', 'mode(live)')] },
  { id: 'perfor-reset', task: 'Reset the performance stats', expected: [c('perfor', 'reset')] },
  { id: 'midi-rescan', task: 'MIDI-Geräte neu scannen', expected: [c('midi-controller', 'rescan')] },
];

/** Antwortformen des Mock-Modells (Index des Falls mod Anzahl). */
export const MOCK_NOISE_VARIANTS = [
  'clean',
  'markdown-fence',
  'prose-around',
  'uppercase-and-empty-parens',
  'unit-suffix',
  'quoted-args',
  'args-in-side-field',
  'hallucinated-then-clean',
  'non-json-then-clean',
  'bare-array',
] as const;
export type MockNoiseVariant = (typeof MOCK_NOISE_VARIANTS)[number];

function splitArgs(command: string): { name: string; args: string[] } {
  const open = command.indexOf('(');
  if (open === -1) return { name: command, args: [] };
  return { name: command.slice(0, open), args: command.slice(open + 1, -1).split(', ') };
}

/** Wendet die Fehlform auf die erwarteten Kommandos an (rein, deterministisch). */
export function renderMockAnswer(expected: readonly ExecutorCommand[], variant: MockNoiseVariant, attempt: number): string {
  const clean = JSON.stringify({ commands: expected });
  switch (variant) {
    case 'clean':
      return clean;
    case 'markdown-fence':
      return '```json\n' + clean + '\n```';
    case 'prose-around':
      return `Klar, hier ist der Plan:\n${clean}\nViel Spaß im Studio!`;
    case 'uppercase-and-empty-parens':
      return JSON.stringify({
        commands: expected.map((cmd) => ({
          pluginId: cmd.pluginId.toUpperCase(),
          command: cmd.command.includes('(') ? cmd.command : `${cmd.command}()`,
        })),
      });
    case 'unit-suffix':
      return JSON.stringify({
        commands: expected.map((cmd) => {
          const { name, args } = splitArgs(cmd.command);
          if (name === 'set_tempo') return { ...cmd, command: `set_tempo(${args[0]} BPM)` };
          if (name === 'gain') return { ...cmd, command: `gain(${args[0]} dB)` };
          if (name === 'note') return { ...cmd, command: `note(${args[0]}Hz)` };
          if (name === 'channel') return { ...cmd, command: `channel(channel${args[0]})` };
          return cmd;
        }),
      });
    case 'quoted-args':
      return JSON.stringify({
        commands: expected.map((cmd) => {
          const { name, args } = splitArgs(cmd.command);
          return args.length > 0 ? { ...cmd, command: `${name}(${args.map((x) => `"${x}"`).join(', ')})` } : cmd;
        }),
      });
    case 'args-in-side-field':
      return JSON.stringify({
        commands: expected.map((cmd) => {
          const { name, args } = splitArgs(cmd.command);
          return args.length > 0 ? { pluginId: cmd.pluginId, command: name, args } : cmd;
        }),
      });
    case 'hallucinated-then-clean':
      return attempt === 1
        ? JSON.stringify({ commands: [{ pluginId: 'mixer', command: 'explode' }, ...expected] })
        : clean;
    case 'non-json-then-clean':
      return attempt === 1 ? 'Ich würde das Tempo erhöhen und dann abspielen.' : clean;
    case 'bare-array':
      return JSON.stringify(expected);
    default:
      return clean;
  }
}

/**
 * Deterministisches Mock-Modell für den Executor: findet den Fall über die
 * `Aufgabe:`-Zeile des Prompts und antwortet in der Fehlform des Falls. Der
 * zweite Versuch (Korrektur-Prompt) wird erkannt und gezählt.
 */
export function createMockExecutorModel(
  cases: readonly ExecutorEvalCase[] = EXECUTOR_EVAL_SET,
): { complete: (req: LlmRequest) => Promise<LlmCompletion>; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const attemptsByTask = new Map<string, number>();
  const complete = async (req: LlmRequest): Promise<LlmCompletion> => {
    calls.push(req);
    const marker = '\nAufgabe: ';
    const task = req.prompt.slice(req.prompt.lastIndexOf(marker) + marker.length).trim();
    const index = cases.findIndex((entry) => entry.task === task);
    const attempt = (attemptsByTask.get(task) ?? 0) + 1;
    attemptsByTask.set(task, attempt);
    if (index === -1) {
      return { provider: 'runpod-local', text: 'unbekannte Aufgabe', latencyMs: 1, model: 'mock-executor' };
    }
    const variant = MOCK_NOISE_VARIANTS[index % MOCK_NOISE_VARIANTS.length];
    return {
      provider: 'runpod-local',
      text: renderMockAnswer(cases[index].expected, variant, attempt),
      latencyMs: 1,
      model: 'mock-executor',
    };
  };
  return { complete, calls };
}
