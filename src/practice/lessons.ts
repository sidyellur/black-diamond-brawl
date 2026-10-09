/** The practice course uses the same player, rival and combat models as a race.
 * This small objective tracker never moves riders or manufactures a success. */
export const PRACTICE_LESSONS = [
  {
    title: '1 / 3  ·  OUTSMART THE BULLY',
    instruction: 'Wait for WIND UP. Jump or carve as the bar fills, then press HIT to counter.',
    hint: 'A green COUNTER cue means you can beat a faster rival, even in the air.'
  },
  {
    title: '2 / 3  ·  PASS THE LINE DEFENDER',
    instruction: 'The defender holds the center. Carve LEFT or RIGHT and pass on a clear line.',
    hint: 'You do not need to fight every rider. Keep your speed and give this one space.'
  },
  {
    title: '3 / 3  ·  FOLLOW THE DAREDEVIL',
    instruction: 'Watch the daredevil take the mogul. Jump the mound in your lane, then land.',
    hint: 'JUMP just before the mound for trick air. Trees cannot be jumped.'
  }
] as const;

export class PracticeObjectives {
  evaded = false;
  countered = false;
  passed = false;
  jumped = false;
  landed = false;
  constructor(readonly lesson: number) {}
  combat(type: string): void {
    if (type === 'evade') this.evaded = true;
    if (type === 'counter' && this.evaded) this.countered = true;
  }
  get complete(): boolean {
    return this.lesson === 0 ? this.countered : this.lesson === 1 ? this.passed : this.jumped && this.landed;
  }
}
