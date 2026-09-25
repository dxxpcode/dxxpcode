import Foundation

/// One newline-delimited JSON-RPC 2.0 stdio connection to a `dxxpcode-agent`
/// process. Requests are correlated by integer id; every `event` notification
/// is delivered in order on `events`.
final class BridgeClient: @unchecked Sendable {
    enum ClientError: Error {
        case rpc(RpcErrorBody)
        case closed
    }

    private let process: Process
    private let stdinHandle: FileHandle
    private var readerTask: Task<Void, Never>?
    private var nextId = 0
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private let lock = NSLock()

    private let eventContinuation: AsyncStream<EventNotification>.Continuation
    let events: AsyncStream<EventNotification>

    /// Launch a process speaking the bridge protocol.
    /// - Parameters:
    ///   - executable: binary or `node`; `arguments` may carry a `.js` entry.
    ///   - environment: full environment for the child (nil → inherit).
    init(executable: URL, arguments: [String], environment: [String: String]? = nil) throws {
        let proc = Process()
        let outPipe = Pipe()
        let inPipe = Pipe()
        let errPipe = Pipe()
        proc.executableURL = executable
        proc.arguments = arguments
        proc.standardOutput = outPipe
        proc.standardInput = inPipe
        proc.standardError = errPipe
        if let environment { proc.environment = environment }
        self.process = proc
        self.stdinHandle = inPipe.fileHandleForWriting
        var cont: AsyncStream<EventNotification>.Continuation!
        self.events = AsyncStream { cont = $0 }
        self.eventContinuation = cont
        try proc.run()
        startReading(outPipe.fileHandleForReading)
        // agentd writes diagnostics to stderr; forward them to ours.
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if !data.isEmpty { FileHandle.standardError.write(data) }
        }
    }

    private func startReading(_ handle: FileHandle) {
        readerTask = Task.detached { [weak self] in
            do {
                for try await line in handle.bytes.lines {
                    guard let self else { return }
                    await self.dispatch(line)
                }
            } catch {
                // fall through to close
            }
            self?.failAll()
        }
    }

    private func dispatch(_ line: String) async {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let id = obj["id"] as? Int {
            let cont: CheckedContinuation<JSONValue, Error>? = lock.withLock {
                pending.removeValue(forKey: id)
            }
            guard let cont else { return }
            if let errorObj = obj["error"] {
                let errBody = (try? JSONDecoder().decode(
                    RpcErrorBody.self,
                    from: JSONSerialization.data(withJSONObject: errorObj)
                )) ?? RpcErrorBody(code: -32000, message: "unknown error")
                cont.resume(throwing: ClientError.rpc(errBody))
            } else {
                let resultObj = obj["result"] ?? NSNull()
                let value = (try? JSONDecoder().decode(
                    JSONValue.self,
                    from: JSONSerialization.data(withJSONObject: resultObj)
                )) ?? .null
                cont.resume(returning: value)
            }
        } else if obj["method"] as? String == "event",
                  let params = obj["params"],
                  let note = try? JSONDecoder().decode(
                      EventNotification.self,
                      from: JSONSerialization.data(withJSONObject: params)
                  ) {
            eventContinuation.yield(note)
        }
    }

    private func failAll() {
        let drained: [Int: CheckedContinuation<JSONValue, Error>] = lock.withLock {
            let p = pending
            pending.removeAll()
            return p
        }
        for cont in drained.values { cont.resume(throwing: ClientError.closed) }
        eventContinuation.finish()
    }

    /// Send a request and await its response.
    @discardableResult
    func call(_ method: String, params: JSONValue = .object([:])) async throws -> JSONValue {
        let id: Int = lock.withLock {
            nextId += 1
            return nextId
        }
        let message: JSONValue = [
            "jsonrpc": "2.0",
            "id": .number(Double(id)),
            "method": .string(method),
            "params": params,
        ]
        var line = try JSONEncoder().encode(message)
        line.append(contentsOf: [0x0A])
        return try await withCheckedThrowingContinuation { cont in
            lock.withLock { pending[id] = cont }
            do {
                try stdinHandle.write(contentsOf: line)
            } catch {
                lock.withLock { _ = pending.removeValue(forKey: id) }
                cont.resume(throwing: error)
            }
        }
    }

    /// Typed convenience: decode the result into `T`.
    @discardableResult
    func call<T: Decodable>(_ method: String, params: JSONValue = .object([:]), as type: T.Type) async throws -> T {
        let value = try await call(method, params: params)
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Send a fire-and-forget notification (no id → no response).
    func notify(_ method: String, params: JSONValue = .object([:])) {
        let message: JSONValue = [
            "jsonrpc": "2.0",
            "method": .string(method),
            "params": params,
        ]
        guard let line = try? JSONEncoder().encode(message) else { return }
        try? stdinHandle.write(contentsOf: line + Data([0x0A]))
    }

    /// Ask the bridge to shut down, then terminate the process.
    func close() {
        notify(BridgeMethod.shutdown)
        let proc = process
        Task.detached {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if proc.isRunning { proc.terminate() }
        }
    }

    deinit {
        if process.isRunning { process.terminate() }
    }
}
