/**
 * audioMONASTRY · V1→V2-Migrationsbrücke
 * ======================================
 * Hält die bestehende Engine (V1) und den neuen AudioGraph (V2) synchron.
 * Die Engine exportiert/importiert ihren Zustand; der Adapter spiegelt ihn
 * in die GraphStateBridge (Gain/Pan-Nodes) und zurück.
 */
import { GraphStateBridge } from '../GraphStateBridge';
import type { AudioGraphState } from '../../../utils/audioGraphSerialization';

export interface GraphEngineSync {
  exportState(): AudioGraphState;
  importState(state: AudioGraphState): boolean;
}

export class GraphEngineAdapter {
  constructor(
    private engine: GraphEngineSync,
    private bridge: GraphStateBridge = new GraphStateBridge(),
  ) {}

  /** V1 → V2: Engine-Zustand in den Graph übernehmen. */
  syncToGraph(): AudioGraphState {
    const state = this.engine.exportState();
    this.bridge.importState(state);
    return this.bridge.exportState(state);
  }

  /** V2 → V1: Graph-Zustand in die Engine zurückspielen. */
  syncFromGraph(): boolean {
    const state = this.bridge.exportState(this.engine.exportState());
    return this.engine.importState(state);
  }

  get graph(): GraphStateBridge {
    return this.bridge;
  }
}
