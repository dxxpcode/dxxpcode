import XCTest
@testable import DxxpCode

/// End-to-end against the real `dxxpcode-agent` over stdio, mirroring the
/// Node golden-transcript tests in test/bridge.test.ts.
final class BridgeClientTests: XCTestCase {

    private var repoRoot: URL {
        // …/apps/macos/DxxpCodeTests/BridgeClientTests.swift → repo root
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // DxxpCodeTests/
            .deletingLastPathComponent()  // macos/
            .deletingLastPathComponent()  // apps/
            .deletingLastPathComponent()  // repo root
    }

    private struct Harness {
        let client: BridgeClient
        let root: String
        let home: String
    }

    private func makeHarness(script: [[String: Any]]) throws -> Harness {
        let home = NSTemporaryDirectory() + "dxxp-macos-test-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)

        // Copy the fixture repo so the run has a project + git history.
        let src = repoRoot.appendingPathComponent("test/fixtures/node-app")
        let dst = URL(fileURLWithPath: home).appendingPathComponent("proj")
        try FileManager.default.copyItem(at: src, to: dst)
        for args in [["init", "-q"], ["add", "-A"],
                     ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]] {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            proc.arguments = args
            proc.currentDirectoryURL = dst
            try proc.run()
            proc.waitUntilExit()
            XCTAssertEqual(proc.terminationStatus, 0, "git \(args.first ?? "") failed")
        }

        let scriptPath = (home as NSString).appendingPathComponent("mock.json")
        let scriptData = try JSONSerialization.data(withJSONObject: script)
        FileManager.default.createFile(atPath: scriptPath, contents: scriptData)

        var env = ProcessInfo.processInfo.environment
        env["DXXPCODE_HOME"] = home
        env["DXXPCODE_PROVIDER"] = "mock"
        env["DXXPCODE_MOCK_SCRIPT"] = scriptPath

        let dist = repoRoot.appendingPathComponent("apps/agentd/dist/main.js")
        let agentd = FileManager.default.fileExists(atPath: dist.path)
            ? dist.path
            : repoRoot.appendingPathComponent("apps/agentd/src/main.ts").path
        env["DXXPCODE_AGENTD"] = agentd

        let launch = try AgentdLocator.resolve(env: env)
        let client = try BridgeClient(executable: launch.executable,
                                      arguments: launch.arguments,
                                      environment: env)
        return Harness(client: client, root: dst.path, home: home)
    }

    private func collectEvents(_ client: BridgeClient, into box: EventBox) {
        Task {
            for await note in client.events {
                await box.append(note)
            }
            await box.markClosed()
        }
    }

    actor EventBox {
        private(set) var notes: [EventNotification] = []
        private(set) var closed = false
        func append(_ n: EventNotification) { notes.append(n) }
        func markClosed() { closed = true }
        func first(_ pred: (EventNotification) -> Bool) -> EventNotification? {
            notes.first(where: pred)
        }
        func count(type name: String, withRequestId: Bool) -> Int {
            notes.filter { $0.event.typeName == name && (withRequestId ? $0.requestId != nil : true) }.count
        }
    }

    private func awaitCondition(_ body: @escaping () async -> Bool,
                                timeout: TimeInterval = 20,
                                file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await body() { return }
            try await Task.sleep(nanoseconds: 30_000_000)
        }
        XCTFail("awaitCondition timed out", file: file, line: line)
    }

    private let planThenRm: [[String: Any]] = [
        ["toolCalls": [["name": "propose_plan",
                        "input": ["summary": "Clean build output",
                                  "steps": ["rm -rf build", "Report"]]]]],
        ["toolCalls": [["name": "run_command",
                        "input": ["command": "rm -rf build", "reason": "clean artifacts"]]]],
        ["text": "Done cleaning."],
    ]

    func testGoldenTranscript() async throws {
        let h = try makeHarness(script: planThenRm)
        let box = EventBox()
        collectEvents(h.client, into: box)

        // ping
        let pong = try await h.client.call(BridgeMethod.ping, as: PingResult.self)
        XCTAssertFalse(pong.version.isEmpty)

        // run.start → sessionId
        let start = try await h.client.call(BridgeMethod.runStart, params: [
            "projectRoot": .string(h.root), "task": .string("clean build"),
        ])
        let sessionId = start["sessionId"]?.stringValue
        XCTAssertNotNil(sessionId)

        // plan event carries requestId → approve
        try await awaitCondition {
            await box.first { $0.event.typeName == "plan" && $0.requestId != nil } != nil
        }
        let planNote = await box.first { $0.event.typeName == "plan" }!
        try await h.client.call(BridgeMethod.planRespond, params: [
            "requestId": .string(planNote.requestId!), "approve": true,
        ])

        // approval_request → allow
        try await awaitCondition {
            await box.first { $0.event.typeName == "approval_request" && $0.requestId != nil } != nil
        }
        let apNote = await box.first { $0.event.typeName == "approval_request" }!
        try await h.client.call(BridgeMethod.approvalRespond, params: [
            "requestId": .string(apNote.requestId!), "allow": true,
        ])

        // done → completed, same sessionId
        try await awaitCondition {
            await box.first { $0.event.typeName == "done" } != nil
        }
        let done = await box.first { $0.event.typeName == "done" }!
        XCTAssertEqual(done.sessionId, sessionId)
        guard case .done(let result) = done.event else { return XCTFail("not done") }
        XCTAssertEqual(result.status, "completed")
        XCTAssertEqual(result.sessionId, sessionId)

        // Golden ordering: status → plan → approval_request → tool_start → tool_end → done
        let order = await box.notes.map { $0.event.typeName }
            .filter { ["status", "plan", "approval_request", "tool_start", "tool_end", "done"].contains($0) }
        XCTAssertEqual(order, ["status", "plan", "approval_request", "tool_start", "tool_end", "done"])

        // Session record persisted under DXXPCODE_HOME
        let sessionFile = (h.home as NSString)
            .appendingPathComponent("sessions/\(sessionId!).json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: sessionFile))
        h.client.close()
    }

    func testRejectPlanThenDenied() async throws {
        let h = try makeHarness(script: planThenRm)
        let box = EventBox()
        collectEvents(h.client, into: box)

        _ = try await h.client.call(BridgeMethod.runStart, params: [
            "projectRoot": .string(h.root), "task": .string("x"),
        ])
        try await awaitCondition {
            await box.first { $0.event.typeName == "plan" && $0.requestId != nil } != nil
        }
        let plan = await box.first { $0.event.typeName == "plan" }!
        try await h.client.call(BridgeMethod.planRespond, params: [
            "requestId": .string(plan.requestId!), "approve": false,
        ])
        try await awaitCondition {
            await box.first { $0.event.typeName == "done" } != nil
        }
        let done = await box.first { $0.event.typeName == "done" }!
        guard case .done(let result) = done.event else { return XCTFail() }
        XCTAssertEqual(result.status, "denied")
        h.client.close()
    }

    func testAlwaysAllowDedupes() async throws {
        let script: [[String: Any]] = [
            ["toolCalls": [["name": "propose_plan",
                            "input": ["summary": "x", "steps": ["a"], "trivial": true]]]],
            ["toolCalls": [["name": "run_command", "input": ["command": "rm -rf build"]]]],
            ["toolCalls": [["name": "run_command", "input": ["command": "rm -rf build"]]]],
            ["text": "done"],
        ]
        let h = try makeHarness(script: script)
        let box = EventBox()
        collectEvents(h.client, into: box)

        _ = try await h.client.call(BridgeMethod.runStart, params: [
            "projectRoot": .string(h.root), "task": .string("t"),
        ])
        try await awaitCondition {
            await box.first { $0.event.typeName == "approval_request" && $0.requestId != nil } != nil
        }
        let ap = await box.first { $0.event.typeName == "approval_request" }!
        try await h.client.call(BridgeMethod.approvalRespond, params: [
            "requestId": .string(ap.requestId!), "allow": true, "always": true,
        ])
        try await awaitCondition {
            await box.first { $0.event.typeName == "done" } != nil
        }
        // Second identical call still emits the event, but without a requestId.
        let prompting = await box.count(type: "approval_request", withRequestId: true)
        XCTAssertEqual(prompting, 1)
        h.client.close()
    }

    func testErrorPathUnknownMethod() async throws {
        let h = try makeHarness(script: [])
        do {
            _ = try await h.client.call("nope.method")
            XCTFail("expected error")
        } catch BridgeClient.ClientError.rpc(let body) {
            XCTAssertEqual(body.code, -32601)
        }
        h.client.close()
    }
}
