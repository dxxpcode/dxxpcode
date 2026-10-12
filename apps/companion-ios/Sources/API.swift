import Foundation

// REST + SSE client for `dxxpcode serve` (see apps/agent-rs/src/serve.rs).
struct DxxpAPI {
    let pair: PairInfo
    private var base: URL { pair.baseURL }

    private func request(_ path: String, method: String, body: Data? = nil) throws -> URLRequest {
        var r = URLRequest(url: base.appending(path: path))
        r.httpMethod = method
        r.setValue("Bearer \(pair.token)", forHTTPHeaderField: "Authorization")
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    private func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        let (data, resp) = try await URLSession.shared.data(for: request(path, method: "GET"))
        try check(resp, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func check(_ resp: URLResponse, _ data: Data) throws {
        guard let h = resp as? HTTPURLResponse, (200..<300).contains(h.statusCode) else {
            throw ApiError(http: (resp as? HTTPURLResponse)?.statusCode ?? -1,
                           body: String(data: data, encoding: .utf8) ?? "")
        }
    }

    struct ApiError: LocalizedError {
        let http: Int
        let body: String
        var errorDescription: String? { http == 401 ? "Unauthorized — pair again" : "HTTP \(http): \(body.prefix(200))" }
    }

    // MARK: Models (serve.rs wire shapes)

    struct Health: Decodable { let name: String; let version: String; let api: Int }

    struct TaskSummary: Decodable, Identifiable {
        let task_id: String
        let status: String
        let task: String
        let project_root: String
        let result: ResultInfo?
        var id: String { task_id }
        var title: String { task }
        var cwd: String { project_root }
    }

    struct ResultInfo: Decodable {
        let status: String?
        let summary: String?
        let filesChanged: [String]?
    }

    struct Project: Decodable, Identifiable {
        var id: String { root }
        let name: String
        let root: String
        let last_used: Int64?
    }

    struct NewTask: Encodable {
        var prompt: String
        var cwd: String?
        var planOnly: Bool?
        var autoApprove: Bool?
        var mode: String?
    }

    // MARK: Endpoints

    func health() async throws -> Health { try await get("health", as: Health.self) }
    func tasks() async throws -> [TaskSummary] { try await get("tasks", as: [TaskSummary].self) }
    func projects() async throws -> [Project] { try await get("projects", as: [Project].self) }

    @discardableResult
    func createTask(_ t: NewTask) async throws -> String {
        let (data, resp) = try await URLSession.shared.data(for: request("tasks", method: "POST", body: JSONEncoder().encode(t)))
        try check(resp, data)
        return (try? JSONDecoder().decode([String: String].self, from: data))?["task_id"] ?? ""
    }

    func input(task: String, type: String, id: Int? = nil, choice: String? = nil, plan: [String: AnyCodable]? = nil, text: String? = nil) async throws {
        var b: [String: AnyCodable] = ["type": AnyCodable(type)]
        if let id { b["id"] = AnyCodable(id) }
        if let choice { b["choice"] = AnyCodable(choice) }
        if let plan { b["plan"] = AnyCodable(plan) }
        if let text { b["text"] = AnyCodable(text) }
        let (data, resp) = try await URLSession.shared.data(
            for: request("tasks/\(task)/input", method: "POST", body: JSONEncoder().encode(b)))
        try check(resp, data)
    }

    func deleteTask(_ id: String) async throws {
        let (data, resp) = try await URLSession.shared.data(for: request("tasks/\(id)", method: "DELETE"))
        try check(resp, data)
    }

    // MARK: SSE — `id: <index>` + `data: <json>` per stored/live event.
    struct SSEvent {
        let id: Int
        let json: [String: AnyCodable]
    }

    func events(task: String, lastEventId: Int? = nil) -> AsyncThrowingStream<SSEvent, Error> {
        AsyncThrowingStream { cont in
            let req: URLRequest
            do {
                var r = try request("tasks/\(task)/events", method: "GET")
                if let lastEventId { r.setValue("\(lastEventId)", forHTTPHeaderField: "Last-Event-ID") }
                req = r
            } catch {
                cont.finish(throwing: error); return
            }
            let taskObj = URLSession.shared.dataTask(with: req) { _, _, _ in }
            cont.onTermination = { _ in taskObj.cancel() }
            Task {
                do {
                    let (bytes, resp) = try await URLSession.shared.bytes(for: req)
                    try check(resp, Data())
                    var pendingId: Int?
                    for try await line in bytes.lines {
                        if line.hasPrefix("id: ") {
                            pendingId = Int(line.dropFirst(4))
                        } else if line.hasPrefix("data: ") {
                            let payload = String(line.dropFirst(6))
                            if let data = payload.data(using: .utf8),
                               let json = try? JSONDecoder().decode([String: AnyCodable].self, from: data) {
                                cont.yield(SSEvent(id: pendingId ?? -1, json: json))
                            }
                            pendingId = nil
                        }
                    }
                    cont.finish()
                } catch {
                    cont.finish(throwing: error)
                }
            }
        }
    }
}

// Tiny dynamic Codable for wire JSON we render but don't model statically.
struct AnyCodable: Codable {
    let value: Any
    init(_ v: Any) { value = v }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { value = b }
        else if let i = try? c.decode(Int.self) { value = i }
        else if let d = try? c.decode(Double.self) { value = d }
        else if let s = try? c.decode(String.self) { value = s }
        else if let a = try? c.decode([AnyCodable].self) { value = a.map(\.value) }
        else if let o = try? c.decode([String: AnyCodable].self) { value = o.mapValues(\.value) }
        else { value = NSNull() }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let b as Bool: try c.encode(b)
        case let i as Int: try c.encode(i)
        case let d as Double: try c.encode(d)
        case let s as String: try c.encode(s)
        case let a as [Any]: try c.encode(a.map(AnyCodable.init))
        case let o as [String: Any]: try c.encode(o.mapValues(AnyCodable.init))
        default: try c.encodeNil()
        }
    }

    var string: String? { value as? String }
    var int: Int? { value as? Int }
    var bool: Bool? { value as? Bool }
    var obj: [String: Any]? { value as? [String: Any] }
    var arr: [Any]? { value as? [Any] }
}
