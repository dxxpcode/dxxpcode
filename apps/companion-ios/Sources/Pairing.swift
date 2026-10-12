import Foundation
import Security

// dxxpcode://pair?host=<ip>&port=8787&token=<dxp_…>&v=1 — printed by
// `dxxpcode serve --lan` and encoded in the desktop QR card.
struct PairInfo: Codable, Equatable {
    var host: String
    var port: Int
    var token: String

    var baseURL: URL { URL(string: "http://\(host):\(port)")! }

    init(host: String, port: Int, token: String) {
        self.host = host; self.port = port; self.token = token
    }

    init?(url: URL) {
        guard url.scheme == "dxxpcode", url.host == "pair",
              let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = c.queryItems?.first(where: { $0.name == "host" })?.value,
              let port = c.queryItems?.first(where: { $0.name == "port" })?.value.flatMap(Int.init),
              let token = c.queryItems?.first(where: { $0.name == "token" })?.value
        else { return nil }
        self.host = host; self.port = port; self.token = token
    }
}

// Token lives in the Keychain; host/port (not secret) in UserDefaults.
enum PairStore {
    private static let service = "dev.dxxpcode.companion"
    private static let account = "pair-token"
    private static let hostKey = "pair-host"
    private static let portKey = "pair-port"

    static func save(_ p: PairInfo) {
        UserDefaults.standard.set(p.host, forKey: hostKey)
        UserDefaults.standard.set(p.port, forKey: portKey)
        let data = Data(p.token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        SecItemAdd(add as CFDictionary, nil)
    }

    static func load() -> PairInfo? {
        guard let host = UserDefaults.standard.string(forKey: hostKey) else { return nil }
        let port = UserDefaults.standard.integer(forKey: portKey)
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let token = String(data: data, encoding: .utf8)
        else { return nil }
        query[kSecReturnData as String] = nil
        return PairInfo(host: host, port: port, token: token)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: hostKey)
        UserDefaults.standard.removeObject(forKey: portKey)
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }
}
