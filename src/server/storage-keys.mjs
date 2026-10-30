// One place that decides where a photo or Google Earth file lives in R2.
// Layout (see docs/superpowers/specs/2026-10-22-r2-storage-lifecycle-design.md, section 4):
//   {workspace}/묘지/{사업지역}/{시군}/{묘지번호}/위치/{저장일}_{버전}/original.kml
//   {workspace}/묘지/{사업지역}/{시군}/{묘지번호}/작업사진/{보고일}_{보고}/01_{사진}.jpg
//   {workspace}/미연결/작업사진/{보고일}_{보고}/…        (묘지를 정하지 못한 보고)
//   staging/{workspace}/{업로드}/…                         (업로드 임시 칸, 1일 자동 만료)
// Only the server builds keys, and it records them in the database; nothing here reads a key back.
import checks from '../shared/checks.cjs';

const MAX_FOLDER = 40;
const UNSORTED = '미분류';
export const UNLINKED = '미연결';

const uuid = (value, name) => {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (!checks.uuid(text)) throw Error(`Invalid ${name}`);
  return text;
};

// Extension of a Google Earth original, from its file name.
export const earthExtension = (file) => (/\.kmz$/i.test(file) ? 'kmz' : 'kml');

// Region and city names come from people; macOS and Windows store the same Hangul differently
// (NFD vs NFC), so folder names are always normalized and limited to letters and digits.
export function folderName(value, fallback = UNSORTED) {
  const text = String(value ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, MAX_FOLDER);
  return text || fallback;
}

export function graveFolder({ region, sigun, number }) {
  if (!Number.isSafeInteger(number) || number < 1) throw Error('Invalid grave number');
  return `묘지/${folderName(region)}/${folderName(sigun)}/${number}`;
}

// Korean calendar day: a report made at 23:50 in Seoul belongs to that day, not the UTC one.
export function dayStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw Error('Invalid date');
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

const folderPath = (workspaceId, folder) => `${uuid(workspaceId, 'workspace')}/${folder}`;
const safeFolder = (folder) => {
  if (
    typeof folder !== 'string' ||
    !/^(묘지\/[\p{L}\p{N}]+\/[\p{L}\p{N}]+\/[1-9][0-9]*|미연결)$/u.test(folder) ||
    folder !== folder.normalize('NFC')
  )
    throw Error('Invalid storage folder');
  return folder;
};

export function photoKeys({ workspaceId, folder, reportId, reportDate, photoIds }) {
  const base = `${folderPath(workspaceId, safeFolder(folder))}/작업사진/${dayStamp(reportDate)}_${uuid(reportId, 'report')}`;
  return photoIds.map((id, index) => {
    const photoId = uuid(id, 'photo');
    return {
      photoId,
      final: `${base}/${String(index + 1).padStart(2, '0')}_${photoId}.jpg`,
      staging: `staging/${uuid(workspaceId, 'workspace')}/${photoId}/photo.jpg`,
    };
  });
}

export function earthKeys({ workspaceId, folder, versionId, savedAt, extension }) {
  if (!['kml', 'kmz'].includes(extension)) throw Error('Invalid extension');
  const version = uuid(versionId, 'version');
  const base = `${folderPath(workspaceId, safeFolder(folder))}/위치/${dayStamp(savedAt)}_${version}`;
  return {
    original: `${base}/original.${extension}`,
    manifest: `${base}/manifest.json`,
    staging: `staging/${uuid(workspaceId, 'workspace')}/${version}/original.${extension}`,
    // The pasted screenshot sits beside the original in the same version folder.
    image: `${base}/earth.jpg`,
    imageStaging: `staging/${uuid(workspaceId, 'workspace')}/${version}/earth.jpg`,
  };
}

// Keys used before 2026-10-22. They stay valid for files that already exist; cleanup deletes both
// spellings because deleting a missing key is harmless.
export const legacy = {
  photo: (ownerId, workspaceId, reportId, photoId) => ({
    final: `${ownerId}/${workspaceId}/${reportId}/${photoId}.jpg`,
    staging: `report-staging/${ownerId}/${workspaceId}/${reportId}/${photoId}.jpg`,
  }),
  earth: (workspaceId, graveId, versionId, extension) => ({
    original: `earth/${workspaceId}/${graveId}/${versionId}/original.${extension}`,
    manifest: `earth/${workspaceId}/${graveId}/${versionId}/manifest.json`,
    staging: `earth-staging/${workspaceId}/${graveId}/${versionId}/original.${extension}`,
    image: `earth/${workspaceId}/${graveId}/${versionId}/earth.jpg`,
    imageStaging: `earth-staging/${workspaceId}/${graveId}/${versionId}/earth.jpg`,
  }),
};
