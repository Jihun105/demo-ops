import Foundation
import Network

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}
func rejects(_ message: String, _ operation: () throws -> Void) {
    do { try operation(); fatalError(message) } catch { }
}
let directory = FileManager.default.temporaryDirectory.appendingPathComponent("demo-ios-tests-\(UUID())")
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: directory) }
let file = directory.appendingPathComponent("outbox.json")
let workspace = UUID().uuidString, otherWorkspace = UUID().uuidString, claim = UUID().uuidString
let outbox = try DemoOutbox(file: file)
rejects("Invalid IDs must be refused") { _ = try outbox.begin(claim: "bad", workspace: workspace, retry: false) }
let first = try outbox.begin(claim: claim, workspace: workspace, retry: false)
check(first.status == "submitted", "Persist before presenting composer")
check(outbox.list(workspace: otherWorkspace).isEmpty, "Do not expose another company's jobs")
rejects("No duplicate presentation") { _ = try outbox.begin(claim: claim, workspace: workspace, retry: true) }
let restored = try DemoOutbox(file: file)
check(restored.list(workspace: workspace).first?.status == "unknown", "Interrupted composer cannot imply delivery")
rejects("Uncertain results cannot be retried") { _ = try restored.begin(claim: claim, workspace: workspace, retry: true) }
_ = try outbox.finish(claim: claim, status: "failed")
rejects("Retry must be explicit") { _ = try outbox.begin(claim: claim, workspace: workspace, retry: false) }
rejects("Cannot move a job between companies") { _ = try outbox.begin(claim: claim, workspace: otherWorkspace, retry: true) }
let retry = try outbox.begin(claim: claim, workspace: workspace, retry: true)
check(retry.attemptId != first.attemptId, "Retry has a distinct attempt")
_ = try outbox.finish(claim: claim, status: "sent")
let completedOutbox = try DemoOutbox(file: file)
check(completedOutbox.list(workspace: workspace).first?.status == "sent", "Completed result survives restart")
rejects("Completed results cannot be resent") { _ = try outbox.begin(claim: claim, workspace: workspace, retry: true) }
try Data("corrupted".utf8).write(to: file)
rejects("Corrupt history must fail closed") { _ = try DemoOutbox(file: file) }
print("PASS: persistent iOS delivery state, company isolation and duplicate prevention")

// Exercise the actual loopback server without Google requests or customer data.
try Data("test-frame".utf8).write(to: directory.appendingPathComponent("map-frame.html"))
let server = DemoMapServer(root: directory, port: 0)
var completed = false
server.start { result in
    guard case .success(let address) = result else { fatalError("Map listener could not start: \(result)") }
    let base = URL(string: address)!.deletingLastPathComponent()
    let cases: [(URL, Int, String?)] = [
        (URL(string: address)!, 200, "test-frame"),
        (base.appendingPathComponent("map-bootstrap.js"), 200, "window.DemoMapParentOrigin = 'capacitor://localhost';"),
        (base.appendingPathComponent("outbox.json"), 404, nil),
        (base.deletingLastPathComponent().appendingPathComponent("wrong/map-frame.html"), 404, nil),
    ]
    var remaining = cases.count
    for (url, expectedCode, expectedBody) in cases {
        URLSession.shared.dataTask(with: url) { data, response, error in
            check(error == nil, "Map request failed: \(String(describing: error))")
            check((response as? HTTPURLResponse)?.statusCode == expectedCode, "Unexpected map HTTP response")
            if let expectedBody { check(String(data: data ?? Data(), encoding: .utf8) == expectedBody, "Wrong static asset") }
            DispatchQueue.main.async {
                remaining -= 1
                if remaining == 0 { server.stop(); completed = true }
            }
        }.resume()
    }
}
let deadline = Date().addingTimeInterval(15)
while !completed && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
check(completed, "Map server timed out")
print("PASS: loopback map assets, parent origin, token and file allowlist")
