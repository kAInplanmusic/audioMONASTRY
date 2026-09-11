/**
 * audioMONASTRY · VisualMONK – Canvas2D-Renderer der Liveshow
 * ==========================================================
 * Zeichnet die audio-reaktive Liveshow auf ein **main-thread**-Canvas, damit
 * `canvas.captureStream(fps)` einen echten MediaStream für Ghostuser 6 liefert
 * (ein OffscreenCanvas im Worker lässt sich nicht zuverlässig capturen).
 *
 * Der Renderer ist bewusst schlank und ohne WebGL-Abhängigkeit: die Presets
 * werden auf wenige, gut aussehende Zeichenmodi abgebildet. Pure Helfer
 * (`updateParticles`, `spawnParticle`, `rgba`) sind ohne Canvas testbar.
 */
import type { VisualParams, VisualPreset } from './types';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  ttl: number;
  size: number;
}

/** Deterministischer Pseudo-Zufall (mulberry32) – testbar. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Farbe aus einer 0..1-RGB-Palette als CSS-String. */
export function rgba(color: readonly [number, number, number], alpha = 1): string {
  const r = Math.round(Math.min(1, Math.max(0, color[0])) * 255);
  const g = Math.round(Math.min(1, Math.max(0, color[1])) * 255);
  const b = Math.round(Math.min(1, Math.max(0, color[2])) * 255);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

export function spawnParticle(rng: () => number, width: number, height: number): Particle {
  return {
    x: rng() * width,
    y: rng() * height,
    vx: (rng() - 0.5) * 2,
    vy: (rng() - 0.5) * 2,
    age: 0,
    ttl: 1.5 + rng() * 3,
    size: 0.6 + rng() * 2.2,
  };
}

/**
 * Bewegt Partikel und lässt gealterte neu entstehen. Reine Schleife über das
 * übergebene Array (keine Allokation) – damit deterministisch testbar.
 */
export function updateParticles(
  particles: Particle[],
  params: VisualParams,
  dtSeconds: number,
  width: number,
  height: number,
  rng: () => number,
): void {
  const dt = Math.min(0.1, Math.max(0, dtSeconds));
  const speed = 6 + params.flow * 90;
  const spread = 1 + params.displacement * 3;
  const cx = width / 2;
  const cy = height / 2;
  for (let i = 0; i < particles.length; i += 1) {
    const p = particles[i];
    // Radialer Drift (Displacement bläst nach außen) + Rotation.
    const dx = (p.x - cx) / Math.max(1, width);
    const dy = (p.y - cy) / Math.max(1, height);
    const rad = Math.hypot(dx, dy) || 1e-4;
    const rot = (params.rotation * Math.PI) / 180;
    p.vx += ((-dy / rad) * rot + (dx / rad) * spread * 0.6) * speed * dt;
    p.vy += ((dx / rad) * rot + (dy / rad) * spread * 0.6) * speed * dt;
    p.x += p.vx * speed * dt;
    p.y += p.vy * speed * dt;
    p.vx *= 0.985;
    p.vy *= 0.985;
    p.age += dt;
    if (p.age > p.ttl || p.x < -20 || p.x > width + 20 || p.y < -20 || p.y > height + 20) {
      particles[i] = spawnParticle(rng, width, height);
    }
  }
}

/** Zeichenmodus je Preset (bewusst wenige, wiederverwendete Modi). */
export type DrawMode = 'starfield' | 'particles' | 'grid' | 'aura' | 'gradient';

export function drawModeForPreset(preset: VisualPreset): DrawMode {
  switch (preset.id) {
    case 'starfield':
      return 'starfield';
    case 'particles':
      return 'particles';
    case 'geometry':
    case 'neongrid':
    case 'wireframe':
      return 'grid';
    case 'gradient':
    case 'noir':
      return 'gradient';
    default:
      // fractal/plasma/liquid/inferno/psy → symetrisches Aura-Feld
      return 'aura';
  }
}

export interface RendererState {
  particles: Particle[];
  rng: () => number;
  count: number;
}

export function createRendererState(count = 220, seed = 1337): RendererState {
  return { particles: [], rng: mulberry32(seed), count };
}

/** Ein Frame zeichnen. `ctx` ist ein 2D-Kontext. */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  preset: VisualPreset,
  params: VisualParams,
  state: RendererState,
  dtSeconds: number,
): void {
  const colors = preset.palette.colors;
  const bg = colors[0];
  const accent = colors[1] ?? colors[0];
  const hot = colors[2] ?? accent;
  const white = colors[colors.length - 1] ?? hot;

  // Hintergrund mit leichtem Trailing (Bewegungsschleier).
  ctx.fillStyle = rgba(bg, 0.28 + (1 - params.brightness) * 0.35);
  ctx.fillRect(0, 0, width, height);

  const mode = drawModeForPreset(preset);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  if (mode === 'particles') {
    if (state.particles.length === 0) {
      for (let i = 0; i < state.count; i += 1) state.particles.push(spawnParticle(state.rng, width, height));
    }
    updateParticles(state.particles, params, dtSeconds, width, height, state.rng);
    for (const p of state.particles) {
      const alpha = Math.max(0, 1 - p.age / p.ttl) * (0.25 + params.brightness * 0.75);
      ctx.fillStyle = rgba(p.age > p.ttl * 0.6 ? hot : accent, alpha);
      const s = p.size * (0.6 + params.zoom);
      ctx.fillRect(p.x, p.y, s, s);
    }
  } else if (mode === 'starfield') {
    const stars = Math.max(1, Math.round(160 * params.zoom));
    for (let i = 0; i < stars; i += 1) {
      const a = (i / stars) * Math.PI * 2 + (params.rotation * Math.PI) / 180;
      const r = ((i * 97) % 1000) / 1000;
      const dist = (r * 1.2 + 0.05) * Math.min(width, height) * 0.7;
      const x = width / 2 + Math.cos(a) * dist * (1 + params.warp);
      const y = height / 2 + Math.sin(a) * dist * (1 + params.warp) * 0.6;
      const size = 0.5 + ((i * 31) % 7) / 4 + params.glow * 2;
      ctx.fillStyle = rgba(i % 5 === 0 ? white : accent, 0.2 + params.brightness * 0.6);
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (mode === 'grid') {
    const lines = 14 + Math.round(params.displacement * 12);
    ctx.lineWidth = 1 + params.glow * 2;
    ctx.strokeStyle = rgba(accent, 0.25 + params.brightness * 0.5);
    const skew = Math.sin((params.rotation * Math.PI) / 180) * 60;
    for (let i = 0; i <= lines; i += 1) {
      const t = i / lines;
      ctx.beginPath();
      ctx.moveTo(t * width + skew, 0);
      ctx.lineTo(t * width - skew, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, t * height + skew * 0.4);
      ctx.lineTo(width, t * height - skew * 0.4);
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(hot, params.glow * 0.5);
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, Math.min(width, height) * (0.2 + params.zoom * 0.3), 0, Math.PI * 2);
    ctx.stroke();
  } else if (mode === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, width, height);
    const shift = (params.hue % 360) / 360;
    g.addColorStop(0, rgba(colors[0], 1));
    g.addColorStop(Math.min(0.95, 0.2 + shift * 0.5), rgba(accent, 0.8));
    g.addColorStop(1, rgba(hot, 0.85));
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.25 + params.brightness * 0.5;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;
  } else {
    // aura: symmetrische, gewarpete Ringe/Polygone
    const sym = Math.max(1, params.symmetry);
    const rings = 6 + Math.round(params.displacement * 10);
    const maxR = Math.min(width, height) * (0.28 + params.zoom * 0.35);
    for (let ring = rings; ring >= 1; ring -= 1) {
      const r = (ring / rings) * maxR * (1 + Math.sin(params.rotation * 0.3 + ring) * params.warp * 0.4);
      ctx.beginPath();
      const steps = 64;
      for (let s = 0; s <= steps; s += 1) {
        const a = (s / steps) * Math.PI * 2;
        const wobble = 1 + Math.sin(a * sym + params.flow * 2) * params.warp * 0.5;
        const x = width / 2 + Math.cos(a) * r * wobble;
        const y = height / 2 + Math.sin(a) * r * wobble;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const t = ring / rings;
      ctx.fillStyle = rgba(t > 0.6 ? baseMix(accent, white, t - 0.6) : accent, 0.05 + (1 - t) * 0.12 + params.glow * 0.06);
      ctx.fill();
      ctx.lineWidth = 1 + params.glow * 2;
      ctx.strokeStyle = rgba(hot, 0.12 + (1 - t) * 0.18);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/** Lineare Mischung zweier RGB-Farben (0..1). */
export function baseMix(a: readonly [number, number, number], b: readonly [number, number, number], t: number): [number, number, number] {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
