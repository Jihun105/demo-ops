package kr.demo.field;

import android.content.Context;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Persist before contacting telephony. Receiver and UI share a process-wide lock. */
public final class DeliveryStore {

  public static final Object LOCK = new Object();

  public static boolean uuid(String value) {
    return value != null && value.matches("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}");
  }

  private static File folder(Context c) {
    File f = new File(c.getFilesDir(), "demo-outbox");
    if (!f.exists() && !f.mkdirs()) throw new IllegalStateException("저장 공간을 확인해주세요.");
    return f;
  }

  private static AtomicFile file(Context c, String id) {
    if (!uuid(id)) throw new IllegalArgumentException("잘못된 청구 ID");
    return new AtomicFile(new File(folder(c), id + ".json"));
  }

  public static JSONObject read(Context c, String id) throws Exception {
    synchronized (LOCK) {
      AtomicFile f = file(c, id);
      if (
        !f.getBaseFile().exists() && !new File(f.getBaseFile().getPath() + ".bak").exists()
      ) return null;
      return new JSONObject(new String(f.readFully(), StandardCharsets.UTF_8));
    }
  }

  public static void write(Context c, JSONObject job) throws Exception {
    synchronized (LOCK) {
      AtomicFile f = file(c, job.getString("claimId"));
      FileOutputStream out = null;
      try {
        out = f.startWrite();
        out.write(job.toString().getBytes(StandardCharsets.UTF_8));
        f.finishWrite(out);
      } catch (Exception e) {
        if (out != null) f.failWrite(out);
        throw e;
      }
    }
  }

  public static void transition(JSONObject job, String status) throws Exception {
    if (!status.equals(job.optString("status"))) {
      job.put("status", status);
      job.put("eventId", UUID.randomUUID().toString());
      job.put("updatedAt", System.currentTimeMillis());
    }
  }

  public static JSONArray list(Context c, String workspace) throws Exception {
    synchronized (LOCK) {
      JSONArray result = new JSONArray();
      File[] files = folder(c).listFiles((d, n) -> n.endsWith(".json") || n.endsWith(".json.bak"));
      if (files == null) return result;
      java.util.Set<String> ids = new java.util.LinkedHashSet<>();
      for (File f : files) ids.add(f.getName().replaceFirst("\\.json(?:\\.bak)?$", ""));
      for (String id : ids) {
        JSONObject j = read(c, id);
        if (j == null || !workspace.equals(j.optString("workspaceId"))) continue;
        if (
          (j.optString("status").equals("queued") || j.optString("status").equals("submitted")) &&
          System.currentTimeMillis() - j.getLong("createdAt") > 15 * 60 * 1000
        ) {
          transition(j, "unknown");
          write(c, j);
        }
        result.put(publicJob(j));
      }
      return result;
    }
  }

  public static JSONObject publicJob(JSONObject j) throws Exception {
    JSONObject result = new JSONObject();
    for (String key : new String[] {
      "claimId",
      "workspaceId",
      "attemptId",
      "status",
      "eventId",
      "updatedAt",
      "errorCode",
    })
      if (j.has(key)) result.put(key, j.get(key));
    return result;
  }

  public static JSONObject purgeConfirmed(
    Context c,
    String workspace,
    JSONArray claimIds,
    String epoch
  ) throws Exception {
    if (
      !uuid(workspace) || !uuid(epoch) || claimIds.length() > 10000
    ) throw new IllegalArgumentException("정리 범위를 확인해주세요.");
    synchronized (LOCK) {
      JSONArray pending = new JSONArray(),
        cleared = new JSONArray();
      File folder = new File(c.getFilesDir(), "demo-mms-pdus");
      for (int i = 0; i < claimIds.length(); i++) {
        String id = claimIds.getString(i);
        JSONObject job = read(c, id);
        if (job == null || !workspace.equals(job.optString("workspaceId"))) continue;
        String status = job.optString("status"),
          attempt = job.optString("attemptId");
        if (!(status.equals("sent") || status.equals("failed")) || !uuid(attempt)) {
          pending.put(id);
          continue;
        }
        JSONArray attempts = job.optJSONArray("retiredAttempts");
        if (attempts == null) attempts = new JSONArray();
        attempts = new JSONArray(attempts.toString()).put(attempt);
        for (int a = 0; a < attempts.length(); a++) {
          String oldAttempt = attempts.getString(a);
          if (!uuid(oldAttempt)) throw new IllegalArgumentException("전송 시도를 확인해주세요.");
          File pdu = new File(folder, oldAttempt + ".pdu");
          if (
            !pdu.getCanonicalFile().getParentFile().equals(folder.getCanonicalFile()) ||
            !pdu
              .getCanonicalFile()
              .getName()
              .equals(oldAttempt + ".pdu")
          ) throw new IllegalStateException("전송 사본 위치를 확인해주세요.");
          if (pdu.exists() && !pdu.delete()) throw new IllegalStateException(
            "전송 사본을 정리하지 못했습니다."
          );
        }
        // Keep IDs, status, results and fingerprint: a restart must never trigger another SMS.
        job.put("privacyEpoch", epoch);
        write(c, job);
        cleared.put(id);
      }
      java.util.Set<String> known = new java.util.HashSet<>();
      File[] jobs = folder(c).listFiles((d, n) -> n.endsWith(".json") || n.endsWith(".json.bak"));
      if (jobs != null) for (File source : jobs) {
        String id = source.getName().replaceFirst("\\.json(?:\\.bak)?$", "");
        JSONObject saved = read(c, id);
        if (saved == null) continue;
        known.add(saved.optString("attemptId"));
        JSONArray retired = saved.optJSONArray("retiredAttempts");
        if (retired != null) for (int a = 0; a < retired.length(); a++) known.add(
          retired.getString(a)
        );
      }
      File[] remaining = folder.listFiles((d, n) -> n.endsWith(".pdu"));
      if (remaining != null) for (File pdu : remaining) {
        String id = pdu.getName().replaceFirst("\\.pdu$", "");
        if (!known.contains(id)) pending.put("unassigned-pdu");
      }
      return new JSONObject().put("pendingIds", pending).put("clearedIds", cleared);
    }
  }

  public static void receive(Context c, String id, String attempt, int part, int code)
    throws Exception {
    synchronized (LOCK) {
      JSONObject j = read(c, id);
      if (j == null || !attempt.equals(j.optString("attemptId"))) return;
      JSONArray parts = j.getJSONArray("results");
      if (part < 0 || part >= parts.length() || !parts.isNull(part)) return;
      parts.put(part, code);
      Integer[] values = new Integer[parts.length()];
      for (int i = 0; i < values.length; i++) values[i] = parts.isNull(i) ? null : parts.getInt(i);
      String status = DeliveryState.reduce(values);
      if (!status.equals("submitted")) transition(j, status);
      if (code != -1) j.put("errorCode", code);
      write(c, j);
    }
  }
}
