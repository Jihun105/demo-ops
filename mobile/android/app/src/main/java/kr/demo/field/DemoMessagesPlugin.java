package kr.demo.field;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.telephony.SmsManager;
import android.telephony.SubscriptionManager;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.io.File;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.*;

@CapacitorPlugin(
  name = "DemoMessages",
  permissions = { @Permission(alias = "sms", strings = { Manifest.permission.SEND_SMS }) }
)
public class DemoMessagesPlugin extends Plugin {

  private static final ExecutorService worker = Executors.newSingleThreadExecutor();

  @PluginMethod
  public void pickPhotos(PluginCall call) {
    Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT)
      .setType("image/*")
      .addCategory(Intent.CATEGORY_OPENABLE);
    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
    pick.putExtra(Intent.EXTRA_LOCAL_ONLY, true);
    pick.addFlags(
      Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
    );
    startActivityForResult(call, pick, "photosPicked");
  }

  @ActivityCallback
  private void photosPicked(PluginCall call, ActivityResult result) {
    if (call == null) return;
    if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
      call.resolve(new JSObject().put("photos", new JSONArray()));
      return;
    }
    Intent data = result.getData();
    ArrayList<Uri> uris = new ArrayList<>();
    if (data.getClipData() != null) {
      for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(
        data.getClipData().getItemAt(i).getUri()
      );
    } else if (data.getData() != null) uris.add(data.getData());
    if (uris.size() > 10) {
      call.reject("사진은 최대 10장까지 선택해주세요.");
      return;
    }
    worker.execute(() -> {
      try {
        JSONArray photos = new JSONArray();
        long total = 0;
        for (Uri uri : uris) {
          try {
            getContext()
              .getContentResolver()
              .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
          } catch (Exception ignored) {}
          JSONObject p = LocalPhotos.importPhoto(getContext(), uri);
          total += p.getLong("size");
          if (total > LocalPhotos.MAX_BYTES) throw new Exception(
            "사진 합계는 20MB 이하여야 합니다."
          );
          photos.put(p);
        }
        call.resolve(new JSObject().put("photos", photos));
      } catch (Exception e) {
        call.reject("사진을 가져오지 못했습니다. JPG·PNG·WebP, 최대 10장·20MB인지 확인해주세요.");
      }
    });
  }

  @PluginMethod
  public void send(PluginCall call) {
    if (getPermissionState("sms") != PermissionState.GRANTED) {
      requestPermissionForAlias("sms", call, "smsPermission");
      return;
    }
    sendGranted(call);
  }

  @PermissionCallback
  private void smsPermission(PluginCall call) {
    if (getPermissionState("sms") != PermissionState.GRANTED) {
      call.reject("문자 발송 권한이 필요합니다. 휴대폰 설정의 데모 업무 앱 권한을 확인해주세요.");
      return;
    }
    sendGranted(call);
  }

  private void sendGranted(PluginCall call) {
    worker.execute(() -> {
      boolean submitted = false;
      JSONObject job = null;
      try {
        String id = call.getString("claimId", ""),
          workspace = call.getString("workspaceId", ""),
          phone = call.getString("phone", ""),
          body = call.getString("body", "");
        JSONArray photos = call.getArray("photos", new JSArray());
        if (
          !DeliveryStore.uuid(id) ||
          !DeliveryStore.uuid(workspace) ||
          !phone.matches("0[0-9]{7,10}") ||
          body.trim().isEmpty() ||
          body.length() > 4000 ||
          photos.length() > 10
        ) throw new Exception("고객 번호와 문자 내용을 확인해주세요.");
        synchronized (DeliveryStore.LOCK) {
          JSONObject old = DeliveryStore.read(getContext(), id);
          if (old != null) {
            if (!workspace.equals(old.getString("workspaceId"))) throw new Exception(
              "작업공간이 다릅니다."
            );
            if (
              !call.getBoolean("retry", false) || !DeliveryState.canRetry(old.getString("status"))
            ) {
              call.resolve(JSObject.fromJSONObject(DeliveryStore.publicJob(old)));
              return;
            }
          }
        }
        if (
          !getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
        ) throw new Exception("유심으로 문자를 보낼 수 있는 Android 휴대폰이 필요합니다.");
        int subscription = SubscriptionManager.getDefaultSmsSubscriptionId();
        if (!SubscriptionManager.isValidSubscriptionId(subscription)) throw new Exception(
          "휴대폰 설정에서 문자 발송용 기본 SIM을 선택해주세요."
        );
        SmsManager manager = SmsManager.getSmsManagerForSubscriptionId(subscription);
        ArrayList<String> parts =
          photos.length() == 0 ? manager.divideMessage(body) : new ArrayList<>();
        byte[] pdu = null;
        if (photos.length() > 0) {
          Bundle config = manager.getCarrierConfigValues();
          pdu = MmsPayload.create(
            getContext(),
            phone,
            body,
            photos,
            config == null ? new Bundle() : config
          );
        }
        if (photos.length() == 0 && parts.isEmpty()) throw new Exception(
          "문자 내용이 비어 있습니다."
        );
        StringBuilder content = new StringBuilder(phone).append("\n").append(body);
        for (int i = 0; i < photos.length(); i++) {
          JSONObject photo = photos.getJSONObject(i);
          content
            .append("\n")
            .append(photo.optString("nativeToken"))
            .append(":")
            .append(LocalPhotos.hash(LocalPhotos.data(getContext(), photo)));
        }
        String fingerprint = LocalPhotos.hash(
          content.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)
        );
        JSONObject previous = DeliveryStore.read(getContext(), id);
        if (
          previous != null && !fingerprint.equals(previous.optString("fingerprint"))
        ) throw new Exception("저장된 청구와 발송 내용이 달라 재전송하지 않았습니다.");
        String attempt = UUID.randomUUID().toString();
        JSONArray results = new JSONArray();
        int count = photos.length() > 0 ? 1 : parts.size();
        for (int i = 0; i < count; i++) results.put(JSONObject.NULL);
        job = new JSONObject()
          .put("fingerprint", fingerprint)
          .put("claimId", id)
          .put("workspaceId", workspace)
          .put("attemptId", attempt)
          .put("status", "queued")
          .put("createdAt", System.currentTimeMillis())
          .put("updatedAt", System.currentTimeMillis())
          .put("results", results);
        JSONArray retired =
          previous == null ? new JSONArray() : previous.optJSONArray("retiredAttempts");
        if (retired == null) retired = new JSONArray();
        if (previous != null && previous.optString("status").equals("failed")) retired.put(
          previous.getString("attemptId")
        );
        job.put("retiredAttempts", retired);
        DeliveryStore.write(getContext(), job);
        ArrayList<PendingIntent> sent = new ArrayList<>();
        for (int i = 0; i < count; i++) {
          Intent intent = new Intent(getContext(), MessageSentReceiver.class)
            .setData(Uri.parse("demo-sent://" + id + "/" + attempt + "/" + i))
            .putExtra("claimId", id)
            .putExtra("attemptId", attempt)
            .putExtra("part", i);
          sent.add(
            PendingIntent.getBroadcast(
              getContext(),
              0,
              intent,
              PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            )
          );
        }
        if (pdu != null) {
          File folder = new File(getContext().getFilesDir(), "demo-mms-pdus");
          if (!folder.exists() && !folder.mkdirs()) throw new Exception(
            "사진 문자 저장 공간을 확인해주세요."
          );
          File file = new File(folder, attempt + ".pdu");
          LocalPhotos.write(file, pdu);
          Uri uri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            file
          );
          submitted = true;
          manager.sendMultimediaMessage(getContext(), uri, null, null, sent.get(0));
        } else {
          submitted = true;
          manager.sendMultipartTextMessage(phone, null, parts, sent, null);
        }
        synchronized (DeliveryStore.LOCK) {
          job = DeliveryStore.read(getContext(), id);
          if (job.getString("status").equals("queued")) {
            DeliveryStore.transition(job, "submitted");
            DeliveryStore.write(getContext(), job);
          }
        }
        call.resolve(JSObject.fromJSONObject(DeliveryStore.publicJob(job)));
      } catch (Exception e) {
        try {
          if (job != null) {
            synchronized (DeliveryStore.LOCK) {
              JSONObject latest = DeliveryStore.read(getContext(), job.getString("claimId"));
              if (latest != null && !latest.optString("status").equals("sent")) {
                DeliveryStore.transition(latest, submitted ? "unknown" : "failed");
                DeliveryStore.write(getContext(), latest);
                job = latest;
              }
            }
            call.resolve(JSObject.fromJSONObject(DeliveryStore.publicJob(job)));
          } else call.reject(
            e.getMessage() == null ? "문자를 준비하지 못했습니다." : e.getMessage()
          );
        } catch (Exception ignored) {
          call.reject(
            "전송 결과를 저장하지 못했습니다. 중복 발송하지 말고 문자 내역을 확인해주세요."
          );
        }
      }
    });
  }

  @PluginMethod
  public void purgePhotos(PluginCall call) {
    worker.execute(() -> {
      try {
        JSArray tokens = call.getArray("tokens"),
          keep = call.getArray("protectedTokens");
        if (tokens == null || keep == null) throw new Exception();
        call.resolve(JSObject.fromJSONObject(LocalPhotos.purge(getContext(), tokens, keep)));
      } catch (Exception e) {
        call.reject("사진 사본 정리를 확인하지 못했습니다.");
      }
    });
  }

  @PluginMethod
  public void purgeConfirmed(PluginCall call) {
    worker.execute(() -> {
      try {
        String workspace = call.getString("workspaceId", ""),
          epoch = call.getString("epoch", "");
        JSArray ids = call.getArray("claimIds");
        if (ids == null) throw new Exception();
        call.resolve(
          JSObject.fromJSONObject(DeliveryStore.purgeConfirmed(getContext(), workspace, ids, epoch))
        );
      } catch (Exception e) {
        call.reject("전송 사본 정리를 확인하지 못했습니다. 미확정 전송은 유지합니다.");
      }
    });
  }

  @PluginMethod
  public void listJobs(PluginCall call) {
    worker.execute(() -> {
      try {
        String workspace = call.getString("workspaceId", "");
        if (!DeliveryStore.uuid(workspace)) throw new Exception();
        call.resolve(new JSObject().put("jobs", DeliveryStore.list(getContext(), workspace)));
      } catch (Exception e) {
        call.reject("전송 기록을 읽지 못했습니다.");
      }
    });
  }
}
