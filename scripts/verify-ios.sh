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
  # Capture the build/test pipeline status BEFORE any diagnostic command. The
  # EXIT trap runs even when xcodebuild fails under set -e + pipefail.
  local status=$?
  local evidence_failed=0
  local attachments=""
  trap - EXIT
  if [[ -n "${RESULT:-}" && -d "$RESULT" ]]; then
    # A new directory per invocation prevents old local screenshots from
    # satisfying this run's evidence gate. Preserve prior runs for inspection.
    if mkdir -p "$OUT/attachments" && attachments="$(mktemp -d "$OUT/attachments/$(basename "$RESULT" .xcresult).XXXXXX")"; then
      if ! printf 'attachments/%s\n' "$(basename "$attachments")" > "$OUT/current-attachments.txt"; then
        evidence_failed=1
      fi
      # Xcode 16+ non-legacy export; no --only-failures, so passing screenshots
      # are retained too. XCTest explicitly stores portable PNG attachments.
      xcrun xcresulttool help export attachments > "$OUT/attachment-export-help.txt" 2>&1 || true
      if ! xcrun xcresulttool export attachments --path "$RESULT" \
        --output-path "$attachments" > "$OUT/attachment-export.log" 2>&1; then
        echo 'Could not export XCTest attachments; see attachment-export.log.' >&2
        evidence_failed=1
      elif [[ "$status" -eq 0 ]]; then
        # This suite retains five screenshots on success: three test endings
        # plus both landscape views. Validate this fresh export, never a glob
        # over previous runs. Preserve the exporter's manifest for named review
        # rather than relying on an undocumented manifest-field schema.
        if ! python3 - "$attachments" >> "$OUT/attachment-export.log" 2>&1 <<'PYTHON'
from pathlib import Path
import struct, sys
root = Path(sys.argv[1])
pngs = list(root.rglob('*.png'))
if len(pngs) < 5:
    sys.exit(f'Expected at least five current-run XCTest PNGs, found {len(pngs)}')
for path in pngs:
    with path.open('rb') as image:
        header = image.read(24)
    if len(header) < 24 or header[:8] != b'\x89PNG\r\n\x1a\n' or header[12:16] != b'IHDR':
        sys.exit(f'Invalid PNG attachment: {path.name}')
    if not all(struct.unpack('>II', header[16:24])):
        sys.exit(f'Empty PNG attachment: {path.name}')
print(f'PASS: {len(pngs)} portable PNG attachments exported for this run.')
PYTHON
        then
          echo 'Missing or invalid current-run XCTest screenshots; see attachment-export.log.' >&2
          evidence_failed=1
        fi
      fi
    else
      echo 'Could not create a fresh XCTest attachment directory.' >&2
      evidence_failed=1
    fi
  else
    echo 'No current XCTest result bundle was produced.' >&2
    evidence_failed=1
  fi
  # Never replace an existing build/test failure with export success or a
  # different diagnostic exit code. A successful test still needs evidence.
  if [[ "$status" -eq 0 && "$evidence_failed" -ne 0 ]]; then
    echo 'FAIL: XCTest evidence is missing or could not be exported.' >> "$OUT/result.txt"
    status=1
  fi
  xcrun simctl io "$SIMULATOR_ID" screenshot "$OUT/final-simulator.png" >/dev/null 2>&1 || true
  xcrun simctl spawn "$SIMULATOR_ID" log show --last 10m --style compact --predicate 'process == "App"' > "$OUT/app-system.log" 2>&1 || true
  exit "$status"
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
# Cold simulator startup can take tens of seconds. Keep the Release app alive
# until actual game artwork appears, instead of capturing/terminating at 3s.
xcrun swiftc scripts/check-ios-screenshot.swift -o "$OUT/check-ios-screenshot"
release_ready=0
release_deadline=$((SECONDS + 120))
while [[ "$SECONDS" -lt "$release_deadline" ]]; do
  xcrun simctl io "$SIMULATOR_ID" screenshot "$OUT/release-launched.png" >/dev/null 2>&1
  if "$OUT/check-ios-screenshot" "$OUT/release-launched.png" > "$OUT/release-rendering.txt" 2>&1; then
    release_ready=1
    break
  fi
  sleep 2
done
[[ "$release_ready" -eq 1 ]] || {
  cat "$OUT/release-rendering.txt" >&2
  echo 'Release app never rendered a landscape game title within 120s.' >&2
  exit 1
}
xcrun simctl spawn "$SIMULATOR_ID" launchctl list > "$OUT/launchctl.txt"
awk -v pid="$APP_PID" '$1 == pid { found=1 } END { exit !found }' "$OUT/launchctl.txt" || {
  echo "Release app process $APP_PID exited immediately after launch." >&2; exit 1;
}
# Retain the exact screenshot that passed the Release rendering assertion.
xcrun simctl terminate "$SIMULATOR_ID" "$BUNDLE_ID"

# Compile the Debug app/runner first, then prewarm the real app outside XCTest's
# shorter first-launch background-assertion timeout. This is a checked preflight,
# not a swallowed test failure or an unbounded test retry.
xcodebuild "${COMMON[@]}" -configuration Debug build-for-testing 2>&1 | tee "$OUT/debug-build.log"
DEBUG_APP="$DERIVED/Build/Products/Debug-iphonesimulator/App.app"
xcrun simctl install "$SIMULATOR_ID" "$DEBUG_APP"
xcrun simctl launch --terminate-running-process "$SIMULATOR_ID" "$BUNDLE_ID" \
  --uitesting --uitest-prewarm --reset-test-data --seed-test-records | tee "$OUT/debug-prewarm-launch.txt"
PREWARM_PID="$(sed -nE 's/.*: ([0-9]+)$/\1/p' "$OUT/debug-prewarm-launch.txt")"
[[ -n "$PREWARM_PID" ]] || { echo 'Debug preflight did not launch.' >&2; exit 1; }
APP_DATA="$(xcrun simctl get_app_container "$SIMULATOR_ID" "$BUNDLE_ID" data)"
PREWARM_JSON="$APP_DATA/Library/Caches/bdb-uitest-prewarm-$PREWARM_PID.json"
prewarm_ready=0
prewarm_deadline=$((SECONDS + 120))
while [[ "$SECONDS" -lt "$prewarm_deadline" ]]; do
  if python3 - "$PREWARM_JSON" > "$OUT/debug-prewarm-status.txt" 2>&1 <<'PY'
from pathlib import Path
import json, sys
path = Path(sys.argv[1])
if not path.is_file(): sys.exit('Waiting for first real WKWebView status')
state = json.loads(path.read_text())
ready = (state.get('nativeActive') and state.get('probeInstalled') and state.get('offlineHTTPBlocked')
         and state.get('titleSeed') == 202 and state.get('titleFadeComplete')
         and not state.get('loading') and state.get('frame', 0) >= 10
         and state.get('nativeWidth', 0) > state.get('nativeHeight', 0)
         and not state.get('errors') and not state.get('externalResources')
         and state.get('protocol') == 'capacitor:')
print(json.dumps(state, indent=2))
sys.exit(0 if ready else 1)
PY
  then
    prewarm_ready=1
    cp "$PREWARM_JSON" "$OUT/debug-prewarm-ready.json"
    break
  fi
  sleep 2
done
[[ "$prewarm_ready" -eq 1 ]] || {
  cat "$OUT/debug-prewarm-status.txt" >&2
  echo 'Debug WKWebView preflight never reached a clean, offline title within 120s.' >&2
  exit 1
}
xcrun simctl io "$SIMULATOR_ID" screenshot "$OUT/debug-prewarm.png"
xcrun simctl terminate "$SIMULATOR_ID" "$BUNDLE_ID"

# Never reuse a stale result bundle after a local rerun.
RESULT="$OUT/GameUITests-$(date -u +%Y%m%dT%H%M%SZ).xcresult"
xcodebuild "${COMMON[@]}" -configuration Debug test-without-building \
  -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 \
  -maximum-test-execution-time-allowance 180 -test-timeouts-enabled YES \
  -resultBundlePath "$RESULT" 2>&1 | tee "$OUT/ui-tests.log"

# Keep a compact, readily downloadable unsigned simulator app. This is NOT an
# IPA, cannot install on a physical iPhone, and contains no signing credentials.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/BlackDiamondBrawl-simulator.zip"
printf '%s\n' 'PASS: Release simulator build/launch and real WKWebView UI tests.' \
  'Simulator-only evidence. Physical-iPhone performance, audio output, interruptions and signing still require device QA.' \
  | tee "$OUT/result.txt"
