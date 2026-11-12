// Game configuration constants from design spec

// Track geometry
export const SEGMENT_LENGTH = 200;
export const COURSE_LENGTH_SEGMENTS = 1500;
export const MAX_SPEED = 3000;
export const DRAW_DISTANCE = 100;
export const CAMERA_DEPTH = 1 / Math.tan((100 / 2) * Math.PI / 180); // Derived from FOV 100°

// Camera & screen (design-spec §3.2)
export const SCREEN_W = 960;
export const SCREEN_H = 540;
export const ROAD_WIDTH = 2000; // world-space road half-width
export const CAMERA_HEIGHT = 1350; // fixed camera elevation above the road surface

/**
 * How far BEHIND the player the camera sits, in world units.
 *
 * A positive trailing offset is load-bearing; its value is tuned together
 * with camera height and shared rider scale. The camera used to sit exactly on
 * the player (`camZ = player.worldZ`), which put the player at `dz = 0` — and
 * `project()` returns null for `dz <= 0`, so the player could not be projected
 * at all and had to be drawn as a fixed-size screen-space sprite that shared
 * no scale model with anything else in the world.
 *
 * Worse, it made the region right around the player a singularity: a rival at
 * the player's exact Z vanished, and one world unit ahead projected ~322,000px
 * wide. Since `SHOVE_Z_WINDOW` is one segment, *every* combat exchange
 * resolved inside that blow-up, which is why rivals appeared as screen-filling
 * boxes whenever they got close enough to fight.
 *
 * Pulling the camera back means the player projects like every other entity
 * and the nearest reachable `dz` is bounded, so entity scale is bounded too.
 * The classic relation is `playerZ = cameraHeight * cameraDepth`, which here
 * is ~1133 — but that places the player exactly at the bottom screen edge,
 * where the sprite is half cut off. This is pulled back further so the rider
 * sits fully on screen at y~461 with the slope readable ahead of it. The
 * farther/higher viewpoint also keeps all five same-depth lanes visible from
 * the center, instead of clipping the two outer rivals offscreen.
 */
export const CAMERA_BACK_Z = 1600;

/** Shared rider scale after widening the local pack view. Keep player and AI
 * physically coherent; the farther camera still draws the hero about 99px tall. */
export const RIDER_WIDTH_FRACTION = 0.22;
export const RIDER_JUMP_HEIGHT_WORLD = 690;

/**
 * World-Z the player starts at. Equal to `CAMERA_BACK_Z` so the camera begins
 * at exactly 0 rather than behind the start of the track array — a negative
 * `camZ` would index the segment walk out of bounds. Riders stagger around
 * this value rather than around 0 (see `spawnAIRiders`), so the start-line
 * layout is unchanged.
 */
export const PLAYER_START_Z = CAMERA_BACK_Z;

/**
 * Hard ceiling on how wide any single world sprite may draw, as a fraction of
 * screen width. `CAMERA_BACK_Z` bounds the near-field blow-up on its own; this
 * is a guard rail for anything that still ends up closer than expected (a
 * rival mid-shove, an obstacle at the very edge of the near plane).
 *
 * Applied as a soft knee rather than a hard `min()` — see `softClampScale`.
 */
export const MAX_ENTITY_SCREEN_FRACTION = 0.42;

// Lanes
export const LANES = [-0.8, -0.4, 0, 0.4, 0.8];

// Player movement (design-spec §4.1/§4.3)
export const PLAYER_ACCEL = 1500; // units/sec^2; reaches MAX_SPEED in ~2s from a stop
export const LANE_TWEEN_MS = 150; // lane-shift tween duration
export const JUMP_AIRTIME_MS = 600; // constant airtime regardless of speed

// Timing
export const PAR_TIME = 130;

// Jump mechanics
export const JUMP_REACH_NORMAL = 9;
export const JUMP_REACH_EXTENDED = 18;
// Extended (trick) airtime: launching off a mogul or crest doubles the normal
// ~600ms airtime to ~1,200ms (design-spec §4.3), covering up to
// JUMP_REACH_EXTENDED segments at MAX_SPEED.
export const JUMP_AIRTIME_EXTENDED_MS = 1200;

// Lane changes
export const LANE_CHANGE_SEGMENTS = 3;

// Boost meter. Earned from risky actions, spent by holding Boost. All starting
// values. BOOST_SPEED_FACTOR must stay below 1.3 unless course placement's
// lane-change model changes (see scripts/verifyBoost.ts).
export const BOOST_MAX = 100;
export const BOOST_SPEED_FACTOR = 1.2; // speed cap multiplier while boosting
export const BOOST_ACCEL_FACTOR = 2; // acceleration multiplier while boosting
export const BOOST_FULL_DURATION_MS = 2500; // a full meter burns out in this long
export const BOOST_MIN_TO_START = 20; // meter needed to begin a boost
export const BOOST_DECAY_MS = 500; // speed above MAX_SPEED bleeds off over this long
/** How fast speed above the current cap bleeds off, in units/sec: a full boost's
 *  excess over `MAX_SPEED` in `BOOST_DECAY_MS`. Shared by the player and rivals,
 *  so dropping into powder at full pace slows down at the same rate boost
 *  fading does, never in a snap. */
export const OVERSPEED_DECAY_PER_SECOND = (MAX_SPEED * (BOOST_SPEED_FACTOR - 1) * 1000) / BOOST_DECAY_MS;
export const BOOST_PENALTY_KEEP = 0.5; // fraction of meter kept after a rock / lost exchange
export const BOOST_GAIN = {
  NEAR_MISS: 8,
  TRICK_LANDING: 15,
  HIT: 12,
  COUNTER: 25,
  KNOCKOUT: 30
};

// Powder fields (#39): one full-width stretch in each bowl section. On the
// ground the top speed, and the boost top speed, are scaled by this factor.
// Airborne riders ignore it, which is why every field opens with moguls to jump.
export const POWDER_SPEED_FACTOR = 0.8;
export const POWDER_MIN_SEGMENTS = 15;
export const POWDER_MAX_SEGMENTS = 25;
/** Moguls across the first segment of a field: at least two lanes, so a timed
 *  trick jump (JUMP_REACH_EXTENDED segments) is always on offer. */
export const POWDER_ENTRY_MOGULS_MIN = 2;
export const POWDER_ENTRY_MOGULS_MAX = 3;

// Ice sheets (#39): one full-width stretch in each ridge section. A lane change
// that STARTS on ice takes `ICE_LANE_TWEEN_MS` instead of `LANE_TWEEN_MS` (jumps
// are unaffected) and a near miss on ice pays `ICE_NEAR_MISS_MULTIPLIER` times.
export const ICE_LANE_TWEEN_MS = 300;
export const ICE_NEAR_MISS_MULTIPLIER = 2;
export const ICE_MIN_SEGMENTS = 20;
export const ICE_MAX_SEGMENTS = 30;
/** Segments of ordinary piste kept either side of a sheet inside its open run. */
export const ICE_EDGE_MARGIN_SEGMENTS = 2;
/** No tree sits on ice or this many segments after it, and no forest section
 *  begins within this many segments of a sheet's end. */
export const ICE_TREE_FREE_SEGMENTS = 10;
/** Lane-change distance the placement model charges on ice: the whole slide at
 *  `MAX_SPEED` (300 ms = 900 units = 4.5 segments), rounded up. The ordinary
 *  `LANE_CHANGE_SEGMENTS` is the same sum for `LANE_TWEEN_MS`. Placement, the
 *  pickup reachability replay and the solvability verifier all read it through
 *  `gapLaneChangeSegments` in `track/surface.ts`. */
export const ICE_LANE_CHANGE_SEGMENTS = Math.ceil((ICE_LANE_TWEEN_MS / 1000) * MAX_SPEED / SEGMENT_LENGTH);

// Tree chute (#39, part 3): once per course, inside one forest section, a
// stretch where the two outer lanes are walled with real trees on every second
// segment and only the three inner lanes are rideable. A tree-free entry funnel
// of `CHUTE_FUNNEL_SEGMENTS` (with marker poles) comes first, so the narrowing is
// readable, and a rider arriving in an outer lane has room to move inward.
export const CHUTE_MIN_SEGMENTS = 20;
export const CHUTE_MAX_SEGMENTS = 30;
export const CHUTE_FUNNEL_SEGMENTS = 10;
/** Wall trees stand on every this-many-th segment of the walled stretch. */
export const CHUTE_WALL_SPACING = 2;
/** Segments an extended (trick) jump can carry the fastest rider: its airtime at BOOST speed (a rival's
 *  cruise, 105% catch-up and the player's boost all exceed the `MAX_SPEED` that `JUMP_REACH_EXTENDED` is
 *  quoted at), plus a segment for taking off up to half a segment late and for the collision window. A wall
 *  tree is hit mid-air, so a flight that ends beyond one still hits it. */
export const CHUTE_BOOSTED_FLIGHT_SEGMENTS = Math.ceil(
  ((JUMP_AIRTIME_EXTENDED_MS / 1000) * MAX_SPEED * BOOST_SPEED_FACTOR + SEGMENT_LENGTH) / SEGMENT_LENGTH);
/** Segments before the funnel in which an OUTER-lane mogul would launch a rider into the first wall tree
 *  (a trick jump flies straight, however fast the rider). The funnel itself is obstacle-free, so the margin
 *  the generator has to police is what is left of the flight. */
export const CHUTE_MOGUL_MARGIN_SEGMENTS = CHUTE_BOOSTED_FLIGHT_SEGMENTS - 1 - CHUTE_FUNNEL_SEGMENTS;
/** Rivals and the cue start treating the outer lanes as closed this many
 *  segments before the first wall tree: the funnel plus a short run-up. */
export const CHUTE_AWARENESS_SEGMENTS = CHUTE_FUNNEL_SEGMENTS + 2;
/** No pickup sits in an outer lane this close to (or inside) the walls: the rider
 *  has to move inward again after taking it, which needs a lane change's distance
 *  and some reaction time. */
export const CHUTE_PICKUP_BUFFER_SEGMENTS = 7;
/** First segments of the walled stretch kept free of inner-lane obstacles, so a
 *  rider who has just made it into the chute has settled before the first one. */
export const CHUTE_INNER_LEAD_SEGMENTS = 4;

// Obstacle placement / density (design-spec §4.2). Obstacle *rows* per 100
// segments ramp from START at t=0 to END at t=1 as the difficulty grows.
export const OBSTACLE_ROWS_PER_100_START = 4;
export const OBSTACLE_ROWS_PER_100_END = 12;
// Segments of every lane kept obstacle-free immediately after a crest apex
// (design-spec §4.2 blind landing zone; 20 ≥ JUMP_REACH_EXTENDED so it also
// covers the crest jump-reach constraint).
export const BLIND_LANDING_SEGMENTS = 20;

// Collision (design-spec §4.4). A hit needs the player and obstacle in the same
// lane with world-Z within ~half a segment.
export const COLLISION_Z_WINDOW = SEGMENT_LENGTH * 0.5;
// Lateral tolerance (as a lane-offset fraction) for "same lane" — half the
// 0.4 lane spacing, so the player must be essentially in the obstacle's lane.
export const COLLISION_LANE_FRACTION = 0.2;

// Collision outcomes (design-spec §4.4).
export const ROCK_SPEED_FACTOR = 0.3; // speed drops to ~30% of current
export const ROCK_TUMBLE_MS = 1000; // ~1s no-steer tumble

/**
 * Segments a rock hit leaves the rider unable to steer, used as a placement
 * constraint exactly like a mogul's jump reach.
 *
 * A rock knocks the rider into a ~1s tumble with NO steering. From full speed
 * that covers ~1650 world units — about 8.3 segments, or 2.8 lanes' worth of
 * steering budget. A player who hits a rock is by definition in that rock's
 * lane and is committed to it for the whole window.
 *
 * That made a tree in the same lane inside the window an unavoidable
 * run-ending death. Measured before the fix (`npm run measure:rocklock`):
 * **2.30% of all rocks**, roughly 1.8 guaranteed kills per course.
 *
 * The placement pass now treats this the same way it already treats a mogul's
 * landing zone — a tree that would fall inside the window is demoted to a
 * rock — so the case cannot be generated. 9 segments gives a little headroom
 * over the measured 8.3.
 */
export const ROCK_LOCK_SEGMENTS = 9;
export const ROCK_IMMUNITY_MS = 1000; // ~1s collision immunity after recovery

// Two-strike trees. The first tree in a race is a heavy crash: the rider stops
// dead, tumbles with no steering or jumping, then is immune while accelerating
// away from a standstill. The second tree ends the run (or eliminates a rival).
// Immunity is counted from the END of the tumble: at PLAYER_ACCEL the rider
// covers ~1,700 units (8-9 segments) in the 1.5s of immunity, and can steer for
// all of it.
export const TREE_CRASH_TUMBLE_MS = 1500;
export const TREE_CRASH_IMMUNITY_MS = 1500;
export const TREE_STRIKES_TO_WIPEOUT = 2;
export const MOGUL_SPEED_FACTOR = 0.75; // ~25% speed loss on a ridden mogul
export const MOGUL_STUMBLE_MS = 400; // brief wobble, no control loss

// A mogul launches an extended trick jump when the player presses jump within
// this forward window of it (design-spec §4.3: "on/just before a mogul").
export const MOGUL_LAUNCH_WINDOW = SEGMENT_LENGTH * 2;

// AI riders (design-spec §4.5). Per-rider cruise speed/aggression/reaction
// distance are drawn from the SAME seeded PRNG the geometry/obstacle passes
// use (see track/aiSpawn.ts), so rivals are deterministic per seed too.
export const AI_RIDER_COUNT = 4;
// Cruise speed is 90-105% of MAX_SPEED so the pack roughly keeps pace with
// the player while still leaving finishing order contestable.
export const AI_CRUISE_SPEED_MIN_FACTOR = 0.9;
export const AI_CRUISE_SPEED_MAX_FACTOR = 1.05;
// Drawn now (part of the spec's per-rider parameter set) but genuinely unused
// until Task 8's bump/combat behavior reads it.
export const AI_AGGRESSION_MIN = 0;
export const AI_AGGRESSION_MAX = 1;
// How many segments ahead a rider looks for an obstacle in its own lane
// before dodging — "a handful of segments" (design-spec §4.5 note), well
// beyond the ~2.25 segments a lane-change tween covers at cruise speed.
export const AI_REACTION_DISTANCE_MIN_SEGMENTS = 6;
export const AI_REACTION_DISTANCE_MAX_SEGMENTS = 12;
// Fixed stagger layout at the start line (lanes skip the player's centre
// lane; Z offsets put two riders just behind and two just ahead of the
// player's worldZ=0 start) — not RNG-drawn, since the spec only calls out
// cruise speed/aggression/reaction distance as needing to be seeded.
export const AI_START_LANES = [0, 1, 3, 4];
export const AI_START_Z_OFFSETS_SEGMENTS = [-2, -1, 1, 2];

// Combat (design-spec §4.6). A shove trigger needs the two riders within this
// many segments of world-Z, whether lateral (steer-in) or same-lane (rear
// approach / a rival drifting in).
export const SHOVE_Z_WINDOW = SEGMENT_LENGTH * 1;
// Per-attacker-pair immunity window after an exchange resolves, so the same
// pairing can't machine-gun re-trigger (spec §4.6).
export const SHOVE_IMMUNITY_MS = 500;
/**
 * Tree-clamp lookahead: a knockback destination lane is rejected if a tree
 * sits within this many segments downstream of the loser's world-Z (spec
 * §4.6).
 *
 * Sized from the distance a knocked rider actually needs to get clear, not
 * picked round. At `MAX_SPEED` after a shove's speed loss (~2400 u/s):
 *
 *   knockback tween (`LANE_TWEEN_MS` 150ms)          ~360 u
 *   buffered escape steer, half a tween to clearance ~180 u
 *   ------------------------------------------------------
 *   best case, perfect play, zero reaction time      ~540 u
 *
 * At 2 segments the window was 400 u — *shorter than the best possible
 * escape* — so trees between 400 u and roughly 1000 u in the destination lane
 * were unavoidable kills, which is precisely what §4.6 promises cannot
 * happen. 5 segments (1000 u) covers the escape plus realistic reaction time.
 *
 * On ice the same sum is 300 ms + half of 300 ms = ~1350 u, longer than the
 * clamp looks. That is safe because no tree stands on ice or within
 * `ICE_TREE_FREE_SEGMENTS` after it (`scripts/verifyIce.ts` measures the
 * distance), so the clamp has nothing to find there.
 *
 * `scripts/verifyCombat.ts` asserts this stays above the computed escape
 * distance, so shrinking it fails the build rather than silently
 * reintroducing forced deaths.
 */
export const TREE_CLAMP_SEGMENTS = 5;
// A rival that trees within this many ms of losing a shove to the player
// counts as the player's knockout (spec §4.6/§4.7).
export const KNOCKOUT_WINDOW_MS = 2000;

/**
 * Rival stagger. Every landed player hit builds a rival's stagger meter; at
 * `STAGGER_MAX` pips it is knocked down: stopped for `KNOCKDOWN_MS`, then
 * collision-immune for `KNOCKDOWN_IMMUNITY_MS` with an empty meter. A rival
 * goes `STAGGER_DECAY_MS` without being hit to recover one pip. A knockdown is
 * not a tree strike and never eliminates a rival.
 */
export const STAGGER_MAX = 3;
export const STAGGER_DECAY_MS = 6000;
export const KNOCKDOWN_MS = 2500;
export const KNOCKDOWN_IMMUNITY_MS = 1500;
/** Pips per landed hit: a brush adds none; the pole and a counter add two. */
export const STAGGER_PIPS = { BRUSH: 0, HIT: 1, ARMED_HIT: 2, COUNTER: 2 } as const;
export const SHOVE_SPEED_LOSS_FACTOR = 0.2; // baseline ~20% loser speed loss
export const ARMED_SHOVE_SPEED_LOSS_FACTOR = 0.4; // double loss on an armed win

/**
 * How long an attack swing locks the attacker's steering AND jump.
 *
 * This is the entire cost of attacking, and it is deliberately positional
 * rather than a speed penalty. Speed losses are noise at this game's scale — a
 * 45% loss costs ~3 segments of a 1500-segment course, against 250 points for
 * a landed hit, so any speed-based cost loses to mashing by roughly 25:1. What
 * is genuinely expensive here is being unable to steer.
 *
 * 250ms at MAX_SPEED is 3.75 segments blind, and an escape steer afterwards
 * needs another ~2.25 to complete — so a swing commits roughly 6 segments of
 * runway. Late-course obstacle rows can sit 5 segments apart, so dense sections
 * contain windows where no swing is safe unless your lane is already clear.
 * That is the intended risk. It is invisible to `verifySolvability` (which
 * models a player with full steering), so it is a playtest tuning target.
 */
export const ATTACK_SWING_MS = 250;

/**
 * The directional SHOVE (player-facing name). Everything about it is `PUSH_*`
 * in code so it can never be mixed up with the older `SHOVE_*` constants above,
 * which belong to the jab's exchange (Z window, pair immunity, speed loss).
 *
 * A push is the slower, costlier second attack: it always succeeds against an
 * eligible target, moves the rival one lane in a direction the player controls,
 * ignores the tree clamp, and adds no stagger pip.
 */
export const PUSH_SWING_MS = 400; // steer + jump lock (jab: ATTACK_SWING_MS)
export const PUSH_COOLDOWN_MS = 900; // independent of the jab's cooldown
export const PUSH_SPEED_LOSS = 0.2; // fraction of the rival's speed lost
/** The hazard cue and the outcome both look this far ahead of the pushed rival. */
export const PUSH_HAZARD_LOOKAHEAD_MS = 1000;

/** Global cooldown between attack presses, regardless of target. Longer than
 *  `SHOVE_IMMUNITY_MS`, so re-attacking the SAME rival is gated by this rather
 *  than by pair immunity. */
export const ATTACK_COOLDOWN_MS = 600;

/** How long a struck rider holds the recoil pose. Long enough to read at
 *  speed, short enough not to look like a stun. */
export const HIT_REACTION_MS = 350;

/** How long the white impact flash lasts on a struck rider. */
export const HIT_FLASH_MS = 80;

/**
 * Attack reach, as a lane-offset fraction. `LANES` are spaced 0.4 apart, so
 * 0.48 is 1.2 lanes — enough to hit a neighbour mid-tween without letting the
 * attack reach two lanes across.
 */
export const ATTACK_LANE_REACH = 0.48;

/** Below this the two riders count as sharing a lane, so the knockback has no
 *  natural direction and falls back to the toward-centre rule. */
export const SAME_LANE_EPSILON = 0.05;

/** Target switching hysteresis: a challenger must score this much better than
 *  the current target to steal it, so the marker does not flicker between two
 *  rivals at similar range. */
export const TARGET_SWITCH_RATIO = 0.75;

/** Grace period before a target that left range is dropped — stops the marker
 *  blinking during a pass-by. */
export const TARGET_GRACE_MS = 100;
// How often (ms) each AI rider re-rolls whether to attempt a bump, gated by
// its own `aggression` (runtime randomness — NOT the seeded PRNG, per §4.5).
export const AI_BUMP_CHECK_INTERVAL_MS = 500;

// Pickups: ski pole (design-spec §4.6), shield, speed wax and snowball (#36).
export const WEAPON_CHARGES = 3;
// Pickups spawn on a clear, reachable lane every 150-220 segments (~7 a course,
// up from ~3), through a seeded stream derived from the course seed.
export const PICKUP_MIN_GAP_SEGMENTS = 150;
export const PICKUP_MAX_GAP_SEGMENTS = 220;
/** Relative weights for the kind of each placed pickup. */
export const PICKUP_KIND_WEIGHTS = { pole: 35, shield: 25, wax: 20, snowball: 20 } as const;
/** A thrown snowball reaches a rival up to this far ahead, in the same or an adjacent lane. */
export const SNOWBALL_RANGE_SEGMENTS = 12;
/** Boost meter added the moment a speed wax pickup is collected. */
export const WAX_BOOST_GAIN = 60;
/** Fixed presentation-only flight time of a thrown snowball. The hit itself
 *  resolves on the throw frame. */
export const SNOWBALL_FLIGHT_MS = 260;

// Near-miss (design-spec §4.7): a one-shot check per entity, evaluated when
// the entity's world-Z crosses the player's. Only counts a genuinely close
// pass — within this many lanes of the entity, at or above this fraction of
// MAX_SPEED.
export const NEAR_MISS_MAX_LANE_DISTANCE = 1;
export const NEAR_MISS_MIN_SPEED_FACTOR = 0.7;

// Point values (from spec §4.7)
export const POINTS = {
  /** A deliberate attack the player pressed for. */
  COMBAT_HIT: 250,
  /** A passive body check — rear-ending a rival, or one drifting into you.
   *  Deliberately a fifth of an attack: the point of a dedicated attack key
   *  is that choosing to fight is the interesting action, and before the
   *  split the scoreboard could not tell intent from accident. */
  COMBAT_BRUSH: 50,
  KNOCKOUT: 500,
  /** One-time bonus for knocking down a rival you had a score to settle with (Cup only). */
  SETTLED: 500,
  /** The directional shove (`PUSH_*`); a knockout is paid on top if it trees. */
  PUSH: 100,
  NEAR_MISS: 100,
  TRICK_JUMP: 150,
  TRICK_JUMP_EXTRA_PER_QUARTER_SECOND: 50,
  COMPLETION_BONUS: 2000,
  TIME_BONUS_PER_SECOND_UNDER_PAR: 50,
  POSITION_BONUS_FIRST: 1000,
  POSITION_BONUS_SECOND: 750,
  POSITION_BONUS_THIRD: 500,
  POSITION_BONUS_FOURTH: 250,
  POSITION_BONUS_FIFTH: 0
};

// ---- Cup grudges (src/progression/grudge.ts) ----
/** Highest grudge level a rival can hold. */
export const GRUDGE_MAX = 2;
/** Added to a rival's aggression for each grudge level (capped at 1.0 overall). */
export const GRUDGE_AGGRESSION_PER_LEVEL = 0.15;
/** Multiplies a rival's attack interval once per grudge level (smaller = attacks more often). */
export const GRUDGE_INTERVAL_FACTOR = 0.85;
/** Deliberate hits on one rival in a race that earn it a grudge. */
export const GRUDGE_HITS_TO_ANGER = 3;
/** Hits a rival must land on the player in a race to leave a score to settle. */
export const GRUDGE_HITS_TO_OWE = 2;

// ---- Feel pass (presentation only; nothing here may change a simulation step) ----
export const FEEL = {
  /** Knockout / heavy-crash beat: real-time length, floor speed, and the share of it held at the floor before easing back. */
  SLOWMO_MS: 350,
  SLOWMO_SCALE: 0.35,
  SLOWMO_HOLD_FRACTION: 0.4,
  /** A beat cannot start within this long of the previous one starting, so
   *  back-to-back knockouts never chain: at most SLOWMO_MS of slow time per cooldown. */
  SLOWMO_COOLDOWN_MS: 1400,
  /** Camera push toward the struck rival: zoom added at full weight, and its length. */
  PUSH_ZOOM: 0.07,
  PUSH_MS: 420,
  /** Heavy crash: extra zoom kick, vignette strength and length. */
  CRASH_ZOOM: 0.05,
  CRASH_VIGNETTE: 0.78,
  CRASH_PULSE_MS: 620,
  /** Boost: scale on the projection's camera depth (below 1 widens the view), eased over this long. */
  BOOST_DEPTH_SCALE: 0.93,
  BOOST_EASE_MS: 200,
  /** Trick landing: upward camera settle (px) and its length. */
  SETTLE_PX: 9,
  SETTLE_MS: 260,
  /** Music tempo, the Flow chain length at which each layer comes in, and scheduling. */
  MUSIC_BPM: 138,
  MUSIC_FLOW_LEVELS: [0, 3, 6, 10] as readonly number[],
  MUSIC_LOOKAHEAD_S: 0.45,
  MUSIC_DUCK_GAIN: 0.3,
  /** Mix levels ahead of the limiter. */
  MASTER_GAIN: 0.9,
  MUSIC_GAIN: 0.34,
  WIND_GAIN: 0.15
} as const;
