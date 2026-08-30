export class WebGPUAdapter {
  private device: GPUDevice | null = null;

  async init() {
    if (!navigator.gpu) {
      throw new Error("WebGPU not supported on this browser.");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("No appropriate WebGPU adapter found.");
    }
    this.device = await adapter.requestDevice();
  }

  getDevice(): GPUDevice {
    if (!this.device) {
      throw new Error("WebGPU device not initialized.");
    }
    return this.device;
  }
}
