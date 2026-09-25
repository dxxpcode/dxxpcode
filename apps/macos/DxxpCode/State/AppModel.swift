import Foundation
import Observation

/// One open project: a working directory plus the agentd bridge serving it.
@Observable
@MainActor
final class ProjectModel: Identifiable {
    let root: String
    var bridge: BridgeClient?
    var sessions: [SessionSummary] = []
    var liveSessions: [SessionModel] = []
    var selectedSessionId: String?
    var bridgeError: String?
    var eventTask: Task<Void, Never>?

    nonisolated var id: String { root }
    var name: String { URL(fileURLWithPath: root).lastPathComponent }

    init(root: String) {
        self.root = root
    }

    /// Spawn agentd for this project and load its session list.
    @MainActor
    func connect(env: [String: String]?) async {
        guard bridge == nil else { return }
        do {
            let launch = try AgentdLocator.resolve()
            let client = try BridgeClient(executable: launch.executable,
                                          arguments: launch.arguments,
                                          environment: env)
            bridge = client
            startEventPump(client)
            await refreshSessions()
        } catch {
            bridgeError = error.localizedDescription
        }
    }

    @MainActor
    private func startEventPump(_ client: BridgeClient) {
        eventTask = Task { [weak self] in
            for await note in client.events {
                self?.route(note)
            }
        }
    }

    /// Route an event notification to the owning live session (by sessionId).
    @MainActor
    private func route(_ note: EventNotification) {
        if let target = liveSessions.first(where: { $0.sessionId == note.sessionId || $0.sessionId == nil }) {
            target.consume(note)
            if case .done = note.event {
                Task { await refreshSessions() }
            }
        }
    }

    @MainActor
    func refreshSessions() async {
        guard let bridge else { return }
        do {
            sessions = try await bridge.call(BridgeMethod.sessionList,
                                             params: ["projectRoot": .string(root)],
                                             as: [SessionSummary].self)
        } catch {
            bridgeError = (error as? BridgeClient.ClientError).flatMap {
                if case .rpc(let body) = $0 { return body.message }
                return nil
            } ?? error.localizedDescription
        }
    }

    /// The session currently shown in the detail pane, set by `ensureSession`.
    var current: SessionModel?

    /// Ensure the session for `summaryId` exists and make it current.
    /// `nil` selects the draft session (new task).
    @MainActor
    @discardableResult
    func ensureSession(_ summaryId: String?) -> SessionModel {
        if let sid = summaryId {
            if let live = liveSessions.first(where: { $0.sessionId == sid }) {
                current = live
                return live
            }
            let model = SessionModel(projectRoot: root, bridge: bridge, sessionId: sid)
            if let summary = sessions.first(where: { $0.id == sid }) {
                model.adopt(summary)
            }
            liveSessions.append(model)
            current = model
            return model
        }
        if let draft = liveSessions.first(where: { $0.sessionId == nil }) {
            current = draft
            return draft
        }
        let model = SessionModel(projectRoot: root, bridge: bridge)
        liveSessions.append(model)
        current = model
        return model
    }
}

/// App-level state: open projects and the sidebar selection.
@Observable
@MainActor
final class AppModel {
    var projects: [ProjectModel] = []
    var selectedProjectId: String?
    var selectedSessionId: String?
    /// Latest agentd resolution failure (surfaced in the sidebar/empty state).
    var lastBridgeError: String?

    /// Session-requested run preferences, shared with the toolbar.
    var effort: String = "medium"
    var model: String?
    var autoApprove = false

    @MainActor
    func openProject(at url: URL) async {
        let root = url.path
        if let existing = projects.first(where: { $0.root == root }) {
            selectedProjectId = existing.id
            return
        }
        let project = ProjectModel(root: root)
        projects.append(project)
        selectedProjectId = project.id
        selectedSessionId = nil
        await project.connect(env: nil)
        if let err = project.bridgeError { lastBridgeError = err }
    }

    @MainActor
    func removeProject(_ project: ProjectModel) {
        project.eventTask?.cancel()
        project.bridge?.close()
        projects.removeAll { $0.id == project.id }
        if selectedProjectId == project.id {
            selectedProjectId = projects.first?.id
            selectedSessionId = nil
        }
    }

    var selectedProject: ProjectModel? {
        projects.first { $0.id == selectedProjectId }
    }
}
