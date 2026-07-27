/**
 * Palette contrast gate.
 *
 * Turns the v2 epic's "value before hue" rule into an enforced contract. Every
 * edge the player must actually read to play the game is asserted here in
 * CIE L*, and the greyscale check catches the failure mode where two colours
 * differ only in hue — which is invisible to a meaningful slice of players and
 * to anyone on a poor screen in daylight.
 *
 * The mogul assertion is the one that matters most: at ΔL* 2.5 against the
 * snow (the pre-v2 value) it was an unavoidable 25%-speed-loss hazard the
 * player could not see coming. That was a gameplay bug wearing an art costume.
 *
 * Usage: npm run verify:palette
 */
import {
  MIN_GAMEPLAY_DELTA_L,
  MIN_OUTLINE_DELTA_L,
  MOGUL,
  RIVAL_SUITS,
  ROCK,
  RUMBLE,
  SNOW,
  TREE,
  deltaL,
  rim
} from '../src/render/palette';

interface Case {
  label: string;
  a: number;
  b: number;
  min: number;
}

const cases: Case[] = [
  // The hazard that was invisible before v2.
  { label: 'mogul lee vs packed snow', a: MOGUL.lee, b: SNOW.packed, min: MIN_GAMEPLAY_DELTA_L },
  { label: 'mogul lee vs alt snow band', a: MOGUL.lee, b: SNOW.packedAlt, min: MIN_GAMEPLAY_DELTA_L },
  // The track edge — the player must know where the piste ends.
  { label: 'piste vs off-piste', a: SNOW.packed, b: SNOW.offPiste, min: MIN_GAMEPLAY_DELTA_L },
  { label: 'piste alt vs off-piste alt', a: SNOW.packedAlt, b: SNOW.offPisteAlt, min: MIN_GAMEPLAY_DELTA_L },
  // Rumble strip against what sits behind it.
  { label: 'rumble warn vs off-piste', a: RUMBLE.warn, b: SNOW.offPiste, min: MIN_GAMEPLAY_DELTA_L },
  // Solid obstacles.
  { label: 'tree foliage vs packed snow', a: TREE.foliage, b: SNOW.packed, min: MIN_GAMEPLAY_DELTA_L },
  { label: 'rock body vs packed snow', a: ROCK.body, b: SNOW.packed, min: MIN_GAMEPLAY_DELTA_L },
  // Sprite outlines have a higher bar — this is what stops riders dissolving
  // into the brightest backdrop in the game.
  { label: 'rider rim vs packed snow', a: rim(0xd23b3b), b: SNOW.packed, min: MIN_OUTLINE_DELTA_L }
];

// Every rival must clear the outline bar and be separable from its neighbours.
RIVAL_SUITS.forEach((suit, i) => {
  cases.push({
    label: `rival ${i} rim vs packed snow`,
    a: rim(suit),
    b: SNOW.packed,
    min: MIN_OUTLINE_DELTA_L
  });
});

let failed = 0;
console.log('\n=== palette contrast (CIE L*) ===');
for (const c of cases) {
  const d = deltaL(c.a, c.b);
  const ok = d >= c.min;
  if (!ok) failed++;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${c.label.padEnd(34)} ΔL* ${d.toFixed(1).padStart(5)}  (min ${c.min})`
  );
}

// Speed cue: the alternating road bands. Held to a lower bar than a gameplay
// edge on purpose — this one has to read as *motion* without turning the piste
// into a zebra crossing, so it is checked for a floor and a ceiling.
const bandDelta = deltaL(SNOW.packed, SNOW.packedAlt);
const bandOk = bandDelta >= 5 && bandDelta <= 14;
if (!bandOk) failed++;
console.log(
  `  ${bandOk ? 'PASS' : 'FAIL'}  ${'road band alternation'.padEnd(34)} ΔL* ${bandDelta
    .toFixed(1)
    .padStart(5)}  (want 5..14)`
);

// Rival suits must be mutually distinguishable by VALUE, not just hue, so the
// pack stays readable in greyscale and under colour-vision deficiency.
console.log('\n=== rival separation in greyscale ===');
let minPairDelta = Infinity;
for (let i = 0; i < RIVAL_SUITS.length; i++) {
  for (let j = i + 1; j < RIVAL_SUITS.length; j++) {
    minPairDelta = Math.min(minPairDelta, deltaL(RIVAL_SUITS[i], RIVAL_SUITS[j]));
  }
}
const pairOk = minPairDelta >= 6;
if (!pairOk) failed++;
console.log(
  `  ${pairOk ? 'PASS' : 'FAIL'}  closest rival pair                 ΔL* ${minPairDelta
    .toFixed(1)
    .padStart(5)}  (min 6)`
);

if (failed) {
  console.error(`\n${failed} palette check(s) failed.\n`);
  process.exit(1);
}
console.log('\npalette OK.\n');
