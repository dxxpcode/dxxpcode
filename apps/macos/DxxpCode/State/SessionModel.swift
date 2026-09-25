import Foundation
import Observation

/// One row in the session transcript.
enum TranscriptItem: Identifiable {
    case text(id: UUID, text: String)
    case tool(id: UUID, tool: String, detail: String, result: ToolResult?)
    case plan(id: UUID, plan: ProposedPlan, requestId: String?, response: PlanResponse?)
    case approval(id: UUID, request: ApprovalRequest, requestId: String?, response: ApprovalResponse?)
    case denied(id: UUID, tool: String, reason: String)
    case compacted(id: UUID, before: Int, after: Int)
    case done(id: UUID, result: RunResult)
    case note(id: UUID, message: String)

    var id: UUID {
        switch self {
        case .text(let id, _), .tool(let id, _, _, _), .plan(let id, _, _, _),
             .approval(let id, _, _, _), .denied(let id, _, _), .compacted(let id, _, _),
             .done(let id, _), .note(let id, _):
            return id
        }
    }

    enum PlanResponse: String { case approved, rejected, autoApproved }
    enum ApprovalResponse: String { case allowed, alwaysAllowed, denied, autoAllowed }
}

struct PendingPlan: Equatable {
    let requestId: String
    let plan: ProposedPlan
    let itemId: UUID
}

struct PendingApproval: Equatable {
    let requestId: String
    let request: ApprovalRequest
    let itemId: UUID
}

extension ApprovalRequest: Equatable {
    static func == (lhs: ApprovalRequest, rhs: ApprovalRequest) -> Bool {
        lhs.tool == rhs.tool && lhs.input == rhs.input && lhs.reason == rhs.reason
    }
}

struct CheckpointEntry: Identifiable, Equatable {
    let seq: Int
    let paths: [String]
    var id: Int { seq }
}

struct ChangedFile: Identifiable, Equatable {
    let path: String
    var diff: String?
    var id: String { path }
}

/// Live state for one agent session: the transcript plus everything the
/// inspector needs. Consumes `EventNotification`s from the bridge in order.
@Observable
@MainActor
final class SessionModel {
    /// Bridge session id — nil until `run.start` responds or a stored session is selected.
    private(set) var sessionId: String?
    let projectRoot: String
    var resumeTask: String?

    private(set) var items: [TranscriptItem] = []
    private(set) var statusLine: String?
    private(set) var running = false
    private(set) var result: RunResult?
    private(set) var todos: [TodoItem] = []
    private(set) var usage: Usage?
    private(set) var checkpoints: [CheckpointEntry] = []
    private(set) var changedFiles: [ChangedFile] = []
    private(set) var pendingPlan: PendingPlan?
    private(set) var pendingApproval: PendingApproval?
    var autoAllowCount = 0
    var errorMessage: String?

    private weak var bridge: BridgeClient?

    init(projectRoot: String, bridge: BridgeClient?, sessionId: String? = nil) {
        self.projectRoot = projectRoot
        self.bridge = bridge
        self.sessionId = sessionId
    }

    /// Selected stored session becomes the resume target for the next task.
    func adopt(_ summary: SessionSummary) {
        sessionId = summary.id
        resumeTask = summary.task
    }

    // MARK: - run control

    func start(task: String, effort: String?, model: String?, autoApprove: Bool) async {
        guard let bridge, !task.isEmpty, !running else { return }
        running = true
        result = nil
        errorMessage = nil
        var params: JSONValue = [
            "projectRoot": .string(projectRoot),
            "task": .string(task),
        ]
        if let effort { params["effort"] = .string(effort) }
        if let model { params["model"] = .string(model) }
        if autoApprove { params["autoApprove"] = true }
        if let sid = sessionId { params["resumeSessionId"] = .string(sid) }
        do {
            let res = try await bridge.call(BridgeMethod.runStart, params: params)
            sessionId = res["sessionId"]?.stringValue ?? sessionId
        } catch {
            running = false
            errorMessage = (error as? BridgeClient.ClientError).flatMap {
                if case .rpc(let body) = $0 { return body.message }
                return nil
            } ?? error.localizedDescription
        }
    }

    func approvePlan(_ approve: Bool) {
        guard let pendingPlan else { return }
        let reqId = pendingPlan.requestId
        respond(itemId: pendingPlan.itemId, plan: approve ? .approved : .rejected)
        self.pendingPlan = nil
        guard let bridge else { return }
        Task {
            try? await bridge.call(BridgeMethod.planRespond,
                                   params: ["requestId": .string(reqId), "approve": .bool(approve)])
        }
    }

    func respondApproval(allow: Bool, always: Bool = false) {
        guard let pendingApproval else { return }
        let reqId = pendingApproval.requestId
        let response: TranscriptItem.ApprovalResponse =
            allow ? (always ? .alwaysAllowed : .allowed) : .denied
        respond(itemId: pendingApproval.itemId, approval: response)
        self.pendingApproval = nil
        guard let bridge else { return }
        Task {
            try? await bridge.call(BridgeMethod.approvalRespond, params: [
                "requestId": .string(reqId),
                "allow": .bool(allow),
                "always": .bool(always),
            ])
        }
    }

    func cancel() {
        guard let bridge, let sessionId else { return }
        Task {
            try? await bridge.call(BridgeMethod.runCancel, params: ["sessionId": .string(sessionId)])
        }
    }

    /// Restore the most recent checkpoint (`checkpoint.undo` undoes latest only).
    func undoToCheckpoint() async -> String? {
        guard let bridge, let sessionId, !checkpoints.isEmpty else { return nil }
        do {
            let res = try await bridge.call(BridgeMethod.checkpointUndo, params: [
                "projectRoot": .string(projectRoot),
                "sessionId": .string(sessionId),
            ])
            let seq = res["seq"]?.numberValue.map { Int($0) }
            if let seq { checkpoints.removeAll { $0.seq == seq } }
            refreshChangedFiles()
            let n = res["restored"]?.arrayValue?.count ?? 0
            return seq.map { "Restored checkpoint \($0) (\(n) files)" }
        } catch {
            return "Nothing to undo"
        }
    }

    // MARK: - event consumption

    func consume(_ note: EventNotification) {
        guard note.sessionId == sessionId || sessionId == nil else { return }
        if sessionId == nil { sessionId = note.sessionId }
        switch note.event {
        case .status(let message):
            statusLine = message
        case .text(let text):
            if case .text(let id, let existing) = items.last {
                items[items.count - 1] = .text(id: id, text: existing + text)
            } else {
                items.append(.text(id: UUID(), text: text))
            }
        case .plan(let plan):
            let id = UUID()
            if let reqId = note.requestId {
                items.append(.plan(id: id, plan: plan, requestId: reqId, response: nil))
                pendingPlan = PendingPlan(requestId: reqId, plan: plan, itemId: id)
            } else {
                items.append(.plan(id: id, plan: plan, requestId: nil, response: .autoApproved))
            }
        case .approvalRequest(let request):
            let id = UUID()
            if let reqId = note.requestId {
                items.append(.approval(id: id, request: request, requestId: reqId, response: nil))
                pendingApproval = PendingApproval(requestId: reqId, request: request, itemId: id)
            } else {
                autoAllowCount += 1
                items.append(.approval(id: id, request: request, requestId: nil, response: .autoAllowed))
            }
        case .toolStart(let tool, let input):
            items.append(.tool(id: UUID(), tool: tool, detail: toolDetail(tool, input), result: nil))
        case .toolEnd(let tool, let result):
            if let idx = items.lastIndex(where: {
                if case .tool(_, let t, _, let r) = $0 { return t == tool && r == nil }
                return false
            }), case .tool(let id, let t, let d, _) = items[idx] {
                items[idx] = .tool(id: id, tool: t, detail: d, result: result)
            }
            if let changed = result.changedFile {
                upsertChangedFile(path: changed, diff: result.diff)
            }
        case .todo(let items):
            todos = items
        case .checkpoint(let seq, let paths):
            checkpoints.append(CheckpointEntry(seq: seq, paths: paths))
        case .denied(let tool, let reason):
            items.append(.denied(id: UUID(), tool: tool, reason: reason))
        case .usage(let u):
            usage = u
        case .compacted(let before, let after, _):
            items.append(.compacted(id: UUID(), before: before, after: after))
        case .done(let res):
            running = false
            statusLine = nil
            result = res
            items.append(.done(id: UUID(), result: res))
            for path in res.filesChanged where !changedFiles.contains(where: { $0.path == path }) {
                changedFiles.append(ChangedFile(path: path))
            }
            refreshChangedFiles()
        }
    }

    // MARK: - helpers

    private func respond(itemId: UUID, plan response: TranscriptItem.PlanResponse) {
        if let idx = items.firstIndex(where: { $0.id == itemId }),
           case .plan(let id, let plan, let reqId, _) = items[idx] {
            items[idx] = .plan(id: id, plan: plan, requestId: reqId, response: response)
        }
    }

    private func respond(itemId: UUID, approval response: TranscriptItem.ApprovalResponse) {
        if let idx = items.firstIndex(where: { $0.id == itemId }),
           case .approval(let id, let req, let reqId, _) = items[idx] {
            items[idx] = .approval(id: id, request: req, requestId: reqId, response: response)
        }
    }

    private func upsertChangedFile(path: String, diff: String?) {
        if let idx = changedFiles.firstIndex(where: { $0.path == path }) {
            if let diff { changedFiles[idx].diff = diff }
        } else {
            changedFiles.append(ChangedFile(path: path, diff: diff))
        }
    }

    /// Pull `git diff HEAD` in the project so files changed by shell commands
    /// (no tool-level diff) also appear in the inspector.
    private func refreshChangedFiles() {
        let root = projectRoot
        Task.detached(priority: .utility) {
            let diffs = GitDiff.changedFiles(in: root)
            Task { @MainActor in
                for (path, diff) in diffs { self.upsertChangedFile(path: path, diff: diff) }
            }
        }
    }

    private func toolDetail(_ tool: String, _ input: JSONValue) -> String {
        switch tool {
        case "run_command":
            return input["command"]?.stringValue ?? input.compactDescription
        case "read_file", "write_file", "edit_file", "delete_file":
            return input["path"]?.stringValue ?? input.compactDescription
        case "search_files":
            return input["pattern"]?.stringValue ?? input.compactDescription
        case "list_files":
            return input["path"]?.stringValue ?? "."
        default:
            return input.compactDescription
        }
    }
}
