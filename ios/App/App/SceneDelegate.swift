import UIKit
import Capacitor
import WebKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--uitesting") {
            prepareSimulatorTests()
        } else {
            showGame()
        }
        #else
        showGame()
        #endif

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    private func showGame() {
        window?.rootViewController = GameViewController()
        window?.makeKeyAndVisible()
    }

    #if DEBUG
    private func prepareSimulatorTests() {
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--reset-test-data") {
            // Isolated simulator installation, never enabled by ordinary launch.
            UserDefaults.standard.removeObject(forKey: "CapacitorStorage.bdb-muted")
            UserDefaults.standard.removeObject(forKey: "CapacitorStorage.black-diamond-brawl:records:v1")
            for key in ["records:v2", "career:v1", "ghosts:v1"] {
                UserDefaults.standard.removeObject(forKey: "CapacitorStorage.black-diamond-brawl:" + key)
            }
        }
        if arguments.contains("--seed-test-records") {
            // Hydration fixture, deliberately separate from gameplay write tests.
            UserDefaults.standard.set("0", forKey: "CapacitorStorage.bdb-muted")
            UserDefaults.standard.set(
                "{\"bestScore\":4321,\"courses\":{\"202\":{\"bestScore\":1234,\"bestTimeSeconds\":42.5,\"attempts\":3,\"lastPlayed\":1700000000000}}}",
                forKey: "CapacitorStorage.black-diamond-brawl:records:v1")
            UserDefaults.standard.set(
                "{\"version\":2,\"rulesVersion\":\"fixed60-v2\",\"courseVersion\":\"mountain-v2\",\"bestScore\":4321,\"courses\":{\"fixed60-v2/mountain-v2/202\":{\"bestScore\":1234,\"bestTimeSeconds\":42.5,\"attempts\":3,\"lastPlayed\":1700000000000}},\"receipts\":[]}",
                forKey: "CapacitorStorage.black-diamond-brawl:records:v2")
        }
        // Block HTTP(S) inside WKWebView BEFORE its first navigation. This
        // verifies bundled/offline boot without changing host network settings.
        let rules = "[{\"trigger\":{\"url-filter\":\"^https?://\"},\"action\":{\"type\":\"block\"}}]"
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "BlackDiamondBrawlOfflineUITest", encodedContentRuleList: rules
        ) { [weak self] ruleList, error in
            guard let self = self else { return }
            let controller = GameViewController()
            controller.simulatorTestRules = ruleList
            // A compile failure is surfaced to XCTest as offlineHTTPBlocked=false.
            self.window?.rootViewController = controller
            self.window?.makeKeyAndVisible()
        }
    }
    #endif

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
