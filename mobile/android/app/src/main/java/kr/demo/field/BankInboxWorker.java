package kr.demo.field;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

public final class BankInboxWorker extends Worker {

  public BankInboxWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
    super(context, parameters);
  }

  static Operation enqueue(Context context) {
    OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(BankInboxWorker.class)
      .setConstraints(
        new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
      )
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .build();
    return WorkManager.getInstance(context).enqueueUniqueWork(
      "demo-bank-inbox",
      ExistingWorkPolicy.APPEND_OR_REPLACE,
      request
    );
  }

  @NonNull
  @Override
  public Result doWork() {
    BankInboxStore store = new BankInboxStore(getApplicationContext());
    try {
      for (int n = 0; n < 20 && !isStopped(); n++) {
        JSONObject credential;
        JSONObject job;
        synchronized (BankInboxStore.LOCK) {
          if (!store.enabled()) return Result.success();
          credential = store.credential();
          JSONArray jobs = store.jobs();
          if (credential == null || jobs.length() == 0) return Result.success();
          job = jobs.getJSONObject(0);
        }
        HttpURLConnection connection = (HttpURLConnection) new URL(
          credential.getString("endpoint")
        ).openConnection();
        try {
          connection.setInstanceFollowRedirects(false);
          connection.setConnectTimeout(15000);
          connection.setReadTimeout(15000);
          connection.setRequestMethod("POST");
          connection.setDoOutput(true);
          connection.setRequestProperty("Content-Type", "application/json");
          connection.setRequestProperty("Authorization", "Bearer " + credential.getString("token"));
          byte[] bytes = new JSONObject()
            .put("action", "receive")
            .put("receipt", job)
            .toString()
            .getBytes(StandardCharsets.UTF_8);
          connection.setFixedLengthStreamingMode(bytes.length);
          try (java.io.OutputStream output = connection.getOutputStream()) {
            output.write(bytes);
          }
          int code = connection.getResponseCode();
          // Refused: stop until the next message or a reconnect; the receipts stay on the phone.
          if (code == 401 || code == 403) {
            store.pause("서버 연결 끊김 · 다시 연결해주세요.");
            return Result.success();
          }
          if (code != 200) return Result.retry();
          String response;
          try (
            java.io.InputStream in = connection.getInputStream();
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()
          ) {
            byte[] buffer = new byte[1024];
            int count;
            while ((count = in.read(buffer)) != -1) {
              out.write(buffer, 0, count);
              if (out.size() > 8192) throw new Exception("Invalid response");
            }
            response = out.toString("UTF-8");
          }
          JSONObject result = new JSONObject(response);
          String status = result.optString("status");
          if (
            !status.equals("held") && !status.equals("matched") && !status.equals("ignored")
          ) return Result.retry();
          if (
            !status.equals("ignored") && !job.getString("id").equals(result.optString("id"))
          ) return Result.retry();
          store.acknowledge(job.getString("id"));
        } finally {
          connection.disconnect();
        }
      }
      return store.jobs().length() > 0 ? Result.retry() : Result.success();
    } catch (Exception ignored) {
      return Result.retry();
    }
  }
}
