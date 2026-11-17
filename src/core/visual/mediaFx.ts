/**
 * audioMONASTRY · VisualMONK – Medien-Effekte (Bilder/Clips nach Klang verformt)
 * ==============================================================================
 * Der Szenen-Shader in `webglRenderer.ts` legt Bild/Clip mit `sceneAmount = 1`
 * UNVERÄNDERT über das generative Feld: die Audio-Parameter wirken nur auf das
 * verdeckte Feld, nicht auf das Medium. Diese Stufe wendet die Effekte auf das
 * Medium selbst an und übernimmt dafür die bestehende Audio→Parameter-Abbildung
 * (`mapAudioToParams`), damit Presets ihren Charakter behalten.
 *
 * Effekte (alle audio-gesteuert, ein Durchgang auf der GPU):
 *  - Kick-Zoom (Bass/Onset) plus langsamer Ken-Burns-Drift,
 *  - Drehung und Wellen-Verzerrung (Höhen/Mitten),
 *  - Farbton-Drift, Helligkeit und Kontrast aus Pegel und Höhen,
 *  - Glow (heller Überstrahl-Anteil), Chroma-Split und Glitch-Streifen auf Onsets,
 *  - Kaleidoskop-Spiegelung bei Presets mit Symmetrie,
 *  - Überblendung zweier Medien, jeweils mit denselben Effekten.
 */
import { clamp01 } from './audioReactive';
import { mediaSize, sceneCoverSpan, type VisualSceneFrame } from './webglRenderer';
import type { AudioFeatures, VisualParams, VisualPreset } from './types';

export interface MediaFxRenderer {
  kind: 'webgl2' | 'webgl';
  render(preset: VisualPreset, params: VisualParams, features: AudioFeatures, timeS: number, scene: VisualSceneFrame | null): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

const VERTEX = `attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT = `precision highp float;
varying vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_mix;
uniform float u_hasA;
uniform float u_fadeIn;
uniform vec2 u_spanA;
uniform vec2 u_spanB;
uniform vec2 u_res;
uniform float u_time;
uniform float u_zoom;
uniform float u_rot;
uniform float u_hue;
uniform float u_bright;
uniform float u_contrast;
uniform float u_glow;
uniform float u_split;
uniform float u_glitch;
uniform float u_warp;
uniform float u_sym;
uniform float u_kaleido;

float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }

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

vec3 media(sampler2D tex, vec2 span, vec2 p) {
  return texture2D(tex, clamp(p * span + 0.5, 0.001, 0.999)).rgb;
}

// Bildraum-Verformung: Zoom, Drehung, Welle, Kaleidoskop (p in Seitenverhältnis-Einheiten).
vec2 distort(vec2 p) {
  p /= max(u_zoom, 0.2);
  float c = cos(u_rot);
  float s = sin(u_rot);
  p = mat2(c, -s, s, c) * p;
  p += u_warp * 0.02 * vec2(sin(p.y * 12.0 + u_time * 1.7), cos(p.x * 12.0 + u_time * 1.3));
  if (u_kaleido > 0.001) {
    float ang = atan(p.y, p.x);
    float rad = length(p);
    float sector = 6.28318530718 / max(u_sym, 1.0);
    ang = abs(mod(ang + sector * 0.5, sector) - sector * 0.5);
    p = mix(p, vec2(cos(ang), sin(ang)) * rad, u_kaleido);
  }
  return p;
}

vec3 grade(sampler2D tex, vec2 span, vec2 p0) {
  vec2 p = p0;
  float band = floor(v_uv.y * 24.0) + floor(u_time * 12.0);
  if (u_glitch > 0.0 && hash(band) > 1.0 - u_glitch * 0.5) {
    p.x += (hash(band + 3.0) - 0.5) * 0.12 * u_glitch;
  }
  vec2 q = distort(p);
  vec2 dir = normalize(q + vec2(1e-4)) * u_split;
  vec3 col = vec3(media(tex, span, q + dir).r, media(tex, span, q).g, media(tex, span, q - dir).b);
  float r = 0.012;
  vec3 blur = (media(tex, span, q + vec2(r, 0.0)) + media(tex, span, q - vec2(r, 0.0)) +
               media(tex, span, q + vec2(0.0, r)) + media(tex, span, q - vec2(0.0, r))) * 0.25;
  col += max(blur - 0.5, 0.0) * u_glow * 1.6;
  return col;
}

void main() {
  float aspect = u_res.x / max(u_res.y, 1.0);
  // Medien-UV bleiben Cover-Fit; die Verformung arbeitet in Seitenverhältnis-Einheiten.
  vec2 p = vec2((v_uv.x - 0.5) * aspect, v_uv.y - 0.5);
  vec3 b = grade(u_b, vec2(u_spanB.x / aspect, u_spanB.y), p);
  vec3 col = b;
  if (u_hasA > 0.5) {
    vec3 a = grade(u_a, vec2(u_spanA.x / aspect, u_spanA.y), p);
    col = mix(a, b, clamp(u_mix, 0.0, 1.0));
  }
  col = hueRotate(col, u_hue);
  col = (col - 0.5) * u_contrast + 0.5;
  col *= u_bright * u_fadeIn;
  col *= mix(0.7, 1.0, smoothstep(1.2, 0.2, length(v_uv - 0.5) * 1.6));
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const UNIFORMS = ['u_a', 'u_b', 'u_mix', 'u_hasA', 'u_fadeIn', 'u_spanA', 'u_spanB', 'u_res', 'u_time', 'u_zoom',
  'u_rot', 'u_hue', 'u_bright', 'u_contrast', 'u_glow', 'u_split', 'u_glitch', 'u_warp', 'u_sym', 'u_kaleido'] as const;

/** Reine Abbildung Klang → Effektstärken (ohne GPU testbar). */
export function mediaFxValues(preset: VisualPreset, params: VisualParams, f: AudioFeatures, timeS: number) {
  const energy = clamp01(f.energy);
  const hueDeg = (((params.hue - preset.palette.hueBase) % 360) + 360) % 360;
  return {
    zoom: Math.min(1.3, 1.04 + f.bass * 0.1 + f.onset * 0.06 + 0.03 * Math.sin(timeS * 0.2)),
    rot: 0.025 * Math.sin(timeS * 0.4) + f.onset * 0.03 * Math.sin(timeS * 7) + f.treble * 0.02 * Math.sin(timeS * 3),
    hue: (hueDeg * Math.PI) / 180 * 0.25,
    bright: 0.75 + 0.5 * clamp01(params.brightness),
    contrast: 0.9 + 0.3 * clamp01(params.contrast),
    glow: clamp01(params.glow),
    split: f.onset * 0.012 + f.bass * 0.004,
    glitch: Math.max(0, Math.min(1, (f.onset - 0.75) / 0.25)),
    warp: clamp01(params.warp),
    sym: Math.max(1, params.symmetry),
    kaleido: params.symmetry > 1 ? clamp01(0.25 + 0.75 * energy) * 0.85 : 0,
  };
}

export function createMediaFxRenderer(canvas: HTMLCanvasElement): MediaFxRenderer | null {
  if (typeof canvas?.getContext !== 'function') return null;
  let kind: 'webgl2' | 'webgl' = 'webgl2';
  let gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false }) as
    WebGLRenderingContext | WebGL2RenderingContext | null;
  if (!gl) {
    kind = 'webgl';
    gl = canvas.getContext('webgl', { antialias: false, alpha: false }) as WebGLRenderingContext | null;
  }
  if (!gl) return null;
  const ctx = gl;

  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = ctx.createShader(type);
    if (!shader) return null;
    ctx.shaderSource(shader, source);
    ctx.compileShader(shader);
    if (!ctx.getShaderParameter(shader, ctx.COMPILE_STATUS)) {
      console.warn('[visual:mediafx] Shader-Kompilierung fehlgeschlagen:', String(ctx.getShaderInfoLog(shader)).slice(0, 200));
      return null;
    }
    return shader;
  };
  const vs = compile(ctx.VERTEX_SHADER, VERTEX);
  const fs = compile(ctx.FRAGMENT_SHADER, FRAGMENT);
  const program = ctx.createProgram();
  if (!vs || !fs || !program) return null;
  ctx.attachShader(program, vs);
  ctx.attachShader(program, fs);
  ctx.linkProgram(program);
  if (!ctx.getProgramParameter(program, ctx.LINK_STATUS)) return null;
  ctx.useProgram(program);

  const buffer = ctx.createBuffer();
  ctx.bindBuffer(ctx.ARRAY_BUFFER, buffer);
  ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
  const position = ctx.getAttribLocation(program, 'a_pos');
  ctx.enableVertexAttribArray(position);
  ctx.vertexAttribPointer(position, 2, ctx.FLOAT, false, 0, 0);

  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const name of UNIFORMS) u[name] = ctx.getUniformLocation(program, name);

  const makeTexture = (): WebGLTexture | null => {
    const tex = ctx.createTexture();
    if (!tex) return null;
    ctx.bindTexture(ctx.TEXTURE_2D, tex);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, 1, 1, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return tex;
  };
  const textureA = makeTexture();
  const textureB = makeTexture();
  let uploadedA: TexImageSource | null = null;
  let uploadedB: TexImageSource | null = null;
  let width = canvas.width;
  let height = canvas.height;

  const isVideo = (s: TexImageSource): boolean => typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement;
  const upload = (tex: WebGLTexture | null, unit: number, source: TexImageSource): boolean => {
    const [mw, mh] = mediaSize(source);
    if (!tex || mw === 0 || mh === 0) return false;
    try {
      ctx.activeTexture(unit);
      ctx.bindTexture(ctx.TEXTURE_2D, tex);
      ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, true);
      ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, source);
    } catch {
      return false;
    }
    return true;
  };

  return {
    kind,
    resize(nextWidth, nextHeight) {
      width = Math.max(1, Math.round(nextWidth));
      height = Math.max(1, Math.round(nextHeight));
      canvas.width = width;
      canvas.height = height;
      ctx.viewport(0, 0, width, height);
    },
    render(preset, params, features, timeS, scene) {
      const v = mediaFxValues(preset, params, features, timeS);
      ctx.viewport(0, 0, width, height);
      ctx.uniform2f(u.u_res, width, height);
      ctx.uniform1f(u.u_time, timeS);
      ctx.uniform1f(u.u_zoom, v.zoom);
      ctx.uniform1f(u.u_rot, v.rot);
      ctx.uniform1f(u.u_hue, v.hue);
      ctx.uniform1f(u.u_bright, v.bright);
      ctx.uniform1f(u.u_contrast, v.contrast);
      ctx.uniform1f(u.u_glow, v.glow);
      ctx.uniform1f(u.u_split, v.split);
      ctx.uniform1f(u.u_glitch, v.glitch);
      ctx.uniform1f(u.u_warp, v.warp);
      ctx.uniform1f(u.u_sym, v.sym);
      ctx.uniform1f(u.u_kaleido, v.kaleido);

      let ready = false;
      let hasA = 0;
      let mix = 1;
      let fadeIn = 1;
      let spanA: [number, number] = [1, 1];
      let spanB: [number, number] = [1, 1];
      const current = scene?.current ?? null;
      if (current) {
        if ((isVideo(current) || uploadedB !== current) && upload(textureB, ctx.TEXTURE1, current)) uploadedB = current;
        if (uploadedB === current) {
          ready = true;
          const [mw, mh] = mediaSize(current);
          spanB = sceneCoverSpan(width, height, mw, mh);
          const fade = typeof scene?.mix === 'number' && Number.isFinite(scene.mix) ? Math.max(0, Math.min(1, scene.mix)) : 1;
          const previous = scene?.previous ?? null;
          if (previous) {
            if ((isVideo(previous) || uploadedA !== previous) && upload(textureA, ctx.TEXTURE0, previous)) uploadedA = previous;
            if (uploadedA === previous) {
              hasA = 1;
              mix = fade;
              const [pw, ph] = mediaSize(previous);
              spanA = sceneCoverSpan(width, height, pw, ph);
            }
          }
          // Erste Szene ohne Vorgänger blendet aus Schwarz ein.
          if (!hasA) fadeIn = fade;
        }
      }
      ctx.uniform1f(u.u_hasA, hasA);
      ctx.uniform1f(u.u_mix, mix);
      ctx.uniform1f(u.u_fadeIn, ready ? fadeIn : 0);
      ctx.uniform2f(u.u_spanA, spanA[0], spanA[1]);
      ctx.uniform2f(u.u_spanB, spanB[0], spanB[1]);
      ctx.activeTexture(ctx.TEXTURE0);
      ctx.bindTexture(ctx.TEXTURE_2D, textureA);
      ctx.activeTexture(ctx.TEXTURE1);
      ctx.bindTexture(ctx.TEXTURE_2D, textureB);
      ctx.uniform1i(u.u_a, 0);
      ctx.uniform1i(u.u_b, 1);
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
    },
    dispose() {
      try {
        ctx.deleteTexture(textureA);
        ctx.deleteTexture(textureB);
        ctx.deleteBuffer(buffer);
        ctx.deleteProgram(program);
        ctx.deleteShader(vs);
        ctx.deleteShader(fs);
      } catch {
        /* Kontext kann bereits verloren sein */
      }
    },
  };
}
