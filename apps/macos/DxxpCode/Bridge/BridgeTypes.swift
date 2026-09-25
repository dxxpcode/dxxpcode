import Foundation

// Codable mirrors of packages/bridge/src/protocol.ts and the AgentEvent wire
// shapes emitted by packages/agent/src/runtime.ts. Field names stay identical —
// the bridge passes everything through verbatim.

struct RpcErrorBody: Decodable, Sendable, Error {
    let code: Int
    let message: String
}

struct ProposedPlan: Decodable, Sendable, Equatable {
    let summary: String
    let steps: [String]
    let trivial: Bool
}

struct PermissionDecision: Decodable, Sendable {
    let level: String // "safe" | "approval" | "restricted"
    let reason: String
}

struct ApprovalRequest: Decodable, Sendable {
    let tool: String
    let input: JSONValue
    let decision: PermissionDecision
    let reason: String?
}

struct ToolResult: Decodable, Sendable {
    let content: String
    let isError: Bool?
    let changedFile: String?
    let diff: String?
}

struct TodoItem: Decodable, Sendable, Equatable {
    let id: String
    let content: String
    let status: String // "pending" | "in_progress" | "completed"
    let activeForm: String?
}

struct Usage: Decodable, Sendable, Equatable {
    let inputTokens: Int
    let outputTokens: Int
}

struct RunResult: Decodable, Sendable {
    let status: String // "completed" | "denied" | "max_iterations" | "cancelled" | "error" | "plan_only"
    let summary: String
    let filesChanged: [String]
    let commands: [String]
    let toolCalls: Int
    let plan: ProposedPlan?
    let diffStat: String?
    let error: String?
    let sessionId: String
    let usage: Usage?
}

enum AgentEvent: Decodable, Sendable {
    case status(message: String)
    case text(String)
    case plan(ProposedPlan)
    case approvalRequest(ApprovalRequest)
    case toolStart(tool: String, input: JSONValue)
    case toolEnd(tool: String, result: ToolResult)
    case todo([TodoItem])
    case checkpoint(seq: Int, paths: [String])
    case denied(tool: String, reason: String)
    case usage(Usage)
    case compacted(before: Int, after: Int, blocks: Int)
    case done(RunResult)

    private enum CodingKeys: String, CodingKey { case type }

    private enum EventType: String, Decodable {
        case status, text, plan, approvalRequest = "approval_request"
        case toolStart = "tool_start", toolEnd = "tool_end"
        case todo, checkpoint, denied, usage, compacted, done
    }

    init(from decoder: Decoder) throws {
        let keyed = try decoder.container(keyedBy: CodingKeys.self)
        let type = try keyed.decode(EventType.self, forKey: .type)
        let c = try decoder.singleValueContainer()
        switch type {
        case .status:
            self = .status(message: try c.decode(StatusPayload.self).message)
        case .text:
            self = .text(try c.decode(TextPayload.self).text)
        case .plan:
            self = .plan(try c.decode(PlanPayload.self).plan)
        case .approvalRequest:
            self = .approvalRequest(try c.decode(ApprovalPayload.self).request)
        case .toolStart:
            let p = try c.decode(ToolStartPayload.self)
            self = .toolStart(tool: p.tool, input: p.input)
        case .toolEnd:
            let p = try c.decode(ToolEndPayload.self)
            self = .toolEnd(tool: p.tool, result: p.result)
        case .todo:
            self = .todo(try c.decode(TodoPayload.self).items)
        case .checkpoint:
            let p = try c.decode(CheckpointPayload.self)
            self = .checkpoint(seq: p.seq, paths: p.paths)
        case .denied:
            let p = try c.decode(DeniedPayload.self)
            self = .denied(tool: p.tool, reason: p.reason)
        case .usage:
            self = .usage(try c.decode(UsagePayload.self).usage)
        case .compacted:
            let p = try c.decode(CompactedPayload.self)
            self = .compacted(before: p.before, after: p.after, blocks: p.blocks)
        case .done:
            self = .done(try c.decode(DonePayload.self).result)
        }
    }

    var typeName: String {
        switch self {
        case .status: return "status"
        case .text: return "text"
        case .plan: return "plan"
        case .approvalRequest: return "approval_request"
        case .toolStart: return "tool_start"
        case .toolEnd: return "tool_end"
        case .todo: return "todo"
        case .checkpoint: return "checkpoint"
        case .denied: return "denied"
        case .usage: return "usage"
        case .compacted: return "compacted"
        case .done: return "done"
        }
    }

    private struct StatusPayload: Decodable { let message: String }
    private struct TextPayload: Decodable { let text: String }
    private struct PlanPayload: Decodable { let plan: ProposedPlan }
    private struct ApprovalPayload: Decodable { let request: ApprovalRequest }
    private struct ToolStartPayload: Decodable { let tool: String; let input: JSONValue }
    private struct ToolEndPayload: Decodable { let tool: String; let result: ToolResult }
    private struct TodoPayload: Decodable { let items: [TodoItem] }
    private struct CheckpointPayload: Decodable { let seq: Int; let paths: [String] }
    private struct DeniedPayload: Decodable { let tool: String; let reason: String }
    private struct UsagePayload: Decodable { let usage: Usage }
    private struct CompactedPayload: Decodable { let before: Int; let after: Int; let blocks: Int }
    private struct DonePayload: Decodable { let result: RunResult }
}

/// Server → client `event` notification params (protocol.ts EventNotificationParams).
struct EventNotification: Decodable, Sendable {
    let sessionId: String
    let event: AgentEvent
    let requestId: String?
}

struct SessionSummary: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let projectRoot: String
    let task: String
    let createdAt: String
    let updatedAt: String
    let messageCount: Int
    let result: String?
}

struct ProvidersList: Decodable, Sendable {
    struct Current: Decodable, Sendable { let provider: String; let model: String }
    struct Entry: Decodable, Sendable { let name: String; let models: [String]; let `default`: String }
    let current: Current?
    let providers: [Entry]
}

struct PingResult: Decodable, Sendable {
    let version: String
    let pid: Int
}

enum BridgeMethod {
    static let ping = "ping"
    static let shutdown = "shutdown"
    static let runStart = "run.start"
    static let runCancel = "run.cancel"
    static let planRespond = "plan.respond"
    static let approvalRespond = "approval.respond"
    static let sessionList = "session.list"
    static let sessionGet = "session.get"
    static let sessionDelete = "session.delete"
    static let checkpointUndo = "checkpoint.undo"
    static let configGet = "config.get"
    static let configSet = "config.set"
    static let providersList = "providers.list"
    static let secretsSet = "secrets.set"
}

let reasonEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"]
