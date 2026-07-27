/**
 * The single source of truth for colour and light in the game.
 *
 * Two rules this module exists to enforce, both learned the hard way (see the
 * v2 overhaul epic §4):
 *
 *  1. **Value before hue.** Every gameplay-relevant distinction must survive
 *     conversion to greyscale. Before this module existed, colours were
 *     declared ad-hoc in each sprite file and the mogul ended up at ΔL* 2.5
 *     against the snow it sits on — an unavoidable hazard costing 25% speed
 *     that the player literally could not see. Hue is decoration; value is
 *     information.
 *
 *  2. **One light, everywhere.** A fixed sun direction shared by every sprite
 *     is most of what makes hand-drawn art read as "designed" rather than
 *     assembled. `shade()` and `rim()` below are the only sanctioned way to
 *     pick a lit/shadow tone, so drifting off the system takes deliberate
 *     effort rather than happening by accident across sessions.
 *
 * Exports functions, not just constants, for exactly that reason.
 */

/** Sun direction, upper-left, shared by every sprite and surface. Not a
 *  vector we trace — a convention: lit faces point up-left, shadow faces
 *  point down-right. */
export const SUN = { x: -0.55, y: -0.83 } as const;

// ---------------------------------------------------------------------------
// Colour maths. All shading happens in linear light and comes back to sRGB,
// because blending gamma-encoded values darkens midtones (a 50% blend of black
// and white in sRGB is ~0.21 linear, not 0.5) and makes every ramp muddy.
// ---------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const toRgb = (hex: number): Rgb => ({
  r: (hex >> 16) & 0xff,
  g: (hex >> 8) & 0xff,
  b: hex & 0xff
});

export const toHex = (c: Rgb): number =>
  ((clamp255(c.r) << 16) | (clamp255(c.g) << 8) | clamp255(c.b)) >>> 0;

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

const srgbToLinear = (c: number): number => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

const linearToSrgb = (x: number): number => {
  const v = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return v * 255;
};

/** Relative luminance (WCAG / Rec.709), 0..1. */
export function luminance(hex: number): number {
  const { r, g, b } = toRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** CIE L*, 0..100 — the perceptually uniform lightness axis. This is the
 *  metric every contrast target in the project is stated in, because equal
 *  steps in L* look like equal steps to the eye and equal steps in raw RGB
 *  emphatically do not. */
export function lStar(hex: number): number {
  const y = luminance(hex);
  return y > 0.008856 ? 116 * Math.pow(y, 1 / 3) - 16 : 903.3 * y;
}

/** Perceptual lightness separation between two colours. The project's
 *  acceptance criteria are written against this: gameplay-relevant edges
 *  need >= 12, sprite outlines against snow need >= 25. */
export function deltaL(a: number, b: number): number {
  return Math.abs(lStar(a) - lStar(b));
}

/** Blends two colours in linear light. `t` = 0 returns `a`, 1 returns `b`. */
export function mix(a: number, b: number, t: number): number {
  const ca = toRgb(a);
  const cb = toRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const ch = (x: number, y: number): number =>
    linearToSrgb(srgbToLinear(x) + (srgbToLinear(y) - srgbToLinear(x)) * k);
  return toHex({ r: ch(ca.r, cb.r), g: ch(ca.g, cb.g), b: ch(ca.b, cb.b) });
}

/**
 * Scales a colour's luminance by `factor` in linear light, keeping its hue.
 * Values above 1 lighten, below 1 darken.
 */
export function scaleLight(hex: number, factor: number): number {
  const { r, g, b } = toRgb(hex);
  return toHex({
    r: linearToSrgb(srgbToLinear(r) * factor),
    g: linearToSrgb(srgbToLinear(g) * factor),
    b: linearToSrgb(srgbToLinear(b) * factor)
  });
}

// ---------------------------------------------------------------------------
// The shading ramp.
// ---------------------------------------------------------------------------

export type Face = 'hilite' | 'lit' | 'base' | 'shadow' | 'core';

/**
 * Ramp factors per face. Deliberately asymmetric: the drop into shadow is
 * larger than the lift into light, because a form reads by its shadow side and
 * an evenly-spaced ramp looks washed out. Shadows also pick up a cool tint and
 * highlights a warm one (see `shade`) — that cool-shadow/warm-highlight pair
 * is most of what separates "shaded" from "same colour, three brightnesses".
 */
const RAMP: Record<Face, number> = {
  hilite: 1.85,
  lit: 1.32,
  base: 1.0,
  shadow: 0.58,
  core: 0.34
};

/** Cool tint pulled into shadow faces, warm tint pushed into lit faces. */
const SHADOW_TINT = 0x6f86b8;
const HILIGHT_TINT = 0xfff2d6;

/**
 * The sanctioned way to pick a tone. Give it a material's base colour and a
 * face, get back the correctly shaded tone under the shared sun.
 *
 * Prefer this over hand-picking a second hex for the shadow side — that is how
 * a palette drifts, and the drift is invisible per-sprite but glaring once two
 * sprites sit next to each other.
 */
export function shade(base: number, face: Face): number {
  const scaled = scaleLight(base, RAMP[face]);
  if (face === 'shadow') return mix(scaled, SHADOW_TINT, 0.17);
  if (face === 'core') return mix(scaled, SHADOW_TINT, 0.26);
  if (face === 'hilite') return mix(scaled, HILIGHT_TINT, 0.22);
  if (face === 'lit') return mix(scaled, HILIGHT_TINT, 0.1);
  return scaled;
}

/**
 * The outline tone for a sprite sitting against snow.
 *
 * This is the 2D equivalent of the view-dependent edge darkening that a
 * photograph gets for free: at an object's silhouette you are looking along
 * its surface, through the full thickness of fabric and self-shadowing, and
 * almost nothing comes back. Snow is the brightest possible backdrop, so
 * without this every sprite dissolves into it — the single most important
 * technique in the whole overhaul.
 *
 * Guarantees the result clears `MIN_OUTLINE_DELTA_L` against `against`.
 */
export function rim(base: number, against: number = SNOW.packed): number {
  let out = mix(scaleLight(base, 0.2), SHADOW_TINT, 0.3);
  // Walk it darker until it clears the contrast bar — cheaper and more robust
  // than trying to pick a factor that works for every possible base colour.
  for (let i = 0; i < 12 && deltaL(out, against) < MIN_OUTLINE_DELTA_L; i++) {
    out = scaleLight(out, 0.72);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Acceptance thresholds. These are asserted by the visual gate, so they are
// contract, not suggestion.
// ---------------------------------------------------------------------------

/** Any edge the player must read to play (track edge, hazards, speed cues). */
export const MIN_GAMEPLAY_DELTA_L = 12;
/** A sprite's outline against the surface behind it. */
export const MIN_OUTLINE_DELTA_L = 25;

// ---------------------------------------------------------------------------
// The palette table.
//
// One entry per material, variants derived by tint rather than hand-tuned, so
// the world reads as one place. Keeping them in a single table is what makes a
// limited palette actually stay limited.
// ---------------------------------------------------------------------------

/** Snow, the surface everything else is judged against. */
export const SNOW = {
  /** Groomed piste — the raceable surface. */
  packed: 0xeef4fb,
  /** The alternating band, for the speed cue. Separated from `packed` by
   *  enough L* to actually read as motion at speed. */
  packedAlt: 0xdae6f4,
  /** Untracked off-piste, outside the rumble strips. Deliberately darker and
   *  bluer than the piste so the track edge is legible at a glance. */
  offPiste: 0xbfd2e8,
  offPisteAlt: 0xa8c0dc,
  /** Shadowed snow — under trees, in troughs, behind moguls. */
  shadow: 0x8fa8c9,
  /** Wind-scoured ice. */
  ice: 0xc9dcf0
} as const;

/** Sky and atmosphere. The fog colour is sampled from these at runtime rather
 *  than being a separate grey, so distance reads as a shift in colour
 *  temperature instead of a wash. */
export const SKY = {
  zenith: 0x2f7ac6,
  mid: 0x74b4e8,
  horizon: 0xcfe4f5,
  /** The tight bright band right at the horizon line. */
  murk: 0xe8f1f8,
  sun: 0xfff6de,
  sunGlow: 0xffe9b0,
  cloud: 0xffffff,
  cloudShadow: 0xc2d5e8
} as const;

/** Distant terrain, in depth order. Each is progressively closer to the
 *  horizon colour — that convergence *is* aerial perspective. */
export const MOUNTAIN = {
  far: 0x9fbcd8,
  mid: 0x7d9ec2,
  near: 0x5f83ab,
  /** Snowcaps catch the sun, so they stay lighter than their host ridge. */
  capFar: 0xd6e6f4,
  capMid: 0xc4d9ee,
  capNear: 0xaecbe6
} as const;

/** Rumble strips. The red/white alternation was previously 4x asymmetric
 *  (red at ΔL* 48 against white at ΔL* 12), which read as flickering dashes
 *  rather than a strip; these are balanced so both halves carry similar
 *  weight against the off-piste behind them. */
export const RUMBLE = {
  warn: 0xd2483c,
  warnAlt: 0x8c2f27
} as const;

/** Obstacles. */
export const TREE = {
  foliage: 0x2c6b47,
  foliageDeep: 0x1d4b32,
  trunk: 0x5b3a22,
  snowLoad: 0xe8f1fb
} as const;

export const ROCK = {
  body: 0x77808f,
  wet: 0x59626f
} as const;

/** The mogul. Its whole job is to be visible against `SNOW.packed`, so it is
 *  built from a shadowed tone rather than a lighter one — a bump on snow reads
 *  by the shadow it casts, not by being brighter than its surroundings. */
export const MOGUL = {
  lee: 0x9db6d4,
  crest: 0xf4f9ff
} as const;

/** Rider kit. `suit` is overridden per-rival; everything else is shared so the
 *  pack reads as one field of racers in different colours. */
export const RIDER = {
  suit: 0xd23b3b,
  pants: 0x3d4657,
  helmet: 0xf2f5f9,
  goggle: 0x2aa8c4,
  goggleGlint: 0xbdf0ff,
  skin: 0xdCA07a,
  glove: 0x2a3140,
  boot: 0x23282f,
  board: 0x18a0b8,
  boardAlt: 0xf5a623
} as const;

/**
 * Rival suit colours, spaced along the *value* axis at roughly L* 40/54/68/82
 * as well as around the hue wheel. Picked by hue alone, green and amber
 * collapse into each other under deuteranopia and the whole pack turns to mush
 * in greyscale; spacing them in lightness means the rivals stay tellable apart
 * even when hue carries no information at all. Enforced by
 * `verify:palette`, which fails if any pair closes below ΔL* 6.
 */
export const RIVAL_SUITS = [0x2e5da5, 0xa859f3, 0x3dbd66, 0xffc241] as const;

/** Ski-pole pickup. */
export const PICKUP = {
  shaft: 0xd8dde4,
  grip: 0x24282e,
  basket: 0xf5a623,
  glow: 0xffd978
} as const;

/** UI ink levels. Three, not five — a HUD with more than three weights stops
 *  reading as a hierarchy. */
export const UI = {
  inkHigh: 0xffffff,
  inkMid: 0xc3d0de,
  inkLow: 0x8497aa,
  panel: 0x121a24,
  panelEdge: 0x2b3d4f,
  accentGood: 0x46d38a,
  accentWarn: 0xf5a623,
  accentBad: 0xe8503a,
  accentInfo: 0x49c0e8
} as const;
