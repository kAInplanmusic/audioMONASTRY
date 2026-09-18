/**
 * audioMONASTRY · VisualMONK – WebGPU/WGSL-Renderer (dritter Pfad)
 * =====================================================================
 * Der dritte Renderpfad neben Canvas2D (Referenz) und WebGL. Er ist bewusst
 * **kein Nachbau** des GL-Shaders, sondern eine eigene WGSL-Feldformel — teilt
 * aber den **Parameter-Contract**: `packUniforms()` aus `webglRenderer.ts`
 * liefert dieselben Werte (Zoom, Rotation, Warp, Farbton, Fluss, Helligkeit,
 * Kontrast, Verdrängung, Glow, Symmetrie, Palette), sodass dasselbe Preset auf
 * allen drei Pfaden dieselbe *Bedeutung* hat. Dass die Bilder nicht pixelgleich
 * sind, ist Absicht und steht so in der Doku: zwei Renderer, ein Parameterraum.
 *
 * WARUM DIESER PFAD ÜBERHAUPT (die frühere Begründung war falsch):
 * `MASTERTODOENDE.json` führte ihn als BLOCKED, weil `navigator.gpu` „in drei
 * Konfigurationen undefiniert" sei. Gemessen wurde damals auf `about:blank` —
 * das ist **kein sicherer Kontext**, dort fehlen WebGPU *und* `audioWorklet`.
 * Auf einem lokalen Origin (http://127.0.0.1, secure) ist `navigator.gpu`
 * vorhanden, und mit `--enable-unsafe-webgpu --enable-features=Vulkan
 * --use-angle=vulkan --use-vulkan=swiftshader --disable-vulkan-surface` liefert
 * `requestAdapter()` einen Adapter (siehe `scripts/browser-api-probe.mjs`).
 *
 * EHRliche GRENZE: Show-Szenen (Bild/Video-Textur, Crossfade) gibt es nur im
 * WebGL-Pfad. `render()` mit Szene sagt das ausdrücklich (`sceneIgnored`) statt
 * still etwas anderes zu zeigen; die UI schaltet für Szenen auf WebGL/2D zurück.
 */

import type { VisualParams, VisualPreset } from './types';
import { packUniforms, MAX_SHADER_COLORS, type VisualSceneFrame } from './webglRenderer';

export interface WebGpuVisualRenderer {
  kind: 'webgpu';
  /**
   * Zeichnet einen Frame. Wird eine Show-Szene uebergeben, zeichnet der Pfad
   * NUR das generative Feld und meldet das ueber den Rueckgabewert.
   */
  render(
    preset: VisualPreset,
    params: VisualParams,
    timeS: number,
    scene?: VisualSceneFrame | null,
  ): { sceneIgnored: boolean };
  resize(width: number, height: number): void;
  /** Echte GPU-Ruecklesung (RGBA8) - fuer Nachweise/Tests, nicht im Live-Pfad. */
  readPixels(): Promise<Uint8Array>;
  dispose(): void;
}

/** Uniform-Layout (WGSL `struct U`): 16 Bytes bis einschliesslich Farben-Block. */
export const WEBGPU_UNIFORM_FLOATS = 40; // 4 (resolution/time/zoom/…) + 6*4 (vec4-Farben)
export const WEBGPU_UNIFORM_BYTES = WEBGPU_UNIFORM_FLOATS * 4;

/**
 * WGSL-Shader: Fullscreen-Dreieck, polar gefaltetes Feld mit Warp/Flow, Palette
 * ueber Winkel+Radius, Glow und Helligkeit/Kontrast. Deterministisch (nur
 * sin/cos/fract, keine Zeitabhaengigkeit ausser `u.time`).
 */
export const WEBGPU_SHADER = /* wgsl */ `
struct U {
  resolution: vec2f,
  time: f32,
  zoom: f32,
  rotation: f32,
  warp: f32,
  hue: f32,
  flow: f32,
  brightness: f32,
  contrast: f32,
  displacement: f32,
  glow: f32,
  symmetry: f32,
  colorCount: f32,
  _pad0: f32,
  _pad1: f32,
  colors: array<vec4f, ${MAX_SHADER_COLORS}>,
};

@group(0) @binding(0) var<uniform> u: U;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VSOut {
  // Ein Dreieck, das den ganzen Clip-Raum abdeckt (wie im WebGL-Pfad).
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = positions[index];
  var out: VSOut;
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = p * 0.5 + vec2f(0.5, 0.5);
  return out;
}

fn palette(i: f32) -> vec3f {
  let count = max(u.colorCount, 1.0);
  let scaled = fract(i) * count;
  let idx = floor(scaled);
  let next = (idx + 1.0) % count;
  let mixv = fract(scaled);
  var a = vec3f(0.0);
  var b = vec3f(0.0);
  for (var k = 0; k < ${MAX_SHADER_COLORS}; k = k + 1) {
    let fi = f32(k);
    if (abs(fi - idx) < 0.5) { a = u.colors[k].rgb; }
    if (abs(fi - next) < 0.5) { b = u.colors[k].rgb; }
  }
  return mix(a, b, mixv);
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let res = max(u.resolution, vec2f(1.0, 1.0));
  var p = (in.uv - vec2f(0.5)) * vec2f(res.x / res.y, 1.0) * 2.0;
  p = p * max(u.zoom, 0.05);
  let cs = cos(-u.rotation);
  let sn = sin(-u.rotation);
  p = vec2f(p.x * cs - p.y * sn, p.x * sn + p.y * cs);

  let r = length(p);
  var a = atan2(p.y, p.x);
  // Symmetrie: Winkel auf einen Sektor falten (1 = aus, 16 = 16-fach).
  let sym = max(u.symmetry, 1.0);
  let sector = 6.28318530718 / sym;
  a = abs(((a + sector * 0.5) % sector) - sector * 0.5);

  let t = u.time * (0.15 + u.flow);
  let warp = u.warp * u.displacement;
  let band = sin(a * sym + r * (6.0 + 8.0 * warp) - t * 2.0);
  let swirl = cos(r * 5.0 - t * 1.3 + a * 3.0);
  let field = 0.5 + 0.5 * (band * 0.7 + swirl * (0.3 + warp));

  var col = palette(field + u.hue * 0.15915494309 + r * 0.12 + t * 0.05);
  col = col * (u.brightness * (1.0 + u.glow * 1.5));
  col = clamp((col - 0.5) * u.contrast + 0.5, vec3f(0.0), vec3f(1.0));
  // Glow: heller Kern, dunkler Rand (ersetzt den Vignette-Effekt des GL-Pfads).
  let vignette = smoothstep(1.6, 0.15, r);
  col = col * mix(1.0, vignette, clamp(u.glow, 0.0, 1.0));
  return vec4f(col, 1.0);
}
`;

/** Ist WebGPU hier verfuegbar? (Fragt KEINEN Adapter an - das macht die Fabrik.) */
export function hasWebGpuSupport(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/** Packt die Uniforms in der Reihenfolge des WGSL-Structs (40 floats). */
export function packWebGpuUniforms(
  preset: VisualPreset,
  params: VisualParams,
  opts: { timeS: number; width: number; height: number },
): Float32Array {
  const v = packUniforms(preset, params, opts);
  const out = new Float32Array(WEBGPU_UNIFORM_FLOATS);
  out[0] = v.resolution[0];
  out[1] = v.resolution[1];
  out[2] = v.time;
  out[3] = v.zoom;
  out[4] = v.rotation;
  out[5] = v.warp;
  out[6] = v.hue;
  out[7] = v.flow;
  out[8] = v.brightness;
  out[9] = v.contrast;
  out[10] = v.displacement;
  out[11] = v.glow;
  out[12] = v.symmetry;
  out[13] = v.colorCount;
  out[14] = 0; // _pad0
  out[15] = 0; // _pad1
  for (let i = 0; i < MAX_SHADER_COLORS; i++) {
    const base = 16 + i * 4;
    out[base] = v.colors[i * 3];
    out[base + 1] = v.colors[i * 3 + 1];
    out[base + 2] = v.colors[i * 3 + 2];
    out[base + 3] = 1;
  }
  return out;
}

/**
 * Erzeugt den WebGPU-Renderer oder `null`, wenn WebGPU/Adapter/Pipeline fehlen.
 * Der Aufrufer faellt dann ehrlich auf WebGL/Canvas2D zurueck.
 */
export async function createWebGpuVisualRenderer(
  canvas: HTMLCanvasElement,
): Promise<WebGpuVisualRenderer | null> {
  if (!hasWebGpuSupport() || typeof canvas?.getContext !== 'function') return null;
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;

  let device: GPUDevice | null = null;
  let context: GPUCanvasContext | null = null;
  let format: GPUTextureFormat = 'bgra8unorm';
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    device = await adapter.requestDevice();
    context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) return null;
    format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
  } catch (err) {
    console.warn('[visual:webgpu] Initialisierung fehlgeschlagen:', (err as Error).message);
    return null;
  }

  const module = device.createShaderModule({ code: WEBGPU_SHADER });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const uniformBuffer = device.createBuffer({
    size: WEBGPU_UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  let width = Math.max(1, canvas.width || 1);
  let height = Math.max(1, canvas.height || 1);
  let disposed = false;
  // Letzter gezeichneter Zustand: die Ruecklesung muss DAS zeigen, was zuletzt
  // gezeichnet wurde - ein erfundener Zustand waere ein wertloser Nachweis.
  let lastFrame: { preset: VisualPreset; params: VisualParams; timeS: number } | null = null;
  device.lost.then((info) => {
    // Geraeteverlust ehrlich melden - der Aufrufer kann auf WebGL/2D wechseln.
    if (!disposed) console.warn('[visual:webgpu] Geraet verloren:', info.message);
  });

  const drawTo = (
    target: GPUTextureView,
    preset: VisualPreset,
    params: VisualParams,
    timeS: number,
  ): void => {
    if (!device) return;
    device.queue.writeBuffer(uniformBuffer, 0, packWebGpuUniforms(preset, params, { timeS, width, height }));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  return {
    kind: 'webgpu',
    render(preset, params, timeS, scene = null) {
      lastFrame = { preset, params, timeS };
      if (!context || disposed) return { sceneIgnored: Boolean(scene?.current) };
      drawTo(context.getCurrentTexture().createView(), preset, params, timeS);
      return { sceneIgnored: Boolean(scene?.current) };
    },
    resize(nextWidth, nextHeight) {
      const w = Math.max(1, Math.round(nextWidth));
      const h = Math.max(1, Math.round(nextHeight));
      if (w === width && h === height) return;
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
      if (context && device) context.configure({ device, format, alphaMode: 'opaque' });
    },
    async readPixels() {
      // Echte GPU-Ruecklesung: in eine Textur rendern, in einen Puffer kopieren,
      // mappen, auslesen. Zeilen muessen auf 256 Bytes ausgerichtet sein.
      if (!device || !lastFrame) return new Uint8Array(0);
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const texture = device.createTexture({
        size: { width, height },
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      // Denselben Zustand erneut in die Offscreen-Textur zeichnen (das Canvas
      // selbst erlaubt kein Kopieren ohne COPY_SRC-Konfiguration).
      drawTo(texture.createView(), lastFrame.preset, lastFrame.params, lastFrame.timeS);
      const buffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      buffer.destroy();
      texture.destroy();
      return mapped;
    },
    dispose() {
      disposed = true;
      try {
        context?.unconfigure();
      } catch { /* egal */ }
      uniformBuffer.destroy();
      device?.destroy();
      device = null;
    },
  };
}
