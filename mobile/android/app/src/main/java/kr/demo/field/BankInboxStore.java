package kr.demo.field;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

final class BankInboxStore {

  static final Object LOCK = new Object();
  private final SharedPreferences prefs;

  BankInboxStore(Context context) {
    prefs = context.getSharedPreferences("demo-bank-inbox", Context.MODE_PRIVATE);
  }

  private void save(SharedPreferences.Editor editor) throws Exception {
    if (!editor.commit()) throw new Exception("Storage unavailable");
  }

  boolean enabled() {
    return prefs.getBoolean("enabled", false);
  }

  String scope() {
    return prefs.getString("scope", "");
  }

  String error() {
    return prefs.getString("error", "");
  }

  JSONArray jobs() throws Exception {
    synchronized (LOCK) {
      return new JSONArray(prefs.getString("jobs", "[]"));
    }
  }

  void add(JSONObject job) throws Exception {
    add(job, System.currentTimeMillis());
  }

  // Receipts are kept until the server takes them, also while sending is stopped. Only receipts
  // older than KEEP_MILLIS are dropped, e.g. on a phone left connected after another one took over.
  void add(JSONObject job, long now) throws Exception {
    synchronized (LOCK) {
      JSONArray all = jobs(),
        keep = new JSONArray();
      for (int i = 0; i < all.length(); i++) {
        JSONObject old = all.getJSONObject(i);
        if (old.getString("id").equals(job.getString("id"))) return;
        if (receivedAt(old) >= now - KEEP_MILLIS) keep.put(old);
      }
      keep.put(job);
      save(prefs.edit().putString("jobs", keep.toString()));
    }
  }

  static final long KEEP_MILLIS = 30L * 24 * 60 * 60 * 1000;

  // A receipt whose time cannot be read is kept rather than dropped.
  private static long receivedAt(JSONObject job) {
    try {
      SimpleDateFormat date = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
      date.setTimeZone(TimeZone.getTimeZone("UTC"));
      return date.parse(job.getString("receivedAt")).getTime();
    } catch (Exception e) {
      return Long.MAX_VALUE;
    }
  }

  void acknowledge(String id) throws Exception {
    synchronized (LOCK) {
      JSONArray all = jobs(),
        keep = new JSONArray();
      for (int i = 0; i < all.length(); i++) if (
        !all.getJSONObject(i).getString("id").equals(id)
      ) keep.put(all.getJSONObject(i));
      save(prefs.edit().putString("jobs", keep.toString()).putString("error", ""));
    }
  }

  // Sending stopped (the server refused this phone, or a receipt could not be handed on). Receiving
  // stays on so no deposit message is lost: each new message tries again, and reconnecting in
  // 설정 sends what was kept. Only 수신 중단 or logging out turns receiving off.
  void pause(String error) throws Exception {
    synchronized (LOCK) {
      save(prefs.edit().putString("error", error));
    }
  }

  void disable() throws Exception {
    synchronized (LOCK) {
      save(prefs.edit().putBoolean("enabled", false).remove("credential").putString("error", ""));
    }
  }

  private static SecretKey secret() throws Exception {
    String alias = "demo-bank-device-v1";
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
    keys.load(null);
    if (!keys.containsAlias(alias)) {
      KeyGenerator generator = KeyGenerator.getInstance(
        KeyProperties.KEY_ALGORITHM_AES,
        "AndroidKeyStore"
      );
      generator.init(
        new KeyGenParameterSpec.Builder(
          alias,
          KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .build()
      );
      generator.generateKey();
    }
    return (SecretKey) keys.getKey(alias, null);
  }

  void configure(String scope, String endpoint, String token) throws Exception {
    synchronized (LOCK) {
      if (jobs().length() > 0 && !scope().equals(scope)) throw new Exception(
        "다른 회사의 미처리 입금 문자가 남아 있습니다."
      );
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, secret());
      String value = new JSONObject().put("endpoint", endpoint).put("token", token).toString();
      String encrypted =
        Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) +
        ":" +
        Base64.encodeToString(
          cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),
          Base64.NO_WRAP
        );
      save(
        prefs
          .edit()
          .putString("scope", scope)
          .putString("credential", encrypted)
          .putBoolean("enabled", true)
          .putString("error", "")
      );
    }
  }

  JSONObject credential() throws Exception {
    synchronized (LOCK) {
      String encrypted = prefs.getString("credential", null);
      if (encrypted == null) return null;
      String[] parts = encrypted.split(":", 2);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(
        Cipher.DECRYPT_MODE,
        secret(),
        new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP))
      );
      return new JSONObject(
        new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8)
      );
    }
  }
}
