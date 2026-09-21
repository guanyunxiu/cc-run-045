import type { KeyValueStore } from './persistence.js';

/**
 * 本地待同步操作队列。
 *
 * 离线期间 BlockDoc 的每次本地事务都会产生一个 Yjs 二进制增量，
 * 全量入队（IndexedDB），进程被杀也不丢。网络恢复后：
 *  1. 先完成 sync step1/step2，与远端状态校验、拉取并自动合并；
 *  2. 再按 seq 顺序幂等推送队列里的增量 —— Yjs 更新天然幂等：
 *     同一 update 重复 apply，已存在的 CRDT item 不会产生二次效果；
 *  3. 服务端 ACK（房间内回播该更新，或显式 ACK 帧）后出队。
 *
 * 幂等键 = 本地 clientID + 事务 update 的时钟起点，服务端可据此去重。
 */

export interface PendingUpdate {
  /** 单调递增序号（单文档内）。 */
  seq: number;
  /** 幂等键：{clientID}:{firstClock}。 */
  dedupeKey: string;
  /** base64 编码的二进制增量。 */
  updateB64: string;
  createdAt: number;
  /** 已推送次数，用于观测卡住的更新。 */
  attempts: number;
}

const SEQ_KEY = '__seq__';

export class SyncQueue {
  constructor(private readonly store: KeyValueStore) {}

  private async nextSeq(): Promise<number> {
    const current = (await this.store.get<number>(SEQ_KEY)) ?? 0;
    const next = current + 1;
    await this.store.put(SEQ_KEY, next);
    return next;
  }

  async enqueue(dedupeKey: string, update: Uint8Array): Promise<PendingUpdate> {
    const item: PendingUpdate = {
      seq: await this.nextSeq(),
      dedupeKey,
      updateB64: toBase64(update),
      createdAt: Date.now(),
      attempts: 0,
    };
    await this.store.put(String(item.seq), item);
    return item;
  }

  async all(): Promise<PendingUpdate[]> {
    const items = await this.store.getAll<PendingUpdate>();
    return items
      .filter((item) => typeof item?.seq === 'number')
      .sort((a, b) => a.seq - b.seq);
  }

  async markAttempt(seq: number): Promise<void> {
    const item = await this.store.get<PendingUpdate>(String(seq));
    if (item) await this.store.put(String(seq), { ...item, attempts: item.attempts + 1 });
  }

  /** 幂等确认后移除（收到服务端回播 / 合并后状态中已含该 update）。 */
  async remove(seq: number): Promise<void> {
    await this.store.delete(String(seq));
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
