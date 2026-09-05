import type { Plugin, PluginState, LockStatus } from './types';
import { hubConnector } from '../hubConnector';

/**
 * Gemeinsame Basisklasse für Legacy-Plugins (Lock-/State-Verwaltung).
 * D6/Deduplizierung: `DspEnginePlugin` und `InstrumentePlugin` teilten sich
 * exakt dieselbe `requestLock`/`releaseLock`/`updateState`-Implementierung.
 */
export abstract class PluginLockable implements Plugin {
  abstract config: { id: string; name: string; colorScheme: string };

  state: PluginState = 'OFF';
  lockStatus: LockStatus = { lockedBy: null, timestamp: 0, active: false };

  async requestLock(userId: string): Promise<boolean> {
    const success = await hubConnector.lockPlugin(this.config.id, userId);
    if (success) {
      this.lockStatus = { lockedBy: userId, timestamp: Date.now(), active: true };
    }
    return success;
  }

  async releaseLock(userId: string): Promise<void> {
    await hubConnector.unlockPlugin(this.config.id, userId);
    this.lockStatus = { lockedBy: null, timestamp: 0, active: false };
  }

  async updateState(newState: PluginState): Promise<void> {
    this.state = newState;
  }
}
