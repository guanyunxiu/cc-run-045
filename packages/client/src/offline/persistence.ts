import { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

type IndexeddbPersistenceInstance = InstanceType<typeof IndexeddbPersistence>;

/**
 * 离线优先本地持久化，基于 IndexedDB + y-indexeddb。
 *
 * 三类数据（库 blockeditor-<docId>）：
 *  1. Yjs 文档状态 —— 由 IndexeddbPersistence 在每次事务后增量落盘，
 *     重新打开页面时先加载本地状态，实现"秒开 + 断网全量编辑"；
 *  2. pending-updates —— 本地待同步的二进制增量队列（SyncQueue）；
 *  3. temp-state       —— 临时文档状态（滚动位置、草稿设置等，可丢弃）。
 */

const DB_VERSION = 1;

function openStore(dbName: string, store: string): Promise<IDBObjectStore> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(store)) {
        db.close();
        // 已存在旧版本库且缺少 store：升级版本重建。
        const upgrade = indexedDB.open(dbName, DB_VERSION + 1);
        upgrade.onupgradeneeded = () => {
          const d = upgrade.result;
          if (!d.objectStoreNames.contains(store)) d.createObjectStore(store, { keyPath: 'key' });
        };
        upgrade.onsuccess = () => resolve(openStoreTx(upgrade.result, store));
        upgrade.onerror = () => reject(upgrade.error);
        return;
      }
      resolve(openStoreTx(db, store));
    };
    request.onerror = () => reject(request.error);
  });
}

function openStoreTx(db: IDBDatabase, store: string): IDBObjectStore {
  return db.transaction(store, 'readwrite').objectStore(store);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 简单的 key/value 存储（pending 队列与临时状态共用）。 */
export class KeyValueStore {
  private storePromise: Promise<IDBObjectStore> | null = null;

  constructor(
    private readonly dbName: string,
    private readonly store: string,
  ) {}

  private tx(): Promise<IDBObjectStore> {
    this.storePromise ??= openStore(this.dbName, this.store);
    return this.storePromise;
  }

  async put<T>(key: string, value: T): Promise<void> {
    const s = await this.tx();
    await requestToPromise(s.put({ key, value }));
  }

  async get<T>(key: string): Promise<T | undefined> {
    const s = await this.tx();
    const row = (await requestToPromise(s.get(key))) as { value: T } | undefined;
    return row?.value;
  }

  async getAll<T>(): Promise<T[]> {
    const s = await this.tx();
    const rows = (await requestToPromise(s.getAll())) as Array<{ value: T }>;
    return rows.map((r) => r.value);
  }

  async delete(key: string): Promise<void> {
    const s = await this.tx();
    await requestToPromise(s.delete(key));
  }

  async clear(): Promise<void> {
    const s = await this.tx();
    await requestToPromise(s.clear());
  }
}

export interface PersistenceHandle {
  /** y-indexeddb 实例，初次本地加载完成后 resolve。 */
  persistence: IndexeddbPersistenceInstance;
  whenSynced: Promise<void>;
  /** 待同步二进制增量队列。 */
  queue: KeyValueStore;
  /** 临时文档状态。 */
  temp: KeyValueStore;
  /** 关闭并刷盘。 */
  destroy: () => void;
}

export function bindIndexedDB(doc: Y.Doc, docId: string): PersistenceHandle {
  const dbName = `blockeditor-${docId}`;
  const persistence = new IndexeddbPersistence(docId, doc);

  const queue = new KeyValueStore(dbName, 'pending-updates');
  const temp = new KeyValueStore(dbName, 'temp-state');

  const whenSynced = new Promise<void>((resolve) => {
    persistence.once('synced', () => resolve());
    // y-indexeddb 在无历史数据时也会触发 synced。
  });

  return {
    persistence,
    whenSynced,
    queue,
    temp,
    destroy: () => {
      persistence.destroy();
    },
  };
}
