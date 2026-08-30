// src/utils/spatialAutomation.ts

export const generateCircularPath = (radius: number, steps: number) => {
  return Array.from({ length: steps }, (_, i) => {
    const angle = (i / steps) * 2 * Math.PI;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
};

export const generateLissajousPath = (a: number, b: number, steps: number) => {
  return Array.from({ length: steps }, (_, i) => {
    const t = (i / steps) * 2 * Math.PI;
    return { x: Math.sin(a * t), y: Math.sin(b * t) };
  });
};

export const generatePingPongPath = (width: number, steps: number) => {
  return Array.from({ length: steps }, (_, i) => {
    const x = Math.sin((i / steps) * 2 * Math.PI) * width;
    return { x, y: 0 };
  });
};
