#!/usr/bin/env bash
# macOS/Xcode 26+ only. Builds unsigned simulator binaries, then boots and tests
# the real installed app. No Apple ID, distribution certificate or paid account.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != Darwin ]]; then
  echo "iOS simulator verification requires macOS and Xcode 26+. Use the iOS simulator GitHub Actions job." >&2
  exit 1
fi
command -v xcodebuild >/dev/null
command -v xcrun >/dev/null
MAJOR="$(xcodebuild -version | awk '/Xcode/{split($2,v,"."); print v[1]}')"
if [[ -z "$MAJOR" || "$MAJOR" -lt 26 ]]; then
  echo "Capacitor 8 requires Xcode 26+. Select a supported DEVELOPER_DIR." >&2
  exit 1
fi

OUT="$PWD/.verify/ios"
DERIVED="$OUT/DerivedData"
mkdir -p "$OUT"
xcodebuild -version | tee "$OUT/xcode-version.txt"
xcrun simctl list devices available -j > "$OUT/available-simulators.json"

# Pick a currently installed iPhone on the newest installed iOS runtime. Prefer
# a standard notched/home-indicator model so safe-area checks are meaningful.
SIMULATOR_ID="${IOS_SIMULATOR_ID:-$(python3 - "$OUT/available-simulators.json" <<'PY'
import json,re,sys
rows=[]
for runtime,devices in json.load(open(sys.argv[1]))['devices'].items():
    if '.iOS-' not in runtime: continue
    version=tuple(map(int,re.findall(r'\d+',runtime.split('.iOS-')[-1])))
    for d in devices:
        if d.get('isAvailable') and d['name'].startswith('iPhone'):
            # Prefer regular iPhone 16/17 over SE and oversized Pro Max devices.
            normal=bool(re.fullmatch(r'iPhone (1[4-9]|[2-9]\d)',d['name']))
            rows.append((version,normal,d['name'],d['udid']))
if not rows: sys.exit('No available iPhone simulator. Install an iOS runtime in Xcode settings.')
print(sorted(rows,reverse=True)[0][-1])
PY
)}"
# Validate explicit overrides too; never silently substitute another device.
python3 - "$OUT/available-simulators.json" "$SIMULATOR_ID" <<'PY'
import json,sys
matches=[d for runtime,rows in json.load(open(sys.argv[1]))['devices'].items()
         if '.iOS-' in runtime for d in rows if d['udid']==sys.argv[2]
         and d.get('isAvailable') and d['name'].startswith('iPhone')]
if not matches: sys.exit('IOS_SIMULATOR_ID must identify an installed, available iPhone simulator.')
print('Selected iPhone:',matches[0]['name'],matches[0]['udid'])
PY
printf '%s\n' "$SIMULATOR_ID" > "$OUT/simulator-id.txt"

cleanup() {
  xcrun simctl io "$SIMULATOR_ID" screenshot "$OUT/final-simulator.png" >/dev/null 2>&1 || true
  xcrun simctl spawn "$SIMULATOR_ID" log show --last 10m --style compact --predicate 'process == "App"' > "$OUT/app-system.log" 2>&1 || true
}
trap cleanup EXIT

# Build web assets and copy the complete production bundle into the native app.
# cap sync also restores local SPM plugin paths after npm ci.
npm run build
npx cap sync ios

# Use a single real simulator throughout. Bootstatus reports a boot failure;
# the boot command can harmlessly fail when the selected device is already on.
xcrun simctl boot "$SIMULATOR_ID" 2>/dev/null || true
xcrun simctl bootstatus "$SIMULATOR_ID" -b
DESTINATION="platform=iOS Simulator,id=$SIMULATOR_ID"
PROJECT="ios/App/App.xcodeproj"
COMMON=(-project "$PROJECT" -scheme App -destination "$DESTINATION" -destination-timeout 120
        -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO)

# A separate Release build ensures the shipping configuration compiles without
# the DEBUG-only XCTest probe. Build/test commands both fail the gate on errors.
xcodebuild "${COMMON[@]}" -configuration Release build 2>&1 | tee "$OUT/release-build.log"
APP="$DERIVED/Build/Products/Release-iphonesimulator/App.app"
[[ -d "$APP" && -s "$APP/App" && -s "$APP/public/index.html" && -s "$APP/PrivacyInfo.xcprivacy" ]] || {
  echo "Release .app or required bundled assets are missing." >&2; exit 1;
}
# Bundled index must resolve real local JS; a successful shell build is not enough.
python3 - "$APP" <<'PY'
from pathlib import Path
import json,re,sys
app=Path(sys.argv[1]); index=(app/'public/index.html').read_text()
scripts=re.findall(r'<script\b[^>]*\bsrc=["\']([^"\']+)',index)
if not scripts: sys.exit('No bundled JavaScript in app/public/index.html')
for src in scripts:
    if '://' in src: sys.exit('Remote JavaScript is not an offline app bundle: '+src)
    if not (app/'public'/src.lstrip('/')).is_file(): sys.exit('Missing bundled JavaScript: '+src)
config=json.loads((app/'capacitor.config.json').read_text())
if config.get('server',{}).get('url'): sys.exit('Remote dev server URL must never ship')
PY
strings "$APP/App" > "$OUT/release-binary-strings.txt"
if grep -q 'game.test.status' "$OUT/release-binary-strings.txt"; then
  echo 'Release binary unexpectedly contains the DEBUG-only test probe.' >&2
  exit 1
fi
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")
[[ "$BUNDLE_ID" == com.sidyellur.blackdiamondbrawl ]]
xcrun simctl install "$SIMULATOR_ID" "$APP"
xcrun simctl launch --terminate-running-process "$SIMULATOR_ID" "$BUNDLE_ID" | tee "$OUT/release-launch.txt"
APP_PID="$(sed -nE 's/.*: ([0-9]+)$/\1/p' "$OUT/release-launch.txt")"
[[ -n "$APP_PID" ]] || { echo 'Simulator did not return an application PID.' >&2; exit 1; }
sleep 3
xcrun simctl spawn "$SIMULATOR_ID" launchctl list > "$OUT/launchctl.txt"
awk -v pid="$APP_PID" '$1 == pid { found=1 } END { exit !found }' "$OUT/launchctl.txt" || {
  echo "Release app process $APP_PID exited immediately after launch." >&2; exit 1;
}
xcrun simctl io "$SIMULATOR_ID" screenshot "$OUT/release-launched.png"
xcrun simctl terminate "$SIMULATOR_ID" "$BUNDLE_ID"

# Never reuse a stale result bundle after a local rerun.
RESULT="$OUT/GameUITests-$(date -u +%Y%m%dT%H%M%SZ).xcresult"
xcodebuild "${COMMON[@]}" -configuration Debug test \
  -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 \
  -maximum-test-execution-time-allowance 180 -test-timeouts-enabled YES \
  -resultBundlePath "$RESULT" 2>&1 | tee "$OUT/ui-tests.log"

# Keep a compact, readily downloadable unsigned simulator app. This is NOT an
# IPA, cannot install on a physical iPhone, and contains no signing credentials.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/BlackDiamondBrawl-simulator.zip"
printf '%s\n' 'PASS: Release simulator build/launch and real WKWebView UI tests.' \
  'Simulator-only evidence. Physical-iPhone performance, audio output, interruptions and signing still require device QA.' \
  | tee "$OUT/result.txt"
