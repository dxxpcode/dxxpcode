import XCTest
@testable import DxxpCode

/// Replay recorded event streams through SessionModel — no process needed.
@MainActor
final class SessionModelTests: XCTestCase {

    private func note(_ sessionId: String, _ eventJSON: String, requestId: String? = nil) throws -> EventNotification {
        let req = requestId.map { ",\"requestId\":\"\($0)\"" } ?? ""
        let json = """
        {"sessionId":"\(sessionId)","event":\(eventJSON)\(req)}
        """
        return try JSONDecoder().decode(EventNotification.self, from: Data(json.utf8))
    }

    func testPlanApprovalFlow() async throws {
        let model = SessionModel(projectRoot: "/tmp/x", bridge: nil, sessionId: "s1")

        try model.consume(note("s1", #"{"type":"status","message":"Inspecting…"}"#))
        XCTAssertEqual(model.statusLine, "Inspecting…")

        try model.consume(note("s1", #"{"type":"plan","plan":{"summary":"Clean","steps":["a","b"],"trivial":false}}"#,
                                requestId: "req_1"))
        XCTAssertNotNil(model.pendingPlan)
        guard case .plan(_, let plan, let reqId, let resp) = model.items.last else {
            return XCTFail("last item should be plan")
        }
        XCTAssertEqual(plan.steps.count, 2)
        XCTAssertEqual(reqId, "req_1")
        XCTAssertNil(resp)

        model.approvePlan(true)
        XCTAssertNil(model.pendingPlan)
        guard case .plan(_, _, _, let responded) = model.items.last else {
            return XCTFail()
        }
        XCTAssertEqual(responded, .approved)
    }

    func testTextStreamsIntoOneItem() async throws {
        let model = SessionModel(projectRoot: "/tmp/x", bridge: nil, sessionId: "s1")
        try model.consume(note("s1", #"{"type":"text","text":"Hello"}"#))
        try model.consume(note("s1", #"{"type":"text","text":" world"}"#))
        XCTAssertEqual(model.items.count, 1)
        guard case .text(_, let text) = model.items[0] else { return XCTFail() }
        XCTAssertEqual(text, "Hello world")
    }

    func testApprovalRequestPendingAndAlways() async throws {
        let model = SessionModel(projectRoot: "/tmp/x", bridge: nil, sessionId: "s1")
        let reqJSON = #"{"type":"approval_request","request":{"tool":"run_command","input":{"command":"rm -rf build"},"decision":{"level":"approval","reason":"destructive"},"reason":"clean"}}"#
        try model.consume(note("s1", reqJSON, requestId: "req_2"))
        XCTAssertNotNil(model.pendingApproval)
        XCTAssertEqual(model.pendingApproval?.request.tool, "run_command")

        model.respondApproval(allow: true, always: true)
        XCTAssertNil(model.pendingApproval)
        guard case .approval(_, _, _, let resp) = model.items.last else { return XCTFail() }
        XCTAssertEqual(resp, .alwaysAllowed)
    }

    func testAutoAllowedRequestHasNoRequestId() async throws {
        let model = SessionModel(projectRoot: "/tmp/x", bridge: nil, sessionId: "s1")
        let reqJSON = #"{"type":"approval_request","request":{"tool":"run_command","input":{"command":"ls"},"decision":{"level":"approval","reason":"x"},"reason":null}}"#
        try model.consume(note("s1", reqJSON))
        XCTAssertNil(model.pendingApproval)
        XCTAssertEqual(model.autoAllowCount, 1)
        guard case .approval(_, _, let reqId, let resp) = model.items.last else { return XCTFail() }
        XCTAssertNil(reqId)
        XCTAssertEqual(resp, .autoAllowed)
    }

    func testToolLifecycleAndDone() async throws {
        let model = SessionModel(projectRoot: "/tmp/x", bridge: nil, sessionId: "s1")
        try model.consume(note("s1", #"{"type":"tool_start","tool":"write_file","input":{"path":"src/index.js"}}"#))
        try model.consume(note("s1", #"{"type":"tool_end","tool":"write_file","result":{"content":"wrote 10 lines","changedFile":"src/index.js","diff":"+x"}}"#))
        try model.consume(note("s1", #"{"type":"usage","usage":{"inputTokens":10,"outputTokens":5}}"#))
        try model.consume(note("s1", #"{"type":"done","result":{"status":"completed","summary":"ok","filesChanged":["src/index.js"],"commands":[],"toolCalls":1,"sessionId":"s1","usage":{"inputTokens":10,"outputTokens":5}}}"#))

        XCTAssertFalse(model.running)
        XCTAssertEqual(model.result?.status, "completed")
        XCTAssertEqual(model.usage?.inputTokens, 10)
        XCTAssertEqual(model.changedFiles.map(\.path), ["src/index.js"])
        XCTAssertEqual(model.changedFiles.first?.diff, "+x")
        guard case .done = model.items.last else { return XCTFail() }
    }

    func testEventsForOtherSessionsAreIgnored() async throws {
        let model = SessionModel(projectRoot: "/tmp/x", bridge: nil, sessionId: "s1")
        try model.consume(note("other", #"{"type":"text","text":"nope"}"#))
        XCTAssertTrue(model.items.isEmpty)
    }
}
