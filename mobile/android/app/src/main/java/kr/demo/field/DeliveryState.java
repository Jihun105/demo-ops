package kr.demo.field;

/** All multipart callbacks must succeed; a timeout is never evidence that nothing was sent. */
public final class DeliveryState {

  public static String reduce(Integer[] results) {
    if (results.length == 0) return "submitted";
    int success = 0;
    for (Integer result : results) {
      if (result == null) return "submitted";
      if (result == -1) success++;
    }
    return success == results.length ? "sent" : success == 0 ? "failed" : "partial";
  }

  public static boolean canRetry(String status) {
    return "failed".equals(status);
  }
}
