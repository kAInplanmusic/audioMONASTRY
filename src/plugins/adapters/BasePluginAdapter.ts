import type { PluginState } from '../types';
import type {
  PluginAudioBlock,
  PluginCommand,
  PluginInterface,
  PluginManifest,
  PluginParameterValue,
  PluginRuntimeContext,
  PluginSnapshot,
} from '../plugin_interface';
import { clockBridge } from '../../core/drop';

/**
 * Gemeinsame Basis aller 16 kanonischen Plugin-Adapter.
 *
 * Invarianten:
 * - OFF ist immer ein transparenter Bypass (kein Audioeingriff).
 * - `process()` ist synchron und echtzeit-sicher.
 * - Netzwerk, AI, Storage und React-State sind außerhalb von `process()`.
 * - Locking wird vor mutierenden Aktionen geprüft.
 * - Snapshot/Restore ist deterministisch.
 * - `dispose()` ist idempotent.
 */
export abstract class BasePluginAdapter implements PluginInterface {
  protected context: PluginRuntimeContext | null = null;
  protected parameters: Record<string, number | string | boolean> = {};
  protected disposed = false;
  protected syncEnabled = true;
  private scheduledSyncId?: string;
  private syncStartTimeout?: ReturnType<typeof setTimeout>;

  public state: PluginState = 'OFF';

  private get syncParamName(): string {
    return `sync.${this.manifest.id}`;
  }

  public isSyncEnabled(): boolean {
    return this.syncEnabled;
  }

  public setSyncEnabled(enabled: boolean): void {
    this.assertNotDisposed();
    this.syncEnabled = !!enabled;
    this.parameters[this.syncParamName] = this.syncEnabled;
    // Backward compatibility
    this.parameters['sync'] = this.syncEnabled;
  }

  protected constructor(
    public readonly manifest: PluginManifest,
  ) {}

  async initialize(context: PluginRuntimeContext): Promise<void> {
    this.assertNotDisposed();
    this.context = context;
    await this.onInitialize(context);
  }

  protected async onInitialize(
    _context: PluginRuntimeContext,
  ): Promise<void> {
    return undefined;
  }

  setState(next: PluginState): void {
    this.assertNotDisposed();
    this.state = next;
  }

  setParameter(parameter: PluginParameterValue): void {
    this.assertNotDisposed();

    if (
      !this.context ||
      this.context.isLockedByOther(this.manifest.id)
    ) {
      return;
    }

    this.parameters[parameter.name] = parameter.value;
    if (parameter.name === this.syncParamName || parameter.name === 'sync') {
      this.syncEnabled = !!parameter.value;
    }
    this.onParameter(parameter);
  }

  protected onParameter(_parameter: PluginParameterValue): void {
    return undefined;
  }

  process(block: PluginAudioBlock): PluginAudioBlock {
    this.assertNotDisposed();

    if (this.state === 'OFF') {
      return block;
    }

    return this.onProcess(block);
  }

  protected onProcess(block: PluginAudioBlock): PluginAudioBlock {
    return block;
  }

  async handleCommand(command: PluginCommand): Promise<unknown> {
    this.assertNotDisposed();

    if (this.context?.isLockedByOther(this.manifest.id)) {
      throw new Error(`Plugin ${this.manifest.id} is locked by another user`);
    }

    return this.onCommand(command);
  }

  protected async onCommand(
    command: PluginCommand,
  ): Promise<unknown> {
    throw new Error(
      `Unsupported command ${command.name} for ${this.manifest.id}`,
    );
  }

  snapshot(): PluginSnapshot {
    return {
      pluginId: this.manifest.id,
      state: this.state,
      parameters: { ...this.parameters, [this.syncParamName]: this.syncEnabled },
    };
  }

  restore(snapshot: PluginSnapshot): void {
    this.assertNotDisposed();

    if (snapshot.pluginId !== this.manifest.id) {
      throw new Error(
        `Snapshot mismatch: ${snapshot.pluginId} != ${this.manifest.id}`,
      );
    }

    this.state = snapshot.state;
    this.parameters = { ...snapshot.parameters };
    const syncParam = this.parameters[this.syncParamName] ?? this.parameters['sync'];
    if (typeof syncParam === 'boolean') {
      this.syncEnabled = syncParam;
    } else if (typeof syncParam === 'string') {
      this.syncEnabled = syncParam === 'true';
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.cancelPendingSyncStart();
    await this.onDispose();
    this.context = null;
  }

  protected async onDispose(): Promise<void> {
    return undefined;
  }

  protected assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`Plugin ${this.manifest.id} is already disposed`);
    }
  }

  /** Kleiner, typisierter Helfer: numerischer Parameter mit Clamp. */
  protected numberParam(
    parameter: PluginParameterValue,
    fallback: number,
    min = -Infinity,
    max = Infinity,
  ): number {
    const raw = typeof parameter.value === 'number' ? parameter.value : Number(parameter.value);
    const n = Number.isFinite(raw) ? raw : fallback;
    return Math.min(max, Math.max(min, n));
  }

  /**
   * Zahl aus den **gespeicherten** Parametern (gesetzt über `restore()` oder
   * `setParameter()`), mit Vorgabe. Für die Block-Verarbeitung: `numberParam()`
   * arbeitet auf einem eingehenden Parameter-Objekt, nicht auf dem Zustand.
   */
  protected numberFromParameters(name: string, fallback: number): number {
    const raw = this.parameters[name];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  }

  /** Klemmt einen Wert auf [min, max] – für Block-Verarbeitung ohne Allokation. */
  protected clampValue(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * Plant einen Start taktgenau.
   *
   * `syncEnabled === false` → sofort.
   * `scheduleAtNextBar` gesetzt → dieses nutzen: es ist die ECHTE taktgenaue
   *   Planung im Audio-Thread (Tone.Transport) und fällt selbst auf sofortigen
   *   Aufruf zurück, wenn der Transport steht. Adapter, die eine solche
   *   Mechanik haben (z. B. drop über den DropAudioAdapter), dürfen sie nicht
   *   durch einen zweiten Zähler ersetzt werden — sonst stünde der Start still.
   * Sonst → ClockBridge: scheduleDrop auf die nächste Bar ('1bar'), mit
   *   BPM-Fallback per setTimeout, wenn der Transport nicht läuft.
   */
  protected scheduleSyncStart(start: () => void, scheduleAtNextBar?: (cb: () => void) => void): void {
    // Bereits geplante Starts abbrechen
    this.cancelPendingSyncStart();

    if (!this.syncEnabled) {
      start();
      return;
    }

    // Vorhandene, erprobte Audio-Thread-Planung bevorzugen.
    if (scheduleAtNextBar) {
      try {
        scheduleAtNextBar(() => start());
        return;
      } catch { start(); return; }
    }

    const clock = clockBridge.getClockState();
    if (clock.isRunning) {
      const id = clockBridge.scheduleDrop(() => {
        this.scheduledSyncId = undefined;
        start();
      }, '1bar');
      this.scheduledSyncId = id;
    } else {
      const delay = clockBridge.getDelayToQuantizationMs('1bar');
      // globales setTimeout statt window.setTimeout: der Adapter kann auch in
      // einem Worker-Kontext laufen, wo `window` nicht existiert. Der Feldtyp
      // ist ReturnType<typeof setTimeout>, damit beide Umgebungen passen.
      this.syncStartTimeout = setTimeout(() => {
        this.syncStartTimeout = undefined;
        start();
      }, delay);
    }
  }

  /** Bricht evtl. geplante Sync-Starts ab – aufrufer: stop/dispose. */
  protected cancelPendingSyncStart(): void {
    if (this.scheduledSyncId) {
      try { clockBridge.cancelScheduledDrop(this.scheduledSyncId); } catch {}
      this.scheduledSyncId = undefined;
    }
    if (this.syncStartTimeout !== undefined) {
      try { clearTimeout(this.syncStartTimeout); } catch {}
      this.syncStartTimeout = undefined;
    }
  }
}
