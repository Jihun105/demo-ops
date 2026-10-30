(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let generation = 0;
  const labels = {
    server: '서버 사본',
    asset: 'KML·KMZ',
    report: '작업 사진',
    device: '기기 사본',
    backup: '백업',
  };
  const count = (value) => Number(value || 0).toLocaleString('ko-KR');
  const size = (bytes) => {
    const value = Number(bytes || 0);
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)}GB`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}MB`;
    return `${Math.ceil(value / 1e3)}KB`;
  };
  // A short sentence for the last check. Zero everywhere means nothing is wrong.
  function checkText(check) {
    if (!check) return '아직 점검한 적이 없습니다. 아래 버튼으로 확인할 수 있습니다.';
    const when = new Date(check.checkedAt);
    const stamp = Number.isNaN(when.getTime())
      ? ''
      : `${when.toLocaleDateString('ko-KR')} ${when.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} · `;
    const problems = [];
    if (check.missing) problems.push(`기록은 있는데 저장소에 없는 파일 ${count(check.missing)}개`);
    if (check.orphans)
      problems.push(
        `기록에 없는 파일 ${count(check.orphans)}개` +
          (check.orphansOld ? `(7일이 지난 것 ${count(check.orphansOld)}개)` : ''),
      );
    if (check.prefixViolations)
      problems.push(`규칙에 없는 폴더·파일 ${count(check.prefixViolations)}개`);
    const note = check.partial ? ' 파일이 많아 일부만 확인했습니다.' : '';
    return `${stamp}확인한 파일 ${count(check.listed)}개 · ${problems.join(' · ') || '이상 없음'}.${note}`;
  }
  function showStats(storage) {
    const stats = $('storage-stats');
    stats.replaceChildren();
    if (!storage) {
      stats.hidden = true;
      return;
    }
    const rows = [
      ['작업 사진', `${count(storage.photos)}장 · ${size(storage.photoBytes)}`],
      ['Google Earth 원본', `${count(storage.originals)}개`],
      ['삭제 대기', `${count(storage.waitingDelete)}건`],
      ...(storage.held ? [['보존 표시', `${count(storage.held)}건`]] : []),
      ['마지막 점검', checkText(storage.lastCheck)],
    ];
    for (const [name, value] of rows) {
      const term = document.createElement('dt'),
        detail = document.createElement('dd');
      term.textContent = name;
      detail.textContent = value;
      stats.append(term, detail);
    }
    stats.hidden = false;
  }
  async function refresh() {
    const current = ++generation;
    $('privacy-refresh').disabled = true;
    try {
      const response = await window.demo.privacyRequest({ action: 'read' });
      if (current !== generation) return;
      if (!response.ok) throw Error();
      const status = response.result;
      $('privacy-status').textContent =
        (status.copies || [])
          .map(
            (c) =>
              `${labels[c.kind] || '사본'} ${c.state === 'complete' ? '완료' : '확인·정리 대기'} ${c.count}건`,
          )
          .join(' · ') || '등록된 정리 작업이 없습니다.';
      showStats(status.storage);
    } catch {
      if (current === generation) {
        $('privacy-status').textContent = '온라인 회사 연결 후 상태를 확인해주세요.';
        showStats(null);
      }
    } finally {
      if (current === generation) $('privacy-refresh').disabled = false;
    }
  }
  async function check() {
    const current = ++generation;
    $('storage-check').disabled = true;
    $('storage-check-result').textContent =
      '저장소를 점검하는 중입니다. 파일이 많으면 잠시 걸립니다.';
    try {
      const response = await window.demo.privacyRequest({ action: 'storage-check' });
      if (current !== generation) return;
      if (!response.ok) throw Error();
      $('storage-check-result').textContent = checkText({
        ...response.result,
        checkedAt: new Date().toISOString(),
      });
      await refresh();
    } catch {
      if (current === generation)
        $('storage-check-result').textContent =
          '점검하지 못했습니다. 온라인 연결과 사장님·마스터 권한을 확인해주세요.';
    } finally {
      if (current === generation) $('storage-check').disabled = false;
    }
  }
  $('privacy-refresh').onclick = refresh;
  $('storage-check').onclick = check;
  $('privacy-settings').addEventListener('toggle', () => {
    if (!$('privacy-settings').open) {
      generation++;
      $('storage-stats').replaceChildren();
      $('storage-stats').hidden = true;
      $('privacy-refresh').disabled = false;
      $('storage-check').disabled = false;
    }
  });
  window.demo.onCustomersChanged?.(() => {
    generation++;
    $('privacy-status').textContent = '자료가 변경되었습니다. 상태를 다시 확인해주세요.';
    $('privacy-refresh').disabled = false;
    $('storage-check').disabled = false;
  });
})();
