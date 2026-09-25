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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if mentionRange != nil && !mentionMatches.isEmpty {
                mentionPicker
                Divider()
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Describe the task — @ to mention files", text: $task, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .font(.body)
                    .onChange(of: task) { _, _ in updateMentionState() }
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.command) {
                            onSubmit()
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
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.running)
                .keyboardShortcut(.return, modifiers: .command)
            }
            .padding(10)
        }
        .background(.bar)
        .overlay(alignment: .top) {
            Rectangle().fill(.separator).frame(height: 1)
        }
    }

    // MARK: - @-mention picker

    private var mentionPicker: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(mentionMatches.prefix(8), id: \.self) { match in
                    Button {
                        insert(match)
                    } label: {
                        Label(match, systemImage: "doc")
                            .font(.callout)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxHeight: 200)
        .background(.bar)
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

    /// Enumerate project files once (shallow git-aware list, capped), then reuse.
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
                fm.fileExists(atPath: (root as NSString).appendingPathComponent(path), isDirectory: &isDir)
                if !isDir.boolValue { out.append(path) }
                if out.count >= 5000 { break }
            }
        }
        projectFiles = out
        return out
    }
}
