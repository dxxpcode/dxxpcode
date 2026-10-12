import SwiftUI

// The XX brand mark, ported 1:1 from apps/site/public/favicon.svg so it stays
// crisp at any size and tints like a symbol. Source path lives in a 482×482
// box (viewBox -20 -106 482 482); coordinates below are offset +20/+106.
struct XXMark: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 482
        let ox = rect.minX + (rect.width - 482 * s) / 2
        let oy = rect.minY + (rect.height - 482 * s) / 2
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: ox + (x + 20) * s, y: oy + (y + 106) * s)
        }
        var path = Path()
        // Left X
        path.move(to: p(0, 0)); path.addLine(to: p(95, 135)); path.addLine(to: p(0, 270))
        path.addLine(to: p(66, 270)); path.addLine(to: p(257, 0)); path.addLine(to: p(191, 0))
        path.addLine(to: p(128.5, 88)); path.addLine(to: p(66, 0)); path.closeSubpath()
        // Right X
        path.move(to: p(375, 0)); path.addLine(to: p(185.5, 270)); path.addLine(to: p(252, 270))
        path.addLine(to: p(314, 183)); path.addLine(to: p(375.5, 270)); path.addLine(to: p(441, 270))
        path.addLine(to: p(347, 135)); path.addLine(to: p(441.5, 0)); path.closeSubpath()
        // Diamonds
        path.move(to: p(267, 23)); path.addLine(to: p(234, 70)); path.addLine(to: p(272, 123.5))
        path.addLine(to: p(305.5, 76.5)); path.closeSubpath()
        path.move(to: p(171, 148)); path.addLine(to: p(138, 195)); path.addLine(to: p(176, 248.5))
        path.addLine(to: p(209.5, 201.5)); path.closeSubpath()
        return path
    }
}
