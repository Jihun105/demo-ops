package kr.demo.field;

import static org.junit.Assert.*;

import android.content.Context;
import java.util.UUID;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class OutboxTest {

  Context context;
  String id, attempt, workspace;

  @Before
  public void setup() {
    context = RuntimeEnvironment.getApplication();
    id = UUID.randomUUID().toString();
    attempt = UUID.randomUUID().toString();
    workspace = UUID.randomUUID().toString();
  }

  JSONObject job(int parts) throws Exception {
    JSONArray results = new JSONArray();
    for (int i = 0; i < parts; i++) results.put(JSONObject.NULL);
    return new JSONObject()
      .put("claimId", id)
      .put("attemptId", attempt)
      .put("workspaceId", workspace)
      .put("status", "submitted")
      .put("createdAt", System.currentTimeMillis())
      .put("updatedAt", System.currentTimeMillis())
      .put("results", results)
      .put("cleanup", "pending");
  }

  @Test
  public void privacyCleanupKeepsUnknownPdusAndPreservesConfirmedAttemptFingerprint()
    throws Exception {
    java.io.File folder = new java.io.File(context.getFilesDir(), "demo-mms-pdus");
    folder.mkdirs();
    java.io.File pdu = new java.io.File(folder, attempt + ".pdu");
    try (java.io.FileOutputStream out = new java.io.FileOutputStream(pdu)) {
      out.write("private".getBytes());
    }
    DeliveryStore.write(context, job(1).put("fingerprint", "immutable-proof"));
    String epoch = UUID.randomUUID().toString();
    JSONArray ids = new JSONArray().put(id);
    assertEquals(
      1,
      DeliveryStore.purgeConfirmed(context, workspace, ids, epoch)
        .getJSONArray("pendingIds")
        .length()
    );
    assertTrue(pdu.exists());
    DeliveryStore.receive(context, id, attempt, 0, -1);
    String event = DeliveryStore.read(context, id).getString("eventId");
    assertEquals(
      1,
      DeliveryStore.purgeConfirmed(context, workspace, ids, epoch)
        .getJSONArray("clearedIds")
        .length()
    );
    assertFalse(pdu.exists());
    JSONObject after = DeliveryStore.read(context, id);
    assertEquals(attempt, after.getString("attemptId"));
    assertEquals(event, after.getString("eventId"));
    assertEquals("immutable-proof", after.getString("fingerprint"));
    assertFalse(DeliveryState.canRetry(after.getString("status")));
    DeliveryStore.receive(context, id, attempt, 0, -1);
    assertEquals(event, DeliveryStore.read(context, id).getString("eventId"));
  }

  @Test
  public void unassignedPduCannotBeClaimedAsFullyCleaned() throws Exception {
    java.io.File folder = new java.io.File(context.getFilesDir(), "demo-mms-pdus");
    folder.mkdirs();
    java.io.File pdu = new java.io.File(folder, UUID.randomUUID().toString() + ".pdu");
    try (java.io.FileOutputStream out = new java.io.FileOutputStream(pdu)) {
      out.write("unassigned".getBytes());
    }
    assertEquals(
      1,
      DeliveryStore.purgeConfirmed(
        context,
        workspace,
        new JSONArray(),
        UUID.randomUUID().toString()
      )
        .getJSONArray("pendingIds")
        .length()
    );
    assertTrue(pdu.exists());
    pdu.delete();
  }

  @Test
  public void callbacksPersistAcrossReadsAndDuplicateCallbacksDoNotChangeHistory()
    throws Exception {
    DeliveryStore.write(context, job(2));
    DeliveryStore.receive(context, id, attempt, 0, -1);
    assertEquals("submitted", DeliveryStore.read(context, id).getString("status"));
    DeliveryStore.receive(context, id, attempt, 1, -1);
    JSONObject sent = DeliveryStore.read(context, id);
    assertEquals("sent", sent.getString("status"));
    String event = sent.getString("eventId");
    DeliveryStore.receive(context, id, attempt, 1, 1);
    assertEquals(event, DeliveryStore.read(context, id).getString("eventId"));
  }

  @Test
  public void staleAttemptCannotAcknowledgeANewAttempt() throws Exception {
    DeliveryStore.write(context, job(1));
    DeliveryStore.receive(context, id, UUID.randomUUID().toString(), 0, -1);
    assertEquals("submitted", DeliveryStore.read(context, id).getString("status"));
  }

  @Test
  public void partialSendIsNotSafeToRetryOrClean() throws Exception {
    DeliveryStore.write(context, job(2));
    DeliveryStore.receive(context, id, attempt, 0, -1);
    DeliveryStore.receive(context, id, attempt, 1, 1);
    assertEquals("partial", DeliveryStore.read(context, id).getString("status"));
    assertFalse(DeliveryState.canRetry("partial"));
  }

  @Test
  public void timeoutStaysUnknownUntilActualLateSuccessArrives() throws Exception {
    JSONObject j = job(1).put("createdAt", System.currentTimeMillis() - 16 * 60 * 1000);
    DeliveryStore.write(context, j);
    DeliveryStore.list(context, workspace);
    assertEquals("unknown", DeliveryStore.read(context, id).getString("status"));
    DeliveryStore.receive(context, id, attempt, 0, -1);
    assertEquals("sent", DeliveryStore.read(context, id).getString("status"));
  }

  @Test
  public void otherWorkspaceCannotReadTheJob() throws Exception {
    DeliveryStore.write(context, job(1));
    assertEquals(0, DeliveryStore.list(context, UUID.randomUUID().toString()).length());
  }

  @Test
  public void interruptedAtomicWriteRecoversBeforeListingOrResending() throws Exception {
    DeliveryStore.write(context, job(1));
    java.io.File original = new java.io.File(context.getFilesDir(), "demo-outbox/" + id + ".json");
    assertTrue(original.renameTo(new java.io.File(original.getPath() + ".bak")));
    assertEquals(1, DeliveryStore.list(context, workspace).length());
    assertEquals(attempt, DeliveryStore.read(context, id).getString("attemptId"));
  }

  @Test
  public void photoCleanupDeletesOnlyUnreferencedManagedTokensAndReportsUnassignedCopies()
    throws Exception {
    String retired = UUID.randomUUID().toString(),
      kept = UUID.randomUUID().toString(),
      orphan = UUID.randomUUID().toString();
    LocalPhotos.write(LocalPhotos.file(context, retired, ".bin"), new byte[] { 1 });
    LocalPhotos.write(LocalPhotos.file(context, kept, ".bin"), new byte[] { 2 });
    LocalPhotos.write(LocalPhotos.file(context, orphan, ".bin"), new byte[] { 3 });
    JSONObject result = LocalPhotos.purge(
      context,
      new JSONArray().put(retired).put(kept),
      new JSONArray().put(kept)
    );
    assertEquals(1, result.getJSONArray("clearedTokens").length());
    assertFalse(LocalPhotos.file(context, retired, ".bin").exists());
    assertTrue(LocalPhotos.file(context, kept, ".bin").exists());
    assertTrue(LocalPhotos.file(context, orphan, ".bin").exists());
    assertEquals(1, result.getInt("unassignedCount"));
    try {
      LocalPhotos.purge(context, new JSONArray().put("../outside"), new JSONArray());
      fail();
    } catch (IllegalArgumentException expected) {}
  }
}
