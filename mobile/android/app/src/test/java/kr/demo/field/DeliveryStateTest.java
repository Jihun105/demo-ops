package kr.demo.field;

import static org.junit.Assert.*;

import org.junit.Test;

public class DeliveryStateTest {

  @Test
  public void waitsForEverySmsPart() {
    assertEquals("submitted", DeliveryState.reduce(new Integer[] { -1, null }));
  }

  @Test
  public void everyPartMustSucceed() {
    assertEquals("sent", DeliveryState.reduce(new Integer[] { -1, -1 }));
    assertEquals("partial", DeliveryState.reduce(new Integer[] { -1, 1 }));
    assertEquals("failed", DeliveryState.reduce(new Integer[] { 1, 2 }));
  }

  @Test
  public void emptyCallbackSetIsNotSuccess() {
    assertEquals("submitted", DeliveryState.reduce(new Integer[] {}));
  }

  @Test
  public void timeoutCannotBecomeFailureOrBeRetried() {
    assertFalse(DeliveryState.canRetry("unknown"));
    assertFalse(DeliveryState.canRetry("partial"));
    assertFalse(DeliveryState.canRetry("submitted"));
    assertFalse(DeliveryState.canRetry("sent"));
    assertTrue(DeliveryState.canRetry("failed"));
  }
}
