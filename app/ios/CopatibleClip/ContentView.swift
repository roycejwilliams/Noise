import SwiftUI
import WebKit

struct ContentView: View {
    @State private var url: URL = URL(string: "https://app.copatible.com")!

    var body: some View {
        WebView(url: $url)
            .ignoresSafeArea()
            .onReceive(
                NotificationCenter.default.publisher(for: .openURL)
            ) { notification in
                if let incoming = notification.object as? URL {
                    url = incoming
                }
            }
    }
}

struct WebView: UIViewRepresentable {
    @Binding var url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard webView.url?.absoluteString != url.absoluteString else { return }
        webView.load(URLRequest(url: url))
    }
}
