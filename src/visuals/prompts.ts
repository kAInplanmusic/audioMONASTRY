/**
 * VisualMONK · Prompt-Katalog für den KI-Nachschub (Image-to-Video)
 * =================================================================
 * 63 fertige Prompts (21 düster / 21 cool / 21 lustig) für den Wan-2.2-TI2V-
 * Worker. Regel, die gemessen funktioniert (docs/VISUALVORLAGEN.md):
 *
 *   * `motiv`  = was das Startbild zeigt (Startframe aus imageHq/R2)
 *   * `motion` = EIN starker Bewegungs-Kern (Kamera ODER Objekt), weil der
 *                Worker aus einem stehenden Bild Bewegung macht
 *   * `tags`   = fürs Manifest-Tagging (poolManifest)
 *   * `energie`= Bewegungsintensität (ruhig/mittel/hart), NICHT Lautstärke
 *
 * Text-to-Video gibt es praktisch nicht (ohne `image_url` nimmt der Worker ein
 * eingebautes fremdes Bild) → der Weg ist immer image→video.
 */

import type { PoolEnergy, PoolMood } from './poolManifest';

export interface DirectorPrompt {
  titel: string;
  mood: PoolMood;
  energie: PoolEnergy;
  tags: readonly string[];
  /** Startbild-Prompt. */
  motiv: string;
  /** Bewegungs-Kern. */
  motion: string;
}

export const PROMPT_KATALOG: readonly DirectorPrompt[] = [
  // ───────────────────────── A) DÜSTER ─────────────────────────
  { titel: 'Neon Altar', mood: 'duester', energie: 'mittel', tags: ['neon-noir', 'haze', 'push-in'], motiv: 'hooded figure standing on wet asphalt under flickering neon tubes', motion: 'slow camera push in with light tubes pulsing and haze drifting' },
  { titel: 'Biomechanical Wound', mood: 'duester', energie: 'ruhig', tags: ['biomech', 'breathe', 'industrial'], motiv: 'colossal biomechanical creature in foggy hangar, exposed ribs glowing', motion: 'creature slowly breathing, fog drifting between its legs, slow cinematic push in' },
  { titel: 'Alien Bloom', mood: 'duester', energie: 'ruhig', tags: ['alien', 'bloom', 'particles'], motiv: 'giant alien flower half-open on cracked concrete, dark soil', motion: 'flower slowly opening, particles drifting in dark, slow orbit' },
  { titel: 'War Cathedral', mood: 'duester', energie: 'mittel', tags: ['industrial', 'war', 'orbit'], motiv: 'abandoned concrete bunker with rusted steel pipes, single red light', motion: 'slow orbit around central pillar, dust motes rising' },
  { titel: 'Neon Siren', mood: 'duester', energie: 'mittel', tags: ['techno', 'neon', 'pulse'], motiv: 'tall hooded woman on neon stage, rain-slick floor', motion: 'camera slow push in, light tubes pulsing in sync, haze drifting' },
  { titel: 'Crawler Tunnel', mood: 'duester', energie: 'ruhig', tags: ['horror', 'tunnel', 'drift'], motiv: 'narrow service tunnel with dripping pipes and green emergency light', motion: 'water droplets falling in rhythm, slow handheld drift forward' },
  { titel: 'Rust Angel', mood: 'duester', energie: 'ruhig', tags: ['industrial', 'decay', 'orbit'], motiv: 'corroded statue of an angel in factory ruins', motion: 'slow camera orbit counterclockwise, rust particles falling' },
  { titel: 'Blood Grid', mood: 'duester', energie: 'mittel', tags: ['neon-noir', 'ripple', 'dark'], motiv: 'glitching neon grid floor reflecting red liquid', motion: 'camera slow push down, liquid gently rippling' },
  { titel: 'Static Monolith', mood: 'duester', energie: 'ruhig', tags: ['techno', 'monolith', 'breathe'], motiv: 'black monolith covered in cables in dark warehouse', motion: 'cables subtly breathing, slow push in with faint smoke drift' },
  { titel: 'Corpse Train', mood: 'duester', energie: 'mittel', tags: ['horror', 'war', 'dolly'], motiv: 'derelict train carriage with broken windows, fog inside', motion: 'slow dolly in through window, condensation forming and fading' },
  { titel: 'Ash Choir', mood: 'duester', energie: 'ruhig', tags: ['industrial', 'ash', 'orbit'], motiv: 'row of empty metal chairs in ash-filled hall', motion: 'slow orbit left, ash particles rising and settling' },
  { titel: 'Neon Wound', mood: 'duester', energie: 'mittel', tags: ['neon-noir', 'ripple', 'noir'], motiv: 'wet alley with neon signs reflecting on blood-stained pavement', motion: 'slow push in, puddle rippling from distant drip' },
  { titel: 'Iron Lung', mood: 'duester', energie: 'ruhig', tags: ['horror', 'breathe', 'industrial'], motiv: 'massive iron lung machine in dark clinic', motion: 'chamber slowly breathing in and out, light flicker' },
  { titel: 'Drone Graveyard', mood: 'duester', energie: 'mittel', tags: ['war', 'drone', 'drift'], motiv: 'field of crashed drones under storm clouds', motion: 'slow orbit over wreckage, wind drifting dust' },
  { titel: 'Submerged Altar', mood: 'duester', energie: 'ruhig', tags: ['horror', 'underwater', 'rise'], motiv: 'underwater concrete altar with glowing algae', motion: 'bubbles rising slowly, gentle camera push in' },
  { titel: 'Flicker Saint', mood: 'duester', energie: 'mittel', tags: ['horror', 'pulse', 'statue'], motiv: 'saint statue with cracked face under strobing light', motion: 'light pulsing, camera micro-push in, haze drifting' },
  { titel: 'Grey Market', mood: 'duester', energie: 'mittel', tags: ['noir', 'market', 'orbit'], motiv: 'black market stall of circuit boards and wires in dark alley', motion: 'slow orbit, wires gently swaying, smoke drifting' },
  { titel: 'Concrete Lung', mood: 'duester', energie: 'ruhig', tags: ['industrial', 'breathe', 'sculpture'], motiv: 'huge concrete lung sculpture, dark interior', motion: 'inner chamber breathing slowly, dust rising' },
  { titel: 'Night Watch', mood: 'duester', energie: 'ruhig', tags: ['war', 'silhouette', 'ripple'], motiv: 'soldier silhouette on watchtower against black sky', motion: 'slow push in, flag slowly rippling in wind' },
  { titel: 'Neon Ghost', mood: 'duester', energie: 'mittel', tags: ['horror', 'neon', 'dissolve'], motiv: 'transparent ghostly figure in neon-lit corridor', motion: 'figure slowly dissolving, camera slow drift right' },
  { titel: 'Rust Pulse', mood: 'duester', energie: 'mittel', tags: ['industrial', 'steam', 'pulse'], motiv: 'exposed reactor core with pulsing red glow and steam', motion: 'steam rising in slow pulses, camera slow push in' },

  // ───────────────────────── B) COOL ─────────────────────────
  { titel: 'Chrome Wave', mood: 'cool', energie: 'ruhig', tags: ['chrome', 'liquid', 'orbit'], motiv: 'liquid chrome sculpture on black pedestal', motion: 'surface rippling slowly, camera slow orbit' },
  { titel: 'Star Grid', mood: 'cool', energie: 'ruhig', tags: ['neon-grid', 'stars', 'push-in'], motiv: 'infinite neon grid receding into starfield', motion: 'slow push in along grid lines, stars twinkling' },
  { titel: 'Geometric Sun', mood: 'cool', energie: 'mittel', tags: ['geometric', 'neon', 'pulse'], motiv: 'triangular neon sunburst on concrete wall', motion: 'light slowly pulsing, camera gentle drift left' },
  { titel: 'Tattoo Sleeve', mood: 'cool', energie: 'ruhig', tags: ['tattoo', 'koi', 'breathe'], motiv: 'arm with intricate blackwork tattoo of a koi', motion: 'skin slightly breathing, camera slow push in' },
  { titel: 'Chrom Orbit', mood: 'cool', energie: 'ruhig', tags: ['chrome', 'sphere', 'orbit'], motiv: 'floating chrome sphere in void', motion: 'sphere slowly rotating, camera slow orbit around it' },
  { titel: 'Street Canvas', mood: 'cool', energie: 'mittel', tags: ['street-art', 'mural', 'push-in'], motiv: 'colorful street art mural of a rising phoenix', motion: 'paint texture subtly shifting, camera slow push in' },
  { titel: 'Neon Lattice', mood: 'cool', energie: 'mittel', tags: ['geometric', 'neon', 'orbit'], motiv: '3D neon lattice cube glowing cyan and magenta', motion: 'lattice slowly rotating, camera slow orbit' },
  { titel: 'Cosmic Dust', mood: 'cool', energie: 'ruhig', tags: ['stars', 'nebula', 'drift'], motiv: 'nebula cloud with fine stardust particles', motion: 'dust drifting slowly, camera gentle push in' },
  { titel: 'Liquid Mirror', mood: 'cool', energie: 'ruhig', tags: ['neon', 'reflection', 'ripple'], motiv: 'black mirror pool reflecting neon skyscrapers', motion: 'surface rippling gently, camera slow drift' },
  { titel: 'Chrome Spine', mood: 'cool', energie: 'mittel', tags: ['chrome', 'geometric', 'pulse'], motiv: 'metallic spine structure with glowing nodes', motion: 'nodes pulsing in sequence, camera slow push in' },
  { titel: 'Grid Walk', mood: 'cool', energie: 'mittel', tags: ['neon-grid', 'walk', 'push-in'], motiv: 'person walking on glowing neon grid floor', motion: 'grid lines breathing with light, camera slow tracking push in' },
  { titel: 'Holo Tattoo', mood: 'cool', energie: 'ruhig', tags: ['tattoo', 'holo', 'orbit'], motiv: 'forearm with holographic geometric tattoo', motion: 'hologram slowly rotating on skin, camera micro-orbit' },
  { titel: 'Star Tunnel', mood: 'cool', energie: 'mittel', tags: ['geometric', 'stars', 'zoom'], motiv: 'infinite tunnel of rotating star polygons', motion: 'tunnel slowly zooming forward, stars drifting' },
  { titel: 'Fluid Metal', mood: 'cool', energie: 'ruhig', tags: ['chrome', 'liquid', 'ripple'], motiv: 'pool of mercury-like liquid metal', motion: 'liquid surface rippling, camera slow orbit above' },
  { titel: 'Neon Signage', mood: 'cool', energie: 'mittel', tags: ['neon', 'retro', 'pulse'], motiv: 'retro neon sign of a comet in dark night', motion: 'sign flickering gently, camera slow push in' },
  { titel: 'Prism Fog', mood: 'cool', energie: 'ruhig', tags: ['geometric', 'prism', 'drift'], motiv: 'glass prism in foggy light beams', motion: 'light refractions shifting, camera slow drift' },
  { titel: 'Chromatic Flow', mood: 'cool', energie: 'mittel', tags: ['chrome', 'flow', 'rise'], motiv: 'flowing ribbon of liquid chrome', motion: 'ribbon rising slowly, camera tracking push in' },
  { titel: 'Tattoo Galaxy', mood: 'cool', energie: 'ruhig', tags: ['tattoo', 'galaxy', 'rotate'], motiv: 'back tattoo of a spiral galaxy', motion: 'galaxy slowly rotating under skin, camera slow push in' },
  { titel: 'Grid Pulse', mood: 'cool', energie: 'mittel', tags: ['neon-grid', 'pulse', 'minimal'], motiv: 'minimalist neon grid wall with single dot', motion: 'dot pulsing outward in waves, camera static with micro-push' },
  { titel: 'Star Dust', mood: 'cool', energie: 'ruhig', tags: ['stars', 'dust', 'drift'], motiv: 'macro shot of stardust on black velvet', motion: 'dust particles slowly drifting, camera gentle orbit' },
  { titel: 'Chromatic Drone', mood: 'cool', energie: 'mittel', tags: ['chrome', 'drone', 'orbit'], motiv: 'sleek chrome drone hovering in void', motion: 'drone slowly rotating, camera slow orbit' },

  // ───────────────────────── C) LUSTIG ─────────────────────────
  { titel: 'Lego Dino', mood: 'lustig', energie: 'mittel', tags: ['lego', 'dinosaur', 'comic'], motiv: 'brightly colored Lego T-Rex on playground', motion: 'head tilting and eyes blinking, camera slow push in' },
  { titel: '8-Bit Pizza', mood: 'lustig', energie: 'hart', tags: ['8-bit', 'retro', 'pixel'], motiv: 'pixel art pizza box on retro counter', motion: 'cheese sprites jiggling, camera slight bounce' },
  { titel: 'Comic Bounce', mood: 'lustig', energie: 'hart', tags: ['comic', 'bounce', 'absurd'], motiv: 'cartoon rabbit with spring shoes', motion: 'rabbit bouncing in place, camera gentle orbit' },
  { titel: 'Lego Spaceship', mood: 'lustig', energie: 'mittel', tags: ['lego', 'space', 'pulse'], motiv: 'Lego spaceship on moon base', motion: 'engine softly pulsing, camera slow push in' },
  { titel: 'Dinosaur Party', mood: 'lustig', energie: 'hart', tags: ['dino', 'party', 'drift'], motiv: 'tiny cartoon dinosaur dancing at party', motion: 'dinosaur bobbing head, confetti drifting down' },
  { titel: 'Retro Arcade', mood: 'lustig', energie: 'mittel', tags: ['8-bit', 'arcade', 'flicker'], motiv: '8-bit arcade cabinet with blinking lights', motion: 'screen flickering, camera slow push in' },
  { titel: 'Brainfuck Cloud', mood: 'lustig', energie: 'mittel', tags: ['surreal', 'brain', 'pulse'], motiv: 'surreal cartoon brain floating as cloud', motion: 'brain pulsing gently, camera slow orbit' },
  { titel: 'Lego Cat', mood: 'lustig', energie: 'mittel', tags: ['lego', 'cat', 'absurd'], motiv: 'Lego cat wearing tiny sunglasses', motion: 'ears twitching, tail swishing, camera drift' },
  { titel: 'Pixel Tornado', mood: 'lustig', energie: 'hart', tags: ['8-bit', 'tornado', 'spin'], motiv: '8-bit pixel tornado swirling over desert', motion: 'tornado slowly spinning, camera push in' },
  { titel: 'Comic Explosion', mood: 'lustig', energie: 'hart', tags: ['comic', 'explosion', 'ripple'], motiv: 'classic comic explosion behind stick figure', motion: 'explosion rippling outward, camera slight shake' },
  { titel: 'Dino Selfie', mood: 'lustig', energie: 'mittel', tags: ['dino', 'selfie', 'absurd'], motiv: 'cartoon dinosaur taking selfie with phone', motion: 'phone screen flashing, camera slow orbit' },
  { titel: 'Lego Castle', mood: 'lustig', energie: 'ruhig', tags: ['lego', 'castle', 'ripple'], motiv: 'tiny Lego castle with flags', motion: 'flags rippling in wind, camera slow push in' },
  { titel: 'Retro Robot', mood: 'lustig', energie: 'hart', tags: ['8-bit', 'robot', 'bounce'], motiv: 'cute 8-bit robot dancing', motion: 'robot arms bobbing, camera gentle drift' },
  { titel: 'Surreal Banana', mood: 'lustig', energie: 'mittel', tags: ['surreal', 'banana', 'rise'], motiv: 'giant banana wearing a hat in desert', motion: 'banana slowly rising, camera orbit' },
  { titel: 'Comic Bubble', mood: 'lustig', energie: 'ruhig', tags: ['comic', 'bubbles', 'drift'], motiv: 'floating speech bubbles with emojis', motion: 'bubbles gently drifting up, camera slow push in' },
  { titel: 'Pixel Pizza', mood: 'lustig', energie: 'hart', tags: ['8-bit', 'pizza', 'spin'], motiv: '8-bit chef tossing pixel pizza', motion: 'pizza spinning in air, camera orbit' },
  { titel: 'Lego Volcano', mood: 'lustig', energie: 'mittel', tags: ['lego', 'volcano', 'bubble'], motiv: 'Lego volcano erupting with foam', motion: 'lava bubbling slowly, camera push in' },
  { titel: 'Dinosaur Nap', mood: 'lustig', energie: 'ruhig', tags: ['dino', 'nap', 'breathe'], motiv: 'cartoon dinosaur napping on cloud', motion: 'cloud slowly drifting, dinosaur breathing' },
  { titel: 'Brainfuck Toaster', mood: 'lustig', energie: 'hart', tags: ['surreal', 'absurd', 'wobble'], motiv: 'toaster popping out with tiny brain', motion: 'brain wobbling, camera slight push in' },
  { titel: 'Retro Score', mood: 'lustig', energie: 'hart', tags: ['8-bit', 'score', 'pulse'], motiv: '8-bit scoreboard counting up', motion: 'numbers flipping rapidly, camera static with micro-zoom' },
  { titel: 'Comic Car', mood: 'lustig', energie: 'mittel', tags: ['comic', 'car', 'move'], motiv: 'cartoon car with smiling face driving', motion: 'wheels spinning, road slightly moving, camera tracking' },
];

/** Textzeilen-Trigger für die Textschicht (L4) — generisch, keine erfundenen Zitate. */
export const TEXTZEILEN_TRIGGER: readonly string[] = [
  'STATIC DRIFT',
  'BREATHE IN THE DARK',
  'NEON NEVER SLEEPS',
  'GLITCH & RISE',
  'ONE PUSH INTO VOID',
  'CHROME DREAMS',
  'ORBIT THE SILENCE',
  'PULSE AFTER PULSE',
  'LE GO PLAY',
  'STARS IN A GRID',
];

/** Prompt per Titel suchen (Fallback: erster). */
export function promptByTitel(titel: string): DirectorPrompt {
  return PROMPT_KATALOG.find((p) => p.titel === titel) ?? PROMPT_KATALOG[0];
}

/**
 * Prompt-Satz für ein laufendes Set wählen — der Nachschub-Pfad aus
 * `docs/VISUALVORLAGEN.md` („ein Clip voraus").
 *
 * Erst nach Bewegungsenergie filtern, dann nach Stimmung. Passt die Stimmung
 * nicht, bleibt es bei der Energie-Auswahl (die Bewegung soll zum Set passen);
 * erst wenn auch die leer wäre, gilt der ganze Katalog. Ein leeres Ergebnis wäre
 * für den Aufrufer wertlos, weil er dann ohne Prompt dasteht. `seed` macht die
 * Wahl reproduzierbar — Determinismus ist im VisualMONK der Beweisweg.
 */
export function promptForSet(
  input: { energie?: PoolEnergy; mood?: PoolMood; seed?: number } = {},
): DirectorPrompt {
  const byEnergie = input.energie
    ? PROMPT_KATALOG.filter((p) => p.energie === input.energie)
    : PROMPT_KATALOG;
  const byMood = input.mood ? byEnergie.filter((p) => p.mood === input.mood) : byEnergie;
  const pool = byMood.length > 0 ? byMood : (byEnergie.length > 0 ? byEnergie : PROMPT_KATALOG);
  const seed = Number.isFinite(input.seed) ? Math.abs(Math.trunc(input.seed as number)) : 0;
  return pool[seed % pool.length];
}
