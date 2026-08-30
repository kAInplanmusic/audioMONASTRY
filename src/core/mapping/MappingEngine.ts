/**
 * audioMONASTRY · Mapping Engine (transportagnostisch)
 * =====================================================
 * Zentrale Schicht zwischen ControlEvent und Applikations-Parameter:
 *
 *   DEVICE → PROTOCOL → CONTROL EVENT → MAPPING ENGINE → APP PARAMETER
 *
 * Die App-Parameter (Targets) sind reine Strings (`mixer.channel1.volume`).
 * Sie erfahren NIE, welches physische Gerät oder Protokoll den Wert erzeugt
 * hat. Die Engine ist synchron, allokationsarm und ohne UI-/Audio-Abhängigkeit.
 */
import type { ControlEvent, ControlSourceProtocol } from '../interfaces';
import { normalizeControlValue } from '../hardware/controlEvent';

export type MappingKind = 'absolute' | 'relative' | 'toggle' | 'momentary';

export interface MappingRule {
  id: string;
  /** Anzeigename (optional, für UI/Export). */
  name?: string;
  sourceProtocol: ControlSourceProtocol;
  /** Leer = jedes Gerät dieses Protokolls. */
  sourceDevice?: string;
  /** 0 = jeder Kanal. */
  channel?: number;
  /** Protokoll-Adresse (MIDI-CC, HID-Usage, OSC-Adress-Hash). */
  parameter: number;
  /** Applikations-Parameter, z. B. `mixer.channel1.volume`. */
  target: string;
  kind: MappingKind;
  /** Zielbereich (normalisiert 0..1); Default 0..1. */
  min?: number;
  max?: number;
  /** Relative Empfindlichkeit (Delta × relativeStep). */
  relativeStep?: number;
  /** Adress-Filter für OSC (exakter Prefix, optional). */
  address?: string;
}

export interface MappedParameter {
  target: string;
  /** Normalisierter Wert 0..1 (nach Semantik-Verarbeitung). */
  value01: number;
  /** Rohwert, der das Mapping ausgelöst hat. */
  raw: number;
  source: ControlEvent;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** Prüft, ob eine Regel auf ein ControlEvent passt. */
export function ruleMatches(rule: MappingRule, ev: ControlEvent): boolean {
  if (rule.sourceProtocol !== ev.sourceProtocol) return false;
  if (rule.sourceDevice && rule.sourceDevice !== ev.sourceDevice) return false;
  if (rule.channel && ev.channel !== 0 && rule.channel !== ev.channel) return false;
  if (rule.parameter !== ev.parameter) return false;
  if (rule.address && ev.address && !ev.address.startsWith(rule.address)) return false;
  return true;
}

/** Wert eines ControlEvents in den Zielbereich (min..max) skalieren. */
function scaleToRange(v01: number, rule: MappingRule): number {
  const min = rule.min ?? 0;
  const max = rule.max ?? 1;
  return min + v01 * (max - min);
}

export class MappingEngine {
  private rules = new Map<string, MappingRule>();
  /** Zustand für relative/toggle-Mappings (pro Regel). */
  private state = new Map<string, number>();

  addRule(rule: MappingRule): void {
    this.rules.set(rule.id, { ...rule });
  }

  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
    this.state.delete(ruleId);
  }

  listRules(): MappingRule[] {
    return [...this.rules.values()];
  }

  getRule(ruleId: string): MappingRule | undefined {
    return this.rules.get(ruleId);
  }

  clear(): void {
    this.rules.clear();
    this.state.clear();
  }

  /** Setzt den internen Zustand (z. B. für Toggle/Relative) zurück. */
  resetState(ruleId?: string): void {
    if (ruleId) this.state.delete(ruleId);
    else this.state.clear();
  }

  /** Setzt den aktuellen Wert eines Zustands-Mappings (z. B. aus UI). */
  setStateValue(ruleId: string, value01: number): void {
    this.state.set(ruleId, clamp01(value01));
  }

  getStateValue(ruleId: string): number {
    return this.state.get(ruleId) ?? 0;
  }

  /** Verarbeitet ein ControlEvent und liefert alle getroffenen Parameter. */
  map(ev: ControlEvent): MappedParameter[] {
    const out: MappedParameter[] = [];
    for (const rule of this.rules.values()) {
      if (!ruleMatches(rule, ev)) continue;
      const value01 = this.apply(rule, ev);
      out.push({ target: rule.target, value01, raw: ev.value, source: ev });
    }
    return out;
  }

  private apply(rule: MappingRule, ev: ControlEvent): number {
    switch (rule.kind) {
      case 'absolute': {
        const v = normalizeControlValue(ev.value, ev.resolution);
        const scaled = scaleToRange(v, rule);
        const lo = Math.min(rule.min ?? 0, rule.max ?? 1);
        const hi = Math.max(rule.min ?? 0, rule.max ?? 1);
        return Math.max(lo, Math.min(hi, scaled));
      }
      case 'relative': {
        // Relativer Encoder/Jog: Delta akkumulieren (ev.value = ±Schritte).
        const prev = this.state.get(rule.id) ?? 0;
        const delta = ev.value * (rule.relativeStep ?? 0.01);
        const next = clamp01(prev + delta);
        this.state.set(rule.id, next);
        return next;
      }
      case 'toggle': {
        // Umschalter: jede steigende Flanke toggelt zwischen min und max.
        if (ev.value <= 0) {
          return this.state.get(rule.id) ?? 0;
        }
        const prev = this.state.get(rule.id) ?? 0;
        const min = rule.min ?? 0;
        const max = rule.max ?? 1;
        const next = prev > (min + max) / 2 ? min : max;
        this.state.set(rule.id, next);
        return next;
      }
      case 'momentary': {
        // Taster: gedrückt = max, losgelassen = min.
        const min = rule.min ?? 0;
        const max = rule.max ?? 1;
        const pressed = ev.resolution > 1 ? normalizeControlValue(ev.value, ev.resolution) > 0.5 : ev.value > 0;
        const next = pressed ? max : min;
        this.state.set(rule.id, next);
        return next;
      }
      default:
        return 0;
    }
  }
}
