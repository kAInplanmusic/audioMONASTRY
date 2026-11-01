import { describe, expect, it } from 'vitest';
import {
  applyModMatrix,
  applyModulationToParameters,
  clampModulation,
  modRouteContribution,
  type ModRoute,
} from '../src/core/dsp/modMatrix';

describe('Modulations-Matrix (FEAT-P3-001)', () => {
  describe('modRouteContribution', () => {
    it('bipolar: 0..1 auf -1..1', () => {
      expect(modRouteContribution(0, 1, 'bipolar')).toBe(-1);
      expect(modRouteContribution(0.5, 1, 'bipolar')).toBe(0);
      expect(modRouteContribution(1, 1, 'bipolar')).toBe(1);
    });

    it('unipolar: 0..1 bleibt 0..1', () => {
      expect(modRouteContribution(0, 1, 'unipolar')).toBe(0);
      expect(modRouteContribution(0.5, 1, 'unipolar')).toBe(0.5);
      expect(modRouteContribution(1, 1, 'unipolar')).toBe(1);
    });

    it('keine Polarität = unipolar (Standard)', () => {
      expect(modRouteContribution(0.5, 0.5)).toBe(0.25); // 0.5 * 0.5
    });

    it('depth wird geklemmt auf -1..1', () => {
      // max depth 1
      expect(modRouteContribution(1, 2, 'bipolar')).toBe(1); // (1*2-1) * 1
      // min depth -1: bipolar(0*2-1)=-1, contribution = -1 * -1 = 1
      expect(modRouteContribution(0, -2, 'bipolar')).toBe(1);
    });

    it('NaN/Inf depth → NaN (wird später geklemmt)', () => {
      const result = modRouteContribution(0.5, Number.NaN, 'bipolar');
      expect(Number.isNaN(result)).toBe(true);
    });
  });

  describe('clampModulation', () => {
    it('keeps numbers within bounds', () => {
      expect(clampModulation(0.5, -1, 1)).toBe(0.5);
      expect(clampModulation(2, -1, 1)).toBe(1);
      expect(clampModulation(-2, -1, 1)).toBe(-1);
    });

    it('NaN/Inf → 0 (dann geklemmt)', () => {
      expect(clampModulation(Number.NaN, -1, 1)).toBe(0);
      // Infinity wird zu 0, dann clamped = 0
      expect(clampModulation(Number.POSITIVE_INFINITY, -1, 1)).toBe(0);
      expect(clampModulation(Number.NEGATIVE_INFINITY, -1, 1)).toBe(0);
    });

    it('reversed bounds: min > max nutzt min als hi', () => {
      // Math.max(min, Math.min(max, value)) wobei min=1, max=-1
      // clampModulation(0.5, 1, -1) = Math.max(1, Math.min(-1, 0.5)) = Math.max(1, -1) = 1
      expect(clampModulation(0.5, 1, -1)).toBe(1);
    });
  });

  describe('applyModMatrix', () => {
    const routes: ModRoute[] = [
      { id: 'r1', source: 'lfo1', destination: 'filter.cutoff', depth: 0.5, polarity: 'bipolar' },
      { id: 'r2', source: 'env', destination: 'filter.cutoff', depth: 0.3, polarity: 'unipolar' },
      { id: 'r3', source: 'lfo1', destination: 'osc pitch', depth: 0.2 },
      { id: 'disabled', source: 'lfo1', destination: 'mute', depth: 0.5, enabled: false },
    ];

    it('sums contributions to same destination', () => {
      const sources = { lfo1: 1, env: 0.5 };
      const result = applyModMatrix(routes, sources);
      // filter.cutoff: 0.5 (bipolar lfo1=1) + 0.15 (unipolar env=0.5) = 0.65
      expect(result.values['filter.cutoff']).toBeCloseTo(0.65);
      expect(result.applied).toBe(3);
    });

    it('skips disabled routes', () => {
      const sources = { lfo1: 1 };
      const result = applyModMatrix(routes, sources);
      expect(result.skipped).toContain('disabled');
    });

    it('skips unknown sources', () => {
      const sources = { unknown: 1 };
      const result = applyModMatrix(routes, sources);
      expect(result.applied).toBe(0);
      expect(result.skipped.length).toBe(4); // all routes
    });

    it('clamps to default -1..1', () => {
      const routes: ModRoute[] = [
        { id: 'r', source: 'source', destination: 'target', depth: 10 },
      ];
      const sources = { source: 1 };
      const result = applyModMatrix(routes, sources);
      expect(result.values['target']).toBe(1); // clamped
    });

    it('custom clamp bounds', () => {
      const routes: ModRoute[] = [
        { id: 'r', source: 's', destination: 't', depth: 1 },
      ];
      const sources = { s: 0.5 }; // unipolar = 0.5 contribution
      const result = applyModMatrix(routes, sources, { clampMin: 0, clampMax: 2 });
      expect(result.values['t']).toBe(0.5); // not clamped, within bounds
    });
  });

  describe('applyModulationToParameters', () => {
    it('adds modulation to base parameters (zero contribution)', () => {
      const base = { 'filter.cutoff': 1000, 'osc pitch': 440 };
      const routes: ModRoute[] = [
        { id: 'r1', source: 'lfo1', destination: 'filter.cutoff', depth: 0.5, polarity: 'bipolar' },
      ];
      // lfo1=0, bipolar(0*2-1)=-1, contribution=-1*0.5=-0.5
      const sources = { lfo1: 0.5 }; // 0.5 => bipolar(0.5*2-1)=0, contribution = 0
      const result = applyModulationToParameters(base, routes, sources);
      expect(result.parameters['filter.cutoff']).toBe(1000);
      expect(result.applied).toBe(1);
    });

    it('moduliert in beide Richtungen', () => {
      const base = { 'filter.cutoff': 1000 };
      const routes: ModRoute[] = [
        { id: 'r1', source: 'lfo1', destination: 'filter.cutoff', depth: 0.5, polarity: 'bipolar' },
      ];
      const sources = { lfo1: 1 }; // bipolar(1*2-1)=1, contribution = 1 * 0.5 = 0.5
      const result = applyModulationToParameters(base, routes, sources);
      expect(result.parameters['filter.cutoff']).toBe(1000.5); // 1000 + 0.5
    });

    it('handles no routes', () => {
      const base = { 'filter.cutoff': 1000 };
      const result = applyModulationToParameters(base, [], {});
      expect(result.parameters).toEqual(base);
      expect(result.applied).toBe(0);
    });
  });
});