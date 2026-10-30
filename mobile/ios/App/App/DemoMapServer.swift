import Foundation
import Network

// Loopback-only static map frame, matching the desktop's allowed Google referrer.
// This server never reads customer records, sessions or photos.
final class DemoMapServer {
    private let root: URL
    private let port: UInt16
    private let token = UUID().uuidString
    private var listener: NWListener?
    private var ready = false
    private var waiters: [(Result<String, Error>) -> Void] = []
    private let assets = ["map-frame.html": "text/html; charset=utf-8", "map-renderer.js": "text/javascript; charset=utf-8",
                          "map-bootstrap.js": "text/javascript; charset=utf-8", "map-boundaries.js": "text/javascript; charset=utf-8",
                          "map-frame.css": "text/css; charset=utf-8"]
    init(root: URL, port: UInt16 = 8092) { self.root = root; self.port = port }
    private var host: String { "127.0.0.1:\(listener?.port?.rawValue ?? port)" }
    var url: String { "http://\(host)/\(token)/map-frame.html" }
    func start(_ completion: @escaping (Result<String, Error>) -> Void) {
        if ready { completion(.success(url)); return }
        waiters.append(completion)
        if listener != nil { return }
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
            let next = try NWListener(using: parameters)
            listener = next
            next.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready: self.ready = true; self.complete(.success(self.url))
                case .failed(let error): self.stop(); self.complete(.failure(error))
                default: break
                }
            }
            next.newConnectionHandler = { [weak self] connection in
                guard let self else { connection.cancel(); return }
                connection.start(queue: .main)
                self.read(connection, buffer: Data())
                DispatchQueue.main.asyncAfter(deadline: .now() + 10) { connection.cancel() }
            }
            next.start(queue: .main)
        } catch { stop(); complete(.failure(error)) }
    }
    func stop() { listener?.cancel(); listener = nil; ready = false }
    private func complete(_ result: Result<String, Error>) {
        let calls = waiters; waiters.removeAll(); calls.forEach { $0(result) }
    }
    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, finished, error in
            guard let self else { connection.cancel(); return }
            var request = buffer; if let data { request.append(data) }
            guard request.count <= 16384, error == nil else { connection.cancel(); return }
            if let text = String(data: request, encoding: .utf8), text.contains("\r\n\r\n") {
                self.respond(connection, request: text)
            } else if finished { connection.cancel() } else { self.read(connection, buffer: request) }
        }
    }
    private func respond(_ connection: NWConnection, request: String) {
        let lines = request.components(separatedBy: "\r\n")
        let first = (lines.first ?? "").split(separator: " ")
        let host = lines.dropFirst().first { $0.lowercased().hasPrefix("host:") }?.dropFirst(5).trimmingCharacters(in: .whitespaces)
        let path = first.count == 3 ? String(first[1]).components(separatedBy: "/") : []
        var body = Data(), type = "text/plain", status = "404 Not Found"
        if first.count == 3, first[0] == "GET", host == self.host,
           path.count == 3, path[0].isEmpty, path[1] == token, let mime = assets[path[2]] {
            if path[2] == "map-bootstrap.js" {
                body = Data("window.DemoMapParentOrigin = 'capacitor://localhost';".utf8)
                status = "200 OK"; type = mime
            } else if let data = try? Data(contentsOf: root.appendingPathComponent(path[2])) {
                body = data; status = "200 OK"; type = mime
            }
        }
        let head = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
    }
    deinit { listener?.cancel() }
}
