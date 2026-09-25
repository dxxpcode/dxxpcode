import SwiftUI

/// Minimal markdown renderer: prose goes through AttributedString(markdown:)
/// (built-in), fenced code blocks become styled monospace blocks. Keeps the
/// app dependency-free; swap for MarkdownUI later if needed.
struct MarkdownText: View {
    let markdown: String

    init(_ markdown: String) {
        self.markdown = markdown
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .prose(let text):
                    Text(attributed(text))
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .code(let lang, let code):
                    VStack(alignment: .leading, spacing: 0) {
                        if let lang, !lang.isEmpty {
                            Text(lang)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 8)
                                .padding(.top, 6)
                        }
                        ScrollView(.horizontal) {
                            Text(code)
                                .font(.callout.monospaced())
                                .textSelection(.enabled)
                                .padding(8)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
                }
            }
        }
    }

    private enum Segment {
        case prose(String)
        case code(lang: String?, code: String)
    }

    private var segments: [Segment] {
        var out: [Segment] = []
        var prose = ""
        var code = ""
        var lang: String?
        var inFence = false
        for line in markdown.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inFence {
                    out.append(.code(lang: lang, code: code.trimmingCharacters(in: .newlines)))
                    code = ""
                    lang = nil
                    inFence = false
                } else {
                    if !prose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        out.append(.prose(prose.trimmingCharacters(in: .newlines)))
                    }
                    prose = ""
                    lang = String(trimmed.dropFirst(3)).isEmpty ? nil : String(trimmed.dropFirst(3))
                    inFence = true
                }
            } else if inFence {
                code += line + "\n"
            } else {
                prose += line + "\n"
            }
        }
        if inFence {
            // Unterminated fence — render what we have as code.
            out.append(.code(lang: lang, code: code.trimmingCharacters(in: .newlines)))
        } else if !prose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append(.prose(prose.trimmingCharacters(in: .newlines)))
        }
        return out
    }

    private func attributed(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
    }
}
