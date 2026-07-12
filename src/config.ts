// Game configuration constants from design spec

// Track geometry
export const SEGMENT_LENGTH = 200;
export const COURSE_LENGTH_SEGMENTS = 1500;
export const MAX_SPEED = 3000;
export const DRAW_DISTANCE = 100;
export const CAMERA_DEPTH = 1 / Math.tan((100 / 2) * Math.PI / 180); // Derived from FOV 100°

// Lanes
export const LANES = [-0.8, -0.4, 0, 0.4, 0.8];

// Timing
export const PAR_TIME = 130;

// Jump mechanics
export const JUMP_REACH_NORMAL = 9;
export const JUMP_REACH_EXTENDED = 18;

// Lane changes
export const LANE_CHANGE_SEGMENTS = 3;

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
