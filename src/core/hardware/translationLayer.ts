/**
 * audioMONASTRY · Translation Layer (transportübergreifend)
 * ==========================================================
 * Übersetzt ControlEvents zwischen Protokollen, ohne die Audio-Engine zu
 * berühren (reine Datenpfade):
 *
 *   MIDI → OSC · OSC → MIDI · HID → MIDI · HID → OSC · MIDI → HID
 *
 * Ausgabe ist bewusst "encoded + event": Der Aufrufer entscheidet, welcher
 * Transport die Bytes/Pakete tatsächlich versendet (Adapter/Sidecar).
 */
import type { ControlEvent, ControlSourceProtocol } from '../interfaces';
import { controlEventToOsc, oscMessageToControlEvents } from './oscBridge';
import { encodeOscBundle, decodeOscPacket } from './oscCodec';
import type { OscMessage } from './oscCodec';
import { eventToControlMessage } from './controlEvent';
import { encodeControlMessage } from './midiCodec';

export interface TranslationRule {
  id: string;
  from: ControlSourceProtocol;
  to: ControlSourceProtocol;
  enabled: boolean;
}

export interface TranslationResult {
  /** OSC-Paket (Big-Endian), wenn Ziel OSC. */
  osc?: Uint8Array;
  /** MIDI-Bytes, wenn Ziel MIDI. */
  midi?: number[];
  /** Ziel-Events (immer vorhanden, wenn eine Regel passt). */
  events: ControlEvent[];
  /** Gepasste Regel-IDs. */
  matchedRules: string[];
}

export class TranslationLayer {
  private rules = new Map<string, TranslationRule>();

  addRule(from: ControlSourceProtocol, to: ControlSourceProtocol, enabled = true): TranslationRule {
    const rule: TranslationRule = { id: `${from}->${to}`, from, to, enabled };
    this.rules.set(rule.id, rule);
    return rule;
  }

  removeRule(id: string): void {
    this.rules.delete(id);
  }

  listRules(): TranslationRule[] {
    return [...this.rules.values()];
  }

  /**
   * Übersetzt ein ControlEvent in alle konfigurierten Ziel-Protokolle.
   * Ein defektes Ziel (nicht kodierbar) wird übersprungen, wirft aber nie.
   */
  translate(ev: ControlEvent): TranslationResult {
    const result: TranslationResult = { events: [], matchedRules: [] };
    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.from !== ev.sourceProtocol) continue;
      try {
        const targetEvent = this.retarget(ev, rule.to);
        result.events.push(targetEvent);
        result.matchedRules.push(rule.id);

        if (rule.to === 'osc') {
          const msg = controlEventToOsc(targetEvent);
          result.osc = encodeOscBundle(0, 1, [msg]); // immediate-Timetag
        } else if (rule.to === 'midi') {
          const msg = eventToControlMessage(targetEvent);
          result.midi = encodeControlMessage(msg);
        }
        // HID-Ziel: der HID-Adapter übernimmt das Encoding (Output-Reports).
      } catch {
        // Kodierungsfehler isolieren – Übersetzung ist Best-Effort.
      }
    }
    return result;
  }

  /** Übersetzt ein binäres OSC-Paket in ControlEvents (Eingangsrichtung). */
  fromOsc(packet: ArrayLike<number>, sourceDevice: string): ControlEvent[] {
    try {
      const decoded = decodeOscPacket(packet);
      const messages: OscMessage[] = decoded.kind === 'bundle'
        ? decoded.elements.filter((p): p is OscMessage => p.kind === 'message')
        : [decoded];
      const out: ControlEvent[] = [];
      for (const m of messages) out.push(...oscMessageToControlEvents(m, sourceDevice));
      return out;
    } catch {
      return [];
    }
  }

  private retarget(ev: ControlEvent, to: ControlSourceProtocol): ControlEvent {
    return {
      ...ev,
      sourceProtocol: to,
      address: to === 'osc' ? `/control/${ev.messageType}/${ev.parameter}` : ev.address,
    };
  }
}
