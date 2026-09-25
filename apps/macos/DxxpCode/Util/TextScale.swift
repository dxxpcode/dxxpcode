import Foundation
import Observation

/// Global transcript text scale, driven by ⌘+/⌘−/⌘0.
@Observable
@MainActor
final class TextScale {
    static let shared = TextScale()
    var factor: Double = 1.0

    static func increase() { shared.factor = min(2.0, shared.factor * 1.1) }
    static func decrease() { shared.factor = max(0.7, shared.factor / 1.1) }
    static func reset() { shared.factor = 1.0 }
}
