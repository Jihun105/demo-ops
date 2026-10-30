package kr.demo.field;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DemoEarth")
public class DemoEarthPlugin extends Plugin {

  @PluginMethod
  public void open(PluginCall call) {
    String address = call.getString("address");
    getActivity().runOnUiThread(() -> {
      try {
        String target = EarthLauncher.open(getActivity(), address);
        JSObject result = new JSObject();
        result.put("openedVia", target);
        call.resolve(result);
      } catch (Exception e) {
        call.reject(e.getMessage());
      }
    });
  }
}
