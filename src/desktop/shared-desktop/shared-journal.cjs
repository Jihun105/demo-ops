'use strict';
const fs = require('node:fs'),
  { createHash } = require('node:crypto'),
  { DatabaseSync } = require('node:sqlite');
const { uuid } = require('../../shared/field-model.cjs');
const { scopedPath, useScopedDb, canonical } = require('./shared-files.cjs');
function requestJournal(userData, access) {
  const file = scopedPath(userData, access, 'requests.db', { actor: true });
  const use = (fn) =>
    useScopedDb(
      file,
      "PRAGMA busy_timeout=5000;create table if not exists requests(id text primary key,session_id text not null,input_sha text not null,input_json text not null,state text not null check(state in ('prepared','confirming','committed','rejected')),result_json text,created_at text not null);" +
        'create table if not exists earth_flows(id text primary key,input_json text not null,metadata_json text not null)',
      fn,
    );
  const parse = (r) =>
    r
      ? {
          requestId: r.id,
          sessionId: r.session_id,
          input: JSON.parse(r.input_json),
          state: r.state,
          result: r.result_json === null ? null : JSON.parse(r.result_json),
          createdAt: r.created_at,
        }
      : null;
  return {
    file,
    installationId() {
      return use((db) => {
        db.exec('create table if not exists device_meta(key text primary key,value text not null)');
        db.prepare('insert or ignore into device_meta values(?,?)').run(
          'installation',
          require('node:crypto').randomUUID(),
        );
        return db.prepare('select value from device_meta where key=?').get('installation').value;
      });
    },
    protectedEarthOriginals() {
      const path = require('node:path'),
        actors = path.dirname(path.dirname(file)),
        result = [];
      for (const actor of fs.readdirSync(actors)) {
        if (!uuid(actor)) continue;
        const folder = path.join(actors, actor),
          candidate = path.join(folder, 'requests.db');
        if (fs.lstatSync(folder).isSymbolicLink())
          throw Error('KML 요청 보관 폴더를 확인해주세요.');
        const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
        if (!stat) continue;
        if (stat.isSymbolicLink() || !stat.isFile())
          throw Error('KML 요청 보관 파일을 확인해주세요.');
        const db = new DatabaseSync(candidate, { readOnly: true, allowExtension: false });
        try {
          if (!db.prepare("select 1 from sqlite_master where name='earth_flows'").get()) continue;
          for (const row of db
            .prepare(
              'select f.input_json,r.state from earth_flows f left join requests r on r.id=f.id',
            )
            .all())
            if (!['committed', 'rejected'].includes(row.state))
              result.push(JSON.parse(row.input_json).original);
        } finally {
          db.close();
        }
      }
      return result;
    },
    flow(id) {
      return use((db) => {
        const row = db.prepare('select * from earth_flows where id=?').get(id);
        return row
          ? { input: JSON.parse(row.input_json), metadata: JSON.parse(row.metadata_json) }
          : null;
      });
    },
    prepareFlow(id, input, metadata) {
      if (!uuid(id)) throw Error('어스 저장 요청을 확인해주세요.');
      return use((db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const row = db.prepare('select * from earth_flows where id=?').get(id);
          const body = canonical(input);
          if (row && row.input_json !== body)
            throw Error('어스 요청 내용이 변경되었습니다. conflict');
          if (!row)
            db.prepare('insert into earth_flows values(?,?,?)').run(
              id,
              body,
              JSON.stringify(metadata),
            );
          else {
            const previous = JSON.parse(row.metadata_json);
            const preparation = db
              .prepare('select state from requests where id=?')
              .get(previous.preparationRequestId);
            const final = db.prepare('select state from requests where id=?').get(id);
            // Only an explicit retry of a definitively rejected preparation gets new
            // phase IDs. Lost/uncertain responses must keep their idempotency keys.
            if (!final && preparation?.state === 'rejected') {
              db.prepare('update earth_flows set metadata_json=? where id=?').run(
                JSON.stringify(metadata),
                id,
              );
              db.exec('COMMIT');
              return metadata;
            }
          }
          db.exec('COMMIT');
          return row ? JSON.parse(row.metadata_json) : metadata;
        } finally {
          if (db.isTransaction) db.exec('ROLLBACK');
        }
      });
    },
    prepare({ requestId, sessionId, input }) {
      if (
        !uuid(requestId) ||
        !uuid(sessionId) ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input)
      )
        throw Error('저장 요청 번호와 내용을 확인해주세요.');
      const body = canonical(input);
      if (!body || Buffer.byteLength(body) > 20000000)
        throw Error('저장 내용의 크기를 확인해주세요.');
      const sha = createHash('sha256').update(body).digest('hex');
      return use((db) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const old = db.prepare('select * from requests where id=?').get(requestId);
          if (old) {
            if (old.input_sha !== sha)
              throw Error('같은 요청 번호에 다른 내용을 저장할 수 없습니다. conflict');
            db.exec('COMMIT');
            return parse(old);
          }
          db.prepare("insert into requests values(?,?,?, ?,'prepared',null,?)").run(
            requestId,
            sessionId,
            sha,
            body,
            new Date().toISOString(),
          );
          const row = parse(db.prepare('select * from requests where id=?').get(requestId));
          db.exec('COMMIT');
          return row;
        } finally {
          if (db.isTransaction) db.exec('ROLLBACK');
        }
      });
    },
    read(id) {
      return use((db) => parse(db.prepare('select * from requests where id=?').get(id)));
    },
    markConfirming(id) {
      use((db) =>
        db
          .prepare("update requests set state='confirming' where id=? and state='prepared'")
          .run(id),
      );
    },
    markCommitted(id, result) {
      use((db) => {
        const row = db.prepare('select state,result_json from requests where id=?').get(id);
        if (!row) throw Error('저장 요청을 찾을 수 없습니다.');
        if (
          row.state === 'committed' &&
          canonical(JSON.parse(row.result_json)) !== canonical(result)
        )
          throw Error('저장 결과가 다릅니다.');
        db.prepare("update requests set state='committed',result_json=? where id=?").run(
          JSON.stringify(result),
          id,
        );
      });
    },
    markRejected(id, error) {
      use((db) =>
        db
          .prepare(
            "update requests set state='rejected',result_json=? where id=? and state<>'committed'",
          )
          .run(JSON.stringify({ code: error.code, message: error.message }), id),
      );
    },
    // New registrations are not resumed after the app was closed (2026-10-25). On the first
    // connection after the app starts, registrations that never finished are given up so their
    // records stop holding back device cleanup and keeping their KML originals. The server drops
    // an unused number reservation and prepared upload by itself after 24 hours. Other kinds of
    // saves (customer edits, work, sales) keep being resumed.
    abandonRegistrations() {
      return use((db) => {
        const open = "state in ('prepared','confirming')";
        const why = JSON.stringify({
          code: 'abandoned',
          message: '앱을 다시 시작해 끝나지 않은 신규 등록을 버렸습니다.',
        });
        const reject = (id) =>
          db
            .prepare(`update requests set state='rejected',result_json=? where id=? and ${open}`)
            .run(why, id);
        let count = 0;
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const flow of db.prepare('select * from earth_flows').all()) {
            if (JSON.parse(flow.input_json).finalInput?.type !== 'register') continue;
            const final = db.prepare('select state from requests where id=?').get(flow.id);
            if (final?.state === 'committed') continue;
            reject(flow.id);
            reject(JSON.parse(flow.metadata_json).preparationRequestId);
            db.prepare('delete from earth_flows where id=?').run(flow.id);
            count++;
          }
          for (const row of db.prepare(`select id,input_json from requests where ${open}`).all()) {
            if (JSON.parse(row.input_json).type !== 'register') continue;
            reject(row.id);
            count++;
          }
          db.exec('COMMIT');
        } finally {
          if (db.isTransaction) db.exec('ROLLBACK');
        }
        return count;
      });
    },
    pending() {
      return use((db) =>
        db
          .prepare(
            "select * from requests where state in ('prepared','confirming') order by created_at,id",
          )
          .all()
          .map(parse),
      );
    },
  };
}
module.exports = { requestJournal };
