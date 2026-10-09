import Capacitor
import UIKit
import WebKit

/// The production host stays small: the game owns its safe-area layout.
final class GameViewController: CAPBridgeViewController {
    override var prefersStatusBarHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    #if DEBUG
    // Entirely absent from Release builds. Activated only by the XCTest process
    // launch argument, with no URL switch, remote endpoint, or JS command API.
    var simulatorTestRules: WKContentRuleList?
    private var testStatus: UIView?
    private var testTimer: Timer?
    private var testEvaluationPending = false
    private var testSample = 0
    private var isSimulatorTest: Bool {
        ProcessInfo.processInfo.arguments.contains("--uitesting")
    }

    private var testRulesInstalled = false

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard isSimulatorTest, let content = webView?.configuration.userContentController else { return }
        // Capacitor replaces webViewConfiguration.userContentController during
        // prepareWebView. Install on the FINAL controller, after bridge setup
        // but before viewDidLoad starts the first navigation.
        if let rules = simulatorTestRules {
            content.add(rules)
            testRulesInstalled = true
        }
        content.addUserScript(WKUserScript(source: """
            window.__nativeTestErrors = [];
            window.addEventListener('error', e => window.__nativeTestErrors.push(String(e.message)));
            window.addEventListener('unhandledrejection', e => window.__nativeTestErrors.push(String(e.reason)));
            // Fixed course fixture; gameplay/input and its save path are unmodified.
            history.replaceState(null, '', '?seed=202');
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard isSimulatorTest, testStatus == nil else { return }
        let status = UIView()
        status.isAccessibilityElement = true
        status.accessibilityIdentifier = "game.test.status"
        status.accessibilityLabel = "Read-only game test status"
        status.accessibilityValue = "{}"
        status.isUserInteractionEnabled = false
        status.backgroundColor = .clear
        view.addSubview(status)
        testStatus = status
        layoutTestStatus()
        testTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            self?.sampleTestStatus()
        }
        sampleTestStatus()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutTestStatus()
    }

    private func layoutTestStatus() {
        testStatus?.frame = CGRect(x: view.safeAreaInsets.left + 2,
                                  y: view.safeAreaInsets.top + 2, width: 2, height: 2)
    }

    private func sampleTestStatus() {
        guard !testEvaluationPending, let webView = webView else { return }
        testEvaluationPending = true
        webView.evaluateJavaScript(Self.snapshotScript) { [weak self] value, error in
            guard let self = self else { return }
            self.testEvaluationPending = false
            var state = value as? [String: Any] ?? [:]
            if let error = error { state["evaluationError"] = error.localizedDescription }
            self.testSample += 1
            state["sample"] = self.testSample
            state["offlineHTTPBlocked"] = self.testRulesInstalled
            state["nativeActive"] = self.view.window?.windowScene?.activationState == .foregroundActive
            state["nativeWidth"] = self.view.bounds.width
            state["nativeHeight"] = self.view.bounds.height
            state["orientation"] = self.view.window?.windowScene?.interfaceOrientation == .landscapeLeft ? "left" : "right"
            let safe = self.view.safeAreaInsets
            state["safe"] = ["left": safe.left, "top": safe.top, "right": safe.right, "bottom": safe.bottom]
            state["nativeMuted"] = UserDefaults.standard.string(forKey: "CapacitorStorage.bdb-muted") ?? ""
            state["nativeRecords"] = UserDefaults.standard.string(forKey: "CapacitorStorage.black-diamond-brawl:records:v2") ?? ""
            state["nativeCareer"] = UserDefaults.standard.string(forKey: "CapacitorStorage.black-diamond-brawl:career:v1") ?? ""
            if let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]),
               let json = String(data: data, encoding: .utf8) {
                self.testStatus?.accessibilityValue = json
                if ProcessInfo.processInfo.arguments.contains("--uitest-prewarm"),
                   let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
                    // Readiness evidence for the CI preflight only. Normal Debug
                    // and XCTest launches never write this file; Release omits it.
                    let file = cache.appendingPathComponent("bdb-uitest-prewarm-\(ProcessInfo.processInfo.processIdentifier).json")
                    try? data.write(to: file, options: .atomic)
                }
            }
        }
    }

    private static let snapshotScript = """
        (() => {
          const game = window.__game;
          const race = game?.scene.getScene('RaceScene');
          const title = game?.scene.getScene('TitleScene');
          const canvas = document.querySelector('canvas');
          const box = element => {
            const r = element?.getBoundingClientRect();
            return r ? { x:r.x, y:r.y, width:r.width, height:r.height } : null;
          };
          const texts = objects => (objects || []).flatMap(o =>
            o.type === 'Text' ? [o.text] : o.list ? texts(o.list) : []);
          return {
            href: location.href, protocol: location.protocol,
            scenes: game?.scene.getScenes(true).map(s => s.scene.key) || [],
            titleSeed: title?.seed ?? null,
            titleFadeComplete: !!title && !title.cameras?.main?.fadeEffect?.isRunning,
            probeInstalled: Array.isArray(window.__nativeTestErrors),
            texts: game?.scene.getScenes(true).flatMap(s => texts(s.children.list)) || [],
            canvas: box(canvas), app: box(document.getElementById('app')),
            loading: !!document.getElementById('loading'),
            frame: game?.loop.frame ?? 0,
            raceMode: race?.options?.mode ?? null,
            raceSeed: race?.seed ?? null,
            practiceLesson: race?.practiceLesson ?? null,
            paused: race?.paused ?? false, countdownMs: race?.countdownMs ?? 0,
            elapsedMs: race?.elapsedRaceMs ?? 0, lane: race?.player?.laneIndex ?? -1,
            speed: race?.player?.speed ?? 0,
            audioState: race?.audio?.context?.state ?? 'uncreated',
            audioMuted: race?.audio?.isMuted ?? false,
            errors: window.__nativeTestErrors || [],
            externalResources: performance.getEntriesByType('resource')
              .filter(r => /^https?:/.test(r.name)).map(r => r.name)
          };
        })()
        """

    deinit { testTimer?.invalidate() }
    #endif
}
