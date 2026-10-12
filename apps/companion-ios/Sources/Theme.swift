import SwiftUI
import UIKit

// Design tokens mirrored from apps/desktop/src/styles.css — the iOS app is
// the same product in a native body: near-white light, pure-black dark,
// hairline borders, faint secondary text, mono accents.
extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: alpha
        )
    }

    static func dx(light: UInt32, dark: UInt32) -> UIColor {
        UIColor { t in
            UIColor(hex: t.userInterfaceStyle == .dark ? dark : light)
        }
    }
}

extension Color {
    static let dxBg = Color(UIColor.dx(light: 0xf7f7f8, dark: 0x000000))
    static let dxSurface = Color(UIColor.dx(light: 0xffffff, dark: 0x0d0d0f))
    static let dxSurface2 = Color(UIColor.dx(light: 0xf4f4f6, dark: 0x17171a))
    static let dxBorder = Color(UIColor.dx(light: 0xe7e7ea, dark: 0x26262a))
    static let dxText = Color(UIColor.dx(light: 0x0a0a0b, dark: 0xf5f5f6))
    static let dxFaint = Color(UIColor.dx(light: 0x9b9ba3, dark: 0x6b6b73))
    static let dxRed = Color(UIColor.dx(light: 0xdc2626, dark: 0xf87171))
}

extension Font {
    static let dxMono = Font.system(.callout, design: .monospaced)
    static let dxMonoSmall = Font.system(.caption2, design: .monospaced)
    static let dxGroupLabel = Font.system(size: 10, weight: .semibold)
}

struct DXGroupLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.dxGroupLabel)
            .tracking(1.1)
            .foregroundStyle(Color.dxFaint.opacity(0.75))
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct DXCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Color.dxSurface)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(Color.dxBorder, lineWidth: 0.5)
            )
    }
}

extension View {
    func dxCard() -> some View { modifier(DXCard()) }
}

// Primary pill — black-on-white / white-on-black, same as the pair screen CTA.
struct DXPrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .foregroundStyle(Color.dxBg)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .background(Color.dxText)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .opacity(configuration.isPressed ? 0.82 : 1)
    }
}

struct DXSecondaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.medium))
            .foregroundStyle(Color.dxText)
            .padding(.vertical, 10)
            .padding(.horizontal, 14)
            .background(Color.dxSurface2)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.dxBorder, lineWidth: 0.5))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

enum DXHaptics {
    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
    static func confirm() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}

// Appearance override: system / light / dark, persisted.
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var scheme: ColorScheme? {
        switch self { case .system: return nil; case .light: return .light; case .dark: return .dark }
    }
}
