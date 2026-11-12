/** The practice course uses the same player, rival and combat models as a race.
 * This small objective tracker never moves riders or manufactures a success. */
export interface PracticeLesson {
  title: string; instruction: string; hint: string;
  /** Touch wording, where the single HIT button changes what the lesson says. */
  touchInstruction?: string; touchHint?: string; touchRetry?: string;
}
export const PRACTICE_LESSONS: ReadonlyArray<PracticeLesson> = [
  {
    title: '1 / 4  ·  OUTSMART THE BULLY',
    instruction: 'Wait for WIND UP. Jump or carve as the bar fills, then press HIT to counter.',
    hint: 'A green COUNTER cue means you can beat a faster rival, even in the air.'
  },
  {
    title: '2 / 4  ·  PASS THE LINE DEFENDER',
    instruction: 'The defender holds the center. Carve LEFT or RIGHT and pass on a clear line.',
    hint: 'You do not need to fight every rider. Keep your speed and give this one space.'
  },
  {
    title: '3 / 4  ·  FOLLOW THE DAREDEVIL',
    instruction: 'Watch the daredevil take the mogul. Jump the mound in your lane, then land.',
    hint: 'JUMP just before the mound for trick air. Trees cannot be jumped.'
  },
  {
    title: '4 / 4  ·  SHOVE INTO THE ROCKS',
    instruction: 'Wait for the "!" on the arrow, then SHOVE the rival into the rock.',
    hint: 'SHOVE (G / L) pushes the rival away from you. The arrow shows which way.',
    // Touch has one attack button: it reads SHOVE while a rock waits beside the rival.
    touchInstruction: 'Wait for the "!" on the arrow: the HIT button turns into SHOVE. Tap it to shove the rival into the rock.',
    touchHint: 'The button reads SHOVE when a rock is waiting. The arrow shows which way the rival goes.',
    touchRetry: 'Try again: ride beside the rival and tap the button when it reads SHOVE.'
  }
];

export const PRACTICE_LESSON_COUNT = PRACTICE_LESSONS.length;
/** A shoved rival must reach the rock within this long for it to count. */
export const PRACTICE_SHOVE_WINDOW_MS = 2000;

export class PracticeObjectives {
  evaded = false;
  countered = false;
  passed = false;
  jumped = false;
  landed = false;
  shovedAtMs: number | null = null;
  rockStruck = false;
  constructor(readonly lesson: number) {}
  combat(type: string): void {
    if (type === 'evade') this.evaded = true;
    if (type === 'counter' && this.evaded) this.countered = true;
  }
  /** The player's directional shove landed on the rival. */
  shoved(nowMs: number): void { this.shovedAtMs = nowMs; }
  /** The rival hit a rock; only counts shortly after a shove. */
  rivalHitRock(nowMs: number): void {
    if (this.shovedAtMs !== null && nowMs - this.shovedAtMs <= PRACTICE_SHOVE_WINDOW_MS) this.rockStruck = true;
  }
  get complete(): boolean {
    return this.lesson === 0 ? this.countered : this.lesson === 1 ? this.passed :
      this.lesson === 2 ? this.jumped && this.landed : this.rockStruck;
  }
}
