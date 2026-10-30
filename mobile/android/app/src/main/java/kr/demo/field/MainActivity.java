package kr.demo.field;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(DemoMessagesPlugin.class);
    registerPlugin(DemoEarthPlugin.class);
    registerPlugin(DemoSessionPlugin.class);
    registerPlugin(DemoBankInboxPlugin.class);
    super.onCreate(savedInstanceState);
    try {
      BankInboxStore store = new BankInboxStore(this);
      if (store.enabled() && store.jobs().length() > 0) BankInboxWorker.enqueue(this);
    } catch (Exception ignored) {}
  }
}
