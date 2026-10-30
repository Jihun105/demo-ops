package kr.demo.field;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import java.io.*;
import java.security.MessageDigest;
import java.util.UUID;
import org.json.JSONObject;

final class LocalPhotos {

  static final int MAX_BYTES = 20 * 1024 * 1024;

  static File folder(Context c) {
    File f = new File(c.getFilesDir(), "demo-photos");
    if (!f.exists() && !f.mkdirs()) throw new IllegalStateException(
      "사진 저장 공간을 확인해주세요."
    );
    return f;
  }

  static File file(Context c, String token, String suffix) {
    if (!DeliveryStore.uuid(token)) throw new IllegalArgumentException(
      "사진 식별자가 잘못됐습니다."
    );
    return new File(folder(c), token + suffix);
  }

  static byte[] read(InputStream input) throws Exception {
    if (input == null) throw new IOException();
    try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[16384];
      int n;
      while ((n = in.read(buffer)) != -1) {
        if (out.size() + n > MAX_BYTES) throw new IOException("사진 합계는 20MB 이하여야 합니다.");
        out.write(buffer, 0, n);
      }
      return out.toByteArray();
    }
  }

  static String hash(byte[] data) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
    StringBuilder value = new StringBuilder();
    for (byte b : digest) value.append(String.format("%02x", b));
    return value.toString();
  }

  static void write(File f, byte[] data) throws Exception {
    try (FileOutputStream out = new FileOutputStream(f)) {
      out.write(data);
      out.getFD().sync();
    }
  }

  static JSONObject importPhoto(Context c, Uri uri) throws Exception {
    String type = c.getContentResolver().getType(uri);
    if (
      !"image/jpeg".equals(type) && !"image/png".equals(type) && !"image/webp".equals(type)
    ) throw new IOException("JPG, PNG, WebP 사진만 선택해주세요.");
    byte[] bytes = read(c.getContentResolver().openInputStream(uri));
    String name = "작업 사진";
    try (
      Cursor cursor = c
        .getContentResolver()
        .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)
    ) {
      if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
    }
    String token = UUID.randomUUID().toString();
    write(file(c, token, ".bin"), bytes);
    return new JSONObject()
      .put("nativeToken", token)
      .put("name", name)
      .put("type", type)
      .put("size", bytes.length)
      .put("data", "data:" + type + ";base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
  }

  static byte[] data(Context c, JSONObject photo) throws Exception {
    String token = photo.optString("nativeToken");
    if (!token.isEmpty()) return read(new FileInputStream(file(c, token, ".bin")));
    String data = photo.getString("data"),
      mime = photo.getString("type"),
      prefix = "data:" + mime + ";base64,";
    if (
      !data.startsWith(prefix) ||
      data.length() > 28000000 ||
      !(mime.equals("image/jpeg") || mime.equals("image/png") || mime.equals("image/webp"))
    ) throw new IOException("사진 형식을 확인해주세요.");
    byte[] bytes = Base64.decode(data.substring(prefix.length()), Base64.DEFAULT);
    if (bytes.length > MAX_BYTES) throw new IOException("사진이 너무 큽니다.");
    return bytes;
  }

  static JSONObject purge(Context c, org.json.JSONArray tokens, org.json.JSONArray protectedTokens)
    throws Exception {
    java.util.Set<String> remove = new java.util.HashSet<>(),
      keep = new java.util.HashSet<>();
    for (int i = 0; i < tokens.length(); i++) {
      String token = tokens.getString(i);
      if (!DeliveryStore.uuid(token)) throw new IllegalArgumentException();
      remove.add(token);
    }
    for (int i = 0; i < protectedTokens.length(); i++) {
      String token = protectedTokens.getString(i);
      if (!DeliveryStore.uuid(token)) throw new IllegalArgumentException();
      keep.add(token);
    }
    File root = folder(c);
    if (
      !root.getCanonicalFile().equals(new File(c.getFilesDir().getCanonicalFile(), "demo-photos"))
    ) throw new IOException("사진 저장 위치를 확인해주세요.");
    org.json.JSONArray cleared = new org.json.JSONArray(),
      pending = new org.json.JSONArray();
    for (String token : remove) {
      if (keep.contains(token)) continue;
      File target = file(c, token, ".bin");
      if (
        !target.getCanonicalFile().getParentFile().equals(root.getCanonicalFile())
      ) throw new IOException();
      if (!target.exists() || (target.isFile() && target.delete())) cleared.put(token);
      else pending.put(token);
    }
    int unassigned = 0;
    File[] files = root.listFiles();
    if (files == null) throw new IOException();
    for (File f : files) {
      String name = f.getName();
      if (!name.endsWith(".bin")) continue;
      String token = name.substring(0, name.length() - 4);
      if (!keep.contains(token) && !remove.contains(token)) unassigned++;
    }
    return new JSONObject()
      .put("clearedTokens", cleared)
      .put("pendingTokens", pending)
      .put("unassignedCount", unassigned);
  }
}
