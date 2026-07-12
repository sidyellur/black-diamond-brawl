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
export const CAMERA_HEIGHT = 1000; // fixed camera elevation above the road surface

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
export const ROCK_IMMUNITY_MS = 1000; // ~1s collision immunity after recovery
export const MOGUL_SPEED_FACTOR = 0.75; // ~25% speed loss on a ridden mogul
export const MOGUL_STUMBLE_MS = 400; // brief wobble, no control loss

// A mogul launches an extended trick jump when the player presses jump within
// this forward window of it (design-spec §4.3: "on/just before a mogul").
export const MOGUL_LAUNCH_WINDOW = SEGMENT_LENGTH * 2;

// Point values (from spec §4.7)
export const POINTS = {
  COMBAT_HIT: 250,
  KNOCKOUT: 500,
  COMBAT_HIT_TOTAL: 750, // COMBAT_HIT + KNOCKOUT
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
