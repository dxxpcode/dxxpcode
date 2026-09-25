import SwiftUI

/// Unified diff renderer: +/−/@@/header line coloring, SF Mono.
struct DiffText: View {
    let diff: String

    init(_ diff: String) {
        self.diff = diff
    }

    var body: some View {
        ScrollView(.horizontal) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line.text.isEmpty ? " " : line.text)
                        .font(.caption.monospaced())
                        .foregroundStyle(line.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(line.background)
                }
            }
            .padding(.vertical, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 6))
        .textSelection(.enabled)
    }

    private struct Line {
        let text: String
        let color: Color
        let background: Color
    }

    private var lines: [Line] {
        diff.components(separatedBy: "\n").map { raw in
            if raw.hasPrefix("+++") || raw.hasPrefix("---") {
                return Line(text: raw, color: .secondary, background: .clear)
            } else if raw.hasPrefix("+") {
                return Line(text: raw, color: Color(red: 0.1, green: 0.55, blue: 0.2),
                            background: Color.green.opacity(0.08))
            } else if raw.hasPrefix("-") {
                return Line(text: raw, color: Color(red: 0.8, green: 0.15, blue: 0.15),
                            background: Color.red.opacity(0.08))
            } else if raw.hasPrefix("@@") {
                return Line(text: raw, color: .accentColor,
                            background: Color.accentColor.opacity(0.08))
            } else if raw.hasPrefix("diff --git") || raw.hasPrefix("index ") || raw.hasPrefix("new file") || raw.hasPrefix("deleted file") {
                return Line(text: raw, color: .secondary, background: .clear)
            } else {
                return Line(text: raw, color: .primary, background: .clear)
            }
        }
    }
}
