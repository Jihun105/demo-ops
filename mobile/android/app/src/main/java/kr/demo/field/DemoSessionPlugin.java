package kr.demo.field;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "DemoSession")
public class DemoSessionPlugin extends Plugin {

  private static final String ALIAS = "demo-login-v1";

  private SharedPreferences preferences() {
    return getContext().getSharedPreferences("demo-login", Context.MODE_PRIVATE);
  }

  private synchronized SecretKey secret() throws Exception {
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
    keys.load(null);
    if (!keys.containsAlias(ALIAS)) {
      KeyGenerator generator = KeyGenerator.getInstance(
        KeyProperties.KEY_ALGORITHM_AES,
        "AndroidKeyStore"
      );
      generator.init(
        new KeyGenParameterSpec.Builder(
          ALIAS,
          KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .build()
      );
      generator.generateKey();
    }
    return (SecretKey) keys.getKey(ALIAS, null);
  }

  private String key(PluginCall call) throws Exception {
    String key = call.getString("key", "");
    if (!key.matches("demo-auth-[a-zA-Z0-9._-]{1,150}")) throw new Exception("Invalid key");
    return key;
  }

  @PluginMethod
  public void get(PluginCall call) {
    try {
      String value = preferences().getString(key(call), null);
      JSObject result = new JSObject();
      if (value == null) result.put("value", JSObject.NULL);
      else {
        String[] parts = value.split(":", 2);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(
          Cipher.DECRYPT_MODE,
          secret(),
          new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP))
        );
        result.put(
          "value",
          new String(
            cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)),
            StandardCharsets.UTF_8
          )
        );
      }
      call.resolve(result);
    } catch (Exception error) {
      call.reject("저장된 로그인을 읽지 못했습니다. 다시 로그인해주세요.");
    }
  }

  @PluginMethod
  public void set(PluginCall call) {
    try {
      String key = key(call),
        value = call.getString("value");
      if (value == null || value.length() > 100000) throw new Exception("Invalid session");
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, secret());
      String encoded =
        Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) +
        ":" +
        Base64.encodeToString(
          cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),
          Base64.NO_WRAP
        );
      if (!preferences().edit().putString(key, encoded).commit()) throw new Exception(
        "Storage unavailable"
      );
      call.resolve();
    } catch (Exception error) {
      call.reject("로그인을 안전하게 저장하지 못했습니다. 기기 저장 공간을 확인해주세요.");
    }
  }

  @PluginMethod
  public void remove(PluginCall call) {
    try {
      if (!preferences().edit().remove(key(call)).commit()) throw new Exception(
        "Storage unavailable"
      );
      call.resolve();
    } catch (Exception error) {
      call.reject("저장된 로그인을 삭제하지 못했습니다. 다시 시도해주세요.");
    }
  }
}
