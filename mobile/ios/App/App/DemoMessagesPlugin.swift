import UIKit
import MessageUI
import UniformTypeIdentifiers
import Capacitor

@objc(DemoMessagesPlugin)
public class DemoMessagesPlugin: CAPPlugin, CAPBridgedPlugin, MFMessageComposeViewControllerDelegate {
    public let identifier = "DemoMessagesPlugin"
    public let jsName = "DemoMessages"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listJobs", returnType: CAPPluginReturnPromise)
    ]
    private var outbox: DemoOutbox?
    private var pending: (call: CAPPluginCall, claim: String)?
    public override func load() {
        do {
            var directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("Demo", isDirectory: true)
            outbox = try DemoOutbox(file: directory.appendingPathComponent("outbox.json"))
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        } catch { outbox = nil }
    }
    @objc func listJobs(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let outbox = self.outbox, let ws = call.getString("workspaceId") else {
                call.reject("전송 기록을 불러오지 못했습니다."); return
            }
            call.resolve(["jobs": outbox.list(workspace: ws).map { $0.js }])
        }
    }
    @objc func send(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.presentMessage(call) }
    }
    private func presentMessage(_ call: CAPPluginCall) {
        guard pending == nil, let view = bridge?.viewController, view.presentedViewController == nil else {
            call.reject("열린 화면을 닫은 뒤 다시 시도해주세요."); return
        }
        guard MFMessageComposeViewController.canSendText() else {
            call.reject("이 아이폰에서 문자 발송을 사용할 수 없습니다. 유심과 메시지 설정을 확인해주세요."); return
        }
        guard let outbox, let claim = call.getString("claimId"), let ws = call.getString("workspaceId"),
              let phone = call.getString("phone"), phone.range(of: "^0[0-9]{7,10}$", options: .regularExpression) != nil,
              let body = call.getString("body"), !body.isEmpty, body.count <= 4000,
              let photos = call.getArray("photos", JSObject.self), photos.count <= 10 else {
            call.reject("수신번호와 문자 내용을 확인해주세요."); return
        }
        if !photos.isEmpty && !MFMessageComposeViewController.canSendAttachments() {
            call.reject("사진 문자를 사용할 수 없습니다. MMS 설정을 확인해주세요."); return
        }
        let composer = MFMessageComposeViewController()
        composer.messageComposeDelegate = self
        composer.recipients = [phone]
        composer.body = body
        var bytes = 0
        for (index, photo) in photos.enumerated() {
            guard let raw = photo["data"] as? String, raw.count <= 28_000_000,
                  let mime = photo["type"] as? String, ["image/jpeg", "image/png", "image/webp"].contains(mime),
                  raw.hasPrefix("data:\(mime);base64,"), let comma = raw.firstIndex(of: ","),
                  let data = Data(base64Encoded: String(raw[raw.index(after: comma)...])), !data.isEmpty,
                  let type = UTType(mimeType: mime) else {
                call.reject("첨부 사진을 읽지 못했습니다."); return
            }
            bytes += data.count
            guard bytes <= 20 * 1024 * 1024,
                  composer.addAttachmentData(data, typeIdentifier: type.identifier, filename: "작업사진-\(index + 1).\(type.preferredFilenameExtension ?? "jpg")") else {
                call.reject("사진을 첨부하지 못했습니다. 사진 크기와 개수를 줄여주세요."); return
            }
        }
        do {
            _ = try outbox.begin(claim: claim, workspace: ws, retry: call.getBool("retry", false))
            pending = (call, claim)
            composer.isModalInPresentation = true
            view.present(composer, animated: true)
        } catch { call.reject(error.localizedDescription) }
    }
    public func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
        guard let request = pending, let outbox else { controller.dismiss(animated: true); return }
        let status: String
        switch result { case .sent: status = "sent"; case .cancelled, .failed: status = "failed"; @unknown default: status = "unknown" }
        // Apple's sent result means accepted by Messages, not delivery to the recipient.
        do {
            let job = try outbox.finish(claim: request.claim, status: status)
            controller.dismiss(animated: true) { request.call.resolve(job.js) }
        } catch {
            controller.dismiss(animated: true) { request.call.reject("문자 결과 저장에 실패했습니다. 실제 발송 내역을 확인해주세요.") }
        }
        pending = nil
    }
}
