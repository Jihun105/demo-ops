package kr.demo.field;

import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import org.json.JSONObject;

final class BankSms {

  static JSONObject receipt(String sender, String body, long timestamp, String source)
    throws Exception {
    if (
      sender == null || body == null || !sender.replaceAll("[ -]", "").equals("15882100")
    ) return null;
    String text = body.split("잔액", 2)[0].trim();
    if (
      !text.matches("(?s).*농협\\s+입금.*") ||
      !text.matches("(?s).*123-45-(?:\\*{4}|6789)01(?:\\s|$).*")
    ) return null;
    if (text.length() > 400) text = text.substring(0, 400);
    SimpleDateFormat date = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
    date.setTimeZone(TimeZone.getTimeZone("UTC"));
    return new JSONObject()
      .put("id", UUID.nameUUIDFromBytes(source.getBytes(StandardCharsets.UTF_8)).toString())
      .put("sender", "15882100")
      .put("text", text)
      .put("receivedAt", date.format(new Date(timestamp)));
  }
}
