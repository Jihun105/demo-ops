// 기기의 고객 자료·업무 기록·초안 등을 IndexedDB에 보관합니다.
export function localStore(indexedDB = window.indexedDB) {
  let database;
  async function open() {
    if (database) return database;
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('demo-field-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('data');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error('기기에 자료를 저장할 수 없습니다. 저장 공간을 확인해주세요.'));
    });
    return database;
  }
  async function run(mode, callback) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('data', mode);
      let result;
      try {
        result = callback(tx.objectStore('data'));
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result.result);
      tx.onerror = () => reject(new Error('로컬 저장에 실패했습니다. 저장 공간을 확인해주세요.'));
      tx.onabort = tx.onerror;
    });
  }
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: (key, value) => run('readwrite', (s) => s.put(value, key)),
    remove: (key) => run('readwrite', (s) => s.delete(key)),
    entries: async () => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('data', 'readonly'),
          result = [];
        const cursor = tx.objectStore('data').openCursor();
        cursor.onsuccess = () => {
          if (cursor.result) {
            result.push([cursor.result.key, cursor.result.value]);
            cursor.result.continue();
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(Error('로컬 정리 목록을 읽지 못했습니다.'));
      });
    },
    batch: (operations) =>
      run('readwrite', (s) => {
        if (!Array.isArray(operations))
          operations = [
            ...(operations.remove || []).map((key) => ({ key, remove: true })),
            ...(operations.put || []).map(([key, value]) => ({ key, value })),
          ];
        let result;
        for (const item of operations)
          result = item.remove ? s.delete(item.key) : s.put(item.value, item.key);
        return result || s.count();
      }),
  };
}
