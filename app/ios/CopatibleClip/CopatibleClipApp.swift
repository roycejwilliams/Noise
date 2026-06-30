import SwiftUI

@main
struct CopatibleClipApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    guard let url = activity.webpageURL else { return }
                    NotificationCenter.default.post(name: .openURL, object: url)
                }
        }
    }
}

extension Notification.Name {
    static let openURL = Notification.Name("openURL")
}
