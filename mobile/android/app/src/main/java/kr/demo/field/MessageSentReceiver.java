package kr.demo.field;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Explicit non-exported receiver; only a per-attempt PendingIntent can update the outbox. */
public class MessageSentReceiver extends BroadcastReceiver {

  @Override
  public void onReceive(Context c, Intent intent) {
    try {
      DeliveryStore.receive(
        c,
        intent.getStringExtra("claimId"),
        intent.getStringExtra("attemptId"),
        intent.getIntExtra("part", -1),
        getResultCode()
      );
    } catch (Exception ignored) {
      /* Missing acknowledgement remains unknown; never delete or resend. */
    }
  }
}
