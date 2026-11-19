/**
 * audioMONASTRY · VisualMONK – GLSL der 25 Medien-Effekte (WebGL1/GLSL ES 1.00)
 * =============================================================================
 * Jeder Effekt ist ein Block `vec3 effect(vec2 uv, vec3 src)`. Der gemeinsame
 * Rahmen liefert Hilfsfunktionen und Uniforms und mischt das Ergebnis mit der
 * Stärke `u_amount` über das Eingangsbild: Stärke 0 = Bild unverändert.
 *
 * Uniforms: u_src (Ergebnis der Vorstufe), u_h1/u_h2 (letzte zwei fertige Frames),
 * u_glyph (Zeichenatlas), u_res, u_time, u_amount, u_audio = (Bass, Mitten, Höhen,
 * Onset), u_energy, u_seed, u_pal[0..3] (Preset-Farben).
 *
 * Randbedingungen ES 1.00: nur konstante Schleifengrenzen, Felder nur mit
 * Schleifen-/Konstantenindex, keine Bit-Operationen.
 */

export const VERTEX = `attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const COPY_FRAGMENT = `precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_src;
void main() { gl_FragColor = vec4(texture2D(u_src, v_uv).rgb, 1.0); }`;

const HEADER = `precision highp float;
varying vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_h1;
uniform sampler2D u_h2;
uniform sampler2D u_glyph;
uniform vec2 u_res;
uniform float u_time;
uniform float u_amount;
uniform vec4 u_audio;
uniform float u_energy;
uniform float u_seed;
uniform vec3 u_pal[4];

float hash11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + 17.0;
    a *= 0.5;
  }
  return s;
}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 S(vec2 uv) { return texture2D(u_src, clamp(uv, 0.0, 1.0)).rgb; }
vec3 hueRot(vec3 color, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  mat3 m = mat3(
    0.299 + 0.701 * c + 0.168 * s, 0.587 - 0.587 * c + 0.330 * s, 0.114 - 0.114 * c - 0.497 * s,
    0.299 - 0.299 * c - 0.328 * s, 0.587 + 0.413 * c + 0.035 * s, 0.114 - 0.114 * c + 0.292 * s,
    0.299 - 0.300 * c + 1.250 * s, 0.587 - 0.588 * c - 1.050 * s, 0.114 + 0.886 * c - 0.203 * s
  );
  return clamp(color * m, 0.0, 1.0);
}
`;

const FOOTER = `
void main() {
  vec3 src = S(v_uv);
  vec3 fx = effect(v_uv, src);
  gl_FragColor = vec4(mix(src, clamp(fx, 0.0, 1.0), clamp(u_amount * 1.25, 0.0, 1.0)), 1.0);
}`;

export function fragmentFor(id: string): string {
  const body = EFFECT_SOURCES[id];
  if (!body) throw new Error('unknown effect: ' + id);
  return HEADER + body + FOOTER;
}

export const EFFECT_SOURCES: Record<string, string> = {
  // 1 Edge Detection – Sobel auf der Helligkeit, Kanten im Preset-Neon
  edge: `
vec3 effect(vec2 uv, vec3 src) {
  vec2 px = (1.2 + 2.0 * u_audio.z) / u_res;
  float tl = lum(S(uv + vec2(-px.x, px.y)));
  float t = lum(S(uv + vec2(0.0, px.y)));
  float tr = lum(S(uv + px));
  float l = lum(S(uv + vec2(-px.x, 0.0)));
  float r = lum(S(uv + vec2(px.x, 0.0)));
  float bl = lum(S(uv - px));
  float b = lum(S(uv + vec2(0.0, -px.y)));
  float br = lum(S(uv + vec2(px.x, -px.y)));
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
  float e = clamp(length(vec2(gx, gy)) * 1.6, 0.0, 1.0);
  vec3 neon = mix(u_pal[1], u_pal[2], 0.5 + 0.5 * sin(u_time * 0.8 + uv.x * 3.0));
  return vec3(0.02, 0.02, 0.04) + src * 0.12 + e * (neon * 1.4 + 0.2);
}`,

  // 2 Hexagon Pixelation
  hexpixel: `
vec3 effect(vec2 uv, vec3 src) {
  float a = u_res.x / u_res.y;
  float n = mix(90.0, 22.0, u_amount) * (1.0 - 0.15 * u_audio.x);
  vec2 p = vec2(uv.x * a, uv.y) * n;
  vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 A = mod(p, r) - h;
  vec2 B = mod(p - h, r) - h;
  vec2 gv = dot(A, A) < dot(B, B) ? A : B;
  vec2 c = (p - gv) / n;
  c.x /= a;
  float edge = smoothstep(0.55, 0.38, length(gv));
  return S(c) * mix(0.6, 1.05, edge);
}`,

  // 3 Voronoi Glitch – Zellen verschieben sich gegeneinander
  voronoi: `
vec3 effect(vec2 uv, vec3 src) {
  float a = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * a, uv.y) * (6.0 + 6.0 * u_audio.x);
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  vec2 cid = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash22(ip + g);
      o = 0.5 + 0.5 * sin(u_time * 0.7 + 6.2831853 * o);
      vec2 d = g + o - fp;
      float dd = dot(d, d);
      if (dd < d1) { d2 = d1; d1 = dd; cid = ip + g; }
      else if (dd < d2) { d2 = dd; }
    }
  }
  vec2 sh = (hash22(cid) - 0.5) * 0.14 * (0.3 + u_audio.w + 0.5 * u_audio.x) * u_amount;
  float edge = smoothstep(0.0, 0.07, sqrt(d2) - sqrt(d1));
  return S(uv + sh) * mix(0.35, 1.0, edge);
}`,

  // 4 ASCII (geometrisch) – Punkt, Plus, Rahmen, Block nach Helligkeit
  ascii: `
vec3 effect(vec2 uv, vec3 src) {
  float a = u_res.x / u_res.y;
  float cell = mix(70.0, 36.0, u_amount);
  vec2 p = vec2(uv.x * a, uv.y) * cell;
  vec2 ip = floor(p);
  vec2 f = fract(p) - 0.5;
  vec2 cuv = (ip + 0.5) / cell;
  cuv.x /= a;
  vec3 col = S(cuv);
  float l = lum(col);
  float shape = 0.0;
  float d = max(abs(f.x), abs(f.y));
  if (l >= 0.2 && l < 0.4) {
    shape = smoothstep(0.10, 0.06, length(f));
  } else if (l >= 0.4 && l < 0.6) {
    shape = max(smoothstep(0.08, 0.04, abs(f.x)) * step(abs(f.y), 0.3),
                smoothstep(0.08, 0.04, abs(f.y)) * step(abs(f.x), 0.3));
  } else if (l >= 0.6 && l < 0.8) {
    shape = smoothstep(0.38, 0.34, d) * smoothstep(0.16, 0.20, d);
  } else if (l >= 0.8) {
    shape = step(d, 0.4);
  }
  return col * shape * 1.15;
}`,

  // 5 Triangulate – Low-Poly-Dreiecksraster, Ecken zucken mit dem Bass
  triangulate: `
vec3 effect(vec2 uv, vec3 src) {
  float a = u_res.x / u_res.y;
  float n = mix(60.0, 14.0, u_amount);
  vec2 p = vec2(uv.x * a, uv.y) * n;
  vec2 g = vec2(p.x - p.y * 0.57735027, p.y * 1.15470054);
  vec2 i = floor(g);
  vec2 f = fract(g);
  float up = step(1.0, f.x + f.y);
  vec2 c = i + mix(vec2(1.0 / 3.0), vec2(2.0 / 3.0), up);
  vec2 pc = vec2(c.x + c.y * 0.5, c.y * 0.8660254);
  pc += (hash22(i + up * 17.0) - 0.5) * u_audio.x * 0.5;
  vec2 q = pc / n;
  q.x /= a;
  return S(q) * (0.85 + 0.3 * hash21(i + up * 3.1));
}`,

  // 6 Feedback-Schleife – Tunnel durch Rückkopplung mit Zoom und Drehung
  feedback: `
vec3 effect(vec2 uv, vec3 src) {
  float z = 0.975 - 0.03 * u_audio.x * u_amount;
  float dir = mod(floor(u_time * 0.5), 2.0) * 2.0 - 1.0;
  float ang = 0.015 * (1.0 + u_audio.z * 2.0) * dir * u_amount;
  vec2 p = uv - 0.5;
  float c = cos(ang);
  float s = sin(ang);
  p = mat2(c, -s, s, c) * p;
  p = p * z + 0.5;
  vec3 prev = hueRot(texture2D(u_h1, clamp(p, 0.0, 1.0)).rgb, 0.04 * u_amount);
  return max(src, prev * (0.88 + 0.08 * u_amount));
}`,

  // 7 Echo Trace / Trails – Geisterbilder aus den letzten Frames
  echo: `
vec3 effect(vec2 uv, vec3 src) {
  vec3 p1 = texture2D(u_h1, uv).rgb;
  vec3 p2 = texture2D(u_h2, uv).rgb;
  vec3 trail = max(p1 * (0.78 + 0.14 * u_amount), p2 * (0.6 + 0.2 * u_amount));
  return max(src, trail);
}`,

  // 8 Pixel Sorting – Fenster von 12 Pixeln nach Helligkeit sortiert
  pixelsort: `
vec3 effect(vec2 uv, vec3 src) {
  float stp = max(1.0, u_res.x / 640.0);
  float px = uv.x * u_res.x;
  float wstart = floor(px / (12.0 * stp)) * 12.0 * stp;
  float t = floor((px - wstart) / stp);
  vec3 cols[12];
  float l[12];
  float mean = 0.0;
  for (int i = 0; i < 12; i++) {
    vec2 q = vec2((wstart + (float(i) + 0.5) * stp) / u_res.x, uv.y);
    cols[i] = S(q);
    l[i] = lum(cols[i]);
    mean += l[i] / 12.0;
  }
  vec3 outc = src;
  for (int i = 0; i < 12; i++) {
    float rank = 0.0;
    for (int j = 0; j < 12; j++) {
      if (l[j] < l[i] || (l[j] == l[i] && j < i)) { rank += 1.0; }
    }
    if (abs(rank - t) < 0.5) { outc = cols[i]; }
  }
  float gate = smoothstep(0.12, 0.3, mean + 0.25 * u_audio.y);
  return mix(src, outc, gate);
}`,

  // 9 Linear Cloner – Wiederholungen mit Spiegelung und Farbversatz
  cloner: `
vec3 effect(vec2 uv, vec3 src) {
  float n = 1.0 + floor(u_amount * 4.0 + u_audio.x * 2.0);
  float idx = floor(uv.x * n);
  vec2 p = vec2(fract(uv.x * n), uv.y);
  p.x = mix(p.x, 1.0 - p.x, mod(idx, 2.0));
  p.y += (hash11(idx) - 0.5) * 0.05 * u_amount * sin(u_time + idx);
  return hueRot(S(p), idx * 0.35 * u_amount);
}`,

  // 10 Corner Color Tint – Ecken in den Preset-Farben
  cornertint: `
vec3 effect(vec2 uv, vec3 src) {
  vec3 bottom = mix(u_pal[0], u_pal[1], uv.x);
  vec3 top = mix(u_pal[2], u_pal[3], uv.x);
  vec3 tint = mix(bottom, top, uv.y);
  float w = smoothstep(0.15, 0.95, length(uv - 0.5) * 1.4);
  return mix(src, src * tint * 1.6 + tint * 0.08, w);
}`,

  // 11 Bright/Contrast als Effekt – hartes Schwarz/Weiß
  contrast: `
vec3 effect(vec2 uv, vec3 src) {
  float k = 1.0 + 9.0 * u_amount * (0.6 + 0.4 * u_energy);
  vec3 c = (src - 0.5) * k + 0.5;
  vec3 bw = vec3(smoothstep(0.42 - 0.1 * u_audio.x, 0.58, lum(src)));
  return mix(c, bw, 0.5 * u_amount);
}`,

  // 12 Dithering – Bayer 8x8, wenige Farbstufen
  dither: `
float b2(vec2 p) { vec2 q = mod(floor(p), 2.0); return 2.0 * abs(q.x - q.y) + q.y; }
float b8(vec2 p) {
  vec2 f = floor(p);
  return (16.0 * b2(mod(f, 2.0)) + 4.0 * b2(mod(floor(f / 2.0), 2.0)) + b2(mod(floor(f / 4.0), 2.0))) / 64.0;
}
vec3 effect(vec2 uv, vec3 src) {
  float px = max(1.0, floor(u_res.x / 480.0));
  vec2 p = floor(uv * u_res / px);
  vec3 s = S((p + 0.5) * px / u_res);
  float lv = mix(8.0, 2.0, u_amount) - 1.0;
  return floor(s * lv + 0.5 + (b8(p) - 0.5)) / lv;
}`,

  // 13 Geometric ASCII – gedrehte Balken, Rauten bei Helligkeit
  geoascii: `
vec3 effect(vec2 uv, vec3 src) {
  float a = u_res.x / u_res.y;
  float cell = mix(60.0, 30.0, u_amount);
  vec2 p = vec2(uv.x * a, uv.y) * cell;
  vec2 ip = floor(p);
  vec2 f = fract(p) - 0.5;
  vec2 cuv = (ip + 0.5) / cell;
  cuv.x /= a;
  vec3 col = S(cuv);
  float l = lum(col);
  float ang = l * 3.14159 + u_time * 0.2;
  vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * f;
  float bar = smoothstep(0.16 * (0.3 + l), 0.05, abs(q.y)) * step(abs(q.x), 0.42);
  float diamond = step(abs(f.x) + abs(f.y), 0.45);
  float shape = l > 0.75 ? diamond : bar;
  return col * shape * 1.2 * step(0.08, l);
}`,

  // 14 Text-ASCII – Zeichenatlas " .:-=+*#%@"
  glyph: `
vec3 effect(vec2 uv, vec3 src) {
  float cw = mix(18.0, 10.0, u_amount);
  vec2 grid = vec2(u_res.x / cw, u_res.y / (cw * 2.0));
  vec2 p = uv * grid;
  vec2 ip = floor(p);
  vec2 f = fract(p);
  vec3 col = S((ip + 0.5) / grid);
  float l = clamp(lum(col) * (1.0 + 0.3 * u_audio.y), 0.0, 0.999);
  float idx = floor(l * 10.0);
  float g = texture2D(u_glyph, vec2((idx + f.x) / 10.0, f.y)).r;
  return col * g * 1.6 + src * 0.05;
}`,

  // 15 Glitch – Blockverschiebung, Kanalversatz, Zeilenraster
  glitch: `
vec3 effect(vec2 uv, vec3 src) {
  float t = floor(u_time * 14.0);
  float band = floor(uv.y * mix(10.0, 40.0, hash11(t)));
  float on = step(1.0 - (0.15 + 0.5 * u_audio.w + 0.2 * u_energy), hash21(vec2(band, t)));
  float shift = (hash21(vec2(band + 7.0, t)) - 0.5) * 0.25 * on;
  vec2 q = vec2(uv.x + shift, uv.y);
  float sp = 0.01 * on * (1.0 + u_audio.w * 2.0);
  vec3 c = vec3(S(q + vec2(sp, 0.0)).r, S(q).g, S(q - vec2(sp, 0.0)).b);
  float burst = step(0.92, hash11(t + 3.0)) * u_audio.w;
  c = mix(c, c.bgr, burst);
  c *= 1.0 - 0.06 * step(0.5, fract(uv.y * u_res.y * 0.5)) * on;
  return c;
}`,

  // 16 Bloom – heller Überstrahl aus 24 Spiralproben
  bloom: `
vec3 effect(vec2 uv, vec3 src) {
  float a = u_res.x / u_res.y;
  vec3 acc = vec3(0.0);
  float r = (0.006 + 0.02 * u_amount + 0.01 * u_audio.x) * 3.0;
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    float ang = fi * 2.3999632;
    float rad = sqrt((fi + 0.5) / 24.0);
    vec2 o = vec2(cos(ang) / a, sin(ang)) * rad * r;
    acc += max(S(uv + o) - 0.5, 0.0) * (1.0 - 0.5 * rad);
  }
  return src + acc / 24.0 * 7.0 * (0.8 + u_audio.x);
}`,

  // 17 Procedural Noise – Körnung und organische Helligkeitswolken
  noise: `
vec3 effect(vec2 uv, vec3 src) {
  float a = u_res.x / u_res.y;
  float g = hash21(floor(uv * u_res) + floor(u_time * 24.0)) - 0.5;
  float f = fbm(vec2(uv.x * a, uv.y) * 4.0 + u_time * 0.15) - 0.5;
  vec3 tint = mix(u_pal[0], u_pal[2], f + 0.5);
  return src * (1.0 + f * 0.6) + g * 0.45 + tint * f * 0.25;
}`,

  // 18 Kaleidoscope – 3 bis 8 Segmente
  kaleido: `
vec3 effect(vec2 uv, vec3 src) {
  float a = u_res.x / u_res.y;
  vec2 p = vec2((uv.x - 0.5) * a, uv.y - 0.5);
  p += 0.06 * vec2(sin(u_time * 0.3), cos(u_time * 0.23));
  float n = 3.0 + floor(u_amount * 5.0 + 0.5);
  float sec = 6.2831853 / n;
  float ang = atan(p.y, p.x) + u_time * 0.1 + u_audio.z * 0.5;
  float rad = length(p) * (0.8 + 0.5 * u_audio.x);
  ang = abs(mod(ang + sec * 0.5, sec) - sec * 0.5);
  vec2 q = vec2(cos(ang), sin(ang)) * rad;
  return S(vec2(q.x / a + 0.5, q.y + 0.5));
}`,

  // 19 Mirror Quad – Spiegelung an beiden Achsen
  mirrorquad: `
vec3 effect(vec2 uv, vec3 src) {
  vec2 p = uv + 0.03 * vec2(sin(u_time * 0.4), cos(u_time * 0.3)) * u_amount;
  p = 0.5 - abs(p - 0.5);
  float k = mix(1.0, 2.0, 0.5 + 0.5 * sin(u_time * 0.2));
  return S(p * k);
}`,

  // 20 Dot Screen / Halftone – gedrehtes Punktraster
  halftone: `
vec3 effect(vec2 uv, vec3 src) {
  float a = u_res.x / u_res.y;
  float cells = mix(110.0, 45.0, u_amount);
  float ang = 0.261799 + u_time * 0.02;
  float c = cos(ang);
  float s = sin(ang);
  vec2 p = mat2(c, -s, s, c) * (vec2(uv.x * a, uv.y) * cells);
  vec2 ip = floor(p);
  vec2 f = fract(p) - 0.5;
  vec2 back = (mat2(c, s, -s, c) * (ip + 0.5)) / cells;
  vec3 col = S(vec2(back.x / a, back.y));
  float rad = 0.5 * sqrt(lum(col)) * (0.7 + 0.5 * u_audio.x);
  return col * smoothstep(rad, rad - 0.12, length(f)) * 1.1;
}`,

  // 21 Hue Rotate – Farbton dreht kontinuierlich im Takt
  huerotate: `
vec3 effect(vec2 uv, vec3 src) {
  return hueRot(src, u_time * 0.8 + u_audio.y * 3.0);
}`,

  // 22 Delay RGB – Kanäle aus früheren Frames plus Versatz
  delayrgb: `
vec3 effect(vec2 uv, vec3 src) {
  vec2 o = vec2(0.006, 0.0) * (1.0 + 3.0 * u_audio.x) * u_amount;
  float r = S(uv - o).r;
  float g = texture2D(u_h1, clamp(uv, 0.0, 1.0)).g;
  float b = texture2D(u_h2, clamp(uv + o, 0.0, 1.0)).b;
  return vec3(r, mix(src.g, g, 0.8), mix(src.b, b, 0.8));
}`,

  // 23 Twitch – kurzes, zufälliges Verreißen
  twitch: `
vec3 effect(vec2 uv, vec3 src) {
  float rate = 8.0 + 10.0 * u_audio.w;
  float slot = floor(u_time * rate);
  float h = hash11(slot + u_seed * 13.0);
  float on = step(1.0 - (0.12 + 0.35 * u_audio.w + 0.1 * u_energy), h);
  vec2 d = (hash22(vec2(slot, 7.0)) - 0.5) * 0.22 * on;
  vec2 p = (uv - 0.5) * (1.0 + 0.18 * on * hash11(slot + 1.0)) + 0.5 + d;
  return S(p);
}`,

  // 24 Distortion – Rausch-Verzerrung (fließend)
  distort: `
vec3 effect(vec2 uv, vec3 src) {
  float a = u_res.x / u_res.y;
  vec2 q = vec2(uv.x * a, uv.y) * 3.0 + u_time * 0.2;
  vec2 n = vec2(fbm(q), fbm(q + 5.2)) - 0.5;
  return S(uv + n * 0.1 * u_amount * (1.0 + u_audio.x + u_audio.y));
}`,

  // 25 RGB Split – Kanäle gegeneinander verschoben
  rgbsplit: `
vec3 effect(vec2 uv, vec3 src) {
  vec2 dir = mix(vec2(1.0, 0.0), normalize(uv - 0.5 + 1e-4), 0.5 + 0.5 * sin(u_time * 0.3));
  float k = (0.004 + 0.018 * u_audio.w + 0.01 * u_audio.x) * u_amount;
  return vec3(S(uv + dir * k).r, S(uv).g, S(uv - dir * k).b);
}`,
};
