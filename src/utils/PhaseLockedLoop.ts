// src/utils/PhaseLockedLoop.ts
export class PhaseLockedLoop {
  private drift: number = 0;
  private kp: number = 0.1; // Proportional gain
  private ki: number = 0.01; // Integral gain

  public update(measuredOffset: number): number {
    this.drift += measuredOffset * this.ki;
    this.drift += measuredOffset * this.kp;
    
    // Smooth the drift
    return this.drift;
  }
}
