# Black Diamond Brawl

A downhill snowboarding combat racer for the **browser and an offline landscape iPhone app**.
Carve through seeded alpine courses, read your rivals' attacks, jump the ridges and fight for the finish.
Built with Phaser 3, TypeScript, Vite and Capacitor. All art and sound are original and generated locally.

## Play

```bash
npm ci             # Node 22 is the CI-tested runtime
npm run dev        # open the printed localhost URL
```

For a production build, run `npm run build` then `npm run preview`.
No public hosting is configured in this repository. No account, backend, purchases or asset downloads are needed to play.

On a Mac with Xcode 26+, run `npm run ios:open`, choose an iPhone simulator and run the app.
The app bundles the same game for offline use, supports iOS 15+, and saves progress with native Preferences.
See [iPhone build and device guide](docs/IPHONE.md). Physical-device signing and installation remain a separate user-dependent step, tracked in [#24](https://github.com/sidyellur/black-diamond-brawl/issues/24).

## Five ways to ride

- **Drop In:** race any generated mountain. New Mountain selects another seed; `?seed=42` repeats a course.
- **Practice:** four replayable, guided lessons teach a timed evade/counter, a clean pass around a defender, a trick jump beside a daredevil, and a shove into the rocks. Practice never changes competitive records or rewards.
- **Cup Series:** three races against the same four named rivals. Standings save between rounds and an interrupted round can be resumed from base camp. Placement points are 10 / 7 / 5 / 3 / 1; a wipeout (a second tree) scores zero. Final standings award gold, silver or bronze for a podium finish.
- **Daily Run:** everyone on the same rules version gets the same course and rivals for the UTC date. Retry today's challenge, then share its seed, date, time and score. Older shared dates are clearly labelled practice.
- **Locker:** earn and equip four board and four jacket colorways through six challenges. Finish a race, land three tricks, land five hits, finish a whole cup, reach a podium or win gold. Equipment is cosmetic only; there is no shop or currency.

## Simple controls, skillful combat

| Keyboard | Action |
| --- | --- |
| `←` / `A`, `→` / `D` | Carve one lane per tap; hold to keep carving |
| `Space` / `↑` / `W` | Jump; time a mogul for extended trick air |
| `F` / `K` | Hit: attack the marked rival, or take an earned counter |
| `G` / `L` | Shove: push the marked rival one lane, in a direction you choose (see below) |
| `Shift` / `S` / `↓` (hold) | Boost: burn the boost meter for 20% more top speed. The meter fills from near misses, trick landings, hits, counters and knockouts; needs 20 to start. Boost cuts out in the air, and rocks or lost fights drain it |
| `Esc` / `P` | Pause / resume |
| `M` | Toggle sound |
| `R` while paused | Retry the current race or lesson |
| `Tab` / `Shift+Tab`, `Enter` | Choose and activate a menu button |

Touch controls (including BOOST and SHOVE buttons) appear on touch devices or with `?touch=1`. Landscape gives the largest controls.

Rivals visibly **wind up before striking**. Jump or carve late in the tell to earn a short green
**COUNTER** window, then use the ordinary Attack button. A counter can beat a faster opponent,
and can be taken while airborne. An early dodge is safe but does not earn the timing bonus.
Normal attacks still favor speed or a ski pole; each pole has three charges. Attacking commits
your steering/jump briefly, so choose your line before swinging.

## Pickups

About seven pickups sit on every mountain, always on a lane you can reach without crossing a tree.
Each has its own shape and a letter, so none depends on colour. Drive over one to collect it,
airborne or not. Rivals never collect them.

| Pickup | Letter | Effect |
| --- | --- | --- |
| Ski pole | P | Three charges. A deliberate attack auto-wins and knocks the rival two lanes. |
| Shield | S | Absorbs the next lost combat exchange or the next rock hit, then breaks. Never stops a tree. One at a time. |
| Speed wax | W | Adds 60 to the boost meter instantly. |
| Snowball | B | One throw. Press Attack with no melee target in reach to hit the nearest rival ahead in your lane or an adjacent one, up to 12 segments away. A blue chevron marks who it will hit. With a melee target in reach, Attack stays a melee hit and the snowball is kept. |

The pole and the snowball share one weapon slot, so picking up one replaces the other. A snowball
hit pays as a clean hit and adds one stagger pip. The first tree (a heavy crash) drops the pole or
snowball but keeps a shield; the second ends the run. The HUD strip under the score shows the weapon
and the shield you are holding.

Every rival has a **stagger meter** of three pips, drawn as three squares in its nameplate (filled
means damage taken). An unarmed hit adds 1, a ski-pole hit adds 2, a counter adds 2, and a passive
body check adds none. A rival that goes 6 seconds without being hit recovers a pip. At three pips
it is **knocked down**: it tumbles to a stop for 2.5 seconds, then gets up with 1.5 seconds of
immunity and an empty meter, well behind the pack. A knockdown pays the 500-point knockout and shows
`KNOCKOUT · NAME`. It is not a tree strike and never eliminates a rival, and a rival that has
finished can no longer be staggered. Shoving a rival into a tree still pays the same single
knockout. You have no stagger meter: a lost exchange costs you a lane and speed, as before.

**Two attacks, two jobs.** The Hit (`F` / `K`) is quick: 250 ms of steering lock, a 600 ms cooldown,
speed loss and a stagger pip, worth 250 points, and the game picks the knockback direction (it
never knocks a rival toward a tree it could avoid). The **Shove** (`G` / `L`) is slow and sure:
400 ms lock, 900 ms cooldown, always lands on a marked rival (no speed contest, and it cannot be
used as a counter), costs the rival 20% speed, adds no stagger pip and is worth 100 points. What
it gives you is aim. A rival in the next lane is pushed directly away from you; a rival in your
lane is pushed to the side you are holding (toward the centre of the road if you hold nothing);
at the road edge the push flips inward. A shove ignores the tree clamp, so you can push a rival
into a tree or rock on purpose. A tree pays the usual knockout if it follows within 2 seconds. With
the ski pole a shove pushes two lanes and spends a charge, but ends at the first tree in its path.
The target marker shows a **small arrow** beside the chevron in the direction a shove would push,
and a **"!"** on it, with TREE/ROCK AHEAD in the hint bar, when a tree or rock sits in that lane
within about a second of the rival's travel. An alert rival can steer out of the way once its 350 ms
hit reaction ends, so the shove rewards timing: it reliably lands a rival in a tree within about
five segments. The Hit and Shove have separate cooldowns, and a rival you just struck by either is
immune to both for half a second.

- **Bully:** follows your lane and hunts a fight. Bait its tell, evade and counter.
- **Line defender:** protects its starting line. Pass on another lane or draw it into a strike.
- **Daredevil:** seeks moguls and rocks, takes real jumps and can clash in the air. Watch its landing line.

The first tree in a race is a heavy crash: you stop dead, tumble for 1.5s, then get 1.5s of immunity while you accelerate away, and it clears your ski pole, Flow chain and boost meter. A "LAST CHANCE" tag shows until the finish. The second tree ends the run, even while airborne. Rivals follow the same rule. Jump rocks, use moguls and crests for trick air, and chain
clean hits, near misses and landings to build Flow. Damage breaks the chain.

## Mountains, ghosts and fair challenges

Each seeded mountain combines six named features: forest slaloms with changing openings,
exposed ridge launches with clear landing zones, and broad bowls with space to fight.
Warm-up, transitions and finish runout remain protected. Course geometry, setpieces,
obstacles, pickups and rival decision streams reproduce for a seed.

A successful finish saves your fastest **personal ghost**. Replay the same mountain to see its
translucent rider and signed checkpoint splits at 25%, 50% and 75%. The ghost never collides,
affects standings or consumes gameplay randomness. Ghosts stay on your device; only the latest
8 mountain ghosts are retained. Score/time records keep the most recent 64 mountains.

Gameplay uses fixed 60 Hz simulation steps and independent seeded opponent randomness.
Shared results include the rules/course versions and are **self-reported**, not an online leaderboard.
There is no live multiplayer or server verification. The native app shares reproducible text; a browser
also includes the current game's challenge URL. If sharing or clipboard access is unavailable,
a selectable text dialog is provided.

Current competitive identity is `fixed60-v3 / mountain-v3`. Earlier records remain stored but
are kept separate because courses and combat changed. Corrupt or full storage never prevents
playing; unsaved progress remains available for the current session. Browser multi-tab updates
are reconciled where possible, but localStorage is not a cross-process transaction system.

## Accessibility and performance

- Attacks use text, shapes and progress bars as well as color
- Menus support keyboard focus, mouse and touch
- OS reduced-motion preference reduces camera roll, shake, flashes and decorative movement
- Sound can be muted; leaving the app/tab pauses and requires explicit Resume
- Native controls respect the notch and home indicator
- Canvas fallback works without WebGL; request it with `?renderer=canvas`
- Long frames are capped for collision safety, so very slow devices can run below real time

## Development and verification

```bash
npm run verify:models  # build + all deterministic model/storage/art checks; no browser
npx playwright install chromium webkit
npm run verify         # full production build + model + Chromium/WebKit acceptance
npm run verify:ios     # macOS/Xcode: unsigned Release launch + real WKWebView XCTest
npm run lab            # illustrated sprite contact sheet
```

GitHub Actions runs the full browser and iPhone simulator gates on pull requests and main.
Workflow artifacts contain screenshots, reports and the production build. Browser tests distinguish
real input flows from labelled accelerated/finish fixtures; model tests cover complete deterministic
runs and broad seeded generation. Simulator evidence is not a claim of physical iPhone validation.

- [Gameplay guide and engineering notes](docs/GAMEPLAY_EXPANSION.md)
- [iPhone build, verification and device checklist](docs/IPHONE.md)
- [Earlier implementation and release evidence](docs/OVERNIGHT_REPORT.md)
- [Original design](docs/design-spec.md) and [implementation plan](docs/implementation-plan.md)
