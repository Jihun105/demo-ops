package kr.demo.field;

import static org.junit.Assert.*;

import android.content.Context;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class BankInboxTest {

  private Context context;

  @Before
  public void setup() {
    context = RuntimeEnvironment.getApplication();
    context.getSharedPreferences("demo-bank-inbox", 0).edit().clear().commit();
  }

  @Test
  public void ignoresUnrelatedSmsAndNeverRetainsBalance() throws Exception {
    String text = "[Web발신]\n농협 입금80,000원\n10/11 20:31 123-45-****01 테스트 잔액999,999원";
    assertNull(BankSms.receipt("01012345678", text, 1791718261000L, "one"));
    assertNull(BankSms.receipt("15882100", text.replace("입금", "출금"), 1791718261000L, "one"));
    JSONObject receipt = BankSms.receipt("1588-2100", text, 1791718261000L, "one");
    assertFalse(receipt.toString().contains("999,999"));
    assertEquals(
      receipt.getString("id"),
      BankSms.receipt("1588-2100", text, 1791718261000L, "one").getString("id")
    );
    assertNotEquals(
      receipt.getString("id"),
      BankSms.receipt("1588-2100", text, 1791718261000L, "two").getString("id")
    );
  }

  @Test
  public void queueSurvivesNewInstanceAndAcknowledgesOnlyOneReceipt() throws Exception {
    BankInboxStore store = new BankInboxStore(context);
    JSONObject one = new JSONObject().put("id", "one"),
      two = new JSONObject().put("id", "two");
    store.add(one);
    store.add(one);
    store.add(two);
    assertEquals(2, new BankInboxStore(context).jobs().length());
    store.acknowledge("one");
    assertEquals("two", new BankInboxStore(context).jobs().getJSONObject(0).getString("id"));
    store.pause("연결 확인 필요");
    assertEquals(1, store.jobs().length());
    assertFalse(store.enabled());
  }

  @Test
  public void refusedSendingKeepsReceivingAndKeepsReceipts() throws Exception {
    context.getSharedPreferences("demo-bank-inbox", 0).edit().putBoolean("enabled", true).commit();
    BankInboxStore store = new BankInboxStore(context);
    store.pause("서버 연결 끊김 · 다시 연결해주세요.");
    assertTrue(store.enabled());
    assertEquals("서버 연결 끊김 · 다시 연결해주세요.", store.error());
    store.add(new JSONObject().put("id", "after"));
    assertEquals(1, new BankInboxStore(context).jobs().length());
    store.acknowledge("after");
    assertEquals("", store.error());
    store.disable();
    assertFalse(store.enabled());
  }

  @Test
  public void receiptsOlderThanThirtyDaysAreDroppedWhenANewOneArrives() throws Exception {
    long now = 1791718261000L,
      day = 24L * 60 * 60 * 1000;
    BankInboxStore store = new BankInboxStore(context);
    store.add(BankSms.receipt("15882100", text("old"), now - 31 * day, "old"), now - 31 * day);
    store.add(
      BankSms.receipt("15882100", text("recent"), now - 29 * day, "recent"),
      now - 29 * day
    );
    store.add(new JSONObject().put("id", "unreadable").put("receivedAt", "?"), now - day);
    store.add(BankSms.receipt("15882100", text("new"), now, "new"), now);
    assertEquals(3, store.jobs().length());
    for (int i = 0; i < store.jobs().length(); i++) assertFalse(
      store.jobs().getJSONObject(i).optString("text").contains("old")
    );
  }

  private static String text(String name) {
    return "[Web발신]\n농협 입금80,000원\n10/11 20:31 123-45-****01 " + name;
  }
}
