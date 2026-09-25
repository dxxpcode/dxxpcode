import Foundation

/// `git diff` helpers run inside the project root. The app isn't sandboxed —
/// spawning git here is equivalent to what the agent does via run_command.
enum GitDiff {
    /// Parse `git diff HEAD` into per-file unified diffs.
    static func changedFiles(in root: String) -> [(path: String, diff: String)] {
        guard let out = run(["-C", root, "diff", "HEAD", "--no-color"]) else { return [] }
        var files: [(String, String)] = []
        var current: String?
        var buf = ""
        func flush() {
            if let current, !buf.isEmpty { files.append((current, buf)) }
            buf = ""
        }
        for line in out.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if line.hasPrefix("diff --git ") {
                flush()
                // diff --git a/<old> b/<new>
                if let range = line.range(of: " b/") {
                    current = String(line[range.upperBound...])
                }
            }
            buf += line + "\n"
        }
        flush()
        return files
    }

    /// Short porcelain listing of untracked files (diff can't cover them).
    static func untrackedFiles(in root: String) -> [String] {
        guard let out = run(["-C", root, "status", "--porcelain"]) else { return [] }
        return out.split(separator: "\n").compactMap { line in
            line.hasPrefix("?? ") ? String(line.dropFirst(3)) : nil
        }
    }

    private static func run(_ arguments: [String]) -> String? {
        let proc = Process()
        let pipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        proc.arguments = arguments
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0 else { return nil }
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }
}
