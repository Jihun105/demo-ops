package kr.demo.field;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

final class EarthLauncher {

  // Keep the native bridge name stable; the external provider is now Naver.
  static final String PACKAGE = "com.nhn.android.nmap";

  static String address(String value) {
    if (
      value == null || value.trim().isEmpty() || value.trim().length() > 500
    ) throw new IllegalArgumentException("묘지 주소가 없습니다. 고객 정보를 확인해주세요.");
    return value.trim();
  }

  static Intent earthIntent(String query) {
    return new Intent(
      Intent.ACTION_VIEW,
      Uri.parse("nmap://search?query=" + Uri.encode(address(query)) + "&appname=kr.demo.field")
    )
      .setPackage(PACKAGE)
      .addCategory(Intent.CATEGORY_BROWSABLE);
  }

  static Intent webIntent(String query) {
    return new Intent(
      Intent.ACTION_VIEW,
      Uri.parse(
        "https://map.naver.com/p/search/" + Uri.encode(address(query)) + "?c=15.00,0,0,2,dh"
      )
    );
  }

  static String open(Context context, String query) {
    Intent web = webIntent(query);
    for (Intent intent : new Intent[] { earthIntent(query), web }) {
      try {
        context.startActivity(intent);
        return intent.getPackage() == null ? "web" : "maps";
      } catch (ActivityNotFoundException | SecurityException ignored) {}
    }
    throw new IllegalStateException("네이버 지도 또는 웹 브라우저를 설치해주세요.");
  }
}
