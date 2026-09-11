/**
 * audioMONASTRY · VisualMONK – WebGL-Renderer (PERF/Qualität-Upgrade, VISUAL-P1-005)
 * ================================================================================
 * Der Canvas2D-Renderer (`canvasRenderer.ts`) läuft und bleibt die **Referenz**.
 * Dieser Renderer ist das **Upgrade**: dieselben `VisualParams` + `VisualPreset`
 * werden per GLSL auf der GPU gezeichnet — bei 60 fps deutlich günstiger als
 * Canvas2D und ohne Partikel-Array auf dem Main-Thread. Seit VISUAL-P1-008 zeichnet
 * er auch Show-Szenen (Bild/Clip) als Textur (`texImage2D`), inklusive Cover-Fit
 * und Crossfade zwischen vorheriger und aktueller Szene.
 *
 * Eigenheiten, die den Entwurf bestimmen:
 *   * Ein Canvas kann **nur einen** Kontexttyp haben. Ist der WebGL-Kontext erst
 *     erzeugt, liefert `getContext('2d')` `null`. Beim Umschalten wird deshalb
 *     das Canvas-Element neu erzeugt; Show-Szenen laufen in beiden Pfaden
 *     (Canvas2D: `drawImage`, WebGL: Textur).
 *   * Ein einziges GLSL-ES-1.00-Shader-Quelltext läuft in WebGL **und** WebGL2
 *     (WebGL2 akzeptiert ES-1.00-Shader) — kein doppelter Shader-Pfad.
 *   * Reine Teile (`buildFragmentShader`, `packUniforms`) sind ohne GPU testbar;
 *     `createWebGLVisualRenderer` wird im Gate im echten Browser geprüft.
 */

import type { VisualParams, VisualPreset } from './types';

export type VisualRendererKind = 'webgl2' | 'webgl' | 'canvas2d';

/** Maximal 6 Farben je Preset (WebGL1-Uniform-Limit-schonend). */
export const MAX_SHADER_COLORS = 6;

/**
 * Zahl der Uniform-Vektoren/Floats, die der Shader erwartet.
 * VISUAL-P1-008: zusätzlich die Show-Szene als Textur (Bild/Clip).
 */
export const SHADER_UNIFORMS = [
  'u_resolution',
  'u_time',
  'u_zoom',
  'u_rotation',
  'u_warp',
  'u_hue',
  'u_flow',
  'u_brightness',
  'u_contrast',
  'u_displacement',
  'u_glow',
  'u_symmetry',
  'u_colorCount',
  'u_sceneA',
  'u_sceneB',
  'u_sceneMix',
  'u_sceneAmount',
  'u_sceneSpanA',
  'u_sceneSpanB',
] as const;

export const VERTEX_SHADER_SOURCE = `attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) * 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/**
 * Fragment-Shader: fraktales Feld aus wenigen Sinus-Oktaven (GPU-freundlich,
 * kein Textur-Sampling nötig), Radialspiegelung über `u_symmetry`, Farbmischung
 * aus der Preset-Palette entlang des Feldes, Farbton-Rotation, Kontrast/
 * Helligkeit, Glow und Vignette.
 */
export function buildFragmentShader(): string {
  const colorDecls = Array.from({ length: MAX_SHADER_COLORS }, (_, i) => `uniform vec3 u_color${i};`).join('\n');
  const colorArray = Array.from({ length: MAX_SHADER_COLORS }, (_, i) => `  colors[${i}] = u_color${i};`).join('\n');
  return `precision mediump float;
varying vec2 v_uv;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_zoom;
uniform float u_rotation;
uniform float u_warp;
uniform float u_hue;
uniform float u_flow;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_displacement;
uniform float u_glow;
uniform float u_symmetry;
uniform float u_colorCount;
${colorDecls}
uniform sampler2D u_sceneA;
uniform sampler2D u_sceneB;
uniform float u_sceneMix;
uniform float u_sceneAmount;
uniform vec2 u_sceneSpanA;
uniform vec2 u_sceneSpanB;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec3 hueRotate(vec3 color, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  mat3 m = mat3(
    0.299 + 0.701 * c + 0.168 * s, 0.587 - 0.587 * c + 0.330 * s, 0.114 - 0.114 * c - 0.497 * s,
    0.299 - 0.299 * c - 0.328 * s, 0.587 + 0.413 * c + 0.035 * s, 0.114 - 0.114 * c + 0.292 * s,
    0.299 - 0.300 * c + 1.250 * s, 0.587 - 0.588 * c - 1.050 * s, 0.114 + 0.886 * c - 0.203 * s
  );
  return clamp(color * m, 0.0, 1.0);
}

void main() {
  vec2 uv = v_uv - 0.5;
  uv.x *= u_resolution.x / max(u_resolution.y, 1.0);

  // Zoom + Rotation (Winkel in Radiant)
  uv *= max(u_zoom, 0.05);
  float cs = cos(u_rotation);
  float sn = sin(u_rotation);
  uv = mat2(cs, -sn, sn, cs) * uv;

  // Radialspiegelung: ganzzahlige Sektoren
  float symmetry = max(u_symmetry, 1.0);
  float ang = atan(uv.y, uv.x);
  float rad = length(uv);
  float sector = 6.28318530718 / symmetry;
  ang = abs(mod(ang + sector * 0.5, sector) - sector * 0.5);
  uv = vec2(cos(ang), sin(ang)) * rad;

  // Fraktales Feld (3 Oktaven) + Fluss/Zeit
  float flow = u_time * u_flow;
  float field = 0.0;
  float amp = 0.6;
  float freq = 1.0;
  for (int i = 0; i < 3; i++) {
    field += amp * noise(uv * freq + vec2(flow, -flow * 0.7));
    amp *= 0.5;
    freq *= 2.1;
  }
  field = mix(field, field + sin((rad - flow) * 6.0) * 0.5, clamp(u_warp, 0.0, 1.0));
  field += u_displacement * (hash(uv * 3.0 + flow) - 0.5);

  // Palette entlang des Feldes mischen
  vec3 colors[${MAX_SHADER_COLORS}];
${colorArray}
  float t = clamp(field, 0.0, 0.9999) * max(u_colorCount - 1.0, 1.0);
  int idx = int(floor(t));
  float blend = fract(t);
  vec3 base = colors[0];
  for (int i = 0; i < ${MAX_SHADER_COLORS} - 1; i++) {
    if (i == idx) base = mix(colors[i], colors[i + 1], blend);
  }

  vec3 color = hueRotate(base, u_hue);
  color += pow(clamp(rad * 1.6, 0.0, 1.0), 2.0) * u_glow * base;
  color = (color - 0.5) * max(u_contrast, 0.0) + 0.5;
  color *= max(u_brightness, 0.0);

  // Vignette + leichte Sättigung
  float vignette = smoothstep(1.15, 0.25, length(v_uv - 0.5));
  color *= mix(0.55, 1.0, vignette);

  // VISUAL-P1-008: Show-Szene (Bild/Clip) als Textur über das Feld legen.
  // Cover-Fit: die sichtbare UV-Spanne wird von der CPU aus Canvas- und
  // Medien-Seitenverhältnis berechnet (kein Verzerren). Bei einem Szenenwechsel
  // blendet u_sceneMix von der vorherigen (A) zur aktuellen Szene (B).
  if (u_sceneAmount > 0.0) {
    vec2 uvA = (v_uv - 0.5) * u_sceneSpanA + 0.5;
    vec2 uvB = (v_uv - 0.5) * u_sceneSpanB + 0.5;
    vec3 scenePrev = texture2D(u_sceneA, clamp(uvA, 0.001, 0.999)).rgb;
    vec3 sceneCur = texture2D(u_sceneB, clamp(uvB, 0.001, 0.999)).rgb;
    vec3 scene = mix(scenePrev, sceneCur, clamp(u_sceneMix, 0.0, 1.0));
    color = mix(color, scene, clamp(u_sceneAmount, 0.0, 1.0));
  }

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;
}

export interface PackedUniforms {
  resolution: [number, number];
  time: number;
  zoom: number;
  rotation: number;
  warp: number;
  hue: number;
  flow: number;
  brightness: number;
  contrast: number;
  displacement: number;
  glow: number;
  symmetry: number;
  colorCount: number;
  colors: number[]; // flach: r,g,b, r,g,b …
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Kantenlänge: endliche, positive Ganzzahl (NaN/0/negativ → 1). */
const safeSide = (v: number) => (Number.isFinite(v) && v > 0 ? Math.max(1, Math.round(v)) : 1);

/**
 * Übersetzt Preset + Parameter in Uniform-Werte. Rein und ohne GPU, damit die
 * Abbildung testbar ist; begrenzt alles auf sinnvolle Bereiche (kein NaN auf
 * die GPU).
 */
export function packUniforms(
  preset: VisualPreset,
  params: VisualParams,
  opts: { timeS: number; width: number; height: number },
): PackedUniforms {
  const palette = (preset.palette?.colors ?? []).slice(0, MAX_SHADER_COLORS);
  const colors: number[] = [];
  for (let i = 0; i < MAX_SHADER_COLORS; i++) {
    const c = palette[i] ?? palette[palette.length - 1] ?? [0, 0, 0];
    colors.push(clamp01(c[0]), clamp01(c[1]), clamp01(c[2]));
  }
  return {
    // Test tests/webglRenderer.test.ts hat aufgedeckt: `Math.round(NaN)` ergab
    // eine NaN-Resolution → nichts würde gezeichnet. Jetzt abgesichert.
    resolution: [safeSide(opts.width), safeSide(opts.height)],
    time: Number.isFinite(opts.timeS) ? opts.timeS : 0,
    zoom: Number.isFinite(params.zoom) ? Math.min(4, Math.max(0.05, params.zoom)) : 1,
    rotation: Number.isFinite(params.rotation) ? (params.rotation * Math.PI) / 180 : 0,
    warp: clamp01(params.warp),
    // 0..360 Grad → 0..2π
    hue: Number.isFinite(params.hue) ? (((params.hue % 360) + 360) % 360) * (Math.PI / 180) : 0,
    flow: Number.isFinite(params.flow) ? Math.min(4, Math.max(0, params.flow)) : 0.5,
    brightness: Number.isFinite(params.brightness) ? Math.min(2, Math.max(0, params.brightness)) : 1,
    contrast: Number.isFinite(params.contrast) ? Math.min(3, Math.max(0, params.contrast)) : 1,
    displacement: clamp01(params.displacement),
    glow: clamp01(params.glow),
    symmetry: Number.isFinite(params.symmetry) ? Math.min(16, Math.max(1, Math.round(params.symmetry))) : 1,
    colorCount: Math.max(1, palette.length || 1),
    colors,
  };
}

/** Ein Frame der Show: aktuelle Szene und (im Crossfade) die vorherige. */
export interface VisualSceneFrame {
  /** Aktuelle Szene (Bild oder Video). */
  current: TexImageSource | null;
  /** Vorherige Szene während des Crossfades. */
  previous?: TexImageSource | null;
  /** 0 = nur vorherige, 1 = nur aktuelle Szene. */
  mix?: number;
}

/** Pixelmaße eines Bildes/eines Videos; `[0, 0]`, solange nicht dekodiert. */
export function mediaSize(source: TexImageSource | null | undefined): [number, number] {
  if (!source) return [0, 0];
  const m = source as {
    videoWidth?: number; videoHeight?: number;
    naturalWidth?: number; naturalHeight?: number;
    width?: number; height?: number;
  };
  const w = m.videoWidth ?? m.naturalWidth ?? m.width ?? 0;
  const h = m.videoHeight ?? m.naturalHeight ?? m.height ?? 0;
  return [Number.isFinite(w) && w > 0 ? w : 0, Number.isFinite(h) && h > 0 ? h : 0];
}

/**
 * Cover-Fit als sichtbare UV-Spanne: Das Medium füllt den Canvas vollständig,
 * ohne verzerrt zu werden (überstehende Ränder werden beschnitten). Reine
 * Funktion, damit die Abbildung ohne GPU prüfbar ist.
 */
export function sceneCoverSpan(
  canvasWidth: number,
  canvasHeight: number,
  mediaWidth: number,
  mediaHeight: number,
): [number, number] {
  const cw = safeSide(canvasWidth);
  const ch = safeSide(canvasHeight);
  const mw = Number.isFinite(mediaWidth) && mediaWidth > 0 ? mediaWidth : 0;
  const mh = Number.isFinite(mediaHeight) && mediaHeight > 0 ? mediaHeight : 0;
  if (mw === 0 || mh === 0) return [1, 1];
  const canvasAspect = cw / ch;
  const mediaAspect = mw / mh;
  return canvasAspect >= mediaAspect ? [1, mediaAspect / canvasAspect] : [canvasAspect / mediaAspect, 1];
}

export interface WebGLVisualRenderer {
  kind: 'webgl2' | 'webgl';
  /**
   * Zeichnet einen Frame (Preset + Parameter + optionale Show-Szene).
   * Ohne Szene (`null`) zeichnet der Shader nur das generative Feld.
   */
  render(preset: VisualPreset, params: VisualParams, timeS: number, scene?: VisualSceneFrame | null): void;
  /** Puffergröße angleichen (CSS-Größe * dpr). */
  resize(width: number, height: number): void;
  dispose(): void;
}

type GL = WebGLRenderingContext | WebGL2RenderingContext;

function compile(gl: GL, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[visual:webgl] Shader-Kompilierung fehlgeschlagen:', String(gl.getShaderInfoLog(shader)).slice(0, 200));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Erzeugt den Renderer oder `null`, wenn kein WebGL verfügbar ist (oder der
 * Kontext bereits von einem anderen Typ belegt ist = Canvas2D-Pfad). Der
 * Aufrufer fällt dann auf `canvasRenderer.renderFrame` zurück.
 */
export function createWebGLVisualRenderer(canvas: HTMLCanvasElement): WebGLVisualRenderer | null {
  if (typeof canvas?.getContext !== 'function') return null;
  let gl: GL | null = null;
  let kind: 'webgl2' | 'webgl' = 'webgl';
  try {
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
    if (gl) kind = 'webgl2';
    if (!gl) {
      gl = canvas.getContext('webgl', { antialias: false, alpha: false }) as WebGLRenderingContext | null;
      kind = 'webgl';
    }
  } catch {
    return null;
  }
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fs = compile(gl, gl.FRAGMENT_SHADER, buildFragmentShader());
  const program = gl.createProgram();
  if (!vs || !fs || !program) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[visual:webgl] Programm-Link fehlgeschlagen:', String(gl.getProgramInfoLog(program)).slice(0, 200));
    return null;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uniformOf = (name: string): WebGLUniformLocation | null => gl!.getUniformLocation(program, name);
  const u = {
    resolution: uniformOf('u_resolution'),
    time: uniformOf('u_time'),
    zoom: uniformOf('u_zoom'),
    rotation: uniformOf('u_rotation'),
    warp: uniformOf('u_warp'),
    hue: uniformOf('u_hue'),
    flow: uniformOf('u_flow'),
    brightness: uniformOf('u_brightness'),
    contrast: uniformOf('u_contrast'),
    displacement: uniformOf('u_displacement'),
    glow: uniformOf('u_glow'),
    symmetry: uniformOf('u_symmetry'),
    colorCount: uniformOf('u_colorCount'),
    colors: Array.from({ length: MAX_SHADER_COLORS }, (_, i) => uniformOf(`u_color${i}`)),
    sceneA: uniformOf('u_sceneA'),
    sceneB: uniformOf('u_sceneB'),
    sceneMix: uniformOf('u_sceneMix'),
    sceneAmount: uniformOf('u_sceneAmount'),
    sceneSpanA: uniformOf('u_sceneSpanA'),
    sceneSpanB: uniformOf('u_sceneSpanB'),
  };

  let width = canvas.width || 1;
  let height = canvas.height || 1;

  // VISUAL-P1-008: zwei Texturen für Show-Szenen (A = vorherige, B = aktuelle).
  // Bilder werden einmal hochgeladen, Videos pro Frame (sie ändern sich).
  const makeTexture = (): WebGLTexture | null => {
    const tex = gl!.createTexture();
    if (!tex) return null;
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    // 1×1-Platzhalter (schwarz): auch ohne Szene ist ein gültiger Sampler
    // gebunden, manche Treiber warnen sonst über eine unvollständige Textur.
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, 1, 1, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return tex;
  };
  const sceneTextureA = makeTexture();
  const sceneTextureB = makeTexture();
  let uploadedA: TexImageSource | null = null;
  let uploadedB: TexImageSource | null = null;

  const isVideoSource = (s: TexImageSource): boolean =>
    typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement;

  /** Lädt ein Bild/Video in die Textur. `false` = (noch) nicht bereit. */
  const upload = (tex: WebGLTexture | null, unit: number, source: TexImageSource): boolean => {
    const [mw, mh] = mediaSize(source);
    if (!tex || mw === 0 || mh === 0) return false;
    try {
      gl!.activeTexture(unit);
      gl!.bindTexture(gl!.TEXTURE_2D, tex);
      // Bildzeilen laufen von oben nach unten, GL erwartet v = 0 unten.
      gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, true);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, source);
    } catch {
      return false;
    }
    return true;
  };

  return {
    kind,
    resize(nextWidth: number, nextHeight: number): void {
      const w = Math.max(1, Math.round(nextWidth));
      const h = Math.max(1, Math.round(nextHeight));
      if (w === width && h === height) return;
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
      gl!.viewport(0, 0, w, h);
    },
    render(preset: Preset, params: VisualParams, timeS: number, scene: VisualSceneFrame | null = null): void {
      const values = packUniforms(preset, params, { timeS, width, height });
      gl!.viewport(0, 0, width, height);
      gl!.uniform2f(u.resolution, values.resolution[0], values.resolution[1]);
      gl!.uniform1f(u.time, values.time);
      gl!.uniform1f(u.zoom, values.zoom);
      gl!.uniform1f(u.rotation, values.rotation);
      gl!.uniform1f(u.warp, values.warp);
      gl!.uniform1f(u.hue, values.hue);
      gl!.uniform1f(u.flow, values.flow);
      gl!.uniform1f(u.brightness, values.brightness);
      gl!.uniform1f(u.contrast, values.contrast);
      gl!.uniform1f(u.displacement, values.displacement);
      gl!.uniform1f(u.glow, values.glow);
      gl!.uniform1f(u.symmetry, values.symmetry);
      gl!.uniform1f(u.colorCount, values.colorCount);
      for (let i = 0; i < MAX_SHADER_COLORS; i++) {
        const base = i * 3;
        gl!.uniform3f(u.colors[i], values.colors[base], values.colors[base + 1], values.colors[base + 2]);
      }

      // Show-Szene: aktuelle Szene → Textur B, vorherige (Crossfade) → A.
      // `sceneAmount = 0` lässt den Shader das generative Feld allein zeichnen.
      let sceneAmount = 0;
      let mix = 1;
      let spanA: [number, number] = [1, 1];
      let spanB: [number, number] = [1, 1];
      if (scene?.current) {
        if ((isVideoSource(scene.current) || uploadedB !== scene.current) && upload(sceneTextureB, gl!.TEXTURE1, scene.current)) {
          uploadedB = scene.current;
        }
        if (uploadedB === scene.current) {
          const [mw, mh] = mediaSize(scene.current);
          spanB = sceneCoverSpan(width, height, mw, mh);
          sceneAmount = 1;
          const previous = scene.previous ?? null;
          if (previous) {
            if ((isVideoSource(previous) || uploadedA !== previous) && upload(sceneTextureA, gl!.TEXTURE0, previous)) {
              uploadedA = previous;
            }
            if (uploadedA === previous) {
              const [pw, ph] = mediaSize(previous);
              spanA = sceneCoverSpan(width, height, pw, ph);
              mix = typeof scene.mix === 'number' && Number.isFinite(scene.mix)
                ? Math.max(0, Math.min(1, scene.mix))
                : 1;
            }
          }
        }
      }

      gl!.activeTexture(gl!.TEXTURE0);
      gl!.bindTexture(gl!.TEXTURE_2D, sceneTextureA);
      gl!.activeTexture(gl!.TEXTURE1);
      gl!.bindTexture(gl!.TEXTURE_2D, sceneTextureB);
      gl!.uniform1i(u.sceneA, 0);
      gl!.uniform1i(u.sceneB, 1);
      gl!.uniform1f(u.sceneMix, mix);
      gl!.uniform1f(u.sceneAmount, sceneAmount);
      gl!.uniform2f(u.sceneSpanA, spanA[0], spanA[1]);
      gl!.uniform2f(u.sceneSpanB, spanB[0], spanB[1]);

      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    },
    dispose(): void {
      try {
        gl!.deleteTexture(sceneTextureA);
        gl!.deleteTexture(sceneTextureB);
        gl!.deleteBuffer(buffer);
        gl!.deleteProgram(program);
        gl!.deleteShader(vs);
        gl!.deleteShader(fs);
      } catch {
        /* Kontext kann bereits verloren sein */
      }
    },
  };
}

/** Kurzform, damit der Aufrufer nicht den Typ-Import braucht. */
type Preset = VisualPreset;
