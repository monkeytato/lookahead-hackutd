import Foundation

/// Talks to the laptop: `npm run dev:lan` serves the dashboard on port 5173 and proxies `/api`
/// to the bridge, so the phone only needs the laptop's Wi-Fi address.
struct BridgeClient {
    let base: URL
    var session: URLSession = .shared

    enum ClientError: LocalizedError {
        case badAddress
        case http(Int, String)

        var errorDescription: String? {
            switch self {
            case .badAddress: return "That address doesn't look right. Use the laptop's Network address, e.g. 192.168.1.20:5173."
            case .http(let code, let body): return "The laptop answered \(code). \(body)"
            }
        }
    }

    /// "192.168.1.20", "192.168.1.20:5173" or "http://host:5173/" → http://host:5173
    static func baseURL(from address: String) -> URL? {
        var s = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard var parts = URLComponents(string: s), let host = parts.host, !host.isEmpty else { return nil }
        if parts.port == nil { parts.port = 5173 }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        return parts.url
    }

    func summary() async throws -> PhoneSummary {
        try PhoneSummary.decode(try await send("GET", "/api/phone", body: nil))
    }

    /// Any stage command, e.g. `.play`, `.lookahead(20)`; see StageCommand.
    func stage(_ cmd: StageCommand) async throws {
        _ = try await send("POST", "/api/stage", body: try JSONEncoder().encode(StageEnvelope(cmd: cmd)))
    }

    /// The laptop picks a random disaster and starts it.
    func randomDisaster() async throws -> PhoneSummary {
        try PhoneSummary.decode(try await send("POST", "/api/phone/random", body: Data("{}".utf8)))
    }

    /// The laptop checks the fix is still valid at the current minute and orders it.
    func orderFix(_ fix: FixOption) async throws -> PhoneSummary {
        let body = try JSONEncoder().encode(FixIntent(assetId: fix.assetId, action: fix.action))
        return try PhoneSummary.decode(try await send("POST", "/api/phone/fix", body: body))
    }

    private func send(_ method: String, _ path: String, body: Data?) async throws -> Data {
        guard let url = URL(string: path, relativeTo: base) else { throw ClientError.badAddress }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        req.httpMethod = method
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw ClientError.http(code, String(decoding: data.prefix(160), as: UTF8.self))
        }
        return data
    }
}

/// Mirrors src/stage/protocol.ts StageCommand (only the ones the phone sends).
struct StageCommand: Encodable, Equatable {
    let type: String
    var dt: Double? = nil
    var min: Double? = nil
    var on: Bool? = nil

    static let play = StageCommand(type: "play")
    static let pause = StageCommand(type: "pause")
    static func jump(_ minutes: Double) -> StageCommand { StageCommand(type: "jump", dt: minutes) }
    static func lookahead(_ minutes: Double) -> StageCommand { StageCommand(type: "lookahead", min: minutes) }
    static func autoPause(_ on: Bool) -> StageCommand { StageCommand(type: "autopause", on: on) }
}

private struct StageEnvelope: Encodable { let cmd: StageCommand }
private struct FixIntent: Encodable { let assetId: String; let action: String }
