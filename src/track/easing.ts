// --- Easing helpers (design-spec §3.3/§3.4) -------------------------------
// Quadratic ease-in for ramping a curve up from 0, quadratic ease-out for
// ramping it back down, and cosine ease-in-out for smooth hill elevation.
// Shared by the Task 3 sampler track (`testTrack.ts`) and the Task 5 seeded
// generator (`sections.ts`) so both build sections the same way.
export const easeIn = (a: number, b: number, pct: number): number => a + (b - a) * pct * pct;
export const easeOut = (a: number, b: number, pct: number): number =>
  a + (b - a) * (1 - (1 - pct) * (1 - pct));
export const easeInOut = (a: number, b: number, pct: number): number =>
  a + (b - a) * (0.5 - Math.cos(pct * Math.PI) / 2);
