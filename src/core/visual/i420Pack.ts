/**
 * audioMONASTRY · VisualMONK: GPU-Packer fuer yuv420p (I420)
 * ==========================================================
 * Wandelt das fertig gerenderte Canvas-Bild auf der GPU in genau die Bytefolge, die `ffmpeg -f rawvideo -pix_fmt yuv420p`
 * erwartet (Y-Ebene, dann U, dann V; BT.601, limited range), und liest sie ueber Pixel-Puffer (PBO) asynchron aus.
 * Warum: Die JPEG-Kodierung im Browser kostet ~20-29 ms je 1080p-Frame auf einem CPU-Thread und ist der Engpass
 * (docs/VIS_GPU_MESSUNG.md); Rohbytes ueber CDP sind zu langsam, deshalb schickt podScene sie per fetch an einen
 * Loopback-Port des Renderers.
 *
 * Layout: Das Ziel ist eine RGBA8-Textur der Groesse (W/4) x (H*3/2); ein Texel haelt 4 aufeinanderfolgende Bytes.
 *   Zeilen 0..H-1      : Y-Ebene (Zeile r = Videozeile r, oben beginnend)
 *   Zeilen H..H+H/4-1  : U-Ebene, linear (W/2 x H/2 Bytes)
 *   Zeilen H+H/4..     : V-Ebene
 * Voraussetzung: W % 4 == 0 und H % 2 == 0 (1080p/1440p erfuellen das), WebGL2.
 *
 * Der Packer fasst nur eigenen Zustand an (eigenes Programm, VAO, Framebuffer, Textureinheit 7) und stellt die vom
 * Renderer benutzten Bindungen danach wieder her. Er laeuft im selben Task wie das Rendern, weil der Zeichenpuffer
 * danach nicht mehr lesbar ist.
 */

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_src;
uniform ivec2 u_size;
out vec4 o;
float lumaOf(vec3 c) { return (16.0 + 65.481 * c.r + 128.553 * c.g + 24.966 * c.b) / 255.0; }
float uOf(vec3 c) { return (128.0 - 37.797 * c.r - 74.203 * c.g + 112.0 * c.b) / 255.0; }
float vOf(vec3 c) { return (128.0 + 112.0 * c.r - 93.786 * c.g - 18.214 * c.b) / 255.0; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int W = u_size.x;
  int H = u_size.y;
  int wp = W / 4;
  vec4 v = vec4(0.0);
  if (p.y < H) {
    for (int k = 0; k < 4; k++) {
      vec3 c = texelFetch(u_src, ivec2(4 * p.x + k, H - 1 - p.y), 0).rgb;
      v[k] = lumaOf(c);
    }
  } else {
    int qsize = (W / 2) * (H / 2);
    for (int k = 0; k < 4; k++) {
      int base = ((p.y - H) * wp + p.x) * 4 + k;
      int plane = base / qsize;
      int idx = base - plane * qsize;
      int cy = idx / (W / 2);
      int cx = idx - cy * (W / 2);
      // Mitte des 2x2-Blocks: LINEAR-Filter mittelt die vier Luma-Pixel.
      vec2 uv = vec2(float(2 * cx) + 1.0, float(H - 2 * cy) - 1.0) / vec2(float(W), float(H));
      vec3 c = texture(u_src, uv).rgb;
      v[k] = plane == 0 ? uOf(c) : vOf(c);
    }
  }
  o = clamp(v, 0.0, 1.0);
}`;

export interface I420Packer {
  readonly bytes: number;
  /** Bild aus dem Zeichenpuffer packen und das Auslesen in Ring-Platz `slot` (0/1) anstossen. */
  issue(slot: number): void;
  /** Wartet (ohne zu blockieren) auf das Ende des Auslesens von `slot` und liefert die Bytes. Puffer wird pro Platz wiederverwendet. */
  fetch(slot: number): Promise<Uint8Array>;
  /** Selbsttest: gepacktes Bild synchron lesen (nur fuer Pruefungen, stoert den Ring nicht). */
  readSync(): Uint8Array;
  dispose(): void;
}

export function i420Supported(width: number, height: number): boolean {
  return width > 0 && height > 0 && width % 4 === 0 && height % 2 === 0;
}

export function createI420Packer(gl: WebGL2RenderingContext, width: number, height: number): I420Packer | null {
  if (!i420Supported(width, height) || typeof gl.fenceSync !== 'function') return null;
  const packW = width / 4;
  const packH = (height * 3) / 2;
  const bytes = packW * packH * 4;

  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('[visual:i420] Shader:', String(gl.getShaderInfoLog(shader)).slice(0, 200));
      return null;
    }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const uSrc = gl.getUniformLocation(program, 'u_src');
  const uSize = gl.getUniformLocation(program, 'u_size');

  const vao = gl.createVertexArray();
  const source = gl.createTexture();
  const target = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!vao || !source || !target || !fbo) return null;

  const savedTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.bindTexture(gl.TEXTURE_2D, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, width, height, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, packW, packH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, savedTex);
  const savedFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, savedFbo);
  if (!complete) return null;

  const pbos = [gl.createBuffer(), gl.createBuffer()];
  for (const pbo of pbos) {
    if (!pbo) return null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
  }
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  const fences: Array<WebGLSync | null> = [null, null];
  const views = [new Uint8Array(bytes), new Uint8Array(bytes)];

  /** Zeichenpuffer -> Textur -> gepackte Textur; Zustand des Renderers bleibt unveraendert. */
  const pass = (): void => {
    const prog = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const prevUnit = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const blend = gl.isEnabled(gl.BLEND);
    const depth = gl.isEnabled(gl.DEPTH_TEST);
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    if (blend) gl.disable(gl.BLEND);
    if (depth) gl.disable(gl.DEPTH_TEST);
    if (scissor) gl.disable(gl.SCISSOR_TEST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, packW, packH);
    gl.useProgram(program);
    gl.uniform1i(uSrc, 7);
    gl.uniform2i(uSize, width, height);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(prevVao);
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    gl.activeTexture(prevUnit);
    if (blend) gl.enable(gl.BLEND);
    if (depth) gl.enable(gl.DEPTH_TEST);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
  };

  const issue = (slot: number): void => {
    pass();
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbos[slot]);
    gl.readPixels(0, 0, packW, packH, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    const old = fences[slot];
    if (old) gl.deleteSync(old);
    fences[slot] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  };

  const fetch = async (slot: number): Promise<Uint8Array> => {
    const fence = fences[slot];
    if (!fence) throw new Error('i420: nothing issued');
    for (;;) {
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) break;
      if (status === gl.WAIT_FAILED) throw new Error('i420: fence wait failed');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    gl.deleteSync(fence);
    fences[slot] = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbos[slot]);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, views[slot]);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return views[slot];
  };

  const readSync = (): Uint8Array => {
    pass();
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const out = new Uint8Array(bytes);
    gl.readPixels(0, 0, packW, packH, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    return out;
  };

  const dispose = (): void => {
    for (const f of fences) if (f) gl.deleteSync(f);
    for (const pbo of pbos) if (pbo) gl.deleteBuffer(pbo);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(source);
    gl.deleteTexture(target);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
  };

  return { bytes, issue, fetch, readSync, dispose };
}
