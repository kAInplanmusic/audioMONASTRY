export type PluginState = 'OFF' | 'AUTO_AI' | 'PRO';
export interface LockStatus {
  lockedBy: string | null;
  timestamp: number;
  active: boolean;
  /** Lock auto-expires after TTL (ms). Default 5 minutes. */
  ttl?: number;
}
export interface Plugin {
  config: { id: string, name: string, colorScheme: string };
  state: PluginState;
  lockStatus: LockStatus;
  requestLock(userId: string): Promise<boolean>;
  releaseLock(userId: string): Promise<void>;
  updateState(newState: PluginState): Promise<void>;
}
