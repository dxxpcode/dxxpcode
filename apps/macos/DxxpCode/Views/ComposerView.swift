import SwiftUI

/// Task input with ⌘⏎-to-send and an `@` file-mention picker. Mentions produce
/// `@path` tokens — the runtime's expandMentions attaches the file contents.
struct ComposerView: View {
    let session: SessionModel
    @Binding var task: String
    let onSubmit: () -> Void

    @State private var mentionMatches: [String] = []
    @State private var mentionRange: Range<String.Index>?
    @State private var projectFiles: [String]?

    private var canSend: Bool {
        !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !session.running
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if mentionRange != nil && !mentionMatches.isEmpty {
                mentionPicker
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Describe the task — @ to mention files, ⌘⏎ to send",
                          text: $task, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .font(.body)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Color(nsColor: .textBackgroundColor),
                                in: RoundedRectangle(cornerRadius: 10))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(Color.primary.opacity(0.12))
                    }
                    .onChange(of: task) { _, _ in updateMentionState() }
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.command) {
                            if canSend { onSubmit() }
                            return .handled
                        }
                        if mentionRange != nil {
                            insertFirstMatch()
                            return .handled
                        }
                        return .ignored
                    }
                Button(action: onSubmit) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 26))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(canSend ? Color.accentColor : Color.secondary.opacity(0.4))
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .keyboardShortcut(.return, modifiers: .command)
                .help("Send ⌘⏎")
            }
            .padding(12)
        }
        .background(.bar)
        .overlay(alignment: .top) {
            Rectangle().fill(.separator).frame(height: 1)
        }
    }

    // MARK: - @-mention picker

    private var mentionPicker: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(mentionMatches.prefix(8), id: \.self) { match in
                MentionRow(path: match) { insert(match) }
            }
        }
        .padding(.vertical, 4)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Color.primary.opacity(0.10))
        }
        .shadow(color: .black.opacity(0.08), radius: 4, y: 2)
    }

    /// Find a trailing `@fragment` at the end of the text and match it
    /// against the enumerated project file list.
    private func updateMentionState() {
        guard let at = task.lastIndex(of: "@"),
              task[at...].contains(" ") == false else {
            mentionRange = nil
            mentionMatches = []
            return
        }
        let fragment = String(task[task.index(after: at)...])
        mentionRange = at..<task.endIndex
        let files = files()
        mentionMatches = files.filter { path in
            fragment.isEmpty || path.localizedCaseInsensitiveContains(fragment)
        }
    }

    private func insertFirstMatch() {
        if let first = mentionMatches.first { insert(first) }
    }

    private func insert(_ path: String) {
        guard let range = mentionRange else { return }
        task.replaceSubrange(range, with: path + " ")
        mentionRange = nil
        mentionMatches = []
    }

    /// Enumerate project files once (shallow list, capped), then reuse.
    private func files() -> [String] {
        if let projectFiles { return projectFiles }
        let root = session.projectRoot
        var out: [String] = []
        let fm = FileManager.default
        let skip: Set<String> = [".git", "node_modules", ".build", "dist", ".dxxpcode", "DerivedData"]
        if let enumerator = fm.enumerator(atPath: root) {
            for case let path as String in enumerator {
                let base = (path as NSString).lastPathComponent
                if skip.contains(base) || base.hasPrefix(".") {
                    enumerator.skipDescendants()
                    continue
                }
                var isDir: ObjCBool = false
                fm.fileExists(atPath: (root as NSString).appendingPathComponent(path),
                              isDirectory: &isDir)
                if !isDir.boolValue { out.append(path) }
                if out.count >= 5000 { break }
            }
        }
        projectFiles = out
        return out
    }
}

/// A single suggestion row with hover feedback.
private struct MentionRow: View {
    let path: String
    let onPick: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: onPick) {
            Label(path, systemImage: "doc")
                .font(.callout)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(hovered ? Color.accentColor.opacity(0.10) : .clear,
                            in: RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }
}
