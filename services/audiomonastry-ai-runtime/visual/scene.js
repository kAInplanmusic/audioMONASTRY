// GENERIERT von scripts/build-vis-scene.mjs aus src/core/visual/podScene.ts - nicht von Hand aendern.
(() => {
  // src/core/visual/audioReactive.ts
  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return value < min ? min : value > max ? max : value;
  }
  function clamp01(value) {
    return clamp(value, 0, 1);
  }
  function wrap360(deg) {
    if (!Number.isFinite(deg)) return 0;
    const wrapped = deg % 360;
    return wrapped < 0 ? wrapped + 360 : wrapped;
  }
  function normalizeFeatures(raw) {
    return {
      bass: clamp01(raw.bass ?? 0),
      mid: clamp01(raw.mid ?? 0),
      treble: clamp01(raw.treble ?? 0),
      rms: clamp01(raw.rms ?? 0),
      onset: clamp01(raw.onset ?? 0),
      energy: clamp01(raw.energy ?? 0),
      bpm: Math.max(0, Number.isFinite(raw.bpm) ? raw.bpm : 0)
    };
  }
  function deriveEnergy(features) {
    if (features.energy > 0) return features.energy;
    const mean = (features.bass + features.mid + features.treble) / 3;
    return clamp01(Math.max(mean, features.rms * 0.9));
  }
  function mapAudioToParams(features, preset, timeSeconds) {
    const f = normalizeFeatures(features);
    const energy = deriveEnergy(f);
    const m = preset.motion;
    const t = Number.isFinite(timeSeconds) ? timeSeconds : 0;
    const rotation = wrap360(m.baseSpin * t + f.treble * m.trebleSpin * t + f.onset * 8);
    const zoom = clamp(preset.base.zoom * (1 + f.bass * 0.6 + f.onset * 0.2), 0.05, 8);
    const warp = clamp01(f.mid * m.warp + f.bass * 0.3);
    const hue = wrap360(preset.palette.hueBase + energy * m.hueSpeed * t + f.mid * 30);
    const flow = clamp(m.flow * (0.2 + energy * 2.2), 0, 8);
    const brightness = clamp01(0.15 + f.rms * 0.9 + f.onset * 0.25);
    const contrast = clamp01(0.55 + f.treble * 0.6);
    const displacement = clamp01(f.bass * 0.85 + f.onset * 0.5);
    const glow = clamp01(preset.base.glow + f.rms * 0.5 + f.onset * 0.4);
    const symmetry = Math.max(1, Math.round(preset.base.symmetry));
    return { zoom, rotation, warp, hue, flow, brightness, contrast, displacement, glow, symmetry };
  }
  function blendParams(a, b, t) {
    const k = clamp01(t);
    if (k <= 0) return { ...a };
    if (k >= 1) return { ...b };
    const lerp = (x, y) => x + (y - x) * k;
    return {
      zoom: lerp(a.zoom, b.zoom),
      rotation: lerp(a.rotation, b.rotation),
      warp: lerp(a.warp, b.warp),
      hue: lerp(a.hue, b.hue),
      flow: lerp(a.flow, b.flow),
      brightness: lerp(a.brightness, b.brightness),
      contrast: lerp(a.contrast, b.contrast),
      displacement: lerp(a.displacement, b.displacement),
      glow: lerp(a.glow, b.glow),
      symmetry: k < 0.5 ? a.symmetry : b.symmetry
    };
  }

  // src/core/visual/visualPresets.ts
  var VISUAL_PRESETS = [
    {
      id: "fractal",
      label: "Fractal Dive",
      description: "Unendlicher Zoom durch ein selbst\xE4hnliches Feld, Bass \xF6ffnet die Tiefe.",
      palette: { colors: [[0.02, 0.02, 0.08], [0.1, 0.35, 0.9], [0.9, 0.3, 0.7], [1, 0.95, 0.7]], hueBase: 220 },
      motion: { baseSpin: 2, trebleSpin: 14, warp: 0.35, hueSpeed: 26, flow: 0.5 },
      base: { zoom: 0.6, glow: 0.5, saturation: 0.9, symmetry: 1 }
    },
    {
      id: "plasma",
      label: "Plasma Fields",
      description: "Flie\xDFende Farbfelder, die mit den Mitten atmen.",
      palette: { colors: [[0.05, 0, 0.15], [0.9, 0.15, 0.5], [0.2, 0.8, 0.9], [0.95, 0.9, 0.3]], hueBase: 300 },
      motion: { baseSpin: 6, trebleSpin: 8, warp: 0.6, hueSpeed: 40, flow: 0.7 },
      base: { zoom: 0.5, glow: 0.6, saturation: 1, symmetry: 1 }
    },
    {
      id: "starfield",
      label: "Galaxies & Planets",
      description: "Sternenfeld mit Nebeln und Planetenbahnen; Onsets lassen Sterne aufblitzen.",
      palette: { colors: [[0, 0, 0.03], [0.15, 0.2, 0.6], [0.7, 0.5, 0.9], [1, 1, 1]], hueBase: 240 },
      motion: { baseSpin: 0.6, trebleSpin: 3, warp: 0.15, hueSpeed: 12, flow: 0.9 },
      base: { zoom: 0.8, glow: 0.7, saturation: 0.8, symmetry: 1 }
    },
    {
      id: "particles",
      label: "Particle Storm",
      description: "Partikelsturm, Geschwindigkeit und Streuung folgen der Energie.",
      palette: { colors: [[0.02, 0.02, 0.05], [0.2, 0.9, 0.6], [0.9, 0.7, 0.2], [1, 1, 1]], hueBase: 160 },
      motion: { baseSpin: 4, trebleSpin: 22, warp: 0.25, hueSpeed: 20, flow: 1.6 },
      base: { zoom: 0.4, glow: 0.55, saturation: 0.95, symmetry: 1 }
    },
    {
      id: "geometry",
      label: "Impossible Geometry",
      description: "Rotierende Gitter und unm\xF6gliche K\xF6rper; Mitten verzerren die Kanten.",
      palette: { colors: [[0.03, 0.03, 0.05], [0.85, 0.85, 0.9], [0.2, 0.6, 0.8], [0.9, 0.4, 0.2]], hueBase: 200 },
      motion: { baseSpin: 9, trebleSpin: 10, warp: 0.5, hueSpeed: 8, flow: 0.4 },
      base: { zoom: 0.7, glow: 0.35, saturation: 0.6, symmetry: 4 }
    },
    {
      id: "liquid",
      label: "Water & Ice",
      description: "Wasseroberfl\xE4che/Reflexe; Bass macht Wellen, H\xF6hen funkeln.",
      palette: { colors: [[0, 0.05, 0.12], [0.1, 0.5, 0.8], [0.6, 0.95, 1], [1, 1, 1]], hueBase: 190 },
      motion: { baseSpin: 1, trebleSpin: 6, warp: 0.7, hueSpeed: 10, flow: 0.6 },
      base: { zoom: 0.55, glow: 0.5, saturation: 0.85, symmetry: 1 }
    },
    {
      id: "inferno",
      label: "Fire & Lightning",
      description: "Feuer- und Blitzfeld; Onsets z\xFCnden Entladungen.",
      palette: { colors: [[0.05, 0, 0], [0.9, 0.2, 0], [1, 0.7, 0.1], [1, 1, 0.85]], hueBase: 20 },
      motion: { baseSpin: 3, trebleSpin: 18, warp: 0.8, hueSpeed: 14, flow: 1.2 },
      base: { zoom: 0.5, glow: 0.75, saturation: 1, symmetry: 1 }
    },
    {
      id: "gradient",
      label: "Color Gradients",
      description: "Ruhige, weiche Farbverl\xE4ufe \u2013 ideal f\xFCr Ambient/Intro.",
      palette: { colors: [[0.05, 0.02, 0.1], [0.3, 0.4, 0.9], [0.9, 0.5, 0.6], [1, 0.95, 0.8]], hueBase: 330 },
      motion: { baseSpin: 1.5, trebleSpin: 3, warp: 0.3, hueSpeed: 18, flow: 0.3 },
      base: { zoom: 0.6, glow: 0.4, saturation: 0.9, symmetry: 1 }
    },
    {
      id: "neongrid",
      label: "Industrial Grid",
      description: "Neon-Gitter, d\xFCster/industriell; Bass pumpt das Raster.",
      palette: { colors: [[0.02, 0, 0.03], [0.1, 0.9, 0.95], [0.95, 0.1, 0.6], [1, 1, 1]], hueBase: 285 },
      motion: { baseSpin: 5, trebleSpin: 12, warp: 0.2, hueSpeed: 24, flow: 1.1 },
      base: { zoom: 0.65, glow: 0.6, saturation: 1, symmetry: 2 }
    },
    {
      id: "psy",
      label: "Psychedelic",
      description: "Hypnotische Fraktal-/Kaleidoskop-Muster, stark farbverschiebend.",
      palette: { colors: [[0.08, 0, 0.12], [0.95, 0.2, 0.8], [0.2, 0.95, 0.6], [1, 0.9, 0.2]], hueBase: 60 },
      motion: { baseSpin: 12, trebleSpin: 30, warp: 0.9, hueSpeed: 70, flow: 0.8 },
      base: { zoom: 0.45, glow: 0.7, saturation: 1, symmetry: 6 }
    },
    {
      id: "noir",
      label: "Film Noir",
      description: "Strenges Schwarz-Wei\xDF mit Regen/Schatten \u2013 nur wenige Akzentfarben.",
      palette: { colors: [[0, 0, 0], [0.25, 0.25, 0.28], [0.75, 0.75, 0.78], [1, 1, 1]], hueBase: 210 },
      motion: { baseSpin: 0.8, trebleSpin: 4, warp: 0.18, hueSpeed: 4, flow: 0.5 },
      base: { zoom: 0.7, glow: 0.25, saturation: 0.1, symmetry: 1 }
    },
    {
      id: "wireframe",
      label: "Wireframe",
      description: "Reine Linien/Kanten (Strichm\xE4nnchen-Look) auf dunklem Grund.",
      palette: { colors: [[0.02, 0.02, 0.04], [0.4, 0.9, 1], [0.9, 0.9, 0.9], [1, 0.6, 0.2]], hueBase: 180 },
      motion: { baseSpin: 7, trebleSpin: 14, warp: 0.4, hueSpeed: 10, flow: 0.6 },
      base: { zoom: 0.6, glow: 0.3, saturation: 0.4, symmetry: 3 }
    }
  ];
  function presetById(id) {
    return VISUAL_PRESETS.find((p) => p.id === id) ?? VISUAL_PRESETS[0];
  }
  var VISUAL_PRESET_IDS = VISUAL_PRESETS.map((p) => p.id);

  // src/core/visual/canvasRenderer.ts
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // src/visuals/visualDirector.ts
  var DIRECTOR_DEFAULTS = {
    minDwellS: 3,
    onsetThreshold: 0.6,
    energyJump: 0.3,
    maxSceneS: 24,
    repeatWindow: 3
  };
  function energyFitWeight(entryEnergy, energy) {
    switch (entryEnergy) {
      case "ruhig":
        return 1.6 - energy * 0.8;
      // 1.6 (ruhig) → 0.8 (hart)
      case "hart":
        return 0.7 + energy * 0.9;
      // 0.7 (ruhig) → 1.6 (hart)
      // 'mittel' und unbekannt (eigene Bilder/Clips ohne Pool-Metadaten): neutral.
      default:
        return 1;
    }
  }
  function moodFitWeight(mood, lastMood) {
    if (mood == null || lastMood === null) return 1;
    return mood === lastMood ? 0.35 : 1;
  }
  function pickNextScene(pool, state2, features, opts) {
    if (pool.length === 0) return -1;
    if (pool.length === 1) return 0;
    const rng = mulberry32(state2.seed + state2.transitions * 7919);
    const energy = Number.isFinite(features.energy) ? Math.max(0, Math.min(1, features.energy)) : 0;
    const window2 = Math.max(1, Math.floor(opts.repeatWindow));
    const recent = (state2.recent && state2.recent.length > 0 ? state2.recent : [state2.index]).slice(-window2);
    const locked = new Set(recent);
    const fit = (entry, i) => locked.has(i) ? 0 : energyFitWeight(entry.energy, energy) * moodFitWeight(entry.mood, state2.lastMood);
    let weights = pool.map(fit);
    let total = weights.reduce((sum, w) => sum + w, 0);
    if (total <= 0) {
      weights = pool.map(
        (entry, i) => i === state2.index ? 0 : energyFitWeight(entry.energy, energy) * moodFitWeight(entry.mood, state2.lastMood)
      );
      total = weights.reduce((sum, w) => sum + w, 0);
    }
    if (total <= 0) return (state2.index + 1) % pool.length;
    let roll = rng() * total;
    for (let i = 0; i < pool.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) return i;
    }
    return (state2.index + 1) % pool.length;
  }

  // src/core/visual/showOrchestrator.ts
  var SHOW_DEFAULTS = {
    minDwellS: 4,
    fadeS: 0.8,
    onsetThreshold: 0.72,
    energyJump: 0.35,
    maxSceneS: 30,
    repeatWindow: DIRECTOR_DEFAULTS.repeatWindow
  };
  function resolve(opts) {
    return { ...SHOW_DEFAULTS, ...opts ?? {} };
  }
  function trimRecent(recent, window2) {
    const w = Math.max(0, Math.floor(window2));
    if (w <= 0) return [];
    return recent.slice(-w);
  }
  function effectiveDurationS(scene, opts) {
    const o = resolve(opts);
    const wanted = scene.durationS > 0 ? scene.durationS : o.maxSceneS;
    const clipLimit = scene.kind === "clip" && typeof scene.mediaDurationS === "number" && scene.mediaDurationS > 0 ? scene.mediaDurationS : Number.POSITIVE_INFINITY;
    return Math.max(1, Math.min(wanted, clipLimit, o.maxSceneS));
  }
  function showTotalDurationS(scenes2, opts) {
    return scenes2.reduce((sum, scene) => sum + effectiveDurationS(scene, opts), 0);
  }
  function createShowState(index = 0, nowMs = 0, energyRef = 0, seed) {
    return {
      index,
      startedAtMs: nowMs,
      transitions: 0,
      energyRef,
      ...seed === void 0 ? {} : { seed },
      lastMood: null,
      recent: [index]
    };
  }
  function nextSceneIndex(index, sceneCount) {
    if (sceneCount <= 0) return -1;
    return (index + 1) % sceneCount;
  }
  function chooseNextIndex(state2, scenes2, features, index, o) {
    if (typeof o.seed !== "number" || !Number.isFinite(o.seed)) {
      return { index: nextSceneIndex(index, scenes2.length), recent: [], lastMood: null };
    }
    const recent = trimRecent(
      state2.recent && state2.recent.length > 0 ? state2.recent : [index],
      o.repeatWindow
    );
    const directorState = {
      seed: o.seed,
      index,
      startedAtMs: state2.startedAtMs,
      energyRef: state2.energyRef,
      // Stimmung der laufenden Szene ist der Bezug für die Rotation.
      lastMood: scenes2[index]?.mood ?? state2.lastMood ?? null,
      transitions: state2.transitions,
      recent
    };
    const directorOpts = {
      minDwellS: o.minDwellS,
      onsetThreshold: o.onsetThreshold,
      energyJump: o.energyJump,
      maxSceneS: o.maxSceneS,
      repeatWindow: o.repeatWindow
    };
    const next = pickNextScene(scenes2, directorState, features, directorOpts);
    return {
      index: next,
      recent: trimRecent([...recent, next], o.repeatWindow),
      lastMood: scenes2[next]?.mood ?? null
    };
  }
  function tickShow(state2, scenes2, features, nowMs, opts) {
    const o = resolve(opts);
    const totalS = showTotalDurationS(scenes2, o);
    if (scenes2.length === 0) {
      return { state: state2, sceneIndex: -1, advanced: false, reason: null, fade: 1, elapsedS: 0, totalS };
    }
    const index = Math.min(Math.max(state2.index, 0), scenes2.length - 1);
    const scene = scenes2[index];
    const elapsedS = Math.max(0, (nowMs - state2.startedAtMs) / 1e3);
    const durationS = effectiveDurationS(scene, o);
    const energy = Number.isFinite(features.energy) ? features.energy : 0;
    let reason = null;
    if (elapsedS >= durationS) {
      reason = "duration";
    } else if (elapsedS >= o.minDwellS) {
      if (features.onset >= o.onsetThreshold) reason = "beat";
      else if (energy - state2.energyRef >= o.energyJump) reason = "energy";
    }
    if (reason) {
      const chosen = chooseNextIndex(state2, scenes2, features, index, o);
      const nextState = {
        index: chosen.index,
        startedAtMs: nowMs,
        transitions: state2.transitions + 1,
        // Bezug für die nächste Szene neu setzen: „Anstieg seit Szenenbeginn“.
        energyRef: energy,
        // MEDIA-2026-11-04-006: Regie-Zustand fortschreiben (Seed + Sperrfenster).
        ...typeof o.seed === "number" && Number.isFinite(o.seed) ? { seed: o.seed, recent: chosen.recent, lastMood: chosen.lastMood } : {}
      };
      return {
        state: nextState,
        sceneIndex: chosen.index,
        advanced: true,
        reason,
        // Beim Wechsel startet der Crossfade der neuen Szene bei 0.
        fade: o.fadeS > 0 ? 0 : 1,
        elapsedS: 0,
        totalS
      };
    }
    return {
      state: state2,
      sceneIndex: index,
      advanced: false,
      reason: null,
      fade: o.fadeS > 0 ? Math.min(1, elapsedS / o.fadeS) : 1,
      elapsedS,
      totalS
    };
  }
  function showFade(state2, nowMs, opts) {
    const o = resolve(opts);
    if (o.fadeS <= 0) return 1;
    const elapsedS = Math.max(0, (nowMs - state2.startedAtMs) / 1e3);
    return Math.min(1, elapsedS / o.fadeS);
  }

  // src/core/visual/webglRenderer.ts
  var MAX_SHADER_COLORS = 6;
  var VERTEX_SHADER_SOURCE = `attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) * 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;
  function buildFragmentShader() {
    const colorDecls = Array.from({ length: MAX_SHADER_COLORS }, (_, i) => `uniform vec3 u_color${i};`).join("\n");
    const colorArray = Array.from({ length: MAX_SHADER_COLORS }, (_, i) => `  colors[${i}] = u_color${i};`).join("\n");
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

  // Vignette + leichte S\xE4ttigung
  float vignette = smoothstep(1.15, 0.25, length(v_uv - 0.5));
  color *= mix(0.55, 1.0, vignette);

  // VISUAL-P1-008: Show-Szene (Bild/Clip) als Textur \xFCber das Feld legen.
  // Cover-Fit: die sichtbare UV-Spanne wird von der CPU aus Canvas- und
  // Medien-Seitenverh\xE4ltnis berechnet (kein Verzerren). Bei einem Szenenwechsel
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
  var clamp012 = (v) => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  var safeSide = (v) => Number.isFinite(v) && v > 0 ? Math.max(1, Math.round(v)) : 1;
  function packUniforms(preset, params2, opts) {
    const palette = (preset.palette?.colors ?? []).slice(0, MAX_SHADER_COLORS);
    const colors = [];
    for (let i = 0; i < MAX_SHADER_COLORS; i++) {
      const c = palette[i] ?? palette[palette.length - 1] ?? [0, 0, 0];
      colors.push(clamp012(c[0]), clamp012(c[1]), clamp012(c[2]));
    }
    return {
      // Test tests/webglRenderer.test.ts hat aufgedeckt: `Math.round(NaN)` ergab
      // eine NaN-Resolution → nichts würde gezeichnet. Jetzt abgesichert.
      resolution: [safeSide(opts.width), safeSide(opts.height)],
      time: Number.isFinite(opts.timeS) ? opts.timeS : 0,
      zoom: Number.isFinite(params2.zoom) ? Math.min(4, Math.max(0.05, params2.zoom)) : 1,
      rotation: Number.isFinite(params2.rotation) ? params2.rotation * Math.PI / 180 : 0,
      warp: clamp012(params2.warp),
      // 0..360 Grad → 0..2π
      hue: Number.isFinite(params2.hue) ? (params2.hue % 360 + 360) % 360 * (Math.PI / 180) : 0,
      flow: Number.isFinite(params2.flow) ? Math.min(4, Math.max(0, params2.flow)) : 0.5,
      brightness: Number.isFinite(params2.brightness) ? Math.min(2, Math.max(0, params2.brightness)) : 1,
      contrast: Number.isFinite(params2.contrast) ? Math.min(3, Math.max(0, params2.contrast)) : 1,
      displacement: clamp012(params2.displacement),
      glow: clamp012(params2.glow),
      symmetry: Number.isFinite(params2.symmetry) ? Math.min(16, Math.max(1, Math.round(params2.symmetry))) : 1,
      colorCount: Math.max(1, palette.length || 1),
      colors
    };
  }
  function mediaSize(source) {
    if (!source) return [0, 0];
    const m = source;
    const w = m.videoWidth ?? m.naturalWidth ?? m.width ?? 0;
    const h = m.videoHeight ?? m.naturalHeight ?? m.height ?? 0;
    return [Number.isFinite(w) && w > 0 ? w : 0, Number.isFinite(h) && h > 0 ? h : 0];
  }
  function sceneCoverSpan(canvasWidth, canvasHeight, mediaWidth, mediaHeight) {
    const cw = safeSide(canvasWidth);
    const ch = safeSide(canvasHeight);
    const mw = Number.isFinite(mediaWidth) && mediaWidth > 0 ? mediaWidth : 0;
    const mh = Number.isFinite(mediaHeight) && mediaHeight > 0 ? mediaHeight : 0;
    if (mw === 0 || mh === 0) return [1, 1];
    const canvasAspect = cw / ch;
    const mediaAspect = mw / mh;
    return canvasAspect >= mediaAspect ? [1, mediaAspect / canvasAspect] : [canvasAspect / mediaAspect, 1];
  }
  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn("[visual:webgl] Shader-Kompilierung fehlgeschlagen:", String(gl.getShaderInfoLog(shader)).slice(0, 200));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }
  function createWebGLVisualRenderer(canvas2) {
    if (typeof canvas2?.getContext !== "function") return null;
    let gl = null;
    let kind = "webgl";
    try {
      gl = canvas2.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance" });
      if (gl) kind = "webgl2";
      if (!gl) {
        gl = canvas2.getContext("webgl", { antialias: false, alpha: false });
        kind = "webgl";
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
      console.warn("[visual:webgl] Programm-Link fehlgeschlagen:", String(gl.getProgramInfoLog(program)).slice(0, 200));
      return null;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const uniformOf = (name) => gl.getUniformLocation(program, name);
    const u = {
      resolution: uniformOf("u_resolution"),
      time: uniformOf("u_time"),
      zoom: uniformOf("u_zoom"),
      rotation: uniformOf("u_rotation"),
      warp: uniformOf("u_warp"),
      hue: uniformOf("u_hue"),
      flow: uniformOf("u_flow"),
      brightness: uniformOf("u_brightness"),
      contrast: uniformOf("u_contrast"),
      displacement: uniformOf("u_displacement"),
      glow: uniformOf("u_glow"),
      symmetry: uniformOf("u_symmetry"),
      colorCount: uniformOf("u_colorCount"),
      colors: Array.from({ length: MAX_SHADER_COLORS }, (_, i) => uniformOf(`u_color${i}`)),
      sceneA: uniformOf("u_sceneA"),
      sceneB: uniformOf("u_sceneB"),
      sceneMix: uniformOf("u_sceneMix"),
      sceneAmount: uniformOf("u_sceneAmount"),
      sceneSpanA: uniformOf("u_sceneSpanA"),
      sceneSpanB: uniformOf("u_sceneSpanB")
    };
    let width = canvas2.width || 1;
    let height = canvas2.height || 1;
    const makeTexture = () => {
      const tex = gl.createTexture();
      if (!tex) return null;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return tex;
    };
    const sceneTextureA = makeTexture();
    const sceneTextureB = makeTexture();
    let uploadedA = null;
    let uploadedB = null;
    const isVideoSource = (s) => typeof HTMLVideoElement !== "undefined" && s instanceof HTMLVideoElement;
    const upload = (tex, unit, source) => {
      const [mw, mh] = mediaSize(source);
      if (!tex || mw === 0 || mh === 0) return false;
      try {
        gl.activeTexture(unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      } catch {
        return false;
      }
      return true;
    };
    return {
      kind,
      resize(nextWidth, nextHeight) {
        const w = Math.max(1, Math.round(nextWidth));
        const h = Math.max(1, Math.round(nextHeight));
        if (w === width && h === height) return;
        width = w;
        height = h;
        canvas2.width = w;
        canvas2.height = h;
        gl.viewport(0, 0, w, h);
      },
      render(preset, params2, timeS, scene = null) {
        const values = packUniforms(preset, params2, { timeS, width, height });
        gl.viewport(0, 0, width, height);
        gl.uniform2f(u.resolution, values.resolution[0], values.resolution[1]);
        gl.uniform1f(u.time, values.time);
        gl.uniform1f(u.zoom, values.zoom);
        gl.uniform1f(u.rotation, values.rotation);
        gl.uniform1f(u.warp, values.warp);
        gl.uniform1f(u.hue, values.hue);
        gl.uniform1f(u.flow, values.flow);
        gl.uniform1f(u.brightness, values.brightness);
        gl.uniform1f(u.contrast, values.contrast);
        gl.uniform1f(u.displacement, values.displacement);
        gl.uniform1f(u.glow, values.glow);
        gl.uniform1f(u.symmetry, values.symmetry);
        gl.uniform1f(u.colorCount, values.colorCount);
        for (let i = 0; i < MAX_SHADER_COLORS; i++) {
          const base = i * 3;
          gl.uniform3f(u.colors[i], values.colors[base], values.colors[base + 1], values.colors[base + 2]);
        }
        let sceneAmount = 0;
        let mix = 1;
        let spanA = [1, 1];
        let spanB = [1, 1];
        if (scene?.current) {
          if ((isVideoSource(scene.current) || uploadedB !== scene.current) && upload(sceneTextureB, gl.TEXTURE1, scene.current)) {
            uploadedB = scene.current;
          }
          if (uploadedB === scene.current) {
            const [mw, mh] = mediaSize(scene.current);
            spanB = sceneCoverSpan(width, height, mw, mh);
            sceneAmount = 1;
            const previous = scene.previous ?? null;
            if (previous) {
              if ((isVideoSource(previous) || uploadedA !== previous) && upload(sceneTextureA, gl.TEXTURE0, previous)) {
                uploadedA = previous;
              }
              if (uploadedA === previous) {
                const [pw, ph] = mediaSize(previous);
                spanA = sceneCoverSpan(width, height, pw, ph);
                mix = typeof scene.mix === "number" && Number.isFinite(scene.mix) ? Math.max(0, Math.min(1, scene.mix)) : 1;
              }
            }
          }
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sceneTextureA);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, sceneTextureB);
        gl.uniform1i(u.sceneA, 0);
        gl.uniform1i(u.sceneB, 1);
        gl.uniform1f(u.sceneMix, mix);
        gl.uniform1f(u.sceneAmount, sceneAmount);
        gl.uniform2f(u.sceneSpanA, spanA[0], spanA[1]);
        gl.uniform2f(u.sceneSpanB, spanB[0], spanB[1]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      dispose() {
        try {
          gl.deleteTexture(sceneTextureA);
          gl.deleteTexture(sceneTextureB);
          gl.deleteBuffer(buffer);
          gl.deleteProgram(program);
          gl.deleteShader(vs);
          gl.deleteShader(fs);
        } catch {
        }
      }
    };
  }

  // src/core/visual/mediaFx.ts
  var VERTEX = `attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;
  var FRAGMENT = `precision highp float;
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

// Bildraum-Verformung: Zoom, Drehung, Welle, Kaleidoskop (p in Seitenverh\xE4ltnis-Einheiten).
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
  // Medien-UV bleiben Cover-Fit; die Verformung arbeitet in Seitenverh\xE4ltnis-Einheiten.
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
  var UNIFORMS = [
    "u_a",
    "u_b",
    "u_mix",
    "u_hasA",
    "u_fadeIn",
    "u_spanA",
    "u_spanB",
    "u_res",
    "u_time",
    "u_zoom",
    "u_rot",
    "u_hue",
    "u_bright",
    "u_contrast",
    "u_glow",
    "u_split",
    "u_glitch",
    "u_warp",
    "u_sym",
    "u_kaleido"
  ];
  function mediaFxValues(preset, params2, f, timeS) {
    const energy = clamp01(f.energy);
    const hueDeg = ((params2.hue - preset.palette.hueBase) % 360 + 360) % 360;
    return {
      zoom: Math.min(1.3, 1.04 + f.bass * 0.1 + f.onset * 0.06 + 0.03 * Math.sin(timeS * 0.2)),
      rot: 0.025 * Math.sin(timeS * 0.4) + f.onset * 0.03 * Math.sin(timeS * 7) + f.treble * 0.02 * Math.sin(timeS * 3),
      hue: hueDeg * Math.PI / 180 * 0.25,
      bright: 0.75 + 0.5 * clamp01(params2.brightness),
      contrast: 0.9 + 0.3 * clamp01(params2.contrast),
      glow: clamp01(params2.glow),
      split: f.onset * 0.012 + f.bass * 4e-3,
      glitch: Math.max(0, Math.min(1, (f.onset - 0.75) / 0.25)),
      warp: clamp01(params2.warp),
      sym: Math.max(1, params2.symmetry),
      kaleido: params2.symmetry > 1 ? clamp01(0.25 + 0.75 * energy) * 0.85 : 0
    };
  }
  function createMediaFxRenderer(canvas2) {
    if (typeof canvas2?.getContext !== "function") return null;
    let kind = "webgl2";
    let gl = canvas2.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) {
      kind = "webgl";
      gl = canvas2.getContext("webgl", { antialias: false, alpha: false });
    }
    if (!gl) return null;
    const ctx = gl;
    const compile2 = (type, source) => {
      const shader = ctx.createShader(type);
      if (!shader) return null;
      ctx.shaderSource(shader, source);
      ctx.compileShader(shader);
      if (!ctx.getShaderParameter(shader, ctx.COMPILE_STATUS)) {
        console.warn("[visual:mediafx] Shader-Kompilierung fehlgeschlagen:", String(ctx.getShaderInfoLog(shader)).slice(0, 200));
        return null;
      }
      return shader;
    };
    const vs = compile2(ctx.VERTEX_SHADER, VERTEX);
    const fs = compile2(ctx.FRAGMENT_SHADER, FRAGMENT);
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
    const position = ctx.getAttribLocation(program, "a_pos");
    ctx.enableVertexAttribArray(position);
    ctx.vertexAttribPointer(position, 2, ctx.FLOAT, false, 0, 0);
    const u = {};
    for (const name of UNIFORMS) u[name] = ctx.getUniformLocation(program, name);
    const makeTexture = () => {
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
    let uploadedA = null;
    let uploadedB = null;
    let width = canvas2.width;
    let height = canvas2.height;
    const isVideo = (s) => typeof HTMLVideoElement !== "undefined" && s instanceof HTMLVideoElement;
    const upload = (tex, unit, source) => {
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
        canvas2.width = width;
        canvas2.height = height;
        ctx.viewport(0, 0, width, height);
      },
      render(preset, params2, features, timeS, scene) {
        const v = mediaFxValues(preset, params2, features, timeS);
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
        let spanA = [1, 1];
        let spanB = [1, 1];
        const current = scene?.current ?? null;
        if (current) {
          if ((isVideo(current) || uploadedB !== current) && upload(textureB, ctx.TEXTURE1, current)) uploadedB = current;
          if (uploadedB === current) {
            ready = true;
            const [mw, mh] = mediaSize(current);
            spanB = sceneCoverSpan(width, height, mw, mh);
            const fade = typeof scene?.mix === "number" && Number.isFinite(scene.mix) ? Math.max(0, Math.min(1, scene.mix)) : 1;
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
        }
      }
    };
  }

  // src/core/visual/podScene.ts
  var MEDIA_TIMEOUT_MS = 2e4;
  var SMOOTHING = 0.35;
  function loadImage(src) {
    return new Promise((resolve2, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const timer = setTimeout(() => reject(new Error("image timeout")), MEDIA_TIMEOUT_MS);
      img.onload = () => {
        clearTimeout(timer);
        resolve2(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error("image error"));
      };
      img.src = src;
    });
  }
  function loadVideo(src) {
    return new Promise((resolve2, reject) => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "auto";
      const timer = setTimeout(() => reject(new Error("video timeout")), MEDIA_TIMEOUT_MS);
      video.onloadeddata = () => {
        clearTimeout(timer);
        void video.play().catch(() => void 0);
        resolve2(video);
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("video error"));
      };
      video.src = src;
    });
  }
  var canvas = null;
  var renderer = null;
  var fx = null;
  var cfg = null;
  var scenes = [];
  var media = [];
  var state = null;
  var params = null;
  var skipped = 0;
  function rendererName(gl) {
    if (!gl) return "none";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(name);
  }
  async function init(config) {
    dispose();
    cfg = config;
    canvas = document.getElementById("stage");
    if (!canvas) throw new Error("stage canvas missing");
    canvas.width = config.width;
    canvas.height = config.height;
    scenes = [];
    media = [];
    skipped = 0;
    for (const scene of config.scenes) {
      try {
        media.push(scene.kind === "clip" ? await loadVideo(scene.src) : await loadImage(scene.src));
        scenes.push(scene);
      } catch {
        skipped += 1;
      }
    }
    if (scenes.length > 0) {
      fx = createMediaFxRenderer(canvas);
      if (!fx) throw new Error("WebGL unavailable");
      fx.resize(config.width, config.height);
    } else {
      renderer = createWebGLVisualRenderer(canvas);
      if (!renderer) throw new Error("WebGL unavailable");
      renderer.resize(config.width, config.height);
    }
    const probe = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    state = createShowState(0, 0, 0, config.seed ?? void 0);
    params = null;
    return { renderer: `${(fx ?? renderer).kind}:${rendererName(probe)}`, loadedScenes: scenes.length, skippedScenes: skipped };
  }
  function frame(raw, index, jpegQuality = 0.9) {
    if (!cfg || !canvas || !(renderer || fx) || !state) throw new Error("not initialised");
    const nowMs = index * 1e3 / cfg.fps;
    const timeS = nowMs / 1e3;
    const features = normalizeFeatures(raw);
    const preset = presetById(cfg.presetId ?? "");
    const target = mapAudioToParams(features, preset, timeS);
    params = params ? blendParams(params, target, SMOOTHING) : target;
    let sceneFrame = null;
    let tick = { sceneIndex: -1, advanced: false, reason: null, fade: 1 };
    if (scenes.length > 0) {
      const previousIndex = state.index;
      const result = tickShow(state, scenes, features, nowMs, cfg.show);
      state = result.state;
      const current = media[result.sceneIndex] ?? null;
      const fade = showFade(state, nowMs, cfg.show);
      const previous = fade < 1 ? media[previousIndex] ?? null : null;
      sceneFrame = { current, previous: previous !== current ? previous : null, mix: fade };
      tick = { sceneIndex: result.sceneIndex, advanced: result.advanced, reason: result.reason, fade };
    }
    if (fx) fx.render(preset, params, features, timeS, sceneFrame);
    else renderer?.render(preset, params, timeS, sceneFrame);
    const jpeg = jpegQuality > 0 ? canvas.toDataURL("image/jpeg", jpegQuality) : null;
    return { info: { ...tick, skippedScenes: skipped }, jpeg };
  }
  function dispose() {
    renderer?.dispose();
    fx?.dispose();
    renderer = null;
    fx = null;
    for (const m of media) {
      if (m instanceof HTMLVideoElement) {
        m.pause();
        m.removeAttribute("src");
        m.load();
      }
    }
    media = [];
    scenes = [];
    state = null;
    params = null;
  }
  window.__vis = { init, frame, dispose };
})();
