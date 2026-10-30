package kr.demo.field;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import android.util.Base64;

public final class BankSmsReceiver extends BroadcastReceiver {

  @Override
  public void onReceive(Context context, Intent intent) {
    if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;
    BankInboxStore store = new BankInboxStore(context);
    if (!store.enabled()) return;
    // The service-centre timestamp can be days old after loss of reception.
    long receivedAt = System.currentTimeMillis();
    PendingResult pending = goAsync();
    new Thread(() -> {
      try {
        SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (parts == null || parts.length == 0) return;
        StringBuilder text = new StringBuilder(),
          source = new StringBuilder();
        for (SmsMessage part : parts) {
          if (
            !String.valueOf(parts[0].getOriginatingAddress()).equals(part.getOriginatingAddress())
          ) return;
          text.append(part.getMessageBody());
          source.append(Base64.encodeToString(part.getPdu(), Base64.NO_WRAP));
        }
        org.json.JSONObject receipt = BankSms.receipt(
          parts[0].getOriginatingAddress(),
          text.toString(),
          receivedAt,
          source.toString()
        );
        if (receipt != null) {
          synchronized (BankInboxStore.LOCK) {
            if (!store.enabled()) return;
            store.add(receipt);
          }
          BankInboxWorker.enqueue(context).getResult().get();
        }
      } catch (Exception ignored) {
        try {
          store.pause("입금 문자 수신 상태를 확인해주세요.");
        } catch (Exception ignoredAgain) {}
      } finally {
        pending.finish();
      }
    }, "demo-bank-receive").start();
  }
}
