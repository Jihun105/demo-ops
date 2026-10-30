package kr.demo.field;

import static org.junit.Assert.*;

import android.content.*;
import java.util.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class EarthLauncherTest {

  @Test
  public void searchesOriginalAddressWithoutGoogleCoordinatesAndRejectsEmptyInput() {
    String query = "서울 종로구 구기동 159 & #/?";
    Intent intent = EarthLauncher.earthIntent(query);
    assertEquals("com.nhn.android.nmap", intent.getPackage());
    assertEquals("nmap", intent.getData().getScheme());
    assertEquals("search", intent.getData().getHost());
    assertEquals(query, intent.getData().getQueryParameter("query"));
    assertEquals("kr.demo.field", intent.getData().getQueryParameter("appname"));
    assertNull(intent.getData().getQueryParameter("lat"));
    assertEquals("/p/search/" + query, EarthLauncher.webIntent(query).getData().getPath());
    assertEquals("15.00,0,0,2,dh", EarthLauncher.webIntent(query).getData().getQueryParameter("c"));
    assertThrows(IllegalArgumentException.class, () -> EarthLauncher.earthIntent(null));
    assertThrows(IllegalArgumentException.class, () -> EarthLauncher.webIntent("  "));
  }

  @Test
  public void missingMapsFallsBackToWebAndMissingBrowserReportsFailure() {
    List<Intent> attempts = new ArrayList<>();
    Context context = new ContextWrapper(RuntimeEnvironment.getApplication()) {
      @Override
      public void startActivity(Intent intent) {
        attempts.add(intent);
        if (intent.getPackage() != null) throw new ActivityNotFoundException();
      }
    };
    assertEquals("web", EarthLauncher.open(context, "서울 구기동 159"));
    assertEquals(2, attempts.size());
    assertEquals("map.naver.com", attempts.get(1).getData().getHost());
    Context missing = new ContextWrapper(context) {
      @Override
      public void startActivity(Intent i) {
        throw new ActivityNotFoundException();
      }
    };
    assertThrows(IllegalStateException.class, () -> EarthLauncher.open(missing, "서울 구기동 159"));
  }
}
