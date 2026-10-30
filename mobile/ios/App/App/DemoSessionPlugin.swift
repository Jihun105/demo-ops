import Foundation
import Security
import Capacitor

@objc(DemoSessionPlugin)
public class DemoSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DemoSessionPlugin"
    public let jsName = "DemoSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]
    private let service = "kr.demo.field.session"
    public override func load() {
        // Keychain can survive uninstall. A new installation must start signed out.
        if !UserDefaults.standard.bool(forKey: "demo.keychain.initialized") {
            let status = SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service] as CFDictionary)
            if status == errSecSuccess || status == errSecItemNotFound {
                UserDefaults.standard.set(true, forKey: "demo.keychain.initialized")
            }
        }
    }
    private func query(_ call: CAPPluginCall) -> [String: Any]? {
        guard let key = call.getString("key"), key.hasPrefix("demo-auth-"), key.count < 300 else {
            call.reject("로그인 저장 정보를 확인해주세요."); return nil
        }
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                kSecAttrAccount as String: key, kSecAttrSynchronizable as String: false]
    }
    @objc func get(_ call: CAPPluginCall) {
        guard var q = query(call) else { return }
        q[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            call.reject("잠금 해제 후 로그인을 다시 확인해주세요."); return
        }
        call.resolve(["value": value])
    }
    @objc func set(_ call: CAPPluginCall) {
        guard var q = query(call), let value = call.getString("value"), let data = value.data(using: .utf8) else {
            call.reject("로그인 정보를 저장하지 못했습니다."); return
        }
        var status = SecItemUpdate(q as CFDictionary, [kSecValueData: data] as CFDictionary)
        if status == errSecItemNotFound {
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(q as CFDictionary, nil)
        }
        if status == errSecSuccess { call.resolve() } else { call.reject("로그인 정보를 안전하게 저장하지 못했습니다.") }
    }
    @objc func remove(_ call: CAPPluginCall) {
        guard let q = query(call) else { return }
        let status = SecItemDelete(q as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { call.resolve() }
        else { call.reject("로그아웃 정보를 저장하지 못했습니다. 잠금 해제 후 다시 시도해주세요.") }
    }
}
