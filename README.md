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
- **Practice:** three replayable, guided lessons teach a timed evade/counter, a clean pass around a defender, and a trick jump beside a daredevil. Practice never changes competitive records or rewards.
- **Cup Series:** three races against the same four named rivals. Standings save between rounds and an interrupted round can be resumed from base camp. Placement points are 10 / 7 / 5 / 3 / 1; a wipeout scores zero. Final standings award gold, silver or bronze for a podium finish.
- **Daily Run:** everyone on the same rules version gets the same course and rivals for the UTC date. Retry today's challenge, then share its seed, date, time and score. Older shared dates are clearly labelled practice.
- **Locker:** earn and equip four board and four jacket colorways through six challenges. Finish a race, land three tricks, land five hits, finish a whole cup, reach a podium or win gold. Equipment is cosmetic only; there is no shop or currency.

## Simple controls, skillful combat

| Keyboard | Action |
| --- | --- |
| `←` / `A`, `→` / `D` | Carve one lane per tap; hold to keep carving |
| `Space` / `↑` / `W` | Jump; time a mogul for extended trick air |
| `F` / `K` | Attack the marked rival, or take an earned counter |
| `Esc` / `P` | Pause / resume |
| `M` | Toggle sound |
| `R` while paused | Retry the current race or lesson |
| `Tab` / `Shift+Tab`, `Enter` | Choose and activate a menu button |

Touch controls appear on touch devices or with `?touch=1`. Landscape gives the largest controls.

Rivals visibly **wind up before striking**. Jump or carve late in the tell to earn a short green
**COUNTER** window, then use the ordinary Attack button. A counter can beat a faster opponent,
and can be taken while airborne. An early dodge is safe but does not earn the timing bonus.
Normal attacks still favor speed or a ski pole; each pole has three charges. Attacking commits
your steering/jump briefly, so choose your line before swinging.

- **Bully:** follows your lane and hunts a fight. Bait its tell, evade and counter.
- **Line defender:** protects its starting line. Pass on another lane or draw it into a strike.
- **Daredevil:** seeks moguls and rocks, takes real jumps and can clash in the air. Watch its landing line.

Trees end a run even while airborne. Jump rocks, use moguls and crests for trick air, and chain
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

Current competitive identity is `fixed60-v2 / mountain-v2`. Earlier records remain stored but
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
