'use strict';
const { scopedPath, useScopedDb } = require('./shared-files.cjs');
const { uuid } = require('../../shared/field-model.cjs');
function draftStore(userData, access) {
  const file = scopedPath(userData, access, 'drafts.db', { actor: true });
  const key = (v) => {
    if (typeof v !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(v))
      throw Error('작성 화면을 확인해주세요.');
    return v;
  };
  const use = (fn) =>
    useScopedDb(
      file,
      'PRAGMA busy_timeout=5000;create table if not exists drafts(key text primary key,value text not null,updated_at text not null)',
      fn,
    );
  return {
    read(k) {
      key(k);
      return use((db) => {
        const row = db.prepare('select value from drafts where key=?').get(k);
        return row ? JSON.parse(row.value) : null;
      });
    },
    write(k, draft) {
      key(k);
      if (
        !draft ||
        typeof draft !== 'object' ||
        (draft.requestId != null && !uuid(draft.requestId)) ||
        (draft.revision != null && typeof draft.revision !== 'string')
      )
        throw Error('입력 내용과 저장 요청을 확인해주세요.');
      const value = JSON.stringify(draft);
      if (Buffer.byteLength(value) > 20000000) throw Error('입력 내용의 크기를 확인해주세요.');
      use((db) =>
        db
          .prepare(
            'insert into drafts values(?,?,?) on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at',
          )
          .run(k, value, new Date().toISOString()),
      );
      return JSON.parse(value);
    },
    discard(k, { requestId } = {}) {
      key(k);
      return use((db) => {
        const row = db.prepare('select value from drafts where key=?').get(k);
        if (row && (!requestId || JSON.parse(row.value).requestId === requestId))
          db.prepare('delete from drafts where key=?').run(k);
      });
    },
  };
}
module.exports = { draftStore };
