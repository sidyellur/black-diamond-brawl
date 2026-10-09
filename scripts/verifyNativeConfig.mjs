/** Fast cross-platform guardrails; simulator execution is a separate macOS gate. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = path => readFileSync(path, 'utf8');
const config = JSON.parse(read('capacitor.config.json'));
const pkg = JSON.parse(read('package.json'));
const plist = read('ios/App/App/Info.plist');
const project = read('ios/App/App.xcodeproj/project.pbxproj');
const privacy = read('ios/App/App/PrivacyInfo.xcprivacy');
assert.equal(config.webDir, 'dist');
assert.equal(config.appId, 'com.sidyellur.blackdiamondbrawl');
assert.equal(config.server, undefined, 'shipping app must bundle assets, never point to a live server');
assert.equal(config.ios.contentInset, 'never', 'safe-area CSS owns the single inset');
assert.equal(config.ios.scrollEnabled, false);
assert.equal(pkg.dependencies['@capacitor/core'], pkg.dependencies['@capacitor/ios']);
assert.equal(pkg.dependencies['@capacitor/core'], pkg.devDependencies['@capacitor/cli']);
assert.match(pkg.dependencies['@capacitor/core'], /^8\.\d+\.\d+$/);
assert.match(plist, /UIInterfaceOrientationLandscapeLeft/);
assert.match(plist, /UIInterfaceOrientationLandscapeRight/);
assert.doesNotMatch(plist, /UIInterfaceOrientationPortrait/);
assert.doesNotMatch(plist, /NSAllowsArbitraryLoads|UIBackgroundModes/);
assert.match(project, /TARGETED_DEVICE_FAMILY = "?1"?;/);
assert.match(project, /PrivacyInfo.xcprivacy in Resources/);
assert.match(privacy, /NSPrivacyAccessedAPICategoryUserDefaults/);
assert.match(privacy, /CA92\.1/);
assert.match(privacy, /<key>NSPrivacyTracking<\/key>\s*<false\s*\/>/);
const icon = readFileSync('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
assert.equal(icon.subarray(1, 4).toString(), 'PNG');
assert.equal(icon.readUInt32BE(16), 1024);
assert.equal(icon.readUInt32BE(20), 1024);
assert.equal(icon[25], 2, 'app icon is opaque RGB');
assert.ok(existsSync('assets/app-icon.svg'), 'keep original editable art');
assert.ok(existsSync('dist/index.html'), 'build browser assets first');
const html = read('dist/index.html');
assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//);
for (const [, asset] of html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)) {
  assert.ok(existsSync(`dist/${asset.replace(/^\//, '')}`), `bundled ${asset}`);
}
console.log('PASS native identity, pinned runtime, offline bundle, landscape, privacy and icon guards');
