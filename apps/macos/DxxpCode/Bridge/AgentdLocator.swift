import Foundation

/// How to launch `dxxpcode-agent`: an executable plus its arguments.
struct AgentdLaunch: Sendable {
    let executable: URL
    let arguments: [String]
}

/// Resolves how to launch `dxxpcode-agent` in this environment.
///
/// Order:
/// 1. `DXXPCODE_AGENTD` env — an executable path, or a `.js`/`.ts` entry spawned via `node`.
/// 2. Bundled `Contents/Resources/dxxpcode-agent` (release packaging).
/// 3. Repo-relative fallbacks for development: `apps/agentd/dist/main.js`,
///    then `apps/agentd/src/main.ts` via `--conditions=development`.
enum AgentdLocator {
    enum LocatorError: Error, LocalizedError {
        case notFound
        var errorDescription: String? {
            "Could not locate dxxpcode-agent. Build it (`npm run build`) or set DXXPCODE_AGENTD."
        }
    }

    static func resolve(env: [String: String] = ProcessInfo.processInfo.environment,
                        bundle: Bundle = .main,
                        fileManager: FileManager = .default) throws -> AgentdLaunch {
        if let override = env["DXXPCODE_AGENTD"], !override.isEmpty {
            return try forScriptOrBinary(override)
        }
        if let bundled = bundle.url(forResource: "dxxpcode-agent", withExtension: nil),
           fileManager.fileExists(atPath: bundled.path) {
            return AgentdLaunch(executable: bundled, arguments: [])
        }
        for root in repoRootCandidates() {
            let dist = root.appendingPathComponent("apps/agentd/dist/main.js")
            if fileManager.fileExists(atPath: dist.path) {
                return nodeInvocation([dist.path], env: env)
            }
            let src = root.appendingPathComponent("apps/agentd/src/main.ts")
            if fileManager.fileExists(atPath: src.path) {
                return nodeInvocation(["--conditions=development", src.path], env: env)
            }
        }
        throw LocatorError.notFound
    }

    private static func forScriptOrBinary(_ path: String,
                                          env: [String: String] = ProcessInfo.processInfo.environment) throws -> AgentdLaunch {
        let url = URL(fileURLWithPath: path)
        switch url.pathExtension {
        case "js":
            return nodeInvocation([path], env: env)
        case "ts":
            return nodeInvocation(["--conditions=development", path], env: env)
        default:
            guard FileManager.default.isExecutableFile(atPath: path) else {
                throw LocatorError.notFound
            }
            return AgentdLaunch(executable: url, arguments: [])
        }
    }

    private static func nodeInvocation(_ args: [String], env: [String: String]) -> AgentdLaunch {
        let node = resolveNode(env)
        if node.lastPathComponent == "env" {
            return AgentdLaunch(executable: node, arguments: ["node"] + args)
        }
        return AgentdLaunch(executable: node, arguments: args)
    }

    /// Absolute path to `node`. Apps launched via Dock/Finder get a minimal
    /// launchd PATH that misses Homebrew/nvm installs, so scan the real PATH
    /// plus the usual install locations.
    static func resolveNode(_ env: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        let fm = FileManager.default
        var dirs = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        let home = env["HOME"] ?? NSHomeDirectory()
        dirs += [
            "/opt/homebrew/bin", "/usr/local/bin",
            "\(home)/.nvm/current/bin", "\(home)/.volta/bin",
            "\(home)/.asdf/shims", "\(home)/.local/bin", "/usr/bin",
        ]
        for dir in dirs {
            let candidate = (dir as NSString).appendingPathComponent("node")
            if fm.isExecutableFile(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }
        return URL(fileURLWithPath: "/usr/bin/env") // last resort
    }

    /// Walk up from the executable (and cwd) looking for a repo root
    /// (a directory containing `apps/agentd`).
    private static func repoRootCandidates() -> [URL] {
        var roots: [URL] = []
        var starts = [URL(fileURLWithPath: FileManager.default.currentDirectoryPath)]
        if let exe = Bundle.main.executableURL {
            starts.append(exe)
        }
        for start in starts {
            var dir = start.hasDirectoryPath ? start : start.deletingLastPathComponent()
            for _ in 0..<8 {
                let marker = dir.appendingPathComponent("apps/agentd")
                if FileManager.default.fileExists(atPath: marker.path) {
                    roots.append(dir)
                    break
                }
                dir.deleteLastPathComponent()
            }
        }
        return roots
    }
}
