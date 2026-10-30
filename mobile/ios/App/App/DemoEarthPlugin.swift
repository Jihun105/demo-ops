import UIKit
import Capacitor

@objc(DemoEarthPlugin)
public class DemoEarthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DemoEarthPlugin"
    public let jsName = "DemoEarth"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)]
    @objc func open(_ call: CAPPluginCall) {
        guard let address = call.getString("address")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !address.isEmpty, address.utf16.count <= 500 else {
            call.reject("묘지 주소가 없습니다. 고객 정보를 확인해주세요."); return
        }
        var app = URLComponents(string: "nmap://search")!
        app.queryItems = [URLQueryItem(name: "query", value: address), URLQueryItem(name: "appname", value: "kr.demo.field")]
        let encoded = address.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        guard let appURL = app.url,
              let webURL = URL(string: "https://map.naver.com/p/search/\(encoded)?c=15.00,0,0,2,dh") else {
            call.reject("묘지 주소를 확인해주세요."); return
        }
        DispatchQueue.main.async {
            // Opening the registered scheme reports false if Naver is absent; no app inventory needed.
            UIApplication.shared.open(appURL) { opened in
                if opened { call.resolve(["target": "maps"]); return }
                UIApplication.shared.open(webURL) { ok in
                    if ok { call.resolve(["target": "web"]) } else { call.reject("네이버 지도를 열지 못했습니다.") }
                }
            }
        }
    }
}
