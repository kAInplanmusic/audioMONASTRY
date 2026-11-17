/**
 * audioMONASTRY · VisualMONK – GPU-Kette der Medien-Effekte
 * =========================================================
 * Die Basisstufe (`mediaFx.ts`) zeichnet in einen Zwischenpuffer; hier laufen die
 * gewählten Effekte nacheinander über zwei Ping-Pong-Puffer und das Ergebnis geht
 * auf den Bildschirm. Die letzten zwei fertigen Frames bleiben als Verlauf liegen
 * (für Echo, Feedback, Delay-RGB). Shader werden erst beim ersten Gebrauch kompiliert.
 */
import { EFFECTS, effectById, orderPicks, type EffectPick } from './registry';
import { COPY_FRAGMENT, VERTEX, fragmentFor } from './shaders';
import type { AudioFeatures } from '../types';

type GL = WebGLRenderingContext | WebGL2RenderingContext;

export interface ChainFrame {
  timeS: number;
  width: number;
  height: number;
  features: AudioFeatures;
  /** Bis zu vier Preset-Farben (RGB 0..1). */
  palette: ReadonlyArray<readonly [number, number, number]>;
  seed: number;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

interface Program {
  program: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
}

const GLYPHS = ' .:-=+*#%@';
const UNIFORMS = ['u_src', 'u_h1', 'u_h2', 'u_glyph', 'u_res', 'u_time', 'u_amount', 'u_audio', 'u_energy', 'u_seed',
  'u_pal[0]', 'u_pal[1]', 'u_pal[2]', 'u_pal[3]'] as const;

export interface EffectChain {
  /** Bindet den Zwischenpuffer der Basisstufe. */
  beginBase(): void;
  /** Wendet die Picks an und zeichnet das Ergebnis auf den Bildschirm. */
  run(picks: readonly EffectPick[], frame: ChainFrame): void;
  resize(width: number, height: number): void;
  /** Alle Effekt-IDs, deren Shader kompiliert werden konnten (Tests/Diagnose). */
  compiled(): string[];
  dispose(): void;
}

export function createEffectChain(gl: GL, width: number, height: number): EffectChain | null {
  const programs = new Map<string, Program | null>();
  let w = Math.max(1, Math.round(width));
  let h = Math.max(1, Math.round(height));

  const compile = (type: number, source: string, label: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('[visual:effect]', label, String(gl.getShaderInfoLog(shader)).slice(0, 300));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX, 'vertex');
  if (!vertex) return null;

  const link = (fragmentSource: string, label: string): Program | null => {
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource, label);
    const program = gl.createProgram();
    if (!fragment || !program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[visual:effect] link', label, String(gl.getProgramInfoLog(program)).slice(0, 300));
      return null;
    }
    const loc: Record<string, WebGLUniformLocation | null> = {};
    for (const name of UNIFORMS) loc[name] = gl.getUniformLocation(program, name);
    return { program, loc };
  };

  const programFor = (id: string): Program | null => {
    if (!programs.has(id)) programs.set(id, link(fragmentFor(id), id));
    return programs.get(id) ?? null;
  };
  const copyProgram = link(COPY_FRAGMENT, 'copy');
  if (!copyProgram) return null;

  const makeTarget = (): Target | null => {
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    return { tex, fbo };
  };

  let base: Target | null;
  let ping: Target | null;
  let pong: Target | null;
  let history: Array<Target | null>;
  let histIndex = 0;
  const allocate = () => {
    base = makeTarget();
    ping = makeTarget();
    pong = makeTarget();
    history = [makeTarget(), makeTarget(), makeTarget()];
  };
  const release = () => {
    for (const t of [base, ping, pong, ...history]) {
      if (t) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
    }
  };
  allocate();
  if (!base || !ping || !pong || history.some((t) => !t)) return null;

  // Zeichenatlas: ein Zeichen pro Zelle, hell auf schwarz.
  const glyphTex = gl.createTexture();
  const atlas = document.createElement('canvas');
  atlas.width = GLYPHS.length * 32;
  atlas.height = 32;
  const c2d = atlas.getContext('2d');
  if (c2d && glyphTex) {
    c2d.fillStyle = '#000';
    c2d.fillRect(0, 0, atlas.width, atlas.height);
    c2d.fillStyle = '#fff';
    c2d.font = 'bold 28px monospace';
    c2d.textAlign = 'center';
    c2d.textBaseline = 'middle';
    for (let i = 0; i < GLYPHS.length; i++) c2d.fillText(GLYPHS[i], i * 32 + 16, 17);
    gl.bindTexture(gl.TEXTURE_2D, glyphTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  const bindTexture = (unit: number, tex: WebGLTexture | null) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  };
  const draw = (target: Target | null) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const copy = (from: Target, to: Target | null) => {
    gl.useProgram(copyProgram.program);
    bindTexture(0, from.tex);
    gl.uniform1i(copyProgram.loc.u_src, 0);
    draw(to);
  };

  return {
    beginBase() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, base!.fbo);
      gl.viewport(0, 0, w, h);
    },
    run(picks, frame) {
      const f = frame.features;
      let current: Target = base!;
      let toggle = 0;
      const recent = history[(histIndex + 2) % 3]!;
      const older = history[(histIndex + 1) % 3]!;
      for (const pick of orderPicks(picks)) {
        const program = programFor(pick.id);
        if (!program) continue;
        const target = toggle === 0 ? ping! : pong!;
        gl.useProgram(program.program);
        bindTexture(0, current.tex);
        bindTexture(1, recent.tex);
        bindTexture(2, older.tex);
        bindTexture(3, glyphTex);
        gl.uniform1i(program.loc.u_src, 0);
        gl.uniform1i(program.loc.u_h1, 1);
        gl.uniform1i(program.loc.u_h2, 2);
        gl.uniform1i(program.loc.u_glyph, 3);
        gl.uniform2f(program.loc.u_res, w, h);
        gl.uniform1f(program.loc.u_time, frame.timeS);
        gl.uniform1f(program.loc.u_amount, pick.amount);
        gl.uniform4f(program.loc.u_audio, f.bass, f.mid, f.treble, f.onset);
        gl.uniform1f(program.loc.u_energy, f.energy);
        gl.uniform1f(program.loc.u_seed, frame.seed);
        for (let i = 0; i < 4; i++) {
          const c = frame.palette[i % Math.max(1, frame.palette.length)] ?? [0.5, 0.5, 0.5];
          gl.uniform3f(program.loc[`u_pal[${i}]`], c[0], c[1], c[2]);
        }
        draw(target);
        current = target;
        toggle ^= 1;
      }
      // Fertigen Frame in den Verlauf legen, dann auf den Bildschirm.
      copy(current, history[histIndex]!);
      histIndex = (histIndex + 1) % 3;
      copy(current, null);
    },
    resize(width2, height2) {
      const nw = Math.max(1, Math.round(width2));
      const nh = Math.max(1, Math.round(height2));
      if (nw === w && nh === h) return;
      release();
      w = nw;
      h = nh;
      allocate();
    },
    compiled() {
      return EFFECTS.filter((e) => programFor(e.id) !== null && effectById(e.id)).map((e) => e.id);
    },
    dispose() {
      try {
        release();
        if (glyphTex) gl.deleteTexture(glyphTex);
        for (const p of programs.values()) if (p) gl.deleteProgram(p.program);
        gl.deleteProgram(copyProgram.program);
        gl.deleteShader(vertex);
      } catch {
        /* Kontext kann bereits verloren sein */
      }
    },
  };
}
