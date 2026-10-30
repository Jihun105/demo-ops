package kr.demo.field;

import android.content.Context;
import android.graphics.*;
import android.media.ExifInterface;
import android.os.Bundle;
import com.google.android.mms.pdu_alt.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import org.json.JSONArray;

final class MmsPayload {

  static byte[] bytes(String value) {
    return value.getBytes(StandardCharsets.UTF_8);
  }

  static PduPart part(String name, String mime, byte[] data) {
    PduPart part = new PduPart();
    part.setContentType(bytes(mime));
    part.setContentId(bytes(name));
    part.setContentLocation(bytes(name));
    part.setName(bytes(name));
    part.setData(data);
    if (mime.equals("text/plain")) part.setCharset(CharacterSets.UTF_8);
    return part;
  }

  static byte[] create(Context c, String phone, String text, JSONArray photos, Bundle config)
    throws Exception {
    int max = Math.min(2 * 1024 * 1024, config.getInt("maxMessageSize", 300 * 1024));
    if (max < 16 * 1024) throw new IOException("통신사의 사진 문자 용량 설정을 확인해주세요.");
    int width = Math.min(1280, config.getInt("maxImageWidth", 1024)),
      height = Math.min(1280, config.getInt("maxImageHeight", 1024));
    width = Math.max(width, 160);
    height = Math.max(height, 160);
    ArrayList<byte[]> images = new ArrayList<>();
    int total = 0;
    for (int i = 0; i < photos.length(); i++) {
      byte[] data = LocalPhotos.data(c, photos.getJSONObject(i));
      total += data.length;
      if (total > LocalPhotos.MAX_BYTES) throw new IOException("사진 합계는 20MB 이하여야 합니다.");
      images.add(data);
    }
    for (int round = 0; round < 5; round++) {
      SendReq req = new SendReq();
      req.addTo(new EncodedStringValue(phone));
      req.setDate(System.currentTimeMillis() / 1000);
      req.setMessageClass(
        PduHeaders.MESSAGE_CLASS_PERSONAL_STR.getBytes(StandardCharsets.US_ASCII)
      );
      req.setExpiry(7 * 24 * 60 * 60);
      req.setDeliveryReport(PduHeaders.VALUE_NO);
      req.setReadReport(PduHeaders.VALUE_NO);
      PduBody body = new PduBody();
      StringBuilder smil = new StringBuilder(
        "<smil><head><layout><root-layout width=\"320\" height=\"480\"/><region id=\"Image\" left=\"0\" top=\"0\" width=\"320\" height=\"320\" fit=\"meet\"/><region id=\"Text\" left=\"0\" top=\"320\" width=\"320\" height=\"160\"/></layout></head><body>"
      );
      for (int i = 0; i < images.size(); i++) smil
        .append("<par dur=\"8000ms\"><img src=\"image")
        .append(i)
        .append(".jpg\" region=\"Image\"/></par>");
      smil.append(
        "<par dur=\"10000ms\"><text src=\"message.txt\" region=\"Text\"/></par></body></smil>"
      );
      body.addPart(part("smil.xml", "application/smil", bytes(smil.toString())));
      body.addPart(part("message.txt", "text/plain", bytes(text)));
      for (int i = 0; i < images.size(); i++) body.addPart(
        part(
          "image" + i + ".jpg",
          "image/jpeg",
          compress(
            images.get(i),
            Math.max(160, width >> round),
            Math.max(160, height >> round),
            Math.max(45, 85 - round * 10)
          )
        )
      );
      req.setBody(body);
      byte[] pdu = new PduComposer(c, req).make();
      if (pdu == null) throw new IOException("사진 문자 내용을 구성하지 못했습니다.");
      if (pdu.length <= max) return pdu;
    }
    throw new IOException("통신사의 사진 문자 용량을 초과했습니다. 사진 수를 줄여주세요.");
  }

  static byte[] compress(byte[] bytes, int width, int height, int quality) throws Exception {
    BitmapFactory.Options options = new BitmapFactory.Options();
    options.inJustDecodeBounds = true;
    BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
    if (
      options.outWidth <= 0 ||
      options.outHeight <= 0 ||
      (long) options.outWidth * options.outHeight > 150000000
    ) throw new IOException("읽을 수 없는 사진입니다.");
    int sample = 1;
    while (options.outWidth / sample > width * 2 || options.outHeight / sample > height * 2)
      sample *= 2;
    options.inJustDecodeBounds = false;
    options.inSampleSize = sample;
    Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
    if (bitmap == null) throw new IOException("사진을 읽지 못했습니다.");
    try {
      Matrix matrix = new Matrix();
      int orientation = new ExifInterface(new ByteArrayInputStream(bytes)).getAttributeInt(
        ExifInterface.TAG_ORIENTATION,
        1
      );
      switch (orientation) {
        case 2:
          matrix.setScale(-1, 1);
          break;
        case 3:
          matrix.setRotate(180);
          break;
        case 4:
          matrix.setScale(1, -1);
          break;
        case 5:
          matrix.setRotate(90);
          matrix.postScale(-1, 1);
          break;
        case 6:
          matrix.setRotate(90);
          break;
        case 7:
          matrix.setRotate(-90);
          matrix.postScale(-1, 1);
          break;
        case 8:
          matrix.setRotate(-90);
          break;
      }
      if (!matrix.isIdentity()) {
        Bitmap rotated = Bitmap.createBitmap(
          bitmap,
          0,
          0,
          bitmap.getWidth(),
          bitmap.getHeight(),
          matrix,
          true
        );
        if (rotated != bitmap) {
          bitmap.recycle();
          bitmap = rotated;
        }
      }
      float scale = Math.min(
        1f,
        Math.min((float) width / bitmap.getWidth(), (float) height / bitmap.getHeight())
      );
      Bitmap output = Bitmap.createBitmap(
        Math.max(1, Math.round(bitmap.getWidth() * scale)),
        Math.max(1, Math.round(bitmap.getHeight() * scale)),
        Bitmap.Config.ARGB_8888
      );
      try {
        Canvas canvas = new Canvas(output);
        canvas.drawColor(Color.WHITE);
        canvas.drawBitmap(
          bitmap,
          null,
          new Rect(0, 0, output.getWidth(), output.getHeight()),
          new Paint(Paint.FILTER_BITMAP_FLAG)
        );
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (!output.compress(Bitmap.CompressFormat.JPEG, quality, out)) throw new IOException(
          "사진을 압축하지 못했습니다."
        );
        return out.toByteArray();
      } finally {
        output.recycle();
      }
    } finally {
      bitmap.recycle();
    }
  }
}
