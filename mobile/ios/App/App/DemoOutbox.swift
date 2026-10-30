import Foundation

// Only delivery state is stored here, never message bodies or photos.
struct DemoDeliveryJob: Codable {
    let claimId: String
    let workspaceId: String
    let attemptId: String
    var eventId: String
    var status: String
    var updatedAt: Double
    var js: [String: Any] {
        ["claimId": claimId, "workspaceId": workspaceId, "attemptId": attemptId,
         "eventId": eventId, "status": status, "updatedAt": updatedAt]
    }
}
final class DemoOutbox {
    private let file: URL
    private var jobs: [String: DemoDeliveryJob]
    init(file: URL) throws {
        self.file = file
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        jobs = FileManager.default.fileExists(atPath: file.path)
            ? try JSONDecoder().decode([String: DemoDeliveryJob].self, from: Data(contentsOf: file)) : [:]
        for (id, var job) in jobs where job.status == "submitted" {
            job.status = "unknown"
            job.eventId = UUID().uuidString
            job.updatedAt = Date().timeIntervalSince1970 * 1000
            jobs[id] = job
        }
        try save()
    }
    func list(workspace: String) -> [DemoDeliveryJob] { jobs.values.filter { $0.workspaceId == workspace } }
    func begin(claim: String, workspace: String, retry: Bool) throws -> DemoDeliveryJob {
        guard UUID(uuidString: claim) != nil, UUID(uuidString: workspace) != nil else {
            throw NSError(domain: "Demo", code: 1, userInfo: [NSLocalizedDescriptionKey: "청구 정보를 확인해주세요."])
        }
        if let old = jobs[claim], old.workspaceId != workspace || old.status != "failed" || !retry {
            throw NSError(domain: "Demo", code: 2, userInfo: [NSLocalizedDescriptionKey: "이미 처리 중이거나 전송 결과 확인이 필요한 문자입니다."])
        }
        let job = DemoDeliveryJob(claimId: claim, workspaceId: workspace, attemptId: UUID().uuidString,
                                  eventId: UUID().uuidString, status: "submitted", updatedAt: Date().timeIntervalSince1970 * 1000)
        let previous = jobs[claim]
        jobs[claim] = job
        do { try save() } catch { jobs[claim] = previous; throw error }
        return job
    }
    func finish(claim: String, status: String) throws -> DemoDeliveryJob {
        guard var job = jobs[claim], ["sent", "failed", "unknown"].contains(status) else {
            throw NSError(domain: "Demo", code: 3, userInfo: [NSLocalizedDescriptionKey: "전송 기록을 확인할 수 없습니다."])
        }
        job.status = status
        job.eventId = UUID().uuidString
        job.updatedAt = Date().timeIntervalSince1970 * 1000
        let previous = jobs[claim]
        jobs[claim] = job
        do { try save() } catch { jobs[claim] = previous; throw error }
        return job
    }
    private func save() throws { try JSONEncoder().encode(jobs).write(to: file, options: .atomic) }
}
