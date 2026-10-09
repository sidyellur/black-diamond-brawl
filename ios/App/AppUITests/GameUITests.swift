import XCTest
import UIKit

/// Uses the actual installed app, Capacitor bridge and WKWebView. All actions
/// are real XCTest touches/system events; the DEBUG probe is read-only.
final class GameUITests: XCTestCase {
    private var app: XCUIApplication!
    private var status: XCUIElement { app.descendants(matching: .any).matching(identifier: "game.test.status").firstMatch }

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        app = XCUIApplication()
    }

    override func tearDownWithError() throws {
        if app != nil {
            let screenshot = XCTAttachment(data: try screenshotPNG(), uniformTypeIdentifier: "public.png")
            screenshot.name = name
            screenshot.lifetime = .keepAlways
            add(screenshot)
            app.terminate()
        }
    }

    @discardableResult
    private func launch(reset: Bool = true) throws -> [String: Any] {
        app.launchArguments = ["--uitesting"]
        if reset { app.launchArguments += ["--reset-test-data", "--seed-test-records"] }
        app.launch()
        XCTAssertTrue(status.waitForExistence(timeout: 60), "Native test status never appeared; app/WKWebView did not boot")
        return try waitFor("bundled title scene", timeout: 60) { state in
            self.scenes(state).contains("TitleScene") && state["loading"] as? Bool == false &&
            state["titleFadeComplete"] as? Bool == true && self.number(state, "titleSeed") == 202
        }
    }

    private func snapshot() -> [String: Any] {
        guard status.exists,
              let text = status.value as? String,
              let data = text.data(using: .utf8),
              let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return state
    }

    @discardableResult
    private func waitFor(_ description: String, timeout: TimeInterval = 20,
                         _ predicate: @escaping ([String: Any]) -> Bool) throws -> [String: Any] {
        var latest: [String: Any] = [:]
        let condition = NSPredicate { _, _ in
            latest = self.snapshot()
            return predicate(latest)
        }
        let expectation = XCTNSPredicateExpectation(predicate: condition, object: nil)
        let result = XCTWaiter.wait(for: [expectation], timeout: timeout)
        XCTAssertEqual(result, .completed, "Timed out waiting for \(description). Last state: \(latest)")
        return latest
    }

    private func number(_ state: [String: Any], _ key: String) -> Double {
        (state[key] as? NSNumber)?.doubleValue ?? -1
    }

    private func scenes(_ state: [String: Any]) -> [String] { state["scenes"] as? [String] ?? [] }

    /// Game coordinates are 960x540; map through the measured safe-area canvas.
    private func tap(_ x: Double, _ y: Double) throws {
        let state = snapshot()
        let canvas = try XCTUnwrap(state["canvas"] as? [String: Any])
        let webView = app.webViews.firstMatch
        XCTAssertTrue(webView.exists)
        let point = CGVector(dx: number(canvas, "x") + x / 960 * number(canvas, "width"),
                             dy: number(canvas, "y") + y / 540 * number(canvas, "height"))
        webView.coordinate(withNormalizedOffset: .zero).withOffset(point).tap()
    }

    private func assertClean(_ state: [String: Any], file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(state["protocol"] as? String, "capacitor:", file: file, line: line)
        XCTAssertEqual(state["offlineHTTPBlocked"] as? Bool, true, file: file, line: line)
        XCTAssertEqual(state["probeInstalled"] as? Bool, true, file: file, line: line)
        XCTAssertEqual(state["externalResources"] as? [String], [], file: file, line: line)
        XCTAssertEqual(state["errors"] as? [String], [], file: file, line: line)
        XCTAssertNil(state["evaluationError"], file: file, line: line)
    }

    private func assertSafeArea(_ state: [String: Any]) throws {
        let canvas = try XCTUnwrap(state["canvas"] as? [String: Any])
        let container = try XCTUnwrap(state["app"] as? [String: Any])
        let safe = try XCTUnwrap(state["safe"] as? [String: Any])
        let width = number(state, "nativeWidth"), height = number(state, "nativeHeight")
        XCTAssertGreaterThan(width, height, "The iPhone game must stay in landscape")
        XCTAssertGreaterThan(number(canvas, "width"), 400)
        XCTAssertGreaterThan(number(canvas, "height"), 200)
        for box in [canvas, container] {
            XCTAssertGreaterThanOrEqual(number(box, "x"), number(safe, "left") - 2)
            XCTAssertGreaterThanOrEqual(number(box, "y"), number(safe, "top") - 2)
            XCTAssertLessThanOrEqual(number(box, "x") + number(box, "width"), width - number(safe, "right") + 2)
            XCTAssertLessThanOrEqual(number(box, "y") + number(box, "height"), height - number(safe, "bottom") + 2)
        }
        XCTAssertEqual(number(canvas, "width") / number(canvas, "height"), 960.0 / 540.0, accuracy: 0.02)
    }

    /// Application-scoped screenshots can be cropped in the wrong coordinate
    /// space after a landscape transition. Capture the actual screen, then let
    /// UIKit apply its imageOrientation before pixel sampling/portable export.
    private func screenImage(_ capturedState: [String: Any]? = nil) -> UIImage {
        let source = XCUIScreen.main.screenshot().image
        let state = capturedState ?? snapshot()
        let format = UIGraphicsImageRendererFormat()
        format.scale = source.scale
        format.opaque = true
        let normalized = UIGraphicsImageRenderer(size: source.size, format: format).image { _ in
            source.draw(in: CGRect(origin: .zero, size: source.size))
        }
        // Some simulator versions expose the physical portrait framebuffer
        // without EXIF rotation. Use the independently observed scene's actual
        // interface orientation, never a content threshold, for this fallback.
        let landscape = number(state, "nativeWidth") > number(state, "nativeHeight")
        let orientation = state["orientation"] as? String
        if normalized.size.width < normalized.size.height && landscape,
           orientation == "left" || orientation == "right" {
            let size = CGSize(width: normalized.size.height, height: normalized.size.width)
            let angle: CGFloat = orientation == "right" ? -.pi / 2 : .pi / 2
            print("SCREENSHOT physical-framebuffer fallback native=\(orientation!) angle=\(angle)")
            return UIGraphicsImageRenderer(size: size, format: format).image { renderer in
                renderer.cgContext.translateBy(x: size.width / 2, y: size.height / 2)
                renderer.cgContext.rotate(by: angle)
                normalized.draw(in: CGRect(x: -normalized.size.width / 2, y: -normalized.size.height / 2,
                    width: normalized.size.width, height: normalized.size.height))
            }
        }
        print("SCREENSHOT metadata-normalized size=\(normalized.size) sourceOrientation=\(source.imageOrientation.rawValue)")
        return normalized
    }

    private func screenshotPNG() throws -> Data {
        try XCTUnwrap(screenImage().pngData())
    }

    private func assertRenderedCanvas(_ state: [String: Any]) throws {
        let canvas = try XCTUnwrap(state["canvas"] as? [String: Any])
        let cgImage = try XCTUnwrap(screenImage(state).cgImage)
        let width = cgImage.width, height = cgImage.height
        XCTAssertGreaterThan(width, height, "Screenshot must show the full landscape display")
        XCTAssertEqual(Double(width) / Double(height),
                       number(state, "nativeWidth") / number(state, "nativeHeight"), accuracy: 0.02,
                       "Screenshot and actual native viewport must use the same orientation")
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        try pixels.withUnsafeMutableBytes { buffer in
            let context = try XCTUnwrap(CGContext(data: buffer.baseAddress, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        }
        let sx = Double(width) / number(state, "nativeWidth")
        let sy = Double(height) / number(state, "nativeHeight")
        var colors = Set<Int>()
        var lightest = 0, darkest = 255
        // Pixel evidence from the actual displayed WKWebView canvas, not the
        // JS scene flag alone. A solid/blank frame must fail this assertion.
        for gy in 1..<31 {
            for gx in 1..<55 {
                let x = min(width - 1, max(0, Int((number(canvas, "x") + number(canvas, "width") * Double(gx) / 55) * sx)))
                let y = min(height - 1, max(0, Int((number(canvas, "y") + number(canvas, "height") * Double(gy) / 31) * sy)))
                let offset = (y * width + x) * 4
                let r = Int(pixels[offset]), g = Int(pixels[offset + 1]), b = Int(pixels[offset + 2])
                colors.insert((r / 16) * 256 + (g / 16) * 16 + b / 16)
                let luminance = (r * 21 + g * 72 + b * 7) / 100
                lightest = max(lightest, luminance)
                darkest = min(darkest, luminance)
            }
        }
        XCTAssertGreaterThan(colors.count, 20, "Canvas screenshot is blank or lacks game artwork")
        XCTAssertGreaterThan(lightest - darkest, 60, "Canvas screenshot has no readable artwork contrast")
    }

    func testOfflineBundledBootAndBothLandscapeSafeAreas() throws {
        var state = try launch()
        assertClean(state)
        try assertSafeArea(state)
        let firstFrame = number(state, "frame")
        state = try waitFor("rendered frames") { self.number($0, "frame") > firstFrame + 5 }
        try assertRenderedCanvas(state)
        XCTAssertTrue((state["texts"] as? [String] ?? []).contains("4,321"), "Native records must hydrate before title rendering")
        for orientation in [UIDeviceOrientation.landscapeRight, .landscapeLeft] {
            let sample = number(snapshot(), "sample")
            XCUIDevice.shared.orientation = orientation
            // Wait for rotation and CSS env()/ResizeObserver to settle.
            Thread.sleep(forTimeInterval: 1)
            let expectedOrientation = orientation == .landscapeRight ? "left" : "right"
            state = try waitFor("fresh rotated viewport") {
                self.number($0, "sample") > sample + 3 && $0["orientation"] as? String == expectedOrientation
            }
            try assertSafeArea(state)
            assertClean(state)
            let screenshot = XCTAttachment(data: try screenshotPNG(), uniformTypeIdentifier: "public.png")
            screenshot.name = orientation == .landscapeRight ? "landscape-right" : "landscape-left"
            screenshot.lifetime = .keepAlways
            add(screenshot)
        }
        // Verify a real pointer-up menu action changes the displayed course.
        let oldSeed = number(state, "titleSeed")
        try tap(420, 351)
        state = try waitFor("New Mountain touch") { self.number($0, "titleSeed") != oldSeed }
        XCTAssertTrue(scenes(state).contains("TitleScene"))
        assertClean(state)
    }

    func testTouchControlsAndBackgroundStayPausedUntilResume() throws {
        _ = try launch()
        try tap(180, 351) // Drop In.
        var state = try waitFor("race start", timeout: 60) {
            self.scenes($0).contains("RaceScene") && self.number($0, "elapsedMs") > 100
        }
        let lane = number(state, "lane")
        try tap(58, 497) // Left touch control.
        _ = try waitFor("touch steering") { self.number($0, "lane") < lane }
        try tap(902, 77) // Pause.
        state = try waitFor("pause button") { $0["paused"] as? Bool == true }
        let pausedAt = number(state, "elapsedMs")
        let pausedLane = number(state, "lane")
        try tap(142, 497) // Gameplay control cannot act through pause overlay.
        Thread.sleep(forTimeInterval: 1)
        state = snapshot()
        XCTAssertEqual(number(state, "elapsedMs"), pausedAt, accuracy: 0.01)
        XCTAssertEqual(number(state, "lane"), pausedLane)
        try tap(480, 267) // Explicit Resume.
        _ = try waitFor("explicit resume") {
            $0["paused"] as? Bool == false && self.number($0, "elapsedMs") > pausedAt
        }

        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
        Thread.sleep(forTimeInterval: 1)
        app.activate()
        state = try waitFor("foreground remains paused") {
            $0["nativeActive"] as? Bool == true && $0["paused"] as? Bool == true
        }
        let foregroundAt = number(state, "elapsedMs")
        let sample = number(state, "sample")
        Thread.sleep(forTimeInterval: 1)
        state = try waitFor("fresh foreground sample") { self.number($0, "sample") > sample + 2 }
        XCTAssertEqual(number(state, "elapsedMs"), foregroundAt, accuracy: 0.01)
        XCTAssertNotEqual(state["audioState"] as? String, "running", "Returning to foreground must not resume audio")
        try tap(480, 267)
        state = try waitFor("user resumes after interruption") {
            $0["paused"] as? Bool == false && self.number($0, "elapsedMs") > foregroundAt
        }
        assertClean(state)
    }

    func testNativePreferencesSurviveProcessRestart() throws {
        var state = try launch()
        let initialRecords = try XCTUnwrap(state["nativeRecords"] as? String)
        XCTAssertTrue((state["texts"] as? [String] ?? []).contains("4,321"))
        XCTAssertTrue((state["texts"] as? [String] ?? []).contains { $0.contains("Mountain best 1,234") })
        try tap(180, 351)
        _ = try waitFor("race scene") { self.scenes($0).contains("RaceScene") }
        try tap(687, 30) // Actual mute control writes through the native plugin.
        state = try waitFor("native Preferences write") {
            $0["nativeMuted"] as? String == "1" && $0["audioMuted"] as? Bool == true
        }
        assertClean(state)
        // Background allows the normal flush hook to run before OS termination.
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
        app.terminate()
        state = try launch(reset: false)
        XCTAssertEqual(state["nativeMuted"] as? String, "1")
        XCTAssertEqual(state["nativeRecords"] as? String, initialRecords)
        XCTAssertTrue((state["texts"] as? [String] ?? []).contains("4,321"))
        try tap(180, 351)
        state = try waitFor("muted state hydrated after restart") {
            self.scenes($0).contains("RaceScene") && $0["audioMuted"] as? Bool == true
        }
        assertClean(state)
    }
}
