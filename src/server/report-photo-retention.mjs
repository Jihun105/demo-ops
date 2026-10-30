// 오래된 보고 이력은 남기고 사진만 삭제합니다. 부분 실패도 안전하게 재시도합니다.
import { cleanupPrivacyAssets } from './privacy-assets.mjs';
import { legacy } from './storage-keys.mjs';
export async function pruneReportPhotos(access, services) {
  try {
    if (access.privacyEnabled) return await cleanupPrivacyAssets(access, services);
    const reports = await services.pendingPrunes(access);
    for (const report of reports) {
      if (
        report.owner_id !== access.ownerId ||
        report.workspace_id !== access.workspaceId ||
        report.state !== 'ready' ||
        report.photo_state !== 'pruning'
      )
        continue;
      try {
        for (const photo of report.photos)
          await services.removePhoto(
            legacy.photo(report.owner_id, report.workspace_id, report.id, photo.id).final,
          );
        await services.finishPrune(access, report.id);
      } catch {
        // 새 보고 등록은 이미 완료됐습니다. 다음 조회/등록 시 남은 삭제를 재시도합니다.
      }
    }
  } catch {
    // 일시적인 정리 실패 때문에 정상 등록/목록 조회를 실패로 바꾸지 않습니다.
  }
}
