/** Settings namespace for the shared Main. Independent of private monitor controls. */
export const MAIN_PROCESSOR_IDS = ['eq', 'dsp', 'effect', 'spatial', 'mixer', 'master'] as const;
export type MainProcessorId = typeof MAIN_PROCESSOR_IDS[number];
export const MAIN_SOURCE_IDS = ['drop', 'song', 'drumsampler', 'syntisampler', 'instru', 'voice', 'sound', 'stem'] as const;
export function isMainProcessor(id: string): id is MainProcessorId { return (MAIN_PROCESSOR_IDS as readonly string[]).includes(id); }

/** Legacy monitor panels save their own root settings; retain the independent Main section. */
export function preserveMainSettings(id: string, next: object, previous: Record<string, unknown> | null): object {
  if (!isMainProcessor(id) || Object.hasOwn(next, 'backendMain') || !previous?.backendMain) return next;
  return { ...next, backendMain: previous.backendMain };
}
