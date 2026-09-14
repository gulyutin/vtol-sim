import type { Recording } from '../game/recorder';

/*
 * Последний открытый бортовой журнал — в IndexedDB браузера: после перезагрузки на место полёта
 * разбор открывается сам. Записи журналов — мегабайты, в localStorage они не помещаются.
 * Отдельная база: у пакетов районов своя, со своими версиями.
 */

const DB = 'vtol-sim-logs';
const STORE = 'logs';
const KEY = 'last';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Хранилище браузера (IndexedDB) недоступно'));
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('Хранилище браузера: запись не удалась'));
        };
      }),
  );
}

export const saveLastLog = (rec: Recording): Promise<void> => run('readwrite', (s) => s.put(rec, KEY)).then(() => undefined);

export const loadLastLog = (): Promise<Recording | undefined> => run('readonly', (s) => s.get(KEY) as IDBRequest<Recording | undefined>);
