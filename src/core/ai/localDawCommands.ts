import type { ExecutorCommand } from './dawExecutor';

const NUMBERS: Readonly<Record<string, number>> = {
  eins: 1, ein: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6,
  sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12,
};
const EQ_TARGET = '(master eq|equalizer|eqmonk|eq)';
const EQ_GROUP = '(?:blitz[ -]pass|bass|tiefen|low|band\\s+\\d{1,2}(?:\\s*(?:bis|-)\\s*\\d{1,2})?)';
const EQ_SHIFT = new RegExp(
  `^${EQ_TARGET}\\s+(${EQ_GROUP})\\s+(?:um\\s+)?(\\d{1,2}(?:[.,]\\d)?|[a-zäöü]+)(?:\\s+d[bB])?\\s+(höher|hoch|anheben|rauf|tiefer|runter|absenken)$`,
  'u',
);
const EQ_GROUP_PATTERN = new RegExp(`^${EQ_TARGET}\\s+${EQ_GROUP}(?:\\s|$)`, 'u');

export function parseLocalDawCommand(input: string): ExecutorCommand | null {
  const normalized = input.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  const localOnly = /^lokal(?: |$)/.test(normalized);
  const text = localOnly ? normalized.slice('lokal'.length).trimStart() : normalized;
  const eq = EQ_SHIFT.exec(text);
  if (eq) {
    const [, scope, target, amount, direction] = eq;
    const master = scope === 'master eq';
    const bandCount = master ? 12 : 36;
    const indices = [...target.matchAll(/\d+/g)].map(item => Number(item[0]));
    const first = indices[0] ?? 1;
    const last = indices[1] ?? indices[0] ?? 3;
    const magnitude = NUMBERS[amount] ?? Number(amount.replace(',', '.'));
    if (first < 1 || last > bandCount || last < first || !Number.isFinite(magnitude) || magnitude <= 0 || magnitude > 12) {
      throw new Error(`EQ erwartet Band 1–${bandCount} und eine Änderung von 0,1–12 dB.`);
    }
    const delta = /^(tiefer|runter|absenken)$/.test(direction) ? -magnitude : magnitude;
    return { pluginId: master ? 'master' : 'eq', command: `shift_gain(${first}-${last}, ${delta})` };
  }
  const tempo = /^(?:transport\s+)?tempo\s+(?:auf\s+)?(\d{2,3})(?:\s+bpm)?$/.exec(text);
  if (tempo) {
    const bpm = Number(tempo[1]);
    if (bpm < 60 || bpm > 250) throw new Error('Tempo erwartet 60–250 BPM.');
    return { pluginId: 'transport', command: `set_tempo(${bpm})` };
  }
  const gain = /^mixer\s+(?:gain|pegel|lautstärke)\s+(?:auf\s+)?([+-]?\d{1,2}(?:[.,]\d)?)\s+db$/.exec(text);
  if (gain) {
    const db = Number(gain[1].replace(',', '.'));
    if (db < -48 || db > 12) throw new Error('Mixerpegel erwartet −48 bis +12 dB.');
    return { pluginId: 'mixer', command: `gain(${db})` };
  }
  if (/^transport (?:play|start|abspielen)$/.test(text)) return { pluginId: 'transport', command: 'play' };
  if (/^transport (?:stop|stopp|anhalten)$/.test(text)) return { pluginId: 'transport', command: 'stop' };
  if (localOnly || EQ_GROUP_PATTERN.test(text)) {
    throw new Error('Lokaler Befehl unbekannt. Beispiele: EQ Bass zwei höher, EQ Band 4 bis 6 um 1 dB tiefer, Tempo 128 BPM.');
  }
  return null;
}
