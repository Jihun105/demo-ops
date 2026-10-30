import Foundation
import Capacitor

@objc(DemoMapPlugin)
public class DemoMapPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DemoMapPlugin"
    public let jsName = "DemoMap"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "context", returnType: CAPPluginReturnPromise)]
    private var server: DemoMapServer?
    @objc func context(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.server == nil, let root = Bundle.main.resourceURL?.appendingPathComponent("public") {
                self.server = DemoMapServer(root: root)
            }
            guard let server = self.server else { call.reject("지도 파일을 찾지 못했습니다."); return }
            server.start { result in
                switch result {
                case .success(let url): call.resolve(["ok": true, "frameUrl": url])
                case .failure: call.reject("지도를 열지 못했습니다. 앱을 다시 실행해주세요.")
                }
            }
        }
    }
}
