package kr.demo.field;

import static org.junit.Assert.*;

import android.graphics.Bitmap;
import android.os.Bundle;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class MmsPayloadTest {

  @org.junit.Before
  public void useRealImageValidation() {
    org.robolectric.shadows.ShadowBitmapFactory.setAllowInvalidImageData(false);
  }

  @Test
  public void createsBoundedMmsWithKoreanBodyAndJpegAttachment() throws Exception {
    Bitmap bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888);
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
    bitmap.recycle();
    JSONArray photos = new JSONArray().put(
      new JSONObject()
        .put("type", "image/png")
        .put(
          "data",
          "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        )
    );
    Bundle config = new Bundle();
    config.putInt("maxMessageSize", 32768);
    byte[] result = MmsPayload.create(
      RuntimeEnvironment.getApplication(),
      "01012345678",
      "데모 작업 안내 금액 150,000원",
      photos,
      config
    );
    assertTrue(result.length <= 32768);
    assertEquals(0x8c, result[0] & 255);
    assertEquals(0x80, result[1] & 255);
    String encoded = new String(result, StandardCharsets.UTF_8);
    assertTrue(encoded.contains("데모 작업 안내 금액 150,000원"));
    assertTrue(encoded.contains("image0.jpg"));
    assertTrue(encoded.contains("message.txt"));
  }

  @Test
  public void invalidImageCannotBeSubmitted() throws Exception {
    JSONArray photos = new JSONArray().put(
      new JSONObject().put("type", "image/jpeg").put("data", "data:image/jpeg;base64,AA==")
    );
    try {
      MmsPayload.create(
        RuntimeEnvironment.getApplication(),
        "01012345678",
        "내용",
        photos,
        new Bundle()
      );
      fail();
    } catch (java.io.IOException expected) {}
  }
}
