import SwiftUI
import AppKit

/// Grabs the hosting NSWindow once so we can set AppKit-level flags
/// SwiftUI doesn't expose (native tab behavior).
struct WindowAccessor: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            view.window?.tabbingMode = .preferred
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}
