import SwiftUI

@main
struct LookaheadApp: App {
    @StateObject private var connection = RemoteConnection()
    var body: some Scene { WindowGroup { RemoteRoot().environmentObject(connection).tint(Color(red: 0, green: 0.494, blue: 0.451)) } }
}

struct RemoteSnapshot: Decodable {
    let revision: Int
    let issues: [RemoteIssue]
    let events: [RemoteEvent]
    let prototype: PrototypeFrame?
    let analyzing: Bool
}
struct RemoteIssue: Decodable, Identifiable {
    let id, kind, assetId, title, location, unit, status, createdAt: String
    let installed: Double
    let evidence: RemoteEvidence?
    let ownerId: String?
    let steps: [RemoteStep]
    let resolution: String?
}
struct RemoteEvidence: Decodable {
    let value: Double
    let unit, source, scanId, at, verdict, note: String
}
struct RemoteStep: Decodable, Identifiable { let id, label: String; let done: Bool }
struct RemoteEvent: Decodable, Identifiable { let id, at, actor, kind, summary, source: String }
struct PrototypeFrame: Decodable {
    let dev, source, at: String
    let ref_c, inlet_bottom_c: Double?
    let vibrating: Bool?
    let floor_raw: Double
    let flags: [String]
}
struct APIError: Decodable { let error: String }

@MainActor
final class RemoteConnection: ObservableObject {
    @Published var snapshot: RemoteSnapshot?
    @Published var connected = false
    @Published var busy = false
    @Published var message: String?
    @Published var error: String?
    @AppStorage("lookahead.laptop") var address = "http://10.190.208.185:5173"
    @AppStorage("lookahead.operator") var operatorName = "Presenter"
    private var refreshing = false
    private let session = URLSession(configuration: .ephemeral)
    func endpoint(_ path: String) throws -> URL {
        guard let base = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              base.scheme == "http" || base.scheme == "https", let host = base.host,
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              base.path.isEmpty || base.path == "/" else {
            throw NSError(domain: "Lookahead", code: 1, userInfo: [NSLocalizedDescriptionKey: "Enter a laptop URL such as http://192.168.1.20:5173."])
        }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        let privateIP = octets.count == 4 && octets.allSatisfy { (0...255).contains($0) } &&
            (octets[0] == 10 || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 172 && (16...31).contains(octets[1])) || octets[0] == 127)
        guard privateIP || host == "localhost" || host.hasSuffix(".local") else {
            throw NSError(domain: "Lookahead", code: 2, userInfo: [NSLocalizedDescriptionKey: "Use your laptop's private LAN address or .local hostname. This controller is for a trusted local demo."])
        }
        return base.appendingPathComponent(path)
    }
    func refresh() async {
        guard !refreshing else { return }; refreshing = true
        defer { refreshing = false }
        do {
            var request = URLRequest(url: try endpoint("api/workflow")); request.timeoutInterval = 5
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let incoming = try JSONDecoder().decode(RemoteSnapshot.self, from: data)
            if incoming.revision >= (snapshot?.revision ?? -1) { snapshot = incoming }
            connected = true
        } catch { connected = false }
    }
    @discardableResult
    func send(_ fields: [String: Any], confirmation: String? = nil) async -> Bool {
        guard !busy else { return false }; busy = true; error = nil
        defer { busy = false }
        do {
            var body = fields; body["actor"] = operatorName.isEmpty ? "iPhone presenter" : operatorName
            var request = URLRequest(url: try endpoint("api/workflow")); request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.timeoutInterval = fields["type"] as? String == "evaluate" ? 95 : 12
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                throw NSError(domain: "Lookahead", code: 3, userInfo: [NSLocalizedDescriptionKey: (try? JSONDecoder().decode(APIError.self, from: data).error) ?? "The laptop rejected this action."])
            }
            let incoming = try JSONDecoder().decode(RemoteSnapshot.self, from: data)
            if incoming.revision >= (snapshot?.revision ?? -1) { snapshot = incoming }
            connected = true; message = confirmation; return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func scan(_ issue: RemoteIssue) async {
        guard !busy else { return }; busy = true; error = nil
        defer { busy = false }
        do {
            var request = URLRequest(url: try endpoint("api/scans/start")); request.httpMethod = "POST"; request.timeoutInterval = 12
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["assetId": issue.assetId, "point": issue.kind == "water" ? "Floor / leak" : issue.kind == "vibration" ? "Vibration / fan housing" : "Front inlet temperature", "operator": operatorName])
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw NSError(domain: "Lookahead", code: 4, userInfo: [NSLocalizedDescriptionKey: (try? JSONDecoder().decode(APIError.self, from: data).error) ?? "Cannot start scan."]) }
            guard let id = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["id"] as? String else { throw URLError(.cannotParseResponse) }
            message = "Scan started. Keep the module steady for 10 seconds."
            try await Task.sleep(for: .seconds(11))
            busy = false
            _ = await send(["type": "verify_scan", "issueId": issue.id, "scanId": id], confirmation: "Independent evidence attached to the incident.")
        } catch { self.error = error.localizedDescription }
    }
}
