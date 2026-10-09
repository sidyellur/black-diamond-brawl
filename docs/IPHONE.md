# Play on iPhone, keep playing in the browser

Black Diamond Brawl uses one Phaser game for both versions. The native iPhone
shell is Capacitor + WKWebView, with all game code, art, and procedural audio
bundled inside the app. It does not require a website, server, account, analytics,
or an Internet connection to play after installation.

## Browser

The original commands still work:

```sh
npm ci
npm run dev
# or: npm run build && npm run preview
```

Browser records stay in that browser. Installing the native app starts a
separate local record book; there is no account sync or automatic import.
The browser supports portrait with a rotation hint as well as landscape.

## Open the iPhone app

Requirements: Node 22 or newer, a Mac with **Xcode 26 or newer**, and an installed
iOS Simulator runtime. The iPhone deployment target is **iOS 15.0**. The first
build requires Internet access to install npm and Swift packages. Dependencies
are locked; native packages use Swift Package Manager, so CocoaPods is unnecessary.

```sh
npm ci
npm run ios:open
```

This builds the game, copies `dist/` into the native app, syncs plugins, and
opens `ios/App/App.xcodeproj`. Select the **App** scheme and an **iPhone simulator**,
then press Run. Alternatively:

```sh
npm run ios:run
```

Always run `npm run ios:sync` after changing game code or installing a plugin.
Opening Xcode alone does not refresh the bundled game. The generated `public/`
and native Capacitor configuration are intentionally not committed; the native
project, lockfile, original app icon, launch screen, and privacy manifest are.
Never configure `server.url` in the shipping configuration: that would replace
the offline bundle with a hosted website.

The app identifier is `com.sidyellur.blackdiamondbrawl`. This is a development
identity, not a claim that an App Store listing or signing registration exists.
The initial native target supports iPhone in either landscape direction; iPad
support is not part of this prototype.

## Phone behavior

- The whole game canvas fits inside the notch and home-indicator safe area, so
  HUD buttons and carving/jump/hit targets use the same safe coordinate system.
- App switching, screen locking, Control Center, and browser page interruptions
  cancel held controls and pause a race. Returning does **not** auto-resume it.
- Tap **Resume** to continue. Sound unlock/recovery happens on an intentional
  gesture, including recovery from Safari's interrupted audio state.
- Personal bests, records for the last 64 mountains, the latest 8 personal ghosts,
  cup standings/medals, cosmetic unlocks/equipment and mute preference use native
  Preferences/UserDefaults. Browser play retains localStorage. Old v1 records
  remain stored separately from current fixed60-v2/mountain-v2 competition.
- Native storage is hydrated before menus appear, and writes are ordered to
  prevent older saves replacing newer ones. Unavailable storage leaves the
  game playable in memory. Deleting the app deletes its local progress.
- A race in progress is not saved across process termination. Completed
  results, cup progress and preferences are saved; relaunch returns to the lodge.
  Resume Cup restarts the unplayed round, preserving completed standings.

## Automated verification

```sh
npx playwright install --with-deps chromium webkit
npm run verify
```

This preserves the full build, art, game-model, seeded-solvability, Chromium
smoke and input/replay checks. It adds native configuration/storage/lifecycle
guards and WebKit mobile coverage for safe-area fit, touch, interruption,
explicit resume, offline replay, and mute persistence. Expansion coverage adds
practice, cup/locker, daily sharing, ghost/splits and new native mode routes.

On a Mac, `npm run verify:ios` runs the same simulator gate used in CI.
Set `IOS_SIMULATOR_ID` to choose an installed iPhone explicitly.

The iOS GitHub Actions workflow uses a standard hosted macOS runner. It builds
and runs an unsigned simulator app, exercises the actual native WKWebView and
plugin bridge, and uploads logs/results/screenshots. It does not provision a
device or use distribution certificates. See the workflow and its verifier
script for the exact current invocation and assertions.

## Physical iPhone and distribution checklist

Simulator/WebKit checks cannot establish real phone performance, touch feel,
battery cost, audio routing, silent-switch behavior, phone-call interruptions,
or App Store acceptance. Before wider distribution:

- Run on a real iPhone, ideally including a small supported screen and a
  notched/Dynamic Island model. Test both landscape directions.
- Check simultaneous carve + jump/hit, canceled swipes, system edge gestures,
  Control Center, phone/audio interruptions, lock/unlock, repeated resume,
  force-quit/relaunch, and airplane-mode cold launch.
- Play full races for frame pacing, heat/battery, legibility, thumb comfort,
  speaker/headphones/Bluetooth audio, and mute persistence.
- Choose the final bundle ID, signing team, distribution method, versioning,
  age rating, support/privacy links, store artwork, and release metadata.
- Review the privacy manifest and store disclosures against the final shipped
  dependencies. Current code collects no analytics and sends no gameplay data.
  UserDefaults is declared with Apple's app-only reason `CA92.1`.
- Device installation requires your signing setup in Xcode. TestFlight/App Store
  distribution requires the appropriate Apple Developer membership and separate
  approval to submit. No membership, purchase, signing secret, or submission is
  configured by this project.

## Sources

- [Capacitor games / Phaser](https://capacitorjs.com/docs/guides/games)
- [iOS support and Xcode requirements](https://capacitorjs.com/docs/ios)
- [Swift Package Manager workflow](https://capacitorjs.com/docs/ios/spm)
- [Native lifecycle events](https://capacitorjs.com/docs/apis/app)
- [Preferences and privacy-manifest requirements](https://capacitorjs.com/docs/apis/preferences)
- [Implementation plan](https://github.com/sidyellur/black-diamond-brawl/issues/22)
