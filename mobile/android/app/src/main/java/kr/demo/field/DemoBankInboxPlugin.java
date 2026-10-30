package kr.demo.field;

import android.Manifest;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.net.URI;

@CapacitorPlugin(
  name = "DemoBankInbox",
  permissions = { @Permission(alias = "receiveSms", strings = { Manifest.permission.RECEIVE_SMS }) }
)
public final class DemoBankInboxPlugin extends Plugin {

  @PluginMethod
  public void status(PluginCall call) {
    try {
      BankInboxStore store = new BankInboxStore(getContext());
      JSObject status = new JSObject();
      status.put("enabled", store.enabled());
      status.put("scope", store.scope());
      status.put("pending", store.jobs().length());
      status.put("error", store.error());
      status.put("permission", getPermissionState("receiveSms") == PermissionState.GRANTED);
      org.json.JSONObject credential = store.credential();
      if (credential != null) {
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(
          credential.getString("token").getBytes(java.nio.charset.StandardCharsets.UTF_8)
        );
        StringBuilder hash = new StringBuilder();
        for (byte b : digest) hash.append(String.format(java.util.Locale.US, "%02x", b & 255));
        status.put("hash", hash.toString());
      }
      call.resolve(status);
    } catch (Exception e) {
      call.reject("입금 문자 보관함을 읽지 못했습니다.");
    }
  }

  @PluginMethod
  public void prepare(PluginCall call) {
    if (getPermissionState("receiveSms") != PermissionState.GRANTED) requestPermissionForAlias(
      "receiveSms",
      call,
      "permissionResult"
    );
    else call.resolve();
  }

  @PermissionCallback
  private void permissionResult(PluginCall call) {
    if (getPermissionState("receiveSms") == PermissionState.GRANTED) call.resolve();
    else call.reject("문자 수신 권한이 필요합니다. 휴대폰의 앱 권한을 확인해주세요.");
  }

  @PluginMethod
  public void enable(PluginCall call) {
    try {
      if (getPermissionState("receiveSms") != PermissionState.GRANTED) throw new Exception(
        "문자 수신 권한이 필요합니다."
      );
      String endpoint = call.getString("endpoint", ""),
        token = call.getString("token", ""),
        scope = call.getString("scope", "");
      URI uri = new URI(endpoint);
      if (
        !"https".equals(uri.getScheme()) ||
        uri.getHost() == null ||
        uri.getUserInfo() != null ||
        uri.getFragment() != null ||
        !token.matches("demo_bank_[a-f0-9]{64}") ||
        !scope.matches("[a-f0-9-]{36}:[a-f0-9-]{36}")
      ) throw new Exception("입금 수신 연결 설정을 확인해주세요.");
      new BankInboxStore(getContext()).configure(scope, endpoint, token);
      BankInboxWorker.enqueue(getContext());
      call.resolve();
    } catch (Exception e) {
      call.reject(e.getMessage() == null ? "입금 수신을 설정하지 못했습니다." : e.getMessage());
    }
  }

  // Tries the kept receipts again, e.g. when 설정 is opened after the server was fixed.
  @PluginMethod
  public void flush(PluginCall call) {
    try {
      if (new BankInboxStore(getContext()).enabled()) BankInboxWorker.enqueue(getContext());
      call.resolve();
    } catch (Exception e) {
      call.reject("입금 문자를 다시 보내지 못했습니다.");
    }
  }

  @PluginMethod
  public void disable(PluginCall call) {
    try {
      new BankInboxStore(getContext()).disable();
      call.resolve();
    } catch (Exception e) {
      call.reject("입금 수신 중단을 저장하지 못했습니다.");
    }
  }
}
