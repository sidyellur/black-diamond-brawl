# Black Diamond Brawl — overnight improvement report

## Goal and scope

Preserve the Road Rash-on-snowboards identity while improving graphics, controls, gameplay, and repeat play. The user authorized a feature PR and merge after verification. No new hosting service or paid infrastructure is being introduced.

## Status log

### 2026-10-09 07:47 UTC / 00:47 PDT — baseline and implementation

- Baseline: `cd88756` on `main`; working branch `dot/gameplay-polish-2026-10-09`.
- Baseline production build passed. Existing palette contrast checks, all 38 combat checks, and course solvability across 1,000 seeds passed.
- Controls, procedural visuals, title/results, and race HUD/game-feel are being improved in parallel.
- No deployment workflow is checked into the repository. Existing GitHub deployment configuration is still being investigated.

## Issues and resolutions

| Issue | State | Resolution / next step |
| --- | --- | --- |
| npm default cache not writable in test environment | Resolved | Installed locked dependencies with a writable `/tmp` cache; no dependency changes. |
| `tsx` executable uses a blocked IPC socket | Resolved for headless checks | `node --import tsx` runs the same TypeScript checks without an IPC daemon. |
| Chromium process singleton cannot create a socket | Investigating | Browser launch fails with `EPERM`, including escalated execution. Finding a supported browser execution route; visual checks are not yet claimed as passed. |
| Cloud browser cannot reach execution workspace localhost | Investigating | Separate browser connection returns connection refused; independent workflow investigation underway. |
| Positive parallax offsets wrap mountain ridge off screen | Fix in progress | Correct seamless ridge wrap and improve faceted mountain rendering. |
| Inputs fire directly during hit-stop and lack lifecycle cleanup | Fix in progress | Poll-based inputs, explicit enabled state, shutdown cleanup, controlled hold steering, short forgiveness buffers. |
| No pause or touch input, minimal controls onboarding | Fix in progress | Pause/resume/retry flow, touch controls, full first-run controls and useful race HUD. |

## Validation

- Passed: baseline TypeScript + Vite production build.
- Passed: baseline palette contrast.
- Passed: baseline combat harness (38 checks).
- Passed: baseline solvability (1,000 deterministic seeds).
- Not yet run successfully: browser smoke/visual tests, touch tests, final integrated build.
- Publication: not pushed, PR not opened, not merged, live deployment not verified.

This report will be updated with final implementation details, evidence, remaining limitations, and publication links.

### 2026-10-09 07:54 UTC / 00:54 PDT — integrated feature pass

- First integrated production build passed.
- Implemented: responsive keyboard and touch control paths; short input forgiveness; countdown; pause/resume/auto-blur pause; score, race position, rival/course progress and attack readiness HUD; procedural sound effects and mute; flow-chain bonuses; replay menus and persistent personal/course records.
- Integrated local checks: 21 control regressions, 38 combat checks, palette checks, and 1,000 seeded solvability checks passed.
- Added normal read-only-permission GitHub Actions verification for the public repository. It will install Chromium from Playwright's supported distribution and run the actual browser gate on the PR; no paid services or billing changes.
- GitHub repository metadata reports no Pages site and no configured homepage; no existing workflow or prior Actions run was found. The deliverable is verified merged source and a production build, not a claimed live deployment.
- The user requested a stronger modern visual direction. A second art pass is replacing low-resolution pixel riders/obstacles with detailed high-resolution illustrations and smooth texture sampling. This is actively being implemented.
- Review caught three score edge cases: false trick reward after rock landing, flow restarting on a damage frame, and a missed rival near-pass at exact Z equality. Regression tests and fixes are in progress.

### 2026-10-09 07:58 UTC / 00:58 PDT — published for real browser verification

- Published feature head `2353033a1c1f2f7e717a2237883528bde17bd347` and opened [PR #20](https://github.com/sidyellur/black-diamond-brawl/pull/20).
- [Actions run 37902048937](https://github.com/sidyellur/black-diamond-brawl/actions/runs/37902048937) successfully installed the supported Chromium runtime and began the complete production-build gate.
- Shell push lacked credentials; resolved through the already-connected GitHub account's atomic Git-data API. The published tree exactly matches the validated local snapshot.
- New model gates: all 27 scoring/flow checks pass, including five regressions that first reproduced the scoring defects. All 21 control checks and 38 combat checks remain green.
- Added rendering assertions for 350 curved/hilly frames, stable projection pools, parallax in both directions, frame-rate-independent powder, and an open/curve-aligned finish arch.
- High-resolution illustration pass remains in progress before final merge. Browser result and visual acceptance remain pending.

### 2026-10-09 08:05 UTC / 01:05 PDT — first real browser results

- All 28 browser acceptance checks passed on the first CI run: pointer menus, countdown input safety, held steering, W jump, pause/time freeze, focus interruption, repeated retries/listener cleanup, result/new-seed/title navigation, persistent records, successful finish, portrait touch, and pointer cancellation.
- The separate smoke gate timed out while the visible countdown was at `1`; it was not a missing keyboard input or a crash. Chromium software rendering was progressing unusually slowly. This gate is still failed until rerun.
- Found a real countdown timing issue: it consumed the capped/smoothed physics delta. On very slow renderers, Phaser treats >200 ms frames as hiccups, stretching the start countdown. Countdown now uses bounded raw frame time while movement retains the collision-safe cap and pause still freezes it.
- Added renderer/FPS/runtime diagnostics and longer startup observation for the next CI run. Existing failure assertions are retained.
- Actual CI screenshots confirm the HUD, pause menu, mobile controls and open finish arch render. Modern192px assets are the next commit and still require in-game screenshot review.

### 2026-10-09 08:11 UTC / 01:11 PDT — modern asset and scene pass

- Replaced 48px pixel riders and hazards with original 192px antialiased illustrations. Seven distinct rider poses now have detailed rear-view helmets, jacket panels, bindings and boards; three fir silhouettes, snow-dusted rocks, shaped moguls and metal ski poles share the same lighting/style.
- Independent raw contact-sheet review approved rider readability, trailing-camera orientation, hazard silhouettes and palette. No downloaded/licensed art or fonts were introduced.
- Enlarged player and rival sprites coherently, added subtle carve camera lean and deterministic off-piste forest scenery, and replaced the highway-like curb treatment with shaped snow banks and sparse piste markers. Broader irregular mountains reduce repeated triangle-wall shapes.
- Added a loading state, actual target advantage warning, quieter motion-linked wind/powder audio, and Canvas fallback for devices without WebGL.
- Local final-pass checks at this stage: production build; 262 actual-art checks over 41 buffers; palette; rendering geometry/finish arch; 38 combat; 27 scoring; 21 controls; records; 1,000 solvability seeds. All passed.
- Actual sprite generation measured about 1.4–1.5 seconds in this environment; packed RGBA atlases 5.77 MiB. This excludes browser/GPU startup. Browser navigation/postrender timings are being recorded separately.
- Modern full-scene visual acceptance, audio/Canvas fallback browser checks and final publication are pending the next CI run.

### 2026-10-09 08:23 UTC / 01:23 PDT — modern visual acceptance and CI repairs

- Published modern head `37250134514f2e3d40ea4dc37817ed24967d9011`. Independent review of actual title, early/mid-race, wide desktop, attack and results screenshots passes the modern illustrated art direction.
- [Run 37903551430](https://github.com/sidyellur/black-diamond-brawl/actions/runs/37903551430): production build, all model/asset gates and all 11 WebGL smoke checks **passed**. Browser acceptance **failed** because its audio diagnostics delayed the Pause key until after the now-correct short countdown. Reordered the test to pause immediately on scene entry; countdown-freeze assertions remain unchanged. The replacement run is pending.
- Chromium logs identified rejected legacy GL launch flags. Tests now use Chromium's supported ANGLE/SwiftShader backend. Software-rendered race frames were approximately 6 FPS on that runner; this is not a hardware-device performance result. Title first post-render was about 2.09 seconds. Movement intentionally caps long simulation frames for collision safety; very slow devices can therefore run below real-time speed.
- Review fixed real touch-cancel activation and multi-pointer ownership defects in menu/HUD buttons, enlarged Pause/Sound touch targets, fixed the clock's minute rollover, and removed lifecycle keyboard captures explicitly on shutdown.
- Reproduced and fixed sequential stale-tab record overwrites. Records refresh/merge newer best scores, faster finish times and attempt counts before mutation, and recover in-memory improvements after quota failure. Expanded storage regressions pass. Truly simultaneous cross-process localStorage writes are not transactional.
- Disabled Phaser's unused audio subsystem; the single gesture-unlocked procedural audio context owns game sound.
- Expanded browser coverage with real touch cancellation, simultaneous steer/jump, Canvas fallback, audio/mute persistence and ten repeated scene restarts. Added clearly labeled mid-course curve/crest visual fixtures; these are not claimed as complete playthroughs.
- Corrected the leading-racer guidance so first place does not say to close the gap. Ordinary rival-pack pacing is under measurement before final sign-off.
- Local follow-on production build, 21 control checks, 27 scoring checks and expanded records checks pass. [Issue #21](https://github.com/sidyellur/black-diamond-brawl/issues/21) tracks remaining release acceptance; no merge or deployment has occurred.

### 2026-10-09 08:33 UTC / 01:33 PDT — real rapid-key regression and pack pacing

- [Run 37904808900](https://github.com/sidyellur/black-diamond-brawl/actions/runs/37904808900) at `aa1a8c8`: all model gates and 13 WebGL smoke checks **passed**; browser acceptance **failed** on the unchanged pause-freeze assertion.
- This failure exposed a real Phaser keyboard-queue issue: multiple DOM key events before a render frame could replay an older P-down/P-up pair, toggling pause off when another key arrived. Added weak event-identity deduplication to race lifecycle, menu, and player key handlers. Two focused model regressions pass; a synchronous real-browser P-down/P-up/ArrowLeft regression now reproduces the exact sequence. Browser re-verification is pending; the assertion is not relaxed.
- Improved ordinary rival pacing with bounded, gradual catch-up after a six-segment deficit. The existing 105% speed ceiling remains; native speed resumes before combat range, all hit/rock/mogul setbacks get four seconds of grace, and finished/wiped-out rivals never return.
- Across 12 deterministic full-course model attempts with real course hazards and legal player inputs, nearby-pack time rose from 44.56% to 76.73%, flat-camera proximity-band time from 63.75% to 68.11%, and natural hits/body checks from 29 to 34. Nine attempts finished; the same three driver-caused DNFs remained. Rival wipeouts remained 29/48. These are model measurements, not a claim of human playthrough or continuous on-screen visibility over crests.
- All 14 new pacing regressions pass, along with the production build, 38 combat, 27 scoring, 23 control, rendering, and 1,000-seed solvability gates.
- Actual crest screenshot review caught haze-band seams. Replaced seven overlapping strips with 32 contiguous gradient samples. Mid-course visual fixtures now align the scoring cursor with their explicit camera reposition, preventing false rewards for skipped obstacles.

### 2026-10-09 08:44 UTC / 01:44 PDT — rapid-key fix verified, immediate Resume repair

- [Run 37905861033](https://github.com/sidyellur/black-diamond-brawl/actions/runs/37905861033) at `f00dc79`: all model/asset/pacing gates and 13 WebGL smoke checks **passed**. The new same-turn keyboard regression and original strict pause/time/position checks **passed**, verifying the rapid-key fix.
- Acceptance progressed to a new failure: clicking Resume immediately after focus interruption could miss. Independent source reproduction confirmed that Phaser sorts overlapping input objects using the prior frame's render list. An overlay revealed before a new frame let its interactive shade take the press, then the button received a release it did not own.
- Removed input from the purely visual shade and explicitly gated underlying HUD controls during pause. Held touch sources and button ownership are cancelled during transitions so interrupted gestures cannot stick or leak into replay/resume. Added an immediate pause-and-pointer-resume browser regression without waiting for a render.
- Actual new crest screenshots confirm smooth haze with no scanline seams. Pause presentation is visually approved. Final touch/finish screenshots and complete browser acceptance are still pending.

### 2026-10-09 09:00 UTC / 02:00 PDT — complete desktop flow verified; mobile hardening

- [Run 37907162894](https://github.com/sidyellur/black-diamond-brawl/actions/runs/37907162894) at `2bcad4a`: all model gates and 13 WebGL smoke checks **passed**. Real-browser immediate Resume, native blur/focus/Resume, keyboard pause, repeated results/retry, successful finish and record persistence now **pass**.
- The gate then failed a quick portrait steering tap. The 160 ms wall-clock input buffer can expire before the next software-rendered frame; a bounded first-observation allowance is being added without extending already-observed jump forgiveness or stale hit-stop commands. The strict one-tap movement assertion remains.
- Real touch cancellation also exposed Phaser 3.90 calling `preventDefault` on non-cancelable `touchcancel`. Added a narrow guard preserving normal touch capture and original dispatch, with cleanup/idempotency tests; no browser errors are filtered out.
- Modern mobile/finish screenshot review passes portrait presentation and finish/results. Landscape capture caught an unsettled resize, so both rotated screenshot paths now wait for the correct FIT dimensions and verify useful minimum fill, not merely that a tiny canvas fits.
- A geometry-reviewed camera adjustment widens local pack visibility: centered same-depth outer rivals move from entirely off-screen to x≈77/883, while the hero remains ≈97 px tall at y≈461 and jump height stays ≈98 px. Shared rider scaling, physics and collision rules remain coherent. Renderer, combat, controls, scoring, pacing and solvability rechecks pass locally; actual new-framing screenshots remain pending.
- The camera's start offset is derived from its trailing distance. Isolated scoring tests now explicitly set their fixture origin rather than relying on that presentation-dependent default. With the final offset, the same 12-seed model comparison measures nearby-pack time 52.56%→76.64%, flat-camera proximity band 63.84%→68.22%, and natural hits/body checks 28→33; rival wipeouts stay 29/48.
